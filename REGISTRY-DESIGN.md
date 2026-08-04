# Solving the Two Critical Gaps: Company Registry & Source Demotion

Addendum to *Job Intelligence Agent, TDD V0.1*. Supersedes the Search Module as specified.
Date: 2026-08-03

**Both problems have one solution.** They look separate — "where do companies come from" and
"Google will block us" — but they collapse into a single module, because X-Ray's real job was
never finding jobs. It was finding *companies*. Once you see that, #2 stops being a problem and
becomes the answer to #1.

---

## The core inversion

The current design is **search-shaped**: keywords go in, matching jobs come out. That model is
borrowed from Google and it does not fit the ATS APIs, which are unsearchable by design.

Replace it with a **registry-shaped** pipeline:

```
BEFORE (search-shaped — impossible on ATS APIs)
  roles + keywords + locations → Search Tasks → Sources → matching jobs

AFTER (registry-shaped)
  CompanyRegistry (N tokens) → fetch ALL jobs → filter locally in SQLite → matches
```

The consequence that makes everything else easy: **filtering moves from the query to the
database.** You stop trying to ask the network a clever question. You pull everything the
registry knows about, cheaply, and run your keyword/score/exclusion logic over local rows.
Config changes then re-filter instantly against data you already have, instead of triggering a
fresh crawl.

`SearchModule` disappears. `CompanyRegistry` + `IngestScheduler` replace it.

---

## Problem 1: Where the company list comes from

### It's already solved — the list is free and public

I checked, and you don't need to build a seed list. The
[job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) repo publishes raw
token arrays, refreshed daily by GitHub Actions:

| File | Tokens |
|---|---|
| `data/greenhouse_companies.json` | 8,333 |
| `data/lever_companies.json` | 4,368 |
| `data/ashby_companies.json` | 3,161 |
| **Total** | **15,862** |
| *(also available)* | `workday`, `bamboohr`, `icims`, `paylocity` |

Format is a flat JSON array of tokens — `["0x", "100x", "15five", ...]` — which drops straight
into a `companies` table. Fetch:

```
https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/greenhouse_companies.json
```

### I validated the tokens — 56% are live

25 random Greenhouse tokens, probed concurrently:

```
14/25 → HTTP 200   (56% live, 1–801 jobs each)
11/25 → HTTP 404   (44% dead — churned since the list was built)
25 tokens, concurrency 8, gzip: 5.6 s wall
```

The 44% dead rate is the important number. It tells you the registry **must be self-pruning** —
a static seed list rots fast. But 404 is a clean, free signal: one request tells you a token is
dead. Pruning is nearly free.

### The whole universe is tractable — don't curate

I previously suggested hand-picking a few hundred companies. The measurements say that's
unnecessarily timid:

| | Cold sweep | Steady state (90% ETag 304s) |
|---|---|---|
| concurrency 8 | 59 min | — |
| concurrency 32 | 15 min | **~2 min** |
| concurrency 64 | 7 min | ~1 min |

Payload for a full 15,862-token sweep: **~47 MB gzipped** (~564 MB uncompressed — which is
exactly why §2 of BOTTLENECKS.md matters). Average live board is 5.2 KB gzipped.

So: 15,862 companies is a *small* number. Sweep the entire universe every 6 hours, filter
locally. You get coverage no curated list can match, and you find roles at companies you'd never
have thought to add.

Keep curation as a **priority tier**, not as the universe — see below.

### Module design

```
CompanyRegistry
├── seed()      — bootstrap from public token lists (one-time, ~16k rows)
├── validate()  — probe; 404 → dead, 200 → live; prune/revive  (weekly)
├── discover()  — append newly-found tokens from feeders       (weekly)
└── prioritize()— assign each company a tier                    (continuous)
```

**Schema:**

