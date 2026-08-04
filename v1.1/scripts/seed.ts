#!/usr/bin/env tsx
/* ============================================================================
   Seed the company registry.
   Run once. ~15,862 tokens across three ATS platforms, from public lists
   refreshed daily by a third party. TDD v0.2 §7.1.

     npm run seed              write to Supabase
     npm run seed -- --dry-run just report what it would insert
   ========================================================================== */

import { SOURCES, ALL_ATS, type Ats } from '../src/sources.js';
import { getClient, loadEnv } from '../src/db.js';

loadEnv();

const DRY = process.argv.includes('--dry-run');
const WATCHLIST = (process.env.WATCHLIST ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function fetchList(ats: Ats): Promise<string[]> {
  const res = await fetch(SOURCES[ats].listUrl);
  if (!res.ok) throw new Error(`${ats} list: HTTP ${res.status}`);
  const tokens = (await res.json()) as string[];
  if (!Array.isArray(tokens)) throw new Error(`${ats} list: unexpected shape`);
  return tokens;
}

async function main() {
  console.log('Seeding company registry\n');

  const rows: { ats: string; token: string; tier: number }[] = [];

  for (const ats of ALL_ATS) {
    process.stdout.write(`  ${ats.padEnd(11)} `);
    const tokens = await fetchList(ats);
    for (const token of tokens) {
      rows.push({
        ats,
        token,
        tier: WATCHLIST.includes(token) ? 0 : 2,
      });
    }
    console.log(`${tokens.length.toLocaleString().padStart(7)} tokens`);
  }

  const tier0 = rows.filter((r) => r.tier === 0).length;
  console.log(`\n  total       ${rows.length.toLocaleString().padStart(7)} tokens`);
  if (tier0) console.log(`  watchlist   ${String(tier0).padStart(7)} (tier 0)`);

  if (DRY) {
    console.log('\n--dry-run: nothing written.');
    console.log('Sample:', rows.slice(0, 5).map((r) => `${r.ats}:${r.token}`).join(', '));
    return;
  }

  const db = getClient();
  const CHUNK = 1000;
  let written = 0;

  console.log('');
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await db
      .from('companies')
      .upsert(batch, { onConflict: 'ats,token', ignoreDuplicates: true });

    if (error) throw new Error(`upsert failed at ${i}: ${error.message}`);
    written += batch.length;
    process.stdout.write(`\r  written ${written.toLocaleString()} / ${rows.length.toLocaleString()}`);
  }

  console.log('\n\nDone. Next: npm run sweep');
}

main().catch((e) => { console.error('\n' + e.message); process.exit(1); });
