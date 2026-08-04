# Job Intelligence Agent
## Technical Design Document — V0.2

| | |
|---|---|
| **Author** | CTO |
| **Version** | 0.2 |
| **Status** | Ready for implementation |
| **Supersedes** | V0.1 (draft) |
| **Date** | 2026-08-03 |

**Objective.** Validate that an automated job discovery and intelligence pipeline can
consistently surface high-quality opportunities earlier than manual searching, while preserving
personalized applications.

**What's different about this version.** V0.1 was written from first principles. V0.2 is written
after measuring the actual systems we depend on and building a working end-to-end prototype.
Every performance number in this document was observed, not estimated; reproduction commands are
in Appendix A. Three of V0.1's core assumptions turned out to be wrong, and correcting them
changed the architecture.

---

## 0. Changelog — what changed from V0.1 and why

Read this section first. It's the whole diff.

| # | V0.1 said | Reality | V0.2 does |
|---|---|---|---|
| 1 | Search Module takes roles/keywords, returns jobs | **ATS APIs cannot be searched.** They are per-company lookups only | Replaced with `CompanyRegistry`; filtering moved into the database |
| 2 | Google X-Ray is a primary source, 4×/day | Google blocks automated querying; we'd be CAPTCHA'd within a week | Demoted to a *weekly registry feeder* that finds companies, not jobs |
| 3 | `minimumScore: 80` | **Highest score across 1,081 real postings was 44%** | Score normalized to % of achievable; realistic cutoff is 15–40 |
| 4 | Dedupe on `company+title+location` hash | Exact hashing misses `Acme` vs `Acme, Inc.`; no cross-run persistence | Normalize before hashing; persist the key; re-notification guard |
| 5 | "500 jobs in under 5 minutes" NFR | SQLite was never the bottleneck — redundant network bytes are | NFR rewritten around request efficiency and 304 rate |
| 6 | `status` column, no defined values | Nothing ever writes it; Phase 5 metrics uncomputable | Explicit lifecycle + feedback capture pulled into V0.1 scope |
| 7 | Notify as terminal pipeline stage, 4×/day | Contradicts "notify daily"; would ping at midnight | Ingest and digest are separate schedules |
| 8 | Single-user schema | Product ambition makes this a costly migration later | Shared corpus split from per-user state on day one |
| 9 | (not addressed) | gzip and ETag are supported and unused | Both mandatory in the fetch layer — 12× and ~100× savings |

Items 1, 2, 3, and 6 are correctness issues: V0.1 as written would not have produced a working
system. The rest are cost and durability improvements.

---

## 1. Executive summary

The goal is not to automate job applications. The system automates everything *before* the
application:

- discovering jobs across thousands of companies
- filtering irrelevant listings
- scoring and ranking opportunities
- (later) enriching with company intelligence and résumé gap analysis
- organizing follow-ups

The applicant submits every application manually. This avoids generic applications while
removing the hours spent searching.

**The central architectural idea:** *fetch broadly, filter locally.* We do not ask the internet
clever questions. We pull the full corpus from stable, unauthenticated APIs and apply all
intelligence to data we already hold.

---

## 2. Product philosophy

A Job Intelligence Agent, not a job board.

```
Traditional                Desired
───────────                ───────
Search                     Wake up
Open 100 tabs              Read today's ranked shortlist
Read descriptions          Review
Close 95 tabs              Personalize
Apply to 5                 Apply
```

Three principles that resolve most design arguments:

1. **Fetch broadly, filter locally.** Network requests are dumb and uniform. All cleverness
   happens in SQL over stored rows, where it is fast, free, and instantly re-runnable.
2. **Keep fragile things out of the hot path.** Anything that can be blocked, rate-limited, or
   broken by a layout change belongs in an asynchronous weekly job whose failure nobody notices.
3. **Store everything, discard nothing.** Postings vanish from ATS endpoints once filled. Data
   not captured today cannot be recovered tomorrow.

