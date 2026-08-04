# Free Hosting, and the Path from Tool to Product

Follows `DEPLOYMENT.md`. Written for: comfortable with NestJS, testing locally first, wants to
turn this into a product with AI features if it works.
Prices and free tiers checked 2026-08-03.

---

## Part 1: Yes, you can run this free — indefinitely

### Oracle Cloud Always Free is the standout

Free forever, no credit expiry, no spin-down:

- **2 ARM cores (Ampere A1) / 12 GB RAM / 200 GB storage**
- Plus 2 small AMD instances, 10 TB/mo egress

That was 4 cores / 24 GB until Oracle halved the Always Free A1 allocation in June 2026.
Even halved, it is *far* more machine than this workload needs, and it's genuinely free rather
than trial credits.

**Two honest caveats:**

- **Capacity.** A1 instances frequently return "out of host capacity" in popular regions. US
  East is notoriously hard; Frankfurt and Singapore usually provision in minutes. People script
  a retry loop against the create endpoint.
- **Oracle is Oracle.** Enforcement of the new limits is reportedly inconsistent, and there are
  scattered reports of idle free instances being reclaimed. Keep backups and don't make it the
  only copy of anything.

For a NestJS app + SQLite + a React bundle, this comfortably runs your entire product at
**$0/month** well past your first users.

### The rest of the free stack

| Piece | Free tier | Fits? |
|---|---|---|
| **Oracle Always Free** | 2 ARM cores, 12 GB, 200 GB | ✅ pipeline + API + UI + DB |
| **GitHub Actions** | unlimited (public) / 2,000 min per month (private) | ✅ ~240 min/mo needed |
| **Cloudflare Pages** | static hosting, 500 builds/mo | ✅ the UI |
| **Cloudflare Tunnel** | free | ✅ expose the box, no open ports |
| **Cloudflare Workers** | 100k req/day, **10 ms CPU** | ⚠️ UI/API only — can't run the sweep |
| **Cloudflare D1** | 5 GB, 5M row reads/day, **100k writes/day** | ⚠️ write cap bites a job pipeline |
| **Turso** | 5 GB, 500M row reads/mo | ✅ if you need networked SQLite |

Note the two ⚠️ rows. Cloudflare's compute is excellent for serving a UI and useless for your
sweep — 10 ms of CPU per invocation isn't in the same universe as a 2-minute fan-out. And D1's
100k writes/day is a real ceiling when a single sweep can write tens of thousands of job rows.
**Serve the UI on Cloudflare, run the pipeline on Oracle.** Both free.

### Recommended free stack for the product version

```
Oracle Always Free VPS
  NestJS  →  pipeline (cron) + /api
  SQLite on local disk
  Vite + React bundle served by Nest
Cloudflare (free)
  Tunnel for ingress, CDN, TLS
Backups → Cloudflare R2 or Backblaze B2 (both have free tiers)

Total: $0/month
```

This is a real, production-shaped deployment at zero cost. You'd move off it when traffic or
reliability demands justify it — not before.

---

## Part 2: The economics are unusually good, and you should design around that

This is the most important thing in this document.

### Ingest is shared. Only scoring is per-user.

You sweep 15,862 companies whether you have one user or ten thousand. **The corpus is identical
for everyone.** What differs per user is only their keywords, their score, their feedback — all
cheap local computation over a shared table.

```
FIXED (no matter how many users):
  the sweep — ~47 MB, ~2 min, 4×/day, one machine

PER USER:
  filter + score over shared rows   → milliseconds, effectively free
  AI features                       → real money per call
```

Most SaaS has marginal cost rising with users. Yours doesn't. The expensive part amortizes across
everybody, and user #5,000 costs you approximately nothing to ingest for.

### The business model falls out of that

Because the non-AI path is genuinely near-zero marginal cost, you can afford a real free tier
rather than a crippled one:

| Tier | What it does | Your marginal cost |
|---|---|---|
| **Free** | keyword filter, scoring, daily digest, tracking | ~$0 |
| **Paid** | résumé gap analysis, company briefs, outreach drafts | LLM calls per user |

That's a healthy shape: the free tier is a complete, useful product that costs you nothing, and
the paid tier maps exactly onto the costs it incurs.

### Keep AI costs on the right side of that line

Not all "AI" costs money:

- **Free forever, runs locally:** embeddings for semantic matching and dedup
  (`all-MiniLM-L6-v2` via Transformers.js, per `BOTTLENECKS.md` §5–6). No API, no per-user cost.
  Put these in the free tier — they'll make your matching visibly better than keyword-only
  competitors at zero marginal cost.
- **Costs real money per call:** anything generative — résumé analysis, company research
  summaries, outreach drafts. These are your Phases 2–4, and they're the paid tier.

Design the boundary deliberately now, because "we accidentally put an LLM call in the free tier's
hot path" is how these products bleed money.

---

## Part 3: Three decisions that are expensive to reverse

