/* ============================================================================
   Source connectors — one interface, three ATS platforms.
   Field paths verified live 2026-08-03 (see TDD v0.2 §7.3).
   ========================================================================== */

export type Ats = 'greenhouse' | 'lever' | 'ashby';

export interface NormalizedJob {
  source: Ats;
  externalId: string;
  title: string;
  company: string;
  location: string;
  remote: boolean;
  description: string;
  url: string;
  postedAt: string | null;
}

export interface SourceDef {
  /** Public token list, refreshed daily by a third party. */
  listUrl: string;
  /** Per-company endpoint. `withDesc` only affects Greenhouse. */
  url: (token: string, withDesc: boolean) => string;
  parse: (data: unknown, token: string) => NormalizedJob[];
}

const REGISTRY_BASE =
  'https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data';

/* ── helpers ─────────────────────────────────────────────────────────────── */

const stripHtml = (s: string) =>
  s.replace(/<[^>]*>/g, ' ')
   .replace(/&nbsp;/g, ' ')
   .replace(/&amp;/g, '&')
   .replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>')
   .replace(/&#\d+;/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

const isRemote = (...vals: (string | undefined | null)[]) =>
  vals.some((v) => v && /remote|anywhere|distributed/i.test(v));

/* ── greenhouse ──────────────────────────────────────────────────────────── */

function parseGreenhouse(data: any, token: string): NormalizedJob[] {
  return (data?.jobs ?? []).map((j: any) => ({
    source: 'greenhouse' as const,
    externalId: String(j.id),
    title: (j.title ?? '').trim(),
    company: (j.company_name ?? token).trim(),
    location: (j.location?.name ?? '').trim(),
    remote: isRemote(j.location?.name),
    description: j.content ? stripHtml(j.content) : '',
    url: j.absolute_url ?? '',
    postedAt: j.first_published ?? j.updated_at ?? null,
  }));
}

/* ── lever ───────────────────────────────────────────────────────────────── */

function parseLever(data: any, token: string): NormalizedJob[] {
  return (Array.isArray(data) ? data : []).map((j: any) => ({
    source: 'lever' as const,
    externalId: String(j.id),
    title: (j.text ?? '').trim(),
    company: token,
    location: (j.categories?.location ?? '').trim(),
    remote: isRemote(j.workplaceType, j.categories?.location),
    description: j.descriptionPlain ?? '',
    url: j.hostedUrl ?? j.applyUrl ?? '',
    postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
}

/* ── ashby ───────────────────────────────────────────────────────────────── */

function parseAshby(data: any, token: string): NormalizedJob[] {
  return (data?.jobs ?? [])
    .filter((j: any) => j.isListed !== false)
    .map((j: any) => ({
      source: 'ashby' as const,
      externalId: String(j.id),
      title: (j.title ?? '').trim(),
      company: token,
      location: (j.location ?? '').trim(),
      remote: !!j.isRemote || isRemote(j.workplaceType, j.location),
      description: j.descriptionPlain ?? '',
      url: j.jobUrl ?? j.applyUrl ?? '',
      postedAt: j.publishedAt ?? null,
    }));
}

/* ── registry ────────────────────────────────────────────────────────────── */

export const SOURCES: Record<Ats, SourceDef> = {
  greenhouse: {
    listUrl: `${REGISTRY_BASE}/greenhouse_companies.json`,
    url: (t, withDesc) =>
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs${
        withDesc ? '?content=true' : ''
      }`,
    parse: parseGreenhouse,
  },
  lever: {
    listUrl: `${REGISTRY_BASE}/lever_companies.json`,
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    parse: parseLever,
  },
  ashby: {
    listUrl: `${REGISTRY_BASE}/ashby_companies.json`,
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    parse: parseAshby,
  },
};

export const ALL_ATS = Object.keys(SOURCES) as Ats[];
