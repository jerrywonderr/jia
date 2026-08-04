/* ============================================================================
   Pipeline primitives: normalization for dedupe, a concurrency pool,
   and a fetch wrapper that does gzip + conditional requests.
   ========================================================================== */

import { createHash } from 'node:crypto';
import type { NormalizedJob } from './sources.js';

/* ── dedupe key ──────────────────────────────────────────────────────────────
   Exact hashing of raw fields misses `Acme` vs `Acme, Inc.` and
   `Remote` vs `Remote - US`. Normalize hard, then hash. TDD v0.2 §7.4.
   ─────────────────────────────────────────────────────────────────────────── */

const LEGAL_SUFFIX =
  /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|gmbh|bv|nv|ab|oy|as|plc|sa|srl|pty|co)\b/g;

const SENIORITY =
  /\b(senior|sr|junior|jr|lead|staff|principal|i{1,3}|iv|vi{0,3}|\d+)\b/g;

export function normCompany(s: string): string {
  return s.toLowerCase()
    .replace(/[.,'’]/g, ' ')
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

export function normTitle(s: string): string {
  return s.toLowerCase()
    .replace(/\(.*?\)/g, ' ')       // "(Senior)", "(Remote)"
    .replace(/[\/,–—-]/g, ' ')
    .replace(SENIORITY, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normLocation(s: string): string {
  const t = (s || '').toLowerCase();
  if (/remote|anywhere|distributed/.test(t)) return 'remote';
  return t.replace(/[^a-z0-9]+/g, '').slice(0, 24);
}

export function dedupKey(j: NormalizedJob): string {
  const basis = `${normCompany(j.company)}|${normTitle(j.title)}|${normLocation(j.location)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 20);
}

/** Collapse duplicates within a batch, keeping the first seen. */
export function dedupe(jobs: NormalizedJob[]): (NormalizedJob & { dedupKey: string })[] {
  const seen = new Map<string, NormalizedJob & { dedupKey: string }>();
  for (const j of jobs) {
    const key = dedupKey(j);
    if (!seen.has(key)) seen.set(key, { ...j, dedupKey: key });
  }
  return [...seen.values()];
}

/* ── concurrency pool ────────────────────────────────────────────────────────
   Per-source, not global: Ashby averages ~12s vs Greenhouse ~1.8s, and a
   shared pool lets the slow source starve the rest. TDD v0.2 §7.2.
   ─────────────────────────────────────────────────────────────────────────── */

export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    }
  );

  await Promise.all(runners);
  return results;
}

/* ── conditional, compressed fetch ───────────────────────────────────────────
   gzip is a 12x payload reduction; ETag turns an unchanged board into a
   0-byte 304. Together they are the difference between a 15-minute and a
   2-minute sweep. TDD v0.2 §7.2.
   ─────────────────────────────────────────────────────────────────────────── */

export interface FetchResult {
  status: 'ok' | 'not-modified' | 'dead' | 'error';
  data?: unknown;
  etag?: string | null;
  detail?: string;
}

export async function conditionalFetch(
  url: string,
  etag: string | null | undefined,
  timeoutMs = 15000
): Promise<FetchResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'accept-encoding': 'gzip, deflate, br',
        accept: 'application/json',
        'user-agent': 'job-intelligence-agent/1.1 (+personal use; polite)',
        ...(etag ? { 'if-none-match': etag } : {}),
      },
    });

    if (res.status === 304) return { status: 'not-modified', etag };
    if (res.status === 404) return { status: 'dead' };
    if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };

    return {
      status: 'ok',
      data: await res.json(),
      etag: res.headers.get('etag'),
    };
  } catch (err: any) {
    return {
      status: 'error',
      detail: err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Exponential backoff with full jitter — without jitter, retries re-sync. */
export const jitteredDelay = (attempt: number, base = 400) =>
  Math.random() * base * 2 ** attempt;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
