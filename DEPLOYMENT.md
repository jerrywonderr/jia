# Running It: Cost, Hosting, and the UI

Companion to `BOTTLENECKS.md`, `REGISTRY-DESIGN.md`, `EXPLAINED.md`.
Prices checked 2026-08-03.

---

## The reframe that saves you money

**This is not a web service. It's a cron job with a dashboard attached.**

One user. Runs four times a day. Idle 99% of the time. Peak load is you opening a page.

Nearly all hosting advice assumes always-on traffic from many users, and that advice is wrong
here — it'll push you toward autoscaling, managed Postgres, and a $25/mo bill for something a
Raspberry Pi could run. Judge every option against *"it's a cron job with a table view."*

Two properties drive the whole decision:

1. **SQLite needs a real disk.** That rules out most serverless platforms, or forces you onto a
   networked database you don't need.
2. **The sweep is one long fan-out job** (~2 min steady state, ~15 min cold). That's longer than
   most serverless function timeouts, so you'd have to chunk it across invocations — real
   complexity for zero benefit.

Together those say: **something with a disk that can run a process for a few minutes.** Cheap and
boring. Not edge, not serverless.

---

## Three options, cheapest first

| | Cost | Good for | Main catch |
|---|---|---|---|
| **A. Your own machine** | **$0** | the 7-day validation your TDD calls for | only runs when the machine is on |
| **B. GitHub Actions + static UI** | **$0** | no server to babysit | cron timing is best-effort |
| **C. Small VPS** | **~€4/mo** | once it's real | you patch the box |

### A. Your own machine — $0

For the 7-day validation period your TDD specifies, this is the correct answer and I'd stop
looking. Docker container plus a cron entry. No accounts, no deploys, no bills, and you can
attach a debugger.

The only real downside is a closed laptop means a missed run — which, for a system whose whole
job is "tell me about jobs each morning," matters less than it sounds. Add a catch-up run on
wake and it's a non-issue.

If you have a Raspberry Pi or an always-on desktop, this stops being a compromise and just
becomes the answer.

### B. GitHub Actions + static UI — $0

The pipeline is a scheduled job, and GitHub will run scheduled jobs for free:

- **Public repo:** unlimited free minutes.
- **Private repo:** 2,000 Linux minutes/month free.

Your usage: ~2 min steady state × 4 runs/day × 30 days ≈ **240 min/month.** That fits inside the
private-repo free tier roughly eight times over.

Then commit the SQLite file (or export JSON) and serve a static UI from GitHub Pages or
Cloudflare Pages — also free.

**This is exactly the pattern the `job-board-aggregator` repo you're seeding from already uses:**
GitHub Actions on a daily schedule, data committed to the repo, static site on top. It's proven
for this precise workload, by the very project supplying your company list.

Three caveats, all manageable:

- **Cron timing is best-effort.** Scheduled workflows get delayed at peak times — sometimes
  15–30 minutes. Irrelevant for a daily digest; annoying if you wanted 08:00 sharp.
- **Scheduled workflows auto-disable after 60 days of repo inactivity.** Since the workflow
  itself commits data, it keeps itself alive — but know the rule exists.
- **A growing binary SQLite file bloats git history.** Every run rewrites the whole file, so
  every run is a full new blob. Mitigate by exporting JSON instead, committing to an orphan
  `data` branch, or using releases/artifacts as storage.

### C. Small VPS — ~€4/month

