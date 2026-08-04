/* ============================================================================
   Job Intelligence Agent — end-to-end browser test
   ----------------------------------------------------------------------------
   Proves the registry-shaped pipeline works, with no server:

     1. REGISTRY   pull public company-token lists
     2. SAMPLE     draw N tokens (+ your watchlist)
     3. FETCH      hit each company's public ATS endpoint, pooled + timed out
     4. NORMALIZE  three different response shapes -> one Job
     5. DEDUPE     normalized company+title+location key
     6. FILTER     drop excluded titles
     7. SCORE      weighted keywords, normalized to a percentage
     8. RENDER     ranked table

   All four upstream endpoints send `Access-Control-Allow-Origin: *`,
   which is why this can run as a plain file:// page.
   ========================================================================== */

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

const SOURCES = {
  greenhouse: {
    list: `${REGISTRY_BASE}/greenhouse_companies.json`,
    url: (t, desc) =>
      `https://boards-api.greenhouse.io/v1/boards/${t}/jobs${desc ? '?content=true' : ''}`,
    parse: parseGreenhouse,
  },
  lever: {
    list: `${REGISTRY_BASE}/lever_companies.json`,
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    parse: parseLever,
  },
  ashby: {
    list: `${REGISTRY_BASE}/ashby_companies.json`,
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    parse: parseAshby,
  },
};

const REQUEST_TIMEOUT_MS = 15000;

/* ── tiny DOM helpers ────────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let lastResults = [];

/* ══════════════════════════════════════════════════════════════════════════
   1. REGISTRY
   ═══════════════════════════════════════════════════════════════════════ */
async function loadRegistry(sources) {
  const registry = [];
  for (const name of sources) {
    log(`registry: fetching ${name} token list…`);
    const res = await fetch(SOURCES[name].list);
    if (!res.ok) throw new Error(`registry ${name} failed: HTTP ${res.status}`);
    const tokens = await res.json();
    tokens.forEach((t) => registry.push({ ats: name, token: t }));
    log(`registry: ${name} → ${tokens.length.toLocaleString()} tokens`, 'ok');
  }
  return registry;
}

/* ══════════════════════════════════════════════════════════════════════════
   2. SAMPLE
   ═══════════════════════════════════════════════════════════════════════ */
function sample(registry, n, favourites) {
  const picked = [];
  const seen = new Set();

  // watchlist first — try each favourite against every enabled source
  for (const fav of favourites) {
    for (const ats of new Set(registry.map((r) => r.ats))) {
      const key = `${ats}:${fav}`;
      if (!seen.has(key)) { seen.add(key); picked.push({ ats, token: fav, fav: true }); }
    }
  }

  // then a random draw
  const pool = registry.filter((r) => !seen.has(`${r.ats}:${r.token}`));
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

/* ══════════════════════════════════════════════════════════════════════════
   3. FETCH  — concurrency pool + per-request timeout
   ═══════════════════════════════════════════════════════════════════════ */
async function fetchAll(targets, concurrency, withDesc, onProgress) {
  const results = [];
  const stats = { live: 0, dead: 0, error: 0 };
  let cursor = 0, done = 0;

  async function worker() {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      const src = SOURCES[target.ats];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(src.url(target.token, withDesc), { signal: ctrl.signal });
        if (res.ok) {
          const jobs = src.parse(await res.json(), target.token);
          stats.live++;
          results.push(...jobs);
          log(`${target.ats}/${target.token} → ${jobs.length} jobs`, 'ok');
        } else if (res.status === 404) {
          stats.dead++;
          log(`${target.ats}/${target.token} → 404 (churned)`, 'dead');
        } else {
          stats.error++;
          log(`${target.ats}/${target.token} → HTTP ${res.status}`, 'err');
        }
      } catch (e) {
        // A dead token on some hosts surfaces as a network/CORS error rather
        // than a clean 404, so count aborts separately from real failures.
        stats.error++;
        log(`${target.ats}/${target.token} → ${e.name === 'AbortError' ? 'timeout' : 'failed'}`, 'err');
      } finally {
        clearTimeout(timer);
        onProgress(++done, targets.length);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  );
  return { jobs: results, stats };
}

/* ══════════════════════════════════════════════════════════════════════════
   4. NORMALIZE — three shapes, one Job
   ═══════════════════════════════════════════════════════════════════════ */
function job(o) {
  return {
    title: (o.title || '').trim(),
    company: (o.company || '').trim(),
    location: (o.location || '').trim(),
    description: o.description || '',
    url: o.url || '',
    postedAt: o.postedAt || null,
    source: o.source,
    remote: !!o.remote,
  };
}

function parseGreenhouse(data, token) {
  return (data.jobs || []).map((j) =>
    job({
      title: j.title,
      company: j.company_name || token,
      location: j.location?.name,
      description: j.content ? stripHtml(decodeEntities(j.content)) : '',
      url: j.absolute_url,
      postedAt: j.first_published || j.updated_at,
      source: 'greenhouse',
      remote: /remote/i.test(j.location?.name || ''),
    })
  );
}

function parseLever(data, token) {
  return (Array.isArray(data) ? data : []).map((j) =>
    job({
      title: j.text,
      company: token,
      location: j.categories?.location,
      description: j.descriptionPlain || '',
      url: j.hostedUrl || j.applyUrl,
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      source: 'lever',
      remote:
        /remote/i.test(j.workplaceType || '') ||
        /remote/i.test(j.categories?.location || ''),
    })
  );
}

function parseAshby(data, token) {
  return (data.jobs || []).map((j) =>
    job({
      title: j.title,
      company: token,
      location: j.location,
      description: j.descriptionPlain || '',
      url: j.jobUrl || j.applyUrl,
      postedAt: j.publishedAt,
      source: 'ashby',
      remote: !!j.isRemote || /remote/i.test(j.workplaceType || ''),
    })
  );
}

function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
const stripHtml = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/* ══════════════════════════════════════════════════════════════════════════
   5. DEDUPE — normalize hard, then hash
   ═══════════════════════════════════════════════════════════════════════ */
const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|gmbh|bv|ab|oy|plc|sa|srl|co)\b/g;