```sql
CREATE TABLE companies (
  id           INTEGER PRIMARY KEY,
  ats          TEXT NOT NULL,          -- greenhouse | lever | ashby | workable | ...
  token        TEXT NOT NULL,
  name         TEXT,
  tier         INTEGER DEFAULT 2,      -- 0 = watchlist, 1 = active, 2 = long tail
  status       TEXT DEFAULT 'unknown', -- live | dead | error
  etag         TEXT,                   -- §2 BOTTLENECKS: conditional requests
  last_fetched INTEGER,
  last_success INTEGER,
  fail_count   INTEGER DEFAULT 0,
  job_count    INTEGER,
  discovered_via TEXT,                 -- seed | xray | domain-probe | manual
  UNIQUE(ats, token)
);
```

**Tiered polling** — this is where curation earns its keep, and it keeps the hot path fast:

| Tier | Who | Cadence |
|---|---|---|
| 0 — watchlist | companies you'd take a job at tomorrow (~50, manual) | every 6 h |
| 1 — active | posted a matching role in the last 90 days (auto-promoted) | every 12 h |
| 2 — long tail | everyone else | daily |
| dead | 3 consecutive 404s | weekly re-probe, then drop |

Tier 0 gives you low latency where it matters. Tier 2 gives you coverage. Auto-promotion from 2
to 1 means the registry learns your search space over time without you maintaining it.

---

## Problem 2: Google X-Ray

### Don't fix it — repurpose it

X-Ray is currently drawn as a peer of the ATS connectors, emitting jobs, running 4×/day. That's
the configuration that gets it banned, and it's also the configuration where it adds least
value: ATS APIs already return clean structured JSON, and X-Ray returns HTML you have to guess
at.

**Move it out of the source layer entirely and make it a registry feeder.**

```
BEFORE:  Scheduler → [Google X-Ray, Greenhouse, Lever, Ashby] → jobs
                          ↑ 4×/day, scrapes SERPs, gets banned

AFTER:   Scheduler → [Greenhouse, Lever, Ashby, ...] → jobs
                                  ↑ fed by
         Weekly ──→ CompanyRegistry.discover() ──→ [X-Ray, domain probe, feeds]
                          ↑ ~50 queries/week, finds tokens not jobs
```

Query shape changes from "find me jobs" to "find me boards":

```
site:job-boards.greenhouse.io  "react native"
site:jobs.lever.co             "react native"
site:jobs.ashbyhq.com          "react native"
```

You parse the *URL path segment* for the token, discard the page content, and hand the token to
the registry. The ATS API then returns proper structured data for that company — forever, with
no further scraping.

### Why this makes the problem disappear