[Hetzner](https://www.hetzner.com/cloud) is €3.79/mo for 2 vCPU / 4 GB. That is comically
oversized for this workload, which is the point — you'll never think about limits again.

Everything lives in one box: pipeline, SQLite on local disk, UI served by the same process, real
cron with real timing. One mental model, no platform quirks, no cold starts, no per-row billing.

This is where I'd land once you're past validation and want it reliably on at 08:00.

Add [Coolify](https://coolify.io) if you want git-push deploys, or just use a systemd timer and a
`git pull`. For remote access without exposing ports, Cloudflare Tunnel is free.

### D. Azure — what's actually free, and for how long

Azure splits its free offer in two, and the distinction decides everything:

| | What you get | Duration |
|---|---|---|
| **12-month free** | B1S / B2pts v2 / B2ats v2 VMs, 750 h/mo · Azure SQL · managed disks | **expires after year 1** |
| **Always free** | Container Apps grant · Functions (1M exec/mo) · Cosmos DB · App Service F1 | forever |

**The VM path is free for a year, then it isn't.** After 12 months: B2pts v2 (ARM, 2 vCPU) from
~$4.09/mo, B1s ~$7.59/mo — plus managed disk, egress, and public IP billed separately. Realistic
all-in for year two: **~$8–15/month.**

**The always-free path fits the compute easily but breaks SQLite.** Azure Container Apps grants
180,000 vCPU-seconds, 360,000 GiB-seconds, and 2M requests per subscription per month, forever.
Our sweep needs:

```
2 min steady state × 4 runs/day × 30 days = 14,400 seconds
at 1 vCPU  →  14,400 vCPU-s   =  8% of the 180,000 grant
at 0.5 vCPU →  7,200 vCPU-s   =  4%
```

So compute is genuinely free with ~12× headroom. **The problem is storage.** Container Apps
scale to zero and have no persistent local disk, and SQLite over a network file share (Azure
Files) has real locking hazards. That leaves three options:

- **Blob snapshot pattern** — download the SQLite file at job start, upload at end. Legitimate
  for a single-writer batch job, and cheap. Adds a failure mode if a run dies mid-write.
- **Cosmos DB free tier** — 1,000 RU/s and 25 GB free for the account lifetime, one free account
  per subscription. But this abandons SQLite entirely: you rewrite the data layer, lose
  relational queries, and lose `sqlite-vec` for the Phase 1.5 embeddings. *(Note: there are
  reports of the included throughput being cut from 1,000 to 100 RU/s — verify current terms
  before relying on it.)*
- **Just use a VM** and accept year-two cost.

**Verdict:** Azure is a fine choice if you want to be on Azure — but its free tier doesn't beat
Oracle's for this workload. You either pay ~$8–15/mo from year two, or re-architect off SQLite
to fit the always-free services. Oracle Always Free gives you a real disk and a real VM
indefinitely.

---

## The durability concern, reconsidered

The worry about Oracle reclaiming idle instances is reasonable, but it's smaller than it looks —
and switching clouds doesn't solve it.

**1. A single VM is a single point of failure everywhere.** An Azure B-series VM is not more
durable than an Oracle A1 at this tier. Azure Backup is a paid add-on. Any single-box deployment
needs a backup strategy; that requirement is independent of vendor.

**2. Oracle's reclamation targets idle instances**, judged on sustained low CPU utilization. This
box runs a cron every six hours and serves a UI, so it isn't idle in the ordinary sense — though
a short cron may still read as low average utilization, so don't treat this as a guarantee.

**3. The decisive point: almost none of your data is irreplaceable.**

| Data | If you lost it |
|---|---|
| Company registry (~15,862 tokens) | re-download the public lists — minutes |
| Jobs corpus | rebuilds from one sweep — minutes |
| **Your feedback labels + config** | **genuinely gone** |

That last row is the only thing worth protecting, and it's *kilobytes*. So "backup" here means:

```bash
# nightly cron — the entire durability story
sqlite3 jobs.db ".dump user_job_state user_config users" | gzip > backup.sql.gz
# push to Cloudflare R2 / Backblaze B2 / a private git repo — all have free tiers
```

Five lines. Once that runs, losing the host costs you a `git pull`, a re-seed, and one sweep —
call it fifteen minutes of unattended catch-up. The historical *jobs* are regenerable; only your
opinions about them aren't.

Reframed that way, host durability stops being an architectural concern and becomes a cron entry.
Pick the host on price and convenience instead.

**One favourable detail for any cloud:** this workload is ingress-heavy and egress-light. You
download ~47 MB per sweep (inbound traffic is free everywhere) and serve only a small UI outbound.
Egress charges — the usual cloud gotcha — barely apply here.

---

## Splitting across Supabase — which half goes where

Supabase free tier, as of 2026: **500 MB database**, 1 GB file storage, 5 GB egress, 2 projects,
**no backups**, and projects auto-pause after a week of inactivity (our 6-hourly cron prevents
that). Exceed a limit and Fair Use returns 402 until the period resets.

The instinct to split precious data from regenerable data is right. But measured against real
job records, **the halves want swapping.**

### The measurement

Sampled 155 live postings across six Greenhouse boards:

| | Avg per job |
|---|---|
| Lean record (title, location, url, dates) | **165 bytes** |
| Full record **with description** | **11,129 bytes** |

Descriptions are ~98% of the payload. Projected across ~8,565 live boards at ~20–25 jobs each
(≈171k–214k jobs):

| Corpus | Size | vs 500 MB |
|---|---|---|
| Lean (no descriptions) | **28–35 MB** | fits, 14× headroom |
| Full (with descriptions) | **1.9–2.4 GB** | **exceeds by 4–5×** |
| `user_job_state`, 200k rows, 1 user | **24 MB** | fits trivially |

So the plan of "precious data on Oracle, everything else on Supabase" inverts both constraints:

- **Capacity** — the "everything else" is the 2 GB half that *doesn't* fit; the precious half is
  24 MB and fits 20× over.
- **Durability** — a single Oracle VM disk is the least durable surface in the system. Putting
  the one irreplaceable thing there and the regenerable corpus on managed infrastructure is
  backwards.

### Three shapes that do work

**A. Invert the split** — corpus local, user data managed

```
Oracle VM · SQLite     jobs, companies, descriptions, raw payloads   (2 GB, regenerable)
Supabase · Postgres    users, user_config, user_job_state            (24 MB, precious)
```

Corpus stays free and unlimited on local disk with fast queries and `sqlite-vec` intact. User
data lives on managed Postgres with auth and RLS ready for the product. Cost: cross-database
joins — but 24 MB of user state loads into memory trivially at one user.

**B. All Supabase, lean corpus** ← *recommended if you want one database*

Store descriptions only for tier 0–1 companies (watchlist + active, ~500 companies ≈ 15k jobs ≈
165 MB). Tier 2 stored lean at 165 bytes/job. Fetch descriptions on demand when you open a job.

```
lean tier-2 corpus     ~35 MB
tier 0–1 w/ descriptions ~165 MB
user state              ~24 MB
                       ─────────
                        ~224 MB   under the 500 MB ceiling
```

Raw payloads go to object storage (Cloudflare R2 / Backblaze B2 free tiers) keyed by job id,
satisfying the TDD's retention rule without bloating Postgres. One database, joins work, and you
get **pgvector** — a better home for the Phase 1.5 embeddings than `sqlite-vec`. This also maps
cleanly onto the tiering already in §7.1 of the TDD.

**C. All local SQLite + nightly dump** — simplest, no Supabase

Everything on Oracle; the five-line backup above protects the 24 MB that matters. Fewest moving
parts. Choose this if the product ambition is still hypothetical.

### One caveat worth naming

**Supabase's free tier has no backups.** It's managed, replicated infrastructure — more durable
than a lone VM disk — but it is not an archive, and there's no point-in-time restore. Keep the
nightly dump regardless of which shape you pick. That cron entry stays cheap insurance in every
scenario.

### What Supabase genuinely buys you

Beyond storage: **auth, row-level security, an auto-generated REST API, and pgvector** — four
things a multi-user product needs and none of which SQLite provides. If the product path is real,
shape B moves you onto that foundation now, while the data is small enough that migrating is
free. That's the strongest argument for it.

---

### For comparison — the managed platforms

- **Render:** $7/mo per always-on service (512 MB).
- **Railway:** ~$10–15/mo for a typical small app; usage-based.
- **Fly.io:** from ~$2/mo for a 256 MB machine, plus $0.15/GB/mo volumes — but the free tier is
  gone and real-world small apps land around $8–25/mo once egress and restarts count.

All fine. All more expensive than Hetzner for less machine, because you're paying for
convenience you don't need at one user.

### What not to do

**Don't put the pipeline on Vercel/Netlify serverless.** Function timeouts can't hold a 2–15
minute fan-out, and SQLite has nowhere to live. You'd end up chunking the sweep across
invocations *and* migrating to a hosted database — a lot of engineering to make a $4 box's job
harder.

If you ever do need a networked SQLite (say, static UI on Pages that queries live rather than
reading a committed file), [Turso](https://turso.tech/pricing) has a free tier of 5 GB and 500M
row reads/month — ample here. Just note it bills *per row read*, not per request, so a careless
`SELECT *` on every page load burns through it faster than you'd guess.

---

## The UI

### Scope it honestly first

A single-user job dashboard is **a filterable table**. That's it:

- list of jobs, sorted by score
- filter by status / score / company / date
- click through to the posting
- four buttons: Interested / Applied / Not for me / Dismissed
- maybe a small chart of jobs-found-per-day

No authentication (one user). No design system. No user accounts, roles, or onboarding. Resisting
scope creep here is worth more than any framework choice.

### Where NestJS leaves you

NestJS gives you **nothing** for UI — it's a backend framework. So you have to decide how the UI
attaches. Three shapes:

**1. NestJS + React bundle served by Nest** ← recommended

Build a Vite + React app, point `@nestjs/serve-static` at the `dist` folder. Nest serves `/api/*`
and the static bundle from one process, one port, one deploy. Your existing TDD survives intact.

**2. Next.js for everything**

Next handles UI and API together, so it's fewer moving parts and one framework to learn. But it's
a worse fit for the pipeline — you'd still run the sweep as a plain Node script on a cron, not as
a route, so you end up with two execution models anyway. Worth it only if you already know Next
and don't know Nest.

**3. No framework — generate a static HTML report each run**

Genuinely viable for V0.1. The pipeline writes `index.html` with the day's table; open it in a
browser. Zero UI code, and it forces you to find out what you actually look at before building
something interactive. Upgrade later once you know.

### Is NestJS the right call at all?

Worth asking, since it's your choice and not a requirement.

**Keep it if:** you intend to build Phases 2–5. Your connector-per-source design maps almost
perfectly onto Nest modules, and DI, scheduling, and queues are all first-class. It'll age well.

**Drop it if:** you want the MVP running this week. A plain TypeScript script with
`better-sqlite3` + `node-cron` + `p-limit` is roughly 200 lines for the whole pipeline, with no
decorators, no modules, and no framework docs to read. You can always port into Nest once the
logic is proven — and porting *working* logic is much easier than designing inside a framework
you're still learning.

The deciding question is just whether you're already fluent in Nest. If yes, use it. If you'd be
learning it and the pipeline simultaneously, that's two problems at once.

---

## Recommended setup

**For validation (next 2 weeks):**

```
Your own machine
  plain TypeScript + better-sqlite3 + node-cron
  static HTML report written each run
Cost: $0
```

Prove the idea works — that the jobs surfaced are actually good — before spending anything on
infrastructure or interface.

**Once it's earning its keep:**

```
Hetzner CX22 (€3.79/mo)
  NestJS  →  pipeline + /api
  Vite + React bundle served by Nest
  SQLite on local disk, nightly backup to object storage
  Cloudflare Tunnel for remote access
Cost: ~€4/mo, all in
```

**If you'd rather never touch a server:**

```
GitHub Actions (scheduled sweep)
  → commits JSON/SQLite
Cloudflare Pages (static React reading that data)
Cost: $0
```

All three run the same pipeline code. The hosting decision is genuinely reversible — which is why
it shouldn't slow you down now.

---

## Sources

- [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions) — free-tier minutes
- [GitHub Actions pricing 2026](https://cicdcalculator.com/github-actions) — post-January-2026 rates
- [Render vs Railway vs Fly.io 2026 pricing](https://expresstech.io/render-vs-railway-vs-fly-io-2026-pricing-showdown/)
- [Fly.io alternatives after the free tier died](https://expresstech.io/7-fly-io-alternatives-in-2026-real-pricing-after-the-free-tier-died/)
- [Coolify vs Fly.io vs Render](https://pristren.com/blog/coolify-vs-fly-io-vs-render/) — Hetzner + Coolify self-hosting
- [Azure free services](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/create-free-services) — 12-month vs always-free split
- [Azure free tier complete guide 2026](https://agentdeals.dev/azure-free-tier-2026) — real limits and hidden costs
- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/) — 180k vCPU-s monthly free grant
- [Azure Cosmos DB free tier](https://docs.azure.cn/en-us/cosmos-db/free-tier) — lifetime 1,000 RU/s + 25 GB
- [Azure VM pricing 2026](https://costbench.com/software/cloud-infrastructure/azure/) — B-series pay-as-you-go
- [Turso pricing](https://turso.tech/pricing) — free tier limits, per-row billing
- [job-board-aggregator](https://github.com/Feashliaa/job-board-aggregator) — the GitHub-Actions-plus-static-site pattern, working in production
