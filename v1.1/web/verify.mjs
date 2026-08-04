/* Headless check of the static site in LIVE mode.
   Loads index.html in jsdom, clicks Search, reports what came back.
     npm i jsdom && node web/verify.mjs
   Test harness only — not shipped. */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8')
  .replace(/<script src="config\.js"><\/script>/, '')
  .replace(/<script src="https:\/\/cdn[^"]*"><\/script>/, '')
  .replace('<script src="app.js"></script>', '');

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
window.fetch = fetch;
window.AbortController = AbortController;
window.console = console;
window.APP_CONFIG = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '', LIVE_SAMPLE: 25, LIVE_CONCURRENCY: 6 };

const s = window.document.createElement('script');
s.textContent = readFileSync(join(here, 'app.js'), 'utf8');
window.document.body.appendChild(s);

console.log(`mode: ${window.document.getElementById('modeBadge').textContent}\nsearching…\n`);
window.document.getElementById('search').click();

const btn = window.document.getElementById('search');
const t0 = Date.now();
await new Promise((r) => {
  const iv = setInterval(() => {
    if (!btn.disabled || Date.now() - t0 > 150000) { clearInterval(iv); r(); }
  }, 400);
});

window.document.querySelectorAll('#stats .stat').forEach((el) =>
  console.log(`  ${el.querySelector('span').textContent.padEnd(9)} ${el.querySelector('b').textContent.trim()}`));

const jobs = window.document.querySelectorAll('#results .job');
console.log(`\ntop matches (${jobs.length} total):`);
[...jobs].slice(0, 10).forEach((j) => {
  const sc = j.querySelector('.score').textContent.trim();
  const ti = j.querySelector('.job-title a').textContent.trim();
  const co = j.querySelector('.job-meta .co').textContent.trim();
  const ch = [...j.querySelectorAll('.chip')].map((c) => c.textContent).join(',');
  console.log(`  ${sc.padStart(3)}%  ${ti.slice(0, 44).padEnd(46)} ${co.slice(0, 16).padEnd(18)} ${ch}`);
});
console.log(`\nstatus: ${window.document.getElementById('stageLabel').textContent}`);