---

## 3. Success criteria

V0.1's criteria described the system running rather than the system working, and "reduce manual
search time by 80%" had no baseline. Replaced with countable measures over a 7-day validation:

| # | Criterion | Target | How measured |
|---|---|---|---|
| 1 | Digest arrives daily without intervention | 7/7 days | run log |
| 2 | Precision@10 on the daily digest | ≥ 0.5 | your own Interested/Dismissed taps |
| 3 | Duplicate rate in digest | < 2% | manual review of 7 digests |
| 4 | No job notified twice | 0 repeats | `notified_at` audit |
| 5 | Registry live-rate known and stable | tracked | 404 counts per sweep |
| 6 | Steady-state sweep duration | < 5 min | run log |
| 7 | At least one job you would not have found manually | ≥ 1 | judgment |

Criterion 7 is the real test. Everything else can pass while the product is pointless.

**Explicitly out of scope for V0.1:** submitting applications, generating résumés, writing cover
letters, contacting recruiters.

---

## 4. Architecture

```
                    ┌──────────── weekly ─────────────┐
                    ▼                                 │
            CompanyRegistry ◄─── discover() ◄─── [list refresh · domain probe
              ~15,862 tokens                        · careers sniff · X-Ray]
                    │
                    │ tiered token list
                    ▼
              IngestScheduler          (6h / 12h / 24h by tier)
                    │
                    ▼
            Source Connectors          greenhouse · lever · ashby · (workable · recruitee …)
                    │                  gzip + If-None-Match → 304 short-circuit
                    ▼
             Extraction / Normalize    3 response shapes → 1 Job
                    │
                    ▼
              Deduplication            normalized key, persisted across runs
                    │
                    ▼
                 SQLite                ← ALL jobs stored, unfiltered
                    │
                    ▼
             Filter + Score            per-user, over stored rows
                    │
                    ▼
             Digest (daily 08:00) ──► Telegram ──► feedback buttons ──┐
                    ▲                                                 │
                    └──────────── calibration ◄───────────────────────┘
```

Two properties worth naming:

- **Discovery is decoupled from ingestion.** The hot path touches only stable, unauthenticated,
  ETag-supporting JSON APIs. Everything that can break lives in the weekly job.
- **Storage precedes filtering.** Changing `config.yaml` re-scores the entire corpus in seconds
  instead of triggering a re-crawl, and lets us answer "what did I miss under the old rules?"

---

## 5. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Backend | **NestJS** | Connector-per-source maps cleanly onto modules; DI, scheduling, queues first-class; carries Phases 2–5 |
| Language | **TypeScript**, strict | — |
| Database | **SQLite** (better-sqlite3) | Zero infrastructure; single writer, read-mostly; Postgres path via Drizzle |
| ORM | **Drizzle** | Lightweight, TS-first, SQLite→Postgres migration path |
| HTTP | **Axios** | Must be configured for gzip — see §7.2 |
| Concurrency | **p-limit** (per source) | Not one global pool — see §7.2 |
| Parsing | **Cheerio**; Playwright only if unavoidable | ATS APIs return JSON; HTML parsing should be rare |
| Scheduling | **@nestjs/schedule** | Two independent crons |
| Embeddings | **Transformers.js** + `all-MiniLM-L6-v2` | Runs locally, ONNX, no API cost — Phase 1.5 |
| Vectors | **sqlite-vec** | Preserves zero-infrastructure property |
| Notifications | **Telegram Bot API** | Inline keyboards give us the feedback loop free |
| UI | **Vite + React**, served by Nest via `@nestjs/serve-static` | One process, one deploy |
| Logging | **Pino** | — |
| Validation | **Zod** | Parse ATS responses defensively; they change without notice |

