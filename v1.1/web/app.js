/* ============================================================================
   Job Intelligence v1.1 — static front end. No accounts, no build step.

   Two modes, chosen automatically from config.js:

     CORPUS  Supabase configured → one RPC against the swept corpus. Fast.
     LIVE    nothing configured  → fetch ATS boards straight from the browser.
             Slower, but needs no backend, so the site works the moment it's
             deployed. All four upstream endpoints send
             Access-Control-Allow-Origin: *, which is what makes this possible.

   Config and saved/dismissed jobs live in localStorage. Nothing leaves the
   browser except requests to the public job APIs.
   ========================================================================== */

const CFG = window.APP_CONFIG || {};
const CORPUS_MODE = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

const db = CORPUS_MODE
  ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
  : null;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let results = [];

/* ── local state (no server) ─────────────────────────────────────────────── */
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('jia.' + k); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('jia.' + k, JSON.stringify(v)); } catch {} },
};

let saved     = new Set(store.get('saved', []));
let dismissed = new Set(store.get('dismissed', []));
const persist = () => {
  store.set('saved', [...saved]);
  store.set('dismissed', [...dismissed]);
};

/* ══════════════════════════════════════════════════════════════════════════
   LIVE MODE — the whole pipeline, in the browser
   ═══════════════════════════════════════════════════════════════════════ */

const REGISTRY = 'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