| | Before | After |
|---|---|---|
| Queries | 4×/day × N roles ≈ **1,000+/week** | ~50/week |
| Failure mode | pipeline loses a primary source | one week's new companies delayed |
| Data quality | scraped HTML, guessy | structured JSON via ATS API |
| Cost at [Serper](https://cloro.dev/blog/best_serp_apis/) ~$0.30/1K | ~$1.30/mo *if it worked* | **~$0.06/mo** |
| Cost at SerpApi $25/mo/1K | over budget | comfortably inside the smallest tier |

A ~20× reduction in query volume moves you from "will be CAPTCHA'd in a week" to "fits in a free
tier." And because discovery is asynchronous and idempotent, a blocked week costs you nothing —
you retry next Monday. That is what "best-effort garnish" should mean structurally, not just as
a label.

### Better feeders that never touch Google

X-Ray shouldn't be the only discovery channel, and it's the weakest one:

1. **Public list refresh (primary).** Re-pull the token lists weekly. They're maintained daily
   by someone else's GitHub Action. Zero cost, zero blocking risk, highest yield.
2. **Domain probing.** For any company you can name, guess tokens from the domain slug and probe
   the three ATS endpoints. 404 or 200 answers definitively in one request. Feed it YC's public
   company export, Wellfound, your LinkedIn network, portfolio pages of VCs you like.
3. **Careers-page redirect sniffing.** Fetch `example.com/careers`, follow redirects, regex the
   final URL for `greenhouse|lever|ashby|workable`. Catches companies that embed rather than
   link.
4. **Job-board RSS/JSON feeds.** RemoteOK, Himalayas, Arbeitnow, Hacker News "Who is Hiring"
   monthly threads — mine for company names, then domain-probe. HN in particular is high-signal
   for the kind of role in your config.
5. **X-Ray (last resort).** Only for roles the above missed.

Feeders 1–4 involve no adversarial scraping. If Google blocks you permanently, the registry
still grows.

---

## Revised architecture

```
                    ┌─── weekly ───────────────────────┐
                    ▼                                  │
            CompanyRegistry ◄── discover() ◄── [list refresh, domain probe,
              (~16k tokens)                      careers sniff, feeds, X-Ray]
                    │
                    │ tiered token list
                    ▼
              IngestScheduler  (6h / 12h / 24h by tier)
                    │
                    ▼
         Source Connectors  [greenhouse | lever | ashby | workable | ...]
                    │        gzip + If-None-Match → 304 skip
                    ▼
              Extraction → Normalize → Dedup
                    │
                    ▼
                 SQLite  (all jobs, unfiltered)
                    │
                    ▼
          Filter + Score  ◄── config.yaml (runs locally, instantly re-runnable)
                    │
                    ▼
            Daily digest → Telegram
```

Two properties worth calling out:

- **Store unfiltered, filter on read.** Keep every job you fetch. Filtering is a cheap local
  query, so tweaking `config.yaml` re-scores your whole corpus in seconds instead of triggering
  a re-crawl. It also means you can answer "what did I miss last month after loosening this
  rule?" — impossible if you discard at ingest.
- **Discovery is decoupled from ingestion.** The hot path touches only stable, unauthenticated,
  ETag-supporting JSON APIs. Everything fragile lives in a weekly job whose failure is invisible.

---

## Implementation order

1. `companies` table + `seed()` from the three public lists — **~16k rows, one afternoon**
2. `validate()` sweep; mark dead tokens — establishes the 56%-live baseline
3. Fetch layer: gzip + ETag + per-source concurrency pools (BOTTLENECKS §2, §3)
4. Tiered scheduler; everything starts at tier 2, tier 0 hand-picked
5. Local filter/score over stored rows
6. `discover()` weekly job — feeders 1 and 2 only
7. X-Ray feeder, *if* 1 and 2 leave gaps

Steps 1–5 are the MVP. Steps 6–7 are growth. Note that step 1 alone gives you more company
coverage than the original design would have reached at any point.

---

## Appendix — verification commands

```bash
# pull the seed lists
for f in greenhouse lever ashby; do
  curl -sL -o $f.json \
    "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data/${f}_companies.json"
  python3 -c "import json;print('$f', len(json.load(open('$f.json'))))"
done

# validate a random sample (live-rate baseline)
python3 -c "
import json,random; random.seed(7)
print('\n'.join(random.sample(json.load(open('greenhouse.json')),25)))" > sample.txt

cat sample.txt | xargs -P 8 -I{} sh -c \
  'curl -s -H "Accept-Encoding: gzip" -o /dev/null \
     -w "{} %{http_code} %{size_download}b\n" \
     "https://boards-api.greenhouse.io/v1/boards/{}/jobs"'
```

Measured 2026-08-03: 14/25 live (56%), 5.6 s wall at concurrency 8, avg 5.2 KB gzipped per live
board.

## Sources

- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) — public token lists, daily refresh
- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html)
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [6 ATS Platforms with Public Job Posting APIs](https://fantastic.jobs/article/ats-with-api) — Lever/Workable/Recruitee/Personio endpoints
- [Greenhouse API: pull job postings from any Greenhouse board](https://jobspipe.dev/blog/greenhouse-api-jobs) — no public token directory, ~12k churning boards
- [Best SERP APIs 2026](https://cloro.dev/blog/best_serp_apis/) — Serper/SerpApi pricing