**Deliberately not chosen:** Postgres (premature), Redis (nothing needs it yet), serverless
(can't hold a multi-minute fan-out, no disk for SQLite), a SERP API (not in the hot path anymore).

---

## 6. Data model

The key decision: **shared corpus separated from per-user state.** As a single user you set
`user_id = 1` and never think about it. It costs nothing now and avoids a painful migration if
this becomes a product.

```sql
-- ─────────── SHARED: identical for every user ───────────

CREATE TABLE companies (
  id             INTEGER PRIMARY KEY,
  ats            TEXT NOT NULL,           -- greenhouse | lever | ashby | ...
  token          TEXT NOT NULL,
  name           TEXT,
  tier           INTEGER DEFAULT 2,       -- 0 watchlist · 1 active · 2 long tail
  status         TEXT DEFAULT 'unknown',  -- live | dead | error
  etag           TEXT,                    -- conditional requests
  last_fetched   INTEGER,
  last_success   INTEGER,
  fail_count     INTEGER DEFAULT 0,
  job_count      INTEGER,
  discovered_via TEXT,                    -- seed | xray | domain-probe | manual
  UNIQUE(ats, token)
);

CREATE TABLE jobs (
  id           INTEGER PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id),
  source       TEXT NOT NULL,
  external_id  TEXT,
  title        TEXT NOT NULL,
  location     TEXT,
  remote       INTEGER DEFAULT 0,
  description  TEXT,
  url          TEXT NOT NULL,
  posted_at    INTEGER,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,          -- absent from a sweep ⇒ likely filled
  dedup_key    TEXT NOT NULL,
  raw_payload  TEXT NOT NULL,             -- original JSON, never discard
  UNIQUE(source, external_id)
);
CREATE INDEX idx_jobs_dedup   ON jobs(dedup_key);
CREATE INDEX idx_jobs_posted  ON jobs(posted_at DESC);

-- ─────────── PER USER: your opinion about a job ───────────

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  telegram_chat_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE user_config (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  config_json TEXT NOT NULL,              -- roles, keywords, exclusions, min_score
  updated_at  INTEGER NOT NULL
);

CREATE TABLE user_job_state (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  score       REAL,
  matched     TEXT,                       -- JSON array, for explainability
  missing     TEXT,
  status      TEXT NOT NULL DEFAULT 'discovered',
  notified_at INTEGER,
  feedback_at INTEGER,
  PRIMARY KEY (user_id, job_id)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER, finished_at INTEGER,
  companies_probed INTEGER, companies_live INTEGER, companies_304 INTEGER,
  jobs_found INTEGER, jobs_new INTEGER, bytes_fetched INTEGER,
  errors INTEGER
);
```

### 6.1 Status lifecycle

Explicitly defined, because V0.1's undefined `status` made Phase 5 impossible:

```
discovered → notified → interested → applied → interviewing → offer
                     ↘ dismissed   ↘ rejected              ↘ rejected
```

`discovered → notified` is written by the digest job. Everything after is written by the user
tapping a Telegram button. **No feedback capture means no scoring calibration and no funnel
metrics — this is why it ships in V0.1, not Phase 5.**

---

## 7. Modules

### 7.1 CompanyRegistry — *new, on the critical path*

Everything downstream is blocked on this. ATS endpoints are per-company lookups; there is no
global search and no official directory of board tokens.

```
CompanyRegistry
├── seed()       one-time bootstrap from public token lists
├── validate()   probe; 404 ⇒ dead. weekly
├── discover()   append newly-found tokens from feeders. weekly
└── prioritize() maintain tier assignment. continuous
```

**Seeding.** Public, free, refreshed daily by a third-party GitHub Action:

```
https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/{ats}_companies.json
```

| List | Tokens |
|---|---|
| greenhouse | 8,333 |
| lever | 4,368 |
| ashby | 3,161 |
| **Total** | **15,862** |

Also available: `workday`, `bamboohr`, `icims`, `paylocity` — for later.

**Measured live rate: 54–56%.** Two independent samples (25 and 39 tokens) both landed there.
Roughly half the registry has churned since the lists were built, so the registry **must be
self-pruning**. A 404 is a clean, free signal; three consecutive 404s marks a token dead.

**Tiered polling** — curation applies here, not to the universe:

| Tier | Membership | Cadence |
|---|---|---|
| 0 — watchlist | ~50 companies you'd join tomorrow (manual) | 6 h |
| 1 — active | posted a matching role in last 90 days (auto-promoted) | 12 h |
| 2 — long tail | everyone else | 24 h |
| dead | 3 consecutive 404s | weekly re-probe, then drop |

Auto-promotion from tier 2 to 1 means the registry learns the search space without maintenance.

**Discovery feeders**, in order of yield and reliability:

1. **Public list refresh** — re-pull weekly. Zero cost, unblockable, highest yield. Primary.
2. **Domain probing** — guess tokens from a company's domain slug, probe all three endpoints.
   One request gives a definitive yes/no. Feed it YC exports, HN "Who is Hiring", your network.
3. **Careers-page redirect sniffing** — fetch `example.com/careers`, follow redirects, match
   `greenhouse|lever|ashby|workable` in the final URL.
4. **Google X-Ray** — last resort only. See §7.7.

### 7.2 Fetch layer — *substantially revised*

The bottleneck is not the database. It is **redundant network bytes.**

**Measured baselines:**

| Request | Status | Time | Bytes |
|---|---|---|---|
| Greenhouse `stripe` | 200 | 1.84 s | 325,460 |
| Greenhouse `stripe`, gzip | 200 | — | **27,029** |
| Greenhouse `stripe`, `If-None-Match` | **304** | **0.53 s** | **0** |
| Ashby `ramp` | 200 | **12.00 s** | 65,784 |
| Lever `leverdemo` | 200 | 1.53 s | 11,562 |
| 8 Greenhouse boards, concurrent | all 200 | 4.78 s wall | 1.94 MB |

No throttling appeared at concurrency 8. Greenhouse publishes no hard limit on the Job Board API
— it is cached and effectively unmetered — but the documented guidance is to poll on a schedule
rather than hammer.

**Three mandatory requirements:**

1. **gzip.** Axios does not request it by default in Node. `Accept-Encoding: gzip` is a one-line
   change for a **12× payload reduction**.
2. **ETag conditional requests.** Both Greenhouse and Ashby return ETags. Store `etag` per
   company; send `If-None-Match`; on 304, skip extract/normalize/dedup entirely. Most boards
   don't change between sweeps, so steady state is mostly 304s. **This is the difference between
   a 15-minute and a 2-minute sweep.**
3. **Per-source concurrency pools.** Ashby's 12-second response is 6.5× Greenhouse. A shared
   global pool lets one slow source starve the rest. Suggested: 5–8 per host.

**Resilience.** V0.1 covered connector *failure* but not *latency* — a hanging request never
fails, it blocks forever.

- `AbortController` timeout: 15 s per request, 2 min per source
- Circuit breaker (`opossum`): N consecutive failures ⇒ skip source for the remainder of the run
- Retry with exponential backoff **plus full jitter**, max 2 retries — without jitter, retries
  re-synchronize into a thundering herd
- Per-connector duration and byte metrics into `runs`

**Full-sweep projections** (15,862 tokens, from measured per-request cost):

| | Cold | Steady state (90% 304) |
|---|---|---|
| concurrency 32 | ~15 min | **~2 min** |
| concurrency 64 | ~7 min | ~1 min |

~47 MB gzipped for the entire universe; ~564 MB uncompressed. That delta is requirement 1.

### 7.3 Extraction & normalization

Three response shapes, one `Job`. Verified field paths:

| | Greenhouse | Lever | Ashby |
|---|---|---|---|
| Envelope | `{jobs:[…]}` | bare array | `{jobs:[…]}` |
| Title | `title` | `text` | `title` |
| Location | `location.name` | `categories.location` | `location` |
| URL | `absolute_url` | `hostedUrl` | `jobUrl` |
| Posted | `first_published` | `createdAt` (ms epoch) | `publishedAt` |
| Description | `content` — **requires `?content=true`**, HTML | `descriptionPlain` — free | `descriptionPlain` — free |
| Remote flag | infer from location | `workplaceType` | `isRemote` |

Greenhouse is the odd one out: descriptions cost extra payload. Fetch with `content=true` for
tiers 0–1, without for tier 2, and backfill on demand.

Validate every response with Zod. These are public endpoints with no contract or changelog.

### 7.4 Deduplication

**Tier 1 — normalize, then hash (V0.1 scope).** Exact hashing of raw fields fails on
`Acme` / `Acme, Inc.` and `Remote` / `Remote – US`.

```
company  → lowercase, strip legal suffixes (inc|llc|ltd|gmbh|corp|bv|…), strip punctuation
title    → lowercase, strip parentheticals, strip seniority tokens and roman numerals
location → canonicalize to enum; anything matching remote|anywhere|distributed → "remote"
dedup_key = sha1(company | title | location)
```

**The key must persist across runs.** V0.1 didn't specify this; without it the same job is
re-notified every sweep. `notified_at` on `user_job_state` is the guard.

**Tier 2 — blocking + fuzzy (deferred).** Block on normalized company, trigram-compare titles
above ~0.85. Cheap because blocking keeps candidate sets tiny.

**Tier 3 — near-duplicate detection (deferred).** MinHash + LSH over description shingles for
cross-source duplicates.

Prior art: Engelbach et al., *Combining Embeddings and Domain Knowledge for Job Posting Duplicate
Detection* (LKE 2024) evaluates precisely this problem and finds **no single method is adequate**
— string comparison, embeddings, and keyword matching each underperform alone; the combination
gives a significant boost. Their tool runs in production. That argues for tier 1 + tier 3
together rather than picking one.

### 7.5 Filtering

Reject on title match against a configured exclusion list (`principal`, `staff`, `director`,
`head of`, `c++`, `cobol`, `sap`, `clearance`, …).

Two cautions learned from the prototype:

- **Match on tokens, not substrings.** `staff` matches `Staffing Coordinator`.
- **Don't reject on "10+ years" scraped from description text.** It false-positives on phrases
  like "10+ years of combined team experience." Title-based seniority filtering is noisy enough;
  description-based is worse.

Filtering runs **over stored rows**, so exclusion changes re-apply instantly to the whole corpus.

### 7.6 Scoring — *ambiguity resolved*

V0.1's weights summed to 130 while `minimumScore` was 80 and the digest rendered "95%".
**Empirically, the highest score across 1,081 real postings was 44%.** A threshold of 80 returns
an empty inbox.

**Score is a percentage of what the active config could award:**

```
max   = Σ(keyword weights) + enabled bonuses
raw   = Σ(matched weights)          title hit = full weight
                                    description-only hit = 0.6 × weight
      + 20  remote
      + 10  salary disclosed
      + 10 × (1 − age_days/30)      linear recency decay, 30-day window
score = round(min(raw / max, 1) × 100)
```

Recency decays continuously rather than a flat cliff — a 2-day-old post should outrank a
25-day-old one. Realistic cutoff: **15–40**, not 80. Store `matched` and `missing` so every score
is explainable in the digest.

**Phase 1.5 — hybrid lexical + semantic.** Keyword scoring compares characters, not concepts: it
can't tell that "React Native" ≈ "cross-platform mobile", and can't rank two jobs that match
every keyword. Add an embedding-similarity component between the job description and your
résumé/ideal-role text:

```
score = 0.7 × lexical + 0.3 × semantic
```

Lexical stays dominant — research on job search specifically finds exact terms in title,
location, work mode, and seniority should outweigh semantics, with embeddings used to expand
recall. Runs entirely locally via Transformers.js + `all-MiniLM-L6-v2` (384-dim, ONNX), stored in
`sqlite-vec`. **Zero marginal cost**, and it's the same infrastructure Phase 2's résumé analyzer
needs.

### 7.7 Google X-Ray — demoted

X-Ray moves out of the source layer entirely and becomes a registry feeder. Its value was never
finding jobs — ATS APIs return better data — it was finding *companies*.

```
site:job-boards.greenhouse.io "react native"
site:jobs.lever.co             "react native"
site:jobs.ashbyhq.com          "react native"
```

Parse the token from the URL path, discard the page body, hand the token to the registry. That
company is then served by its proper JSON API permanently.

| | V0.1 | V0.2 |
|---|---|---|
| Volume | 1,000+ queries/week | ~50/week |
| Failure impact | primary source lost | one week's new companies delayed |
| Data quality | scraped HTML | structured JSON via ATS API |
| Cost at ~$0.30/1K | — | **~$0.06/month** |

A 20× volume reduction moves this from "certain to be blocked" to "fits a free tier." If Google
blocks us permanently, feeders 1–3 keep the registry growing.

### 7.8 Notification & feedback

**Digest.** Once daily at 08:00. Top N jobs above cutoff, not yet notified, ranked by score, each
showing company, title, location, age, score, and matched keywords. Stamp `notified_at`.

**Optional urgent path:** immediate alert for scores above a high threshold (≥ 90) where being
early matters.

**Feedback — the part V0.1 was missing.** Telegram inline keyboard on every job:

```
[ Interested ]  [ Applied ]  [ Not for me ]  [ Dismiss company ]
```

One webhook handler writing `user_job_state.status`. This is roughly a day of work and it is
what makes the system improvable: labelled data for scoring calibration, a computable funnel for
Phase 5, and an actual answer to "is this working?"

---

## 8. Scheduling

Two independent crons. V0.1 conflated them — Notify was a terminal pipeline stage on a 6-hour
schedule, which contradicts "notify daily" and would have pinged at midnight.

| Job | Cadence | Does |
|---|---|---|
| **Ingest** | tier-driven: 6 h / 12 h / 24 h | fetch → normalize → dedupe → store |
| **Digest** | daily 08:00 | score unnotified rows → rank → send → stamp |
| **Registry maintenance** | weekly, Sunday 03:00 | validate, prune, discover |

Filtering and scoring run inside the digest job, over stored rows — not during ingest.

---

## 9. Configuration

YAML today, but **accessed through an interface**, not read as a file:

```ts
interface ConfigService {
  getFor(userId: number): Promise<UserConfig>;
}
```

Backed by `config.yaml` now, a `user_config` row later. Ten minutes of work that keeps
multi-tenancy from touching filtering or scoring code.

```yaml
roles:      [React Native Engineer, Frontend Engineer, Software Engineer]
keywords:   { react native: 30, react: 15, typescript: 15, node: 15, nestjs: 15 }
bonuses:    { remote: 20, salary: 10, recent: 10 }
exclude:    [principal, staff, director, head of, cobol, sap, clearance]
locations:  [Remote, Worldwide]
minimumScore: 25        # NOT 80 — see §7.6
digestSize: 15
```

---

## 10. Observability

Per stage: started, completed, duration, item counts, failures, retries.
Per connector: request count, 200/304/404/error split, bytes, p50/p95 latency.
Per run: a `runs` row.

The two health metrics that matter:

- **304 rate** — should exceed 80% in steady state. A drop means caching regressed.
- **Live rate** — should hold near 55%. A sharp fall means an upstream API changed.

---

## 11. Non-functional requirements

V0.1's "complete one run in under 5 minutes for 500 jobs" measured the wrong thing: SQLite and
Cheerio were never the constraint.

| | Requirement |
|---|---|
| **Performance** | p95 steady-state sweep < 5 min for the full registry |
| **Efficiency** | > 80% of requests served as 304 in steady state |
| **Politeness** | ≤ 8 concurrent connections per host; no source polled more than hourly |
| **Reliability** | One connector failing or hanging must not delay or fail the run |
| **Correctness** | No job notified to the same user twice |
| **Maintainability** | Every connector isolated behind `JobSource`; all rules config-driven |
| **Recoverability** | Raw payloads retained; any run reproducible from stored data |

---

## 12. Deployment & cost

| Phase | Where | Cost |
|---|---|---|
| **Validation** (now) | local machine, SQLite on disk | **$0** |
| **Personal use** | Oracle Cloud Always Free — 2 ARM cores / 12 GB / 200 GB | **$0** |
| **Product** | same, + Cloudflare for CDN/tunnel/TLS | **$0** until real traffic |

Oracle's Always Free A1 allocation was halved in June 2026 (from 4 cores / 24 GB); even halved
it is far more machine than this needs. Caveats: A1 capacity is scarce in popular regions
(Frankfurt and Singapore provision readily), and idle instances have been reclaimed — keep
backups.

**Not viable:** serverless for the pipeline. Function timeouts cannot hold a multi-minute
fan-out, and SQLite has nowhere to live. Cloudflare Workers' 10 ms CPU limit and D1's 100k
writes/day are both fine for serving the UI and useless for the sweep.

### 12.1 Product economics

Worth stating because it should shape the roadmap:

**Ingest cost is fixed; it does not scale with users.** We sweep 15,862 companies whether there
is one user or ten thousand — the corpus is identical for everyone. Only filtering and scoring
are per-user, and those are milliseconds of SQL over shared rows.

```
FIXED    the sweep — ~47 MB, ~2 min, one machine
PER USER filter + score  → ≈ $0
         generative AI   → real per-call cost
```

This supports a genuinely complete free tier, and draws the paid line exactly where costs are:
free = filter/score/digest/tracking plus local embeddings; paid = résumé analysis, company
briefs, outreach drafts. Keep generative calls out of any free hot path.

---

## 13. Prototype validation

A browser-only prototype (`test/`) implements the full pipeline. Run 2026-08-03, 30 random
companies plus a 3-company watchlist:

```
probed           39
live             21   (54%)
dead / 404       18
jobs found     1081
after dedupe   1054
after filter    952
above cutoff    159
elapsed        30.2s
```

Top match: `React Native Engineer, Merchant Experience Mobile` — Stripe. From a random draw.

**What it confirmed:** the registry approach works; the three normalizers are correct; live rate
holds at ~54%; CORS is open on all four endpoints (`Access-Control-Allow-Origin: *`), so a
browser client is viable for the UI.

**What it caught:** `minimumScore: 80` would have returned zero results. Found in an afternoon
rather than after building the notification layer.

---

## 14. Implementation order

**Blocking — nothing else starts without these:**

1. `companies` table + `seed()` from the three public lists (~15,862 rows)
2. `validate()` sweep; establish the live-rate baseline
3. Fetch layer: gzip, ETag, per-source pools, timeouts, circuit breaker

**V0.1 scope:**

4. Normalizers for the three ATS platforms, Zod-validated
5. Normalized persistent `dedup_key`
6. Storage with raw payloads retained
7. Tiered ingest scheduler
8. Filter + score over stored rows, percentage-normalized
9. Daily digest + **feedback buttons**
10. React UI served by Nest — a filterable ranked table, nothing more

**Phase 1.5:** semantic scoring, MinHash dedup, weekly discovery feeders.

**Deferred:** résumé analyzer (P2), company intelligence (P3), outreach assistant (P4), dashboard
metrics (P5). All additive; none change the schema materially — provided step 9 ships, since
P5's funnel metrics are computed from feedback data.

---

## 15. Risks & open questions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ATS changes response shape without notice | medium | high | Zod validation, per-connector alerts, raw payloads let us reprocess |
| Public token list is abandoned | low | medium | We hold a local copy; feeders 2–3 keep it growing |
| Registry live-rate degrades sharply | medium | medium | Tracked per sweep; triggers investigation |
| Greenhouse begins rate-limiting | low | medium | Already polite; ETag cuts volume ~90%; back off per tier |
| Scoring never gets good enough | **medium** | **high** | Feedback loop from day one; precision@10 is criterion 2 |
| Redistribution rights for a product | medium | high | See below |

**Open — legal.** Reading public ATS endpoints for personal use is uncontroversial.
Republishing to paying customers is a distinct question. Individual postings are largely factual
and short titles generally lack copyright protection, but compilations can carry it, and terms of
service are separate exposure. These three endpoints are *intended* for distribution, which
likely helps. **Not a blocker for V0.1** — resolve before taking money, with counsel.

**Open — technical.** Whether tier-2 companies need descriptions at all, or whether title-only
scoring plus on-demand backfill is sufficient. Cheap to test once the corpus exists.

---

## Appendix A — measured baselines

All figures 2026-08-03, from a Linux host.

```bash
# per-source latency and payload
for u in "https://boards-api.greenhouse.io/v1/boards/stripe/jobs" \
         "https://api.lever.co/v0/postings/leverdemo?mode=json" \
         "https://api.ashbyhq.com/posting-api/job-board/ramp"; do
  curl -s -o /dev/null -w "$u %{http_code} %{time_total}s %{size_download}b\n" "$u"
done

# concurrency behaviour — watch for 429s
time ( for c in stripe airbnb dropbox coinbase robinhood databricks figma reddit; do
  curl -s -o /dev/null -w "$c %{http_code} %{time_total}s %{size_download}b\n" \
    "https://boards-api.greenhouse.io/v1/boards/$c/jobs" &
done; wait )

# gzip saving
curl -s -o /dev/null -w "plain %{size_download}\n" URL
curl -s -H "Accept-Encoding: gzip" -o /dev/null -w "gzip  %{size_download}\n" URL

# ETag → 304
ET=$(curl -sI URL | grep -i '^etag:' | sed 's/^[Ee][Tt][Aa][Gg]: //' | tr -d '\r')
curl -s -o /dev/null -w "%{http_code} %{size_download}b\n" -H "If-None-Match: $ET" URL

# registry seed + live-rate sample
for f in greenhouse lever ashby; do
  curl -sL -o $f.json \
   "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/${f}_companies.json"
done
```

## Appendix B — verified endpoint reference

All public, unauthenticated, `Access-Control-Allow-Origin: *`:

```
GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs[?content=true]
GET https://api.lever.co/v0/postings/{token}?mode=json
GET https://api.ashbyhq.com/posting-api/job-board/{token}[?includeCompensation=true]
```

Same pattern available for later expansion: Workable, Recruitee, Personio, SmartRecruiters,
Teamtailor.

## Appendix C — reference documents

| Document | Contents |
|---|---|
| `BOTTLENECKS.md` | Eight bottlenecks with measurements and researched solutions |
| `REGISTRY-DESIGN.md` | Registry inversion and X-Ray demotion in depth |
| `EXPLAINED.md` | Plain-language version of both |
| `DEPLOYMENT.md` | Hosting options and cost comparison |
| `PRODUCT-PATH.md` | Free-tier hosting, product economics, irreversible decisions |
| `test/` | Working browser prototype and headless verifier |

## Appendix D — sources

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [6 ATS Platforms with Public Job Posting APIs](https://fantastic.jobs/article/ats-with-api)
- [Greenhouse API: no public board directory](https://jobspipe.dev/blog/greenhouse-api-jobs)
- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) — token lists
- [Engelbach et al., Job Posting Duplicate Detection](https://arxiv.org/abs/2406.06257) — LKE 2024
- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — local embeddings
- [Oracle Cloud free tier 2026 changes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/)
- [Cloudflare Workers free tier 2026](https://agentdeals.dev/vendor/cloudflare-workers)
- [Best SERP APIs 2026](https://cloro.dev/blog/best_serp_apis/)
