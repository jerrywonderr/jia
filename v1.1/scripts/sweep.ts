#!/usr/bin/env tsx
/* ============================================================================
   The sweep. Runs in GitHub Actions every 6 hours.

     read companies by tier
       -> fetch with gzip + If-None-Match
       -> 304: skip everything downstream
       -> normalize -> dedupe -> upsert jobs
       -> write ETags back, update company status
       -> log a run row

     npm run sweep                       full, tier-aware
     npm run sweep -- --tier 0           one tier
     npm run sweep -- --limit 200        cap companies
     npm run sweep:dry                   no DB, no writes — proves the pipeline
   ========================================================================== */

import { SOURCES, ALL_ATS, type Ats, type NormalizedJob } from '../src/sources.js';
import { dedupe, pool, conditionalFetch } from '../src/pipeline.js';
import { getClient, loadEnv } from '../src/db.js';

loadEnv();

/* ── args ────────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const DRY        = flag('dry-run');
const LIMIT      = Number(opt('limit', '0')) || 0;
const ONLY_TIER  = opt('tier') !== undefined ? Number(opt('tier')) : null;
const CONCURRENCY = Number(opt('concurrency', '8'));

/**
 * Which tiers are due, given the current hour.
 *
 * This keeps the sweep rate-limited and predictable:
 * - tier 0 runs every sweep (watchlist)
 * - tier 1 runs roughly twice a day
 * - tier 2 runs once a day
 */
function tiersDue(): number[] {
  if (ONLY_TIER !== null) return [ONLY_TIER];

  const h = new Date().getUTCHours();
  const due = [0];
  if (h % 12 < 6) due.push(1);
  if (h < 6) due.push(2);
  return due;
}

/** Descriptions are ~98% of payload — only fetch them where they earn it. */
const wantsDescription = (tier: number) => tier <= 1;

interface CompanyRow {
  id: number; ats: Ats; token: string; tier: number;
  etag: string | null; status: string; fail_count: number;
}

/* ── dry-run source: sample real tokens, no DB ───────────────────────────── */
async function dryRunCompanies(n: number): Promise<CompanyRow[]> {
  const out: CompanyRow[] = [];
  let id = 1;
  for (const ats of ALL_ATS) {
    const res = await fetch(SOURCES[ats].listUrl);
    const tokens = (await res.json()) as string[];
    const take = Math.ceil(n / ALL_ATS.length);
    for (let i = 0; i < take && tokens.length; i++) {
      const t = tokens[Math.floor(Math.random() * tokens.length)];
      out.push({ id: id++, ats, token: t, tier: 2, etag: null, status: 'unknown', fail_count: 0 });
    }
  }
  return out;
}