You said you're still planning, so this is the useful part. Almost everything can be deferred —
these can't, and they cost you nothing to get right today.

### 1. Split shared data from per-user data in the schema

The current TDD has one `jobs` table holding `score` and `status`. That's correct for one user
and a painful migration for many, because score and status are *yours*, not the job's.

```sql
-- SHARED: one row per job, ever. Read-mostly.
jobs (id, company_id, title, description, url, posted_at, dedup_key, raw_payload, ...)

-- PER USER: your opinion about a job.
user_job_state (user_id, job_id, score, status, notified_at, feedback_at, ...)

-- PER USER: replaces config.yaml eventually.
user_config (user_id, roles, keywords, exclusions, locations, min_score, ...)
```

As a single user you set `user_id = 1` and never think about it. It costs you nothing now and
saves an unpleasant rewrite later. This is the one I'd genuinely insist on.

### 2. Store raw payloads

Keep the original JSON for every job you ingest, not just your parsed fields.

When you add AI features, change your extraction, or want to re-score history against a new
model, you'll want to reprocess the archive. If you only kept parsed fields, that history is
gone — and job postings disappear from ATS endpoints once filled, so you cannot re-fetch it.

At ~47 MB per full sweep gzipped, storage is not your problem. Losing the data is.

### 3. Make config a interface, not a file

YAML is right for you today. But `ConfigService.getFor(userId)` returning a typed object — backed
by YAML now, a DB row later — means multi-tenancy doesn't touch your filtering or scoring code
at all. Ten minutes now, a refactor avoided later.

### What you can safely defer

Hosting (all options run the same code), UI framework, auth, billing, Postgres migration,
MinHash dedup, semantic scoring. None of these constrain the others. Don't let them slow you
down.

---

## Part 4: One thing to check before you sell it

Reading public ATS endpoints for personal use is uncontroversial. **Republishing that data to
paying customers is a different question**, and it's worth getting a real answer before you build
a business on it.

The landscape, as best I can summarize it:

- Individual job postings are largely factual, and short titles and phrases generally don't
  attract copyright. But a *compilation* can carry protection even when its elements don't.
- Terms of service are a separate exposure from copyright — scraping or redistributing can breach
  a site's ToS regardless of the copyright position.
- Aggregators commonly rely on transformative use, attribution, and linking out to the original
  posting rather than reproducing full descriptions.
- Common practice among aggregators: store and index freely, display snippets plus a link, honor
  removal requests, and read the ToS of each source.

**I'm not a lawyer and this isn't legal advice.** The practical steps I'd suggest: read the terms
for Greenhouse, Lever, and Ashby specifically — their public endpoints are *intended* for
distribution, which likely helps you — and get an hour with an attorney before you take money.
The cost of asking early is trivial next to discovering the answer late.

This changes nothing about your MVP. Personal use is fine. Just know the question exists before
the product exists.

---

## Where that leaves you

**Now (local, $0):** build the pipeline on your machine as planned. Use the split schema, store
raw payloads, wrap config behind an interface. Prove the jobs it surfaces are actually good.

**If it works ($0):** Oracle Always Free + Cloudflare. Same NestJS code, now always-on, still
free. Add auth and the React UI.

**If people want it ($0 → small):** free tier stays free because ingest is already paid for.
Charge for the generative AI features, which is where your costs actually are.

The pleasant conclusion: **there is no point on this path where hosting cost is your obstacle.**
Not at one user, not at a thousand. What'll cost you is LLM calls — which is exactly what you
should be charging for.

---

## Sources

- [Oracle Cloud free tier 2026 changes](https://terminalbytes.com/oracle-cloud-free-tier-changes-2026/) — A1 reduced to 2 OCPU / 12 GB, June 2026
- [Oracle Cloud Always Free setup guide](https://medium.com/@imvinojanv/setup-always-free-vps-with-4-ocpu-24gb-ram-and-200gb-storage-the-ultimate-oracle-cloud-guide-bed5cbf73d34)
- [OCI free tier breakdown](https://fullmetalbrackets.com/blog/oci-free-tier-breakdown)
- [oci-arm-host-capacity](https://github.com/oeufmeister/oci-arm-host-capacity) — working around "out of capacity"
- [Cloudflare Workers free tier 2026](https://agentdeals.dev/vendor/cloudflare-workers) — 100k req/day, 10 ms CPU
- [Cloudflare Workers + Hono + D1 + R2 free stack](https://www.buildmvpfast.com/blog/cloudflare-workers-hono-d1-r2-free-fullstack-2026) — D1 limits
- [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Turso pricing](https://turso.tech/pricing)
- [Is aggregating job postings legal?](https://www.avvo.com/legal-answers/is-aggregating-job-postings-from-employeer-career--1480697.html) — attorney commentary, not advice
- [Copyright and content aggregation platforms](https://www.scoredetect.com/blog/posts/copyright-and-content-aggregation-platforms-explained)