function normCompany(s) {
  return s.toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function normTitle(s) {
  return s.toLowerCase()
    .replace(/\(.*?\)/g, ' ')                                    // "(Senior)" etc
    .replace(/\b(senior|sr|junior|jr|lead|i{1,3}|iv|v|\d)\b/g, ' ') // seniority + levels
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normLocation(s) {
  const t = s.toLowerCase();
  if (/remote|anywhere|distributed/.test(t)) return 'remote';
  return t.replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

function dedupe(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const key = `${normCompany(j.company)}|${normTitle(j.title)}|${normLocation(j.location)}`;
    if (!seen.has(key)) seen.set(key, j);
  }
  return [...seen.values()];
}

/* ══════════════════════════════════════════════════════════════════════════
   6. FILTER
   ═══════════════════════════════════════════════════════════════════════ */
function filterJobs(jobs, exclusions) {
  if (!exclusions.length) return jobs;
  return jobs.filter((j) => {
    const t = j.title.toLowerCase();
    return !exclusions.some((x) => t.includes(x));
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   7. SCORE — normalized to a percentage of what's achievable
   ═══════════════════════════════════════════════════════════════════════ */
const SALARY_RE =
  /(\$|€|£)\s?\d{2,3}[,.]?\d{3}|\b\d{2,3}[,.]\d{3}\s?(usd|eur|gbp)\b|\bsalary\s*(range|band)\b/i;

function scoreJobs(jobs, cfg) {
  // Denominator: every point this config could possibly award.
  let max = cfg.keywords.reduce((s, k) => s + k.weight, 0);
  if (cfg.bonusRemote) max += 20;
  if (cfg.bonusSalary) max += 10;
  if (cfg.bonusRecent) max += 10;
  if (max === 0) max = 1;

  return jobs.map((j) => {
    const haystack = `${j.title} ${j.description}`.toLowerCase();
    const titleLc = j.title.toLowerCase();

    let raw = 0;
    const matched = [], missing = [];

    for (const { term, weight } of cfg.keywords) {
      if (haystack.includes(term)) {
        // A hit in the title is worth more than one buried in the description.
        const w = titleLc.includes(term) ? weight : weight * 0.6;
        raw += w;
        matched.push(term);
      } else {
        missing.push(term);
      }
    }

    if (cfg.bonusRemote && j.remote) { raw += 20; matched.push('remote'); }
    if (cfg.bonusSalary && SALARY_RE.test(j.description)) { raw += 10; matched.push('salary'); }

    // Recency decays over 30 days rather than a flat cliff.
    let ageDays = null;
    if (cfg.bonusRecent && j.postedAt) {
      ageDays = (Date.now() - new Date(j.postedAt)) / 864e5;
      if (ageDays >= 0 && ageDays < 30) {
        raw += 10 * (1 - ageDays / 30);
        if (ageDays <= 7) matched.push('recent');
      }
    }

    return {
      ...j,
      ageDays,
      score: Math.round(Math.min(raw / max, 1) * 100),
      matched,
      missing,
    };
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   ORCHESTRATION
   ═══════════════════════════════════════════════════════════════════════ */
async function run() {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = 'Running…';

  $('empty').hidden = true;
  $('progressPanel').hidden = false;
  $('log').innerHTML = '';
  setBar(0);

  const t0 = performance.now();

  try {
    const cfg = readConfig();
    if (!cfg.sources.length) throw new Error('Select at least one source.');

    stage('Loading registry…');
    const registry = await loadRegistry(cfg.sources);

    stage('Sampling companies…');
    const targets = sample(registry, cfg.sampleSize, cfg.favourites);
    log(`sampled ${targets.length} companies from ${registry.length.toLocaleString()}`);

    stage('Fetching job boards…');
    const { jobs: raw, stats } = await fetchAll(
      targets, cfg.concurrency, cfg.withDesc,
      (done, total) => {
        setBar((done / total) * 100);
        $('progressCount').textContent = `${done} / ${total}`;
      }
    );

    stage('Processing…');
    const deduped = dedupe(raw);
    const filtered = filterJobs(deduped, cfg.exclusions);
    const scored = scoreJobs(filtered, cfg);
    const passing = scored.filter((j) => j.score >= cfg.minScore);

    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    renderFunnel({
      probed: targets.length,
      live: stats.live,
      dead: stats.dead + stats.error,
      raw: raw.length,
      deduped: deduped.length,
      filtered: filtered.length,
      passing: passing.length,
      secs,
    });

    lastResults = passing;
    renderResults();

    stage(`Done in ${secs}s`);
    setBar(100);
  } catch (err) {
    stage('Failed');
    log(String(err.message || err), 'err');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run pipeline';
  }
}

/* ── config ──────────────────────────────────────────────────────────────── */
function readConfig() {
  const keywords = $('keywords').value
    .split('\n')
    .map((line) => {
      const [term, w] = line.split(':');
      if (!term || !term.trim()) return null;
      return { term: term.trim().toLowerCase(), weight: parseFloat(w) || 10 };
    })
    .filter(Boolean);

  return {
    sources: [...document.querySelectorAll('.src:checked')].map((c) => c.value),
    sampleSize: +$('sampleSize').value,
    concurrency: +$('concurrency').value,
    withDesc: $('withDesc').checked,
    favourites: $('favourites').value.split(',').map((s) => s.trim()).filter(Boolean),
    keywords,
    bonusRemote: $('bonusRemote').checked,
    bonusSalary: $('bonusSalary').checked,
    bonusRecent: $('bonusRecent').checked,
    exclusions: $('exclusions').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    minScore: +$('minScore').value,
  };
}

/* ── rendering ───────────────────────────────────────────────────────────── */
function renderFunnel(f) {
  const liveRate = f.probed ? Math.round((f.live / f.probed) * 100) : 0;
  $('funnel').hidden = false;
  $('stats').innerHTML = `
    ${stat(f.probed, 'probed')}
    ${stat(`${f.live} <small style="font-size:12px">(${liveRate}%)</small>`, 'live', 'good')}
    ${stat(f.dead, 'dead / 404', 'warn')}
    ${stat(f.raw, 'jobs found')}
    ${stat(f.deduped, 'after dedupe')}
    ${stat(f.filtered, 'after filter')}
    ${stat(f.passing, 'above cutoff', 'acc')}
    ${stat(f.secs + 's', 'elapsed')}
  `;
}
const stat = (v, label, cls = '') =>
  `<div class="stat ${cls}"><b>${v}</b><span>${label}</span></div>`;

function renderResults() {
  const sortBy = $('sortBy').value;
  const list = [...lastResults].sort((a, b) => {
    if (sortBy === 'date') return new Date(b.postedAt || 0) - new Date(a.postedAt || 0);
    if (sortBy === 'company') return a.company.localeCompare(b.company);
    return b.score - a.score;
  });

  $('resultsPanel').hidden = false;
  $('resultCount').textContent = `${list.length}`;

  if (!list.length) {
    $('results').innerHTML =
      `<p class="nores">No jobs cleared the cutoff. Lower the minimum score,
       widen your keywords, or sample more companies.</p>`;
    return;
  }

  $('results').innerHTML = list.map((j) => {
    const cls = j.score >= 60 ? 'hi' : j.score >= 30 ? 'mid' : '';
    const age =
      j.ageDays == null ? '' :
      j.ageDays < 1 ? 'today' :
      j.ageDays < 30 ? `${Math.round(j.ageDays)}d ago` :
      `${Math.round(j.ageDays / 30)}mo ago`;

    return `
      <div class="job">
        <div class="score ${cls}">${j.score}</div>
        <div>
          <p class="job-title">
            <a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a>
          </p>
          <div class="job-meta">
            <span class="co">${esc(j.company)}</span>
            ${j.location ? `<span>${esc(j.location)}</span>` : ''}
            ${age ? `<span>${age}</span>` : ''}
            <span class="src-badge">${j.source}</span>
          </div>
          <div class="chips">
            ${j.matched.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}
            ${j.missing.slice(0, 4).map((m) => `<span class="chip miss">${esc(m)}</span>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');
}

/* ── progress UI ─────────────────────────────────────────────────────────── */
const stage = (t) => { $('stageLabel').textContent = t; };
const setBar = (pct) => { $('bar').style.width = pct + '%'; };

function log(msg, cls = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = msg;
  const box = $('log');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

/* ── wiring ──────────────────────────────────────────────────────────────── */
$('run').addEventListener('click', run);
$('sortBy').addEventListener('change', renderResults);
$('reset').addEventListener('click', () => location.reload());

for (const [slider, out] of [
  ['sampleSize', 'sampleOut'], ['concurrency', 'concOut'], ['minScore', 'minOut'],
]) {
  const s = $(slider);
  const sync = () => { $(out).textContent = s.value; };
  s.addEventListener('input', sync);
  sync();
}
