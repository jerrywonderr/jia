# Job Intelligence Agent — Bottleneck Analysis & Solutions

Companion to *Job Intelligence Agent, Technical Design Document (V0.1 MVP)*.
Date: 2026-08-03

All latency/payload numbers below were measured live against the real endpoints from a
sandboxed Linux host, not estimated. Reproduction commands are in Appendix A.

---

## Summary table

| # | Bottleneck | Severity | Fix |
|---|---|---|---|
| 1 | No company universe — ATS APIs are per-company, not searchable | **Blocker** | Seed + maintain a board-token registry; add a discovery job |
| 2 | Network fan-out volume (~125 MB/run uncompressed) | High | gzip + ETag conditional requests → ~99% reduction |
| 3 | Ashby tail latency (12 s single request) | High | Per-source concurrency pools, timeouts, circuit breaker |
| 4 | Google X-Ray will be CAPTCHA'd | High | Demote to optional; use a SERP API or drop it |
| 5 | Exact-hash dedup misses near-duplicates | Medium | Normalize → blocking key → trigram/embedding tiebreak |
| 6 | Keyword scoring is uncalibrated and ambiguous | Medium | Normalize to %, add lexical+semantic hybrid |
| 7 | No feedback capture → scoring can never improve | Medium | Telegram inline buttons writing back to `status` |
| 8 | Notify runs 4×/day but criteria say daily | Low | Split digest from ingest schedule |

---

## 1. Company universe — the actual blocker

**The problem.** The design lists Greenhouse, Lever, Ashby, and Wellfound as connectors and
gives the Search Module `roles / keywords / locations` as input. But these ATS endpoints are
*per-company and unsearchable*:

```
GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
GET https://api.lever.co/v0/postings/{token}?mode=json
GET https://api.ashbyhq.com/posting-api/job-board/{token}
```

Greenhouse and Ashby both state plainly that filtering/searching is not possible on these
endpoints. You cannot ask "who is hiring a React Native engineer" — you can only ask "what is
Stripe hiring for." So the pipeline needs a **company universe** to iterate, and the design has
no module that produces one. Everything downstream is gated on this.

There is also **no official directory** of Greenhouse board tokens; the population is roughly
12,000 companies and it churns weekly.

**Solutions, cheapest first:**

- **Seed manually (do this for V0.1).** 200–500 hand-picked companies you'd actually work for.
  Store as `companies.yaml` with `ats:token` pairs (`greenhouse:stripe`, `lever:leverdemo`,
  `ashby:ramp`). This is a better product than a broad crawl anyway — it encodes your taste,
  and taste is the whole value proposition.
- **Bootstrap from public sources.** The [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator)
  repo indexes 1M+ positions across 20k+ companies on Greenhouse/Lever/Ashby/Workday with a
  daily GitHub Actions refresh — usable as a seed list.
- **Token discovery job.** Weekly crawl that resolves company domains → career page → detects
  ATS by URL pattern, appends new tokens. Cheap, incremental, yours.