/* ── main ────────────────────────────────────────────────────────────────── */
async function main() {
  const started = Date.now();
  const db = DRY ? null : getClient();
  const due = tiersDue();

  console.log(`sweep  ${DRY ? '[DRY RUN] ' : ''}tiers=${due.join(',')} concurrency=${CONCURRENCY}\n`);

  /* 1 — which companies */
  let companies: CompanyRow[];

  if (DRY) {
    companies = await dryRunCompanies(LIMIT || 24);
  } else {
    let q = db!.from('companies')
      .select('id, ats, token, tier, etag, status, fail_count')
      .in('tier', due)
      .neq('status', 'dead')
      .order('last_fetched', { ascending: true, nullsFirst: true });
    if (LIMIT) q = q.limit(LIMIT);
    const { data, error } = await q;
    if (error) throw new Error(`load companies: ${error.message}`);
    companies = (data ?? []) as CompanyRow[];
  }

  if (!companies.length) {
    console.log('No companies due. Did you run `npm run seed`?');
    return;
  }
  console.log(`  ${companies.length.toLocaleString()} companies due\n`);

  /* 2 — fetch, grouped per source so one slow ATS can't starve the others */
  const stats = { live: 0, notModified: 0, dead: 0, error: 0, jobs: 0 };
  const allJobs: (NormalizedJob & { companyId: number })[] = [];
  const companyUpdates: any[] = [];
  let done = 0;

  await Promise.all(
    ALL_ATS.map(async (ats) => {
      const group = companies.filter((c) => c.ats === ats);
      if (!group.length) return;

      await pool(group, CONCURRENCY, async (c) => {
        const withDesc = wantsDescription(c.tier);
        const res = await conditionalFetch(SOURCES[ats].url(c.token, withDesc), c.etag);
        const now = new Date().toISOString();

        if (res.status === 'not-modified') {
          stats.notModified++;
          companyUpdates.push({
            id: c.id,
            ats: c.ats,
            token: c.token,
            tier: c.tier,
            last_fetched: now,
            status: 'live',
            fail_count: 0,
          });
        } else if (res.status === 'ok') {
          const jobs = SOURCES[ats].parse(res.data, c.token).filter((j) => j.url && j.title);
          stats.live++; stats.jobs += jobs.length;
          for (const j of jobs) allJobs.push({ ...j, companyId: c.id });
          companyUpdates.push({
            id: c.id,
            ats: c.ats,
            token: c.token,
            tier: c.tier,
            etag: res.etag ?? null,
            last_fetched: now,
            last_success: now,
            status: 'live',
            fail_count: 0,
            job_count: jobs.length,
            name: jobs[0]?.company ?? c.token,
          });
        } else if (res.status === 'dead') {
          stats.dead++;
          const fails = c.fail_count + 1;
          companyUpdates.push({
            id: c.id,
            ats: c.ats,
            token: c.token,
            tier: c.tier,
            last_fetched: now,
            fail_count: fails,
            status: fails >= 3 ? 'dead' : 'unknown',
          });
        } else {
          stats.error++;
          companyUpdates.push({
            id: c.id,
            ats: c.ats,
            token: c.token,
            tier: c.tier,
            last_fetched: now,
            status: 'error',
            fail_count: c.fail_count + 1,
          });
        }

        if (++done % 100 === 0 || done === companies.length) {
          process.stdout.write(
            `\r  ${done}/${companies.length}  live=${stats.live} 304=${stats.notModified} dead=${stats.dead} err=${stats.error} jobs=${stats.jobs}`
          );
        }
      });
    })
  );
  console.log('\n');

  /* 3 — dedupe */
  const deduped = dedupe(allJobs) as ((NormalizedJob & { companyId: number; dedupKey: string })[]);
  console.log(`  ${allJobs.length.toLocaleString()} jobs -> ${deduped.length.toLocaleString()} after dedupe`);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const rate304 = companies.length
    ? Math.round((stats.notModified / companies.length) * 100) : 0;

  if (DRY) {
    console.log(`\n  live rate  ${Math.round((stats.live / companies.length) * 100)}%`);
    console.log(`  elapsed    ${secs}s`);
    console.log('\n  sample:');
    for (const j of deduped.slice(0, 8)) {
      console.log(`    ${j.source.padEnd(11)} ${j.company.slice(0, 18).padEnd(20)} ${j.title.slice(0, 52)}`);
    }
    console.log('\n--dry-run: nothing written.');
    return;
  }

  /* 4 — upsert jobs */
  const rows = deduped.map((j) => ({
    company_id: j.companyId,
    source: j.source,
    external_id: j.externalId,
    title: j.title,
    location: j.location || null,
    remote: j.remote,
    description: j.description || null,
    url: j.url,
    posted_at: j.postedAt,
    last_seen: new Date().toISOString(),
    dedup_key: j.dedupKey,
  }));

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db!.from('jobs')
      .upsert(rows.slice(i, i + CHUNK), { onConflict: 'source,external_id' });
    if (error) { console.error(`\n  job upsert error at ${i}: ${error.message}`); stats.error++; }
    else upserted += Math.min(CHUNK, rows.length - i);
    process.stdout.write(`\r  upserting jobs ${upserted}/${rows.length}`);
  }
  console.log('');

  /* 5 — write ETags and company status back */
  let updated = 0;
  for (let i = 0; i < companyUpdates.length; i += CHUNK) {
    const { error } = await db!.from('companies')
      .upsert(companyUpdates.slice(i, i + CHUNK), { onConflict: 'id' });
    if (error) console.error(`\n  company update error at ${i}: ${error.message}`);
    else updated += Math.min(CHUNK, companyUpdates.length - i);
    process.stdout.write(`\r  updating companies ${updated}/${companyUpdates.length}`);
  }
  console.log('');

  /* 6 — run log */
  await db!.from('runs').insert({
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    companies_probed: companies.length,
    companies_live: stats.live,
    companies_304: stats.notModified,
    companies_dead: stats.dead,
    jobs_found: allJobs.length,
    jobs_new: rows.length,
    errors: stats.error,
    notes: `tiers=${due.join(',')} 304rate=${rate304}%`,
  });

  console.log(
    `\ndone in ${secs}s  ·  live ${stats.live}  ·  304 ${stats.notModified} (${rate304}%)  ` +
    `·  dead ${stats.dead}  ·  jobs ${rows.length.toLocaleString()}`
  );
  if (rate304 < 50 && stats.live > 20) {
    console.log('note: 304 rate is low — expected >80% once ETags are populated.');
  }
}

main().catch((e) => { console.error('\n' + (e?.message ?? e)); process.exit(1); });