const ATS = {
  greenhouse: {
    list: `${REGISTRY}/greenhouse_companies.json`,
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`,
    parse: (d, t) => (d.jobs || []).map((j) => ({
      title: j.title || '', company: j.company_name || t,
      location: j.location?.name || '',
      remote: /remote|anywhere/i.test(j.location?.name || ''),
      description: j.content ? strip(decode(j.content)) : '',
      url: j.absolute_url, posted_at: j.first_published || j.updated_at,
      source: 'greenhouse',
    })),
  },
  lever: {
    list: `${REGISTRY}/lever_companies.json`,
    url: (t) => `https://api.lever.co/v0/postings/${t}?mode=json`,
    parse: (d, t) => (Array.isArray(d) ? d : []).map((j) => ({
      title: j.text || '', company: t,
      location: j.categories?.location || '',
      remote: /remote/i.test(`${j.workplaceType || ''} ${j.categories?.location || ''}`),
      description: j.descriptionPlain || '',
      url: j.hostedUrl || j.applyUrl,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      source: 'lever',
    })),
  },
  ashby: {
    list: `${REGISTRY}/ashby_companies.json`,
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${t}`,
    parse: (d, t) => (d.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
      title: j.title || '', company: t,
      location: j.location || '',
      remote: !!j.isRemote || /remote/i.test(j.workplaceType || ''),
      description: j.descriptionPlain || '',
      url: j.jobUrl || j.applyUrl, posted_at: j.publishedAt,
      source: 'ashby',
    })),
  },
};

function decode(s) { const e = document.createElement('textarea'); e.innerHTML = s; return e.value; }
const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

let registryCache = null;
async function loadRegistry() {
  if (registryCache) return registryCache;
  const out = [];
  for (const [ats, def] of Object.entries(ATS)) {
    const r = await fetch(def.list);
    if (!r.ok) continue;
    for (const token of await r.json()) out.push({ ats, token });
  }
  registryCache = out;
  return out;
}

async function liveSearch(cfg, onProgress) {
  const registry = await loadRegistry();
  const n = CFG.LIVE_SAMPLE || 30;
  const targets = [];
  for (let i = 0; i < n && registry.length; i++) {
    targets.push(registry[Math.floor(Math.random() * registry.length)]);
  }

  const jobs = [];
  const stats = { live: 0, dead: 0 };
  let cursor = 0, done = 0;

  const worker = async () => {
    while (cursor < targets.length) {
      const t = targets[cursor++];
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(ATS[t.ats].url(t.token), { signal: ctrl.signal });
        if (res.ok) { stats.live++; jobs.push(...ATS[t.ats].parse(await res.json(), t.token)); }
        else stats.dead++;
      } catch { stats.dead++; }
      finally { clearTimeout(timer); onProgress(++done, targets.length); }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(CFG.LIVE_CONCURRENCY || 6, targets.length) }, worker
  ));

  return { jobs: dedupe(jobs), probed: targets.length, ...stats };
}

/* dedupe + score, mirroring the SQL side */
const normCo = (s) => s.toLowerCase()
  .replace(/[.,]/g, ' ')
  .replace(/\b(inc|llc|ltd|limited|corp|corporation|gmbh|bv|plc|sa|co)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '');
const normTi = (s) => s.toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/\b(senior|sr|junior|jr|lead|staff|principal|i{1,3}|iv|\d+)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const normLo = (s) => /remote|anywhere|distributed/i.test(s || '')
  ? 'remote' : (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);

function dedupe(jobs) {
  const seen = new Map();
  for (const j of jobs) {
    const k = `${normCo(j.company)}|${normTi(j.title)}|${normLo(j.location)}`;
    if (!seen.has(k)) seen.set(k, j);
  }
  return [...seen.values()];
}

function scoreLocally(jobs, cfg) {
  const max = cfg.keywords.reduce((s, k) => s + k.weight, 0) || 1;
  const cutoffMs = Date.now() - cfg.maxAge * 864e5;

  return jobs.map((j) => {
    const hay = `${j.title} ${j.description}`.toLowerCase();
    const tl = j.title.toLowerCase();
    let raw = 0; const matched = [];
    for (const { term, weight } of cfg.keywords) {
      if (hay.includes(term)) { raw += tl.includes(term) ? weight : weight * 0.6; matched.push(term); }
    }
    return { ...j, score: Math.round(Math.min(raw / max, 1) * 100), matched };
  }).filter((j) => {
    if (j.score < cfg.minScore) return false;
    if (cfg.remoteOnly && !j.remote) return false;
    if (cfg.exclude.some((x) => j.title.toLowerCase().includes(x))) return false;
    if (j.posted_at && new Date(j.posted_at).getTime() < cutoffMs) return false;
    return true;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   CORPUS MODE — one RPC
   ═══════════════════════════════════════════════════════════════════════ */

async function corpusSearch(cfg) {
  const keywords = {};
  for (const { term, weight } of cfg.keywords) keywords[term] = weight;

  const { data, error } = await db.rpc('search_jobs', {
    p_keywords: keywords,
    p_exclude: cfg.exclude,
    p_remote_only: cfg.remoteOnly,
    p_max_age_days: cfg.maxAge,
    p_min_score: cfg.minScore,
    p_limit: 80,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadCorpusStats() {
  if (!CORPUS_MODE) return;
  const { data } = await db.rpc('corpus_stats');
  const s = data?.[0];
  if (!s) return;
  $('corpusStats').innerHTML =
    `<b>${Number(s.total_jobs).toLocaleString()}</b> jobs · ` +
    `<b>${Number(s.live_companies).toLocaleString()}</b> companies` +
    (s.last_run ? `<br>updated ${timeAgo(new Date(s.last_run))}` : '');
}

/* ══════════════════════════════════════════════════════════════════════════
   ORCHESTRATION
   ═══════════════════════════════════════════════════════════════════════ */

function readConfig() {
  const keywords = $('keywords').value.split('\n').map((line) => {
    const [term, w] = line.split(':');
    if (!term?.trim()) return null;
    return { term: term.trim().toLowerCase(), weight: parseFloat(w) || 10 };
  }).filter(Boolean);

  return {
    keywords,
    exclude: $('exclusions').value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    remoteOnly: $('remoteOnly').checked,
    maxAge: +$('maxAge').value,
    minScore: +$('minScore').value,
  };
}

function saveConfig() {
  store.set('config', {
    keywords: $('keywords').value,
    exclusions: $('exclusions').value,
    remoteOnly: $('remoteOnly').checked,
    maxAge: $('maxAge').value,
    minScore: $('minScore').value,
  });
}

function restoreConfig() {
  const c = store.get('config', null);
  if (!c) return;
  $('keywords').value = c.keywords ?? $('keywords').value;
  $('exclusions').value = c.exclusions ?? $('exclusions').value;
  $('remoteOnly').checked = !!c.remoteOnly;
  $('maxAge').value = c.maxAge ?? 45;
  $('minScore').value = c.minScore ?? 15;
}

async function search() {
  const btn = $('search');
  btn.disabled = true; btn.textContent = 'Searching…';
  $('empty').hidden = true;
  saveConfig();

  const cfg = readConfig();
  const t0 = performance.now();

  try {
    if (!cfg.keywords.length) throw new Error('Add at least one keyword.');

    let list, funnel;

    if (CORPUS_MODE) {
      $('progressPanel').hidden = false;
      $('stageLabel').textContent = 'Querying corpus…';
      setBar(60);
      list = await corpusSearch(cfg);
      funnel = null;
    } else {
      $('progressPanel').hidden = false;
      $('stageLabel').textContent = 'Fetching company boards…';
      const r = await liveSearch(cfg, (d, t) => {
        setBar((d / t) * 100);
        $('progressCount').textContent = `${d} / ${t}`;
      });
      const scored = scoreLocally(r.jobs, cfg).sort((a, b) => b.score - a.score);
      list = scored;
      funnel = { probed: r.probed, live: r.live, dead: r.dead, found: r.jobs.length, matched: scored.length };
    }

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    results = list;

    if (funnel) renderFunnel({ ...funnel, secs });
    else $('funnel').hidden = true;

    renderResults();
    $('stageLabel').textContent = `Done in ${secs}s`;
    setBar(100);
    setTimeout(() => { $('progressPanel').hidden = true; }, 900);
  } catch (err) {
    $('stageLabel').textContent = 'Failed — ' + err.message;
    console.error(err);
  } finally {
    btn.disabled = false; btn.textContent = 'Search';
  }
}

/* ── rendering ───────────────────────────────────────────────────────────── */
const statBox = (v, l, c = '') => `<div class="stat ${c}"><b>${v}</b><span>${l}</span></div>`;

function renderFunnel(f) {
  $('funnel').hidden = false;
  const rate = f.probed ? Math.round((f.live / f.probed) * 100) : 0;
  $('stats').innerHTML =
    statBox(f.probed, 'probed') +
    statBox(`${f.live} <small style="font-size:11px">(${rate}%)</small>`, 'live', 'good') +
    statBox(f.dead, 'gone', 'warn') +
    statBox(f.found.toLocaleString(), 'jobs') +
    statBox(f.matched, 'matched', 'acc') +
    statBox(f.secs + 's', 'took');
}

function timeAgo(d) {
  const days = (Date.now() - d.getTime()) / 864e5;
  if (days < 0.04) return 'just now';
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  if (days < 30) return `${Math.round(days)}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

function renderResults() {
  const sortBy = $('sortBy').value;
  const hide = $('hideDismissed').checked;

  let list = [...results];
  if (hide) list = list.filter((j) => !dismissed.has(j.url));
  list.sort((a, b) =>
    sortBy === 'date' ? new Date(b.posted_at || 0) - new Date(a.posted_at || 0)
    : sortBy === 'company' ? (a.company || '').localeCompare(b.company || '')
    : b.score - a.score);

  $('resultsPanel').hidden = false;
  $('resultCount').textContent = list.length;

  if (!list.length) {
    const liveNote = CORPUS_MODE ? '' :
      ' Live mode samples a random slice of companies each time — searching again checks a different slice.';
    $('results').innerHTML =
      `<p class="nores">Nothing matched. Lower the minimum match, add keywords, ` +
      `or widen the date range.${liveNote}</p>`;
    renderSaved();
    return;
  }

  $('results').innerHTML = list.map((j) => {
    const cls = j.score >= 55 ? 'hi' : j.score >= 28 ? 'mid' : '';
    const age = j.posted_at ? timeAgo(new Date(j.posted_at)) : '';
    const isSaved = saved.has(j.url);
    const isGone  = dismissed.has(j.url);
    const chips = (j.matched || []).slice(0, 6)
      .map((m) => `<span class="chip">${esc(m)}</span>`).join('');

    return `
      <div class="job ${isGone ? 'dismissed' : ''}">
        <div class="score ${cls}">${j.score}</div>
        <div>
          <p class="job-title"><a href="${esc(j.url)}" target="_blank" rel="noopener"
             data-track="${esc(j.url)}">${esc(j.title)}</a></p>
          <div class="job-meta">
            <span class="co">${esc(j.company)}</span>
            ${j.location ? `<span>${esc(j.location)}</span>` : ''}
            ${age ? `<span>${age}</span>` : ''}
            <span class="src-badge">${esc(j.source)}</span>
          </div>
          <div class="chips">${chips}</div>
        </div>
        <div class="actions">
          <button class="act ${isSaved ? 'on' : ''}" data-save="${esc(j.url)}">
            ${isSaved ? 'Saved' : 'Save'}</button>
          <button class="act" data-dismiss="${esc(j.url)}">
            ${isGone ? 'Undo' : 'Not for me'}</button>
        </div>
      </div>`;
  }).join('');

  renderSaved();
}

function renderSaved() {
  const list = results.filter((j) => saved.has(j.url));
  $('savedPanel').hidden = list.length === 0;
  $('savedCount').textContent = list.length;
  $('savedList').innerHTML = list.map((j) => `
    <div class="job">
      <div class="score">${j.score}</div>
      <div>
        <p class="job-title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></p>
        <div class="job-meta"><span class="co">${esc(j.company)}</span>
          ${j.location ? `<span>${esc(j.location)}</span>` : ''}</div>
      </div>
      <div class="actions">
        <button class="act on" data-save="${esc(j.url)}">Remove</button>
      </div>
    </div>`).join('');
}

const setBar = (p) => { $('bar').style.width = p + '%'; };

/* ── anonymous feedback (corpus mode only, no identity) ──────────────────── */
function sessionId() {
  let s = store.get('session', null);
  if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('session', s); }
  return s;
}
function track(action, job) {
  if (!CORPUS_MODE || !job?.id) return;
  db.from('feedback_events')
    .insert({ job_id: job.id, action, session: sessionId() })
    .then(() => {}, () => {});   // best-effort, never blocks the UI
}

/* ── wiring ──────────────────────────────────────────────────────────────── */
document.addEventListener('click', (e) => {
  const saveUrl = e.target.closest('[data-save]')?.dataset.save;
  const dropUrl = e.target.closest('[data-dismiss]')?.dataset.dismiss;
  const linkUrl = e.target.closest('[data-track]')?.dataset.track;

  if (saveUrl) {
    const job = results.find((j) => j.url === saveUrl);
    if (saved.has(saveUrl)) saved.delete(saveUrl);
    else { saved.add(saveUrl); track('saved', job); }
    persist(); renderResults();
  }
  if (dropUrl) {
    const job = results.find((j) => j.url === dropUrl);
    if (dismissed.has(dropUrl)) dismissed.delete(dropUrl);
    else { dismissed.add(dropUrl); track('dismissed', job); }
    persist(); renderResults();
  }
  if (linkUrl) track('clicked', results.find((j) => j.url === linkUrl));
});

$('search').addEventListener('click', search);
$('sortBy').addEventListener('change', renderResults);
$('hideDismissed').addEventListener('change', renderResults);
$('reset').addEventListener('click', () => {
  localStorage.removeItem('jia.config');
  location.reload();
});

for (const [slider, out] of [['maxAge', 'ageOut'], ['minScore', 'minOut']]) {
  const el = $(slider);
  const sync = () => { $(out).textContent = el.value; };
  el.addEventListener('input', sync);
  sync();
}

/* ── boot ────────────────────────────────────────────────────────────────── */
restoreConfig();
for (const [slider, out] of [['maxAge', 'ageOut'], ['minScore', 'minOut']]) {
  $(out).textContent = $(slider).value;
}

$('modeBadge').textContent = CORPUS_MODE ? 'corpus' : 'live';
$('modeBadge').className = 'badge' + (CORPUS_MODE ? '' : ' live');

if (CORPUS_MODE) {
  loadCorpusStats();
  $('emptyHint').textContent =
    'Connected to the swept corpus — searches are instant.';
} else {
  $('corpusStats').innerHTML = 'live mode — no backend';
  $('emptyHint').textContent =
    'Running in live mode: each search samples a random slice of company boards and ' +
    'fetches them right now, so it takes ~20-40 seconds and sees a different slice each ' +
    'time. Add Supabase credentials in config.js to search the full pre-swept corpus instantly.';
}