- **Buy breadth.** [Fantastic.jobs](https://fantastic.jobs/api) (54 ATS platforms, one API) or
  [Apify's ATS Company Discovery](https://apify.com/wickfeed/ats-company-discovery) if you'd
  rather not maintain the registry.

**Design change:** add a `CompanyRegistry` module upstream of Search. Search emits tasks as the
cross product of *registry × config*, not of *keywords × sources*.

**Widen the net cheaply:** the same public-unauthenticated pattern exists for Workable,
Recruitee, SmartRecruiters, Personio, and Teamtailor. Adding a connector is ~30 lines once
`JobSource` exists.

---

## 2. Network fan-out — the real throughput constraint

**Measured, live:**

| Request | Status | Time | Bytes |
|---|---|---|---|
| Greenhouse `stripe` | 200 | 1.84 s | 325,460 |
| Ashby `ramp` | 200 | **12.00 s** | 65,784 |
| Lever `leverdemo` | 200 | 1.53 s | 11,562 |
| 8 Greenhouse boards, concurrent | all 200 | **4.78 s wall** | ~1.94 MB |

No rate limiting or throttling appeared at concurrency 8. Greenhouse does not publish a hard
limit on the Job Board API — it's cached and effectively unmetered — but the guidance is to
poll on a schedule rather than hammer.

**Extrapolated:** 500 companies at ~250 KB average = **~125 MB per run, 4 runs/day = 500 MB/day**
of mostly-unchanged JSON. That, not SQLite, is what breaks the "5 minutes for 500 jobs" NFR.

**Two fixes, both verified working:**

**gzip — 12× reduction.** Neither Axios nor curl sends `Accept-Encoding: gzip` by default here:

```
no-gzip  325,460 bytes
gzip      27,029 bytes    ← same payload
```

**ETag conditional requests — ~100% reduction on unchanged boards.** Both Greenhouse and Ashby
return ETags:

```
etag: W/"ad9d11f810aee5feb36f64b61e6c6ceb"          (Greenhouse)
etag: W/"job-board:0a9da5ad67c1e2..."                (Ashby)

→ replay with If-None-Match:
   http=304  bytes=0  t=0.53s
```

Store `etag` per company row; send `If-None-Match`; skip the entire extract/normalize/dedup
path on 304. Most boards don't change between 6-hour runs, so in steady state you'll 304 on the
large majority of requests. **This single change is the difference between a 5-minute run and a
20-second run.** It is not in the current design and should be.

**Revised NFR:** drop "500 jobs in 5 minutes" (SQLite and Cheerio were never the constraint) and
replace with: *p95 full run < 90 s for 500 companies; > 80% of requests served as 304 in steady
state; no source exceeds 5 concurrent connections.*

---

## 3. Tail latency and connector isolation

Ashby took **12 seconds for a single request** — 6.5× Greenhouse. With a naive sequential loop
or a shared global concurrency pool, one slow source starves the rest.

The doc's error handling ("Google failed → continue → Lever → continue") describes *failure*
isolation but not *latency* isolation. A hanging connector with no timeout doesn't fail — it
just blocks forever.

**Fix:**

- Per-source concurrency pools (`p-limit` / NestJS BullMQ), not one global pool. Suggested: 5–8
  per host.
- Hard `AbortController` timeout per request (10 s) and per source (2 min).
- Circuit breaker: N consecutive failures → skip that source for the rest of the run, log, keep
  going. `opossum` handles this if you don't want to write it.
- Retry with exponential backoff + full jitter, capped at 2 retries. Jitter matters — without it
  you re-synchronize every retry into a thundering herd.
- Emit per-source duration metrics; the doc already asks for stage logging, extend it to
  per-connector.

---

## 4. Google X-Ray

Google has no official search API and actively blocks automated querying. At 4 runs/day you'll
be CAPTCHA'd within days, and the architecture diagram currently gives X-Ray equal billing with
the ATS connectors.

**Options:**

- **Drop it from V0.1.** ATS connectors give you higher-quality structured data. X-Ray is a
  discovery mechanism for *companies you don't know about* — which is a Phase 2 concern, not an
  MVP one.
- **Repurpose it for the registry.** Its real value is finding new board tokens
  (`site:boards.greenhouse.io "react native"`), not finding jobs. Run it weekly as part of the
  discovery job, not 4×/day in the hot path.
- **Pay for a SERP API if you keep it.** Serper is ~$0.30/1K queries; SerpApi runs
  $25/mo for 1,000 up to $275/mo for 30,000, with no pay-as-you-go and hard failure at the plan
  cap. Brave Search API is $3–5/1K but is genuinely independent index, not Google's.

Given weekly registry use, even the cheapest tier is ample.

---

## 5. Deduplication

`hash(company + title + location)` exact-matched will not catch:

- `Acme Inc` / `Acme, Inc.` / `Acme`
- `Senior React Native Engineer` / `React Native Engineer (Senior)`
- `Remote` / `Remote - US` / `Remote (Worldwide)`

And critically — the doc doesn't say the hash **persists across runs**. Without a stored dedup
key, the same job gets re-notified every 6 hours.

**Fix — three tiers, in order of cost:**

1. **Normalize before hashing.** Lowercase; strip legal suffixes (Inc/Ltd/GmbH/LLC/Corp);
   strip punctuation; canonicalize location to an enum; strip seniority tokens into a separate
   field rather than leaving them in the title. This alone catches most of it.
2. **Blocking key + fuzzy compare.** Block on normalized company, then trigram-similarity
   (`fast-levenshtein` / `string-similarity`) on title above ~0.85. Cheap because blocking keeps
   the candidate set tiny.
3. **Near-duplicate detection on description** for cross-source dupes, via MinHash + LSH over
   character shingles — the standard approach and far better than byte-exact.

The directly relevant research: [Engelbach et al., *Combining Embeddings and Domain Knowledge
for Job Posting Duplicate Detection*](https://arxiv.org/abs/2406.06257) (LKE 2024) evaluates
exactly this problem and finds that **no single method is adequate** — string comparison alone,
embeddings alone, and keyword matching alone all underperform, while the *combination* of
character-overlap similarity + deep embeddings + curated weighted skill lookup lists gives a
significant boost. Their tool is in production. That is a strong argument for tier 1 + tier 3
together rather than picking one.

**Also:** persist `dedupKey` and `notifiedAt` on the Jobs row. Dedup is a cross-run concern, not
a within-run one.

---

## 6. Scoring

**Ambiguity to resolve first.** The example weights sum to 130, `minimumScore` is 80, and the
notification renders "95%". Raw points or percentage? If raw with an 80 threshold, you need
nearly a perfect keyword sweep and your inbox will be empty. Define score as *percentage of
maximum achievable score for the active config* so the threshold survives config edits.

**Structural weakness.** Pure keyword weighting compares characters, not concepts — it can't
tell that "React Native" ≈ "cross-platform mobile" or that "Node" ≈ "backend JavaScript". It
also can't rank two jobs that both match every keyword.

**Fix — hybrid lexical + semantic, and keep it local:**

- Keep the weighted keyword score as the **lexical** component and weight it *higher*. Research
  on job search specifically finds exact terms in title, location, work mode, and seniority
  should dominate, with semantics used to expand recall beyond exact overlap.
- Add a **semantic** component: embed the job description and your résumé/ideal-role text,
  score by cosine similarity. Runs fully locally in Node —
  [Transformers.js](https://huggingface.co/Xenova/all-MiniLM-L6-v2) with `all-MiniLM-L6-v2`
  (384-dim, ONNX runtime, no API calls, no cost). Store vectors with `sqlite-vec`, which keeps
  the zero-infrastructure property the design correctly prizes.
- Final score = `0.7 × lexical + 0.3 × semantic`, then calibrate the weights against your own
  feedback data once you have some (see §7).

Transformer-based résumé–JD matching reports ~89% accuracy/F1 in the literature, so this is
well-trodden. It's also a natural home for the Phase 2 Resume Analyzer — the embedding
infrastructure is the same, which means adding it later costs almost nothing.

**Add recency decay.** Flat "+10 recently posted" should be a continuous decay; application
response rates fall off sharply with posting age, and a 2-day-old post is meaningfully better
than a 13-day-old one.

---

## 7. No feedback loop

The Jobs table has a `status` column with no defined values and no mechanism to set it. Since
applying is manual, nothing in the MVP ever writes it. Consequences:

- Scoring weights can never be calibrated — you have no labels.
- Phase 5's Interview Rate / Response Rate / Jobs Applied metrics are **not computable** from
  anything V0.1 records.
- Success criterion "reduce manual search time by 80%" has no baseline and can't be evaluated on
  day 7.

**Fix (small, high leverage — pull it into V0.1):** Telegram inline keyboard buttons on each
notified job — `Interested / Applied / Dismissed / Not relevant`. One webhook handler writing
back to `status`. Define the enum explicitly:
`discovered → notified → interested → applied → interviewing → rejected / offer / dismissed`.

That gives you labeled training data from day one, makes Phase 5 possible, and turns "did this
work?" into a countable question. Replace the 80% criterion with something measurable:
*precision@10 on the daily digest ≥ 0.5, judged by your own Interested/Dismissed taps.*

---

## 8. Notification cadence

The pipeline has Notify as an unconditional terminal stage and the scheduler runs at
00:00/06:00/12:00/18:00 — that's four pings a day, but success criteria say "notify the user
daily." Also, a 00:00 notification is a bad idea.

**Fix:** decouple. Ingest on the 6-hour cron; notify on a separate daily cron (say 08:00) that
reads unnotified rows above `minimumScore`, ranks, sends one digest, stamps `notifiedAt`. Add an
optional immediate-alert path for scores above a high threshold (say 95%) where being early
actually matters.

---

## Recommended sequencing

**Before writing code:** resolve §1 (company registry) and §6's score-units ambiguity. Both are
design decisions that change module boundaries.

**In V0.1:** §2 (gzip + ETag — trivial to add up front, painful to retrofit), §3 (per-source
pools + timeouts), §5 tier 1 (normalized persistent dedup key), §7 (feedback buttons), §8
(split schedules).

**Defer:** §5 tier 3 (MinHash), §6 semantic scoring. Both are additive and neither changes the
schema much — but note that §7 must ship in V0.1 or §6's calibration has nothing to learn from.

**Drop:** §4 Google X-Ray from the hot path.

---

## Appendix A — reproducing the measurements

```bash
# latency / payload per source
for u in "https://boards-api.greenhouse.io/v1/boards/stripe/jobs" \
         "https://api.lever.co/v0/postings/leverdemo?mode=json" \
         "https://api.ashbyhq.com/posting-api/job-board/ramp"; do
  curl -s -o /dev/null -w "$u %{http_code} %{time_total}s %{size_download}b\n" "$u"
done

# concurrency behaviour (8 parallel, watch for 429s)
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
```

## Appendix B — sources

- [Greenhouse Job Board API](https://developers.greenhouse.io/job-board.html) — official docs
- [Ashby Public Job Posting API](https://developers.ashbyhq.com/docs/public-job-posting-api) — official docs
- [6 ATS Platforms with Public Job Posting APIs](https://fantastic.jobs/article/ats-with-api) — endpoint reference for Ashby, Greenhouse, Lever, Personio, Recruitee, Workable
- [Greenhouse API: pull job postings from any Greenhouse board](https://jobspipe.dev/blog/greenhouse-api-jobs) — board-token structure, no public directory
- [Greenhouse API: every public job board, one key](https://jobspipe.dev/sources/greenhouse) — rate-limit guidance
- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) — open dataset, 20k+ companies
- [ATS Company Discovery](https://apify.com/wickfeed/ats-company-discovery) — commercial token discovery
- [Fantastic.jobs API](https://fantastic.jobs/api) — commercial multi-source aggregator
- [Engelbach et al., Combining Embeddings and Domain Knowledge for Job Posting Duplicate Detection](https://arxiv.org/abs/2406.06257) — LKE 2024
- [Near-duplicate Detection with LSH and Datasketch](https://yorko.github.io/2023/practical-near-dup-detection/) — MinHash/LSH practicum
- [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) — local ONNX embeddings for Node
- [Building Semantic Search with Transformers.js](https://machinelearningmastery.com/building-semantic-search-with-transformers-js-and-sentence-embeddings/) — Node implementation
- [Best SERP APIs 2026](https://cloro.dev/blog/best_serp_apis/) and [SerpApi alternatives](https://scrape.do/blog/serpapi-alternatives/) — SERP pricing
- [HTTP conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests) — MDN, ETag semantics
