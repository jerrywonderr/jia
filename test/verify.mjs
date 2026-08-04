/* Headless verification of the browser app.
   Loads the real index.html + app.js in jsdom, clicks "Run pipeline"
   against the live APIs, and reports the funnel.

   Usage:  npm i jsdom && node verify.mjs
   This is a test harness, not part of the app. */

import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8')
  .replace('<script src="app.js"></script>', '');   // inject manually after shims

const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;

// Node has all of these natively; jsdom's window doesn't expose them.
window.fetch = fetch;
window.AbortController = AbortController;
window.console = console;   // jsdom supplies performance itself

const script = window.document.createElement('script');
script.textContent = readFileSync(join(here, 'app.js'), 'utf8');
window.document.body.appendChild(script);

// Small, polite sample.
window.document.getElementById('sampleSize').value = '30';
window.document.getElementById('concurrency').value = '6';
window.document.getElementById('favourites').value = 'stripe, ramp, leverdemo';

console.log('running pipeline against live APIs…\n');
window.document.getElementById('run').click();

// Poll until the run finishes (button re-enables).
const btn = window.document.getElementById('run');
const started = Date.now();
await new Promise((resolve) => {
  const iv = setInterval(() => {
    if (!btn.disabled || Date.now() - started > 180000) { clearInterval(iv); resolve(); }
  }, 400);
});

const text = (sel) => window.document.querySelector(sel)?.textContent?.trim() ?? '';

console.log('── FUNNEL ' + '─'.repeat(50));
window.document.querySelectorAll('#stats .stat').forEach((s) => {
  const v = s.querySelector('b').textContent.trim();
  const l = s.querySelector('span').textContent.trim();
  console.log(`  ${l.padEnd(16)} ${v}`);
});

const jobs = window.document.querySelectorAll('#results .job');
console.log(`\n── TOP MATCHES (${jobs.length} shown) ` + '─'.repeat(30));
[...jobs].slice(0, 12).forEach((j) => {
  const score = j.querySelector('.score').textContent.trim();
  const title = j.querySelector('.job-title a').textContent.trim();
  const co = j.querySelector('.job-meta .co').textContent.trim();
  const src = j.querySelector('.src-badge').textContent.trim();
  const chips = [...j.querySelectorAll('.chip:not(.miss)')].map((c) => c.textContent).join(',');
  console.log(`  ${score.padStart(3)}%  ${title.slice(0, 46).padEnd(48)} ${co.slice(0, 16).padEnd(17)} ${src.padEnd(11)} ${chips}`);
});

console.log(`\nstatus: ${text('#stageLabel')}`);
const errors = [...window.document.querySelectorAll('#log .err')].map((e) => e.textContent);
if (errors.length) {
  console.log(`\n${errors.length} error line(s), first few:`);
  errors.slice(0, 5).forEach((e) => console.log('  ' + e));
}
