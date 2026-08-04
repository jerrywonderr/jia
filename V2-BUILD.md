# V2 — Zero-Cost, No-Signup Public Build

How to get this in front of people with no accounts, no server, and no bill.
Follows `TDD-v0.2.md`. Limits verified 2026-08-03.

---

## Dropping signup simplifies almost everything

No accounts removes four layers at once:

| Removed | Because |
|---|---|
| Supabase Auth, sessions, password reset | nobody signs in |
| `users`, `user_config`, `user_job_state` tables | nothing is stored per person |
| Row-level security policies | one public read policy covers it |
| Per-user score precomputation | scoring is a stateless call |

What replaces them: **the browser holds the config.** Keywords, weights, and exclusions live in
`localStorage`; every query passes them as parameters. The server side is stateless and identical
for everyone.

### Architecture

```
┌─ GitHub Actions ── every 6h · free ───────────────────────┐
│  sweep registry → fetch boards → normalize → dedupe       │
│  upsert into Supabase                                      │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌─ Supabase (free) ──────────────────────────────────────────┐
│  Postgres · public read-only · stateless scoring RPC       │
│  no auth, no user tables                                    │
└──────────────────────────┬─────────────────────────────────┘
                           ▼
┌─ Cloudflare Pages (free) ──────────────────────────────────┐
│  static React · config in localStorage · anon Supabase key │
└─────────────────────────────────────────────────────────────┘
```

Nothing runs continuously. Nobody signs in. Nothing costs money.

### The property that makes this cheap forever

**Storage is completely flat.** The database holds only the shared corpus, so it's the same size
whether ten people use the site or ten thousand:

```
companies                        ~2 MB
jobs, lean (long tail)          ~35 MB
jobs, tier 0-1 w/ descriptions ~165 MB
                               ────────
                                ~202 MB   against a 500 MB free tier
```

Compare with the account-based design, which needed a score row per user per job and broke the
free tier at about 20 users. Removing signup doesn't just simplify the code — it removes the
scaling wall entirely.

---

## Schema

Two tables. That's the whole thing.

```sql
create table companies (
  id bigserial primary key,
  ats text not null, token text not null,
  name text, tier smallint default 2,
  status text default 'unknown',
  etag text,                      -- MUST be here: CI runners are ephemeral
  last_fetched timestamptz, fail_count int default 0,
  unique (ats, token)
);

create table jobs (
  id bigserial primary key,
  company_id bigint references companies(id),
  source text not null, external_id text,
  title text not null, location text, remote boolean default false,
  description text,               -- tier 0-1 only; null for the long tail
  url text not null,
  posted_at timestamptz,
  first_seen timestamptz default now(),
  last_seen  timestamptz default now(),
  dedup_key text not null,
  raw_key text,                   -- R2 object key, not the payload
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(description,'')), 'B')
  ) stored,
  unique (source, external_id)
);
create index on jobs using gin (search_vector);
create index on jobs (posted_at desc);
create index on jobs (last_seen);

-- public read, no writes from the browser
alter table jobs      enable row level security;
alter table companies enable row level security;
create policy public_read_jobs      on jobs      for select using (true);
create policy public_read_companies on companies for select using (true);
```

Writes happen only from GitHub Actions using the service key. The browser gets the anon key,
which can read and nothing else.

### Stateless scoring

No `user_id` anywhere — config arrives as arguments:

```sql
create or replace function search_jobs(
  p_keywords jsonb,               -- {"react native": 30, "typescript": 15}
  p_exclude  text[]  default '{}',
  p_remote_only boolean default false,
  p_max_age_days int default 30,
  p_limit int default 50
) returns table (
  id bigint, title text, company text, location text,
  url text, posted_at timestamptz, score real
)
language sql stable as $$
  with w as (
    select key as term, value::real as weight from jsonb_each_text(p_keywords)
  ), total as (select sum(weight) tw from w)
  select j.id, j.title, c.name, j.location, j.url, j.posted_at,
         (100.0 * sum(w.weight * ts_rank(j.search_vector,
                        plainto_tsquery('english', w.term)))
          / nullif((select tw from total), 0))::real as score
  from jobs j
  join companies c on c.id = j.company_id
  cross join w
  where j.last_seen > now() - make_interval(days => p_max_age_days)
    and (not p_remote_only or j.remote)
    and not (j.title ilike any (select '%'||x||'%' from unnest(p_exclude) x))
  group by j.id, j.title, c.name, j.location, j.url, j.posted_at
  order by score desc
  limit p_limit;
$$;
```

Called from the browser as `supabase.rpc('search_jobs', {...})`. Sketch, not final — but the
shape is the point: no rows written, no identity, GIN index does the work.

---

## The honest cost of dropping signup

Worth naming plainly, because it changes what the product *is*.

**You lose the agent.** The TDD's premise was "wake up to today's ranked shortlist." Pushing
anything to someone requires a delivery address, which requires them to give you one. Without
that, this is a very good job *search site* people visit — not an agent that reaches out.

That may be exactly right for a first public test: zero friction, no data to protect, no privacy
policy to write, and you find out whether the *ranking* is good before asking anyone for
anything. But it is a different product from the one in `TDD-v0.2.md`.

**Three ways to get delivery back without a signup flow:**

| Approach | How it dodges signup | Trade-off |
|---|---|---|
| **RSS feed** | config encoded in the URL: `/feed?kw=react:30,ts:15` | user needs a reader; still zero accounts |
| **Browser push** | permission prompt, no identity | must revisit the site once; browser-bound |
| **Telegram bot** | the chat ID *is* the identity | arguably a signup, but a one-tap one |

The RSS route is the purest fit: stateless, no personal data, and a GitHub Action can generate
feeds for any config passed in the URL. It preserves the original "it comes to me" premise while
storing nothing about anybody.

**You also lose centralized feedback labels** — which were criterion #2 in the TDD and the input
to scoring calibration. Partial recovery without identity: an insert-only anonymous events table.

```sql
create table feedback_events (
  id bigserial primary key,
  job_id bigint references jobs(id),
  action text not null,              -- clicked | dismissed | saved
  session text,                      -- random client-side id, not a person
  created_at timestamptz default now()
);
alter table feedback_events enable row level security;
create policy anon_insert on feedback_events for insert with check (true);
```

No accounts, no personal data, but you learn in aggregate which results people click and which
they skip — enough to tune weights. Individual users still get their own saved/dismissed state
in `localStorage`.

---

## Build order

**1 — Supabase project + schema** *(half a day)* — run the DDL, enable RLS, grab the anon key.

**2 — Seed the registry** *(half a day)* — one-off script, 15,862 rows into `companies`.
Everything is blocked on this.

**3 — Sweep as a GitHub Action** *(2 days)* — plain TypeScript, no framework:

```yaml
# .github/workflows/sweep.yml
on:
  schedule: [{ cron: '0 */6 * * *' }]
  workflow_dispatch:
jobs:
  sweep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run sweep
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

Read companies by tier → fetch with gzip + `If-None-Match` → skip 304s → normalize → dedupe →
upsert → write ETags back → log a run row. The logic ports directly from `test/app.js`.

**4 — Static React on Cloudflare Pages** *(2 days)* — config panel writing to `localStorage`,
results from `search_jobs()`. The prototype's markup is already the right shape.

**5 — Anonymous feedback events** *(half a day)* — click/dismiss/save, insert-only.

**6 — RSS feeds** *(1 day, optional)* — if you want the "it comes to me" behaviour back.

**About four days of evenings to something public, useful, and free.**

---

## Limits and what breaks first

| Limit | Free tier | Bites at |
|---|---|---|
| Supabase storage | 500 MB | never — corpus is flat at ~202 MB |
| **Supabase egress** | **5 GB/mo** | **~100k searches/mo** at ~50 KB per result set |
| GitHub Actions | unlimited (public repo) | never |
| Cloudflare Pages | unlimited bandwidth | never |

**Egress is now the only meaningful ceiling**, and 100k searches a month is a lot of traffic for
a first test. If you hit it, that's a $25 Pro plan and a very good problem.

Two operational notes: Supabase free projects pause after a week of inactivity — the 6-hourly
sweep prevents that automatically. And exceeding any limit returns 402 across all services until
the period resets, so watch egress rather than storage.

**No backups on the free tier**, but with no accounts there's nothing irreplaceable: the registry
re-downloads and the corpus rebuilds from one sweep. Losing the database costs about fifteen
minutes. That was the whole worry earlier, and dropping signup dissolves it.

---

## Upgrading to the full agent later

This is a foundation, not a detour. The three decisions flagged in `PRODUCT-PATH.md` §3 as
expensive to reverse are all preserved here — in fact the no-signup design satisfies them more
cleanly than the account-based one did:

| Decision | Status here |
|---|---|
| Shared corpus separated from per-user data | ✅ enforced — there *is* no per-user data |
| Raw payloads retained | ✅ `jobs.raw_key` → R2 |
| Config behind an interface | ✅ becomes `getConfig()` in the browser |

### Purely additive — no rework

| To add | What it takes |
|---|---|
| Accounts | flip on Supabase Auth; `auth.users` appears |
| Per-user config & saved jobs | two new tables + RLS; nothing existing changes |
| Semantic scoring | add an embedding column + pgvector index |
| Email/Telegram digest | a new scheduled job reading the same corpus |
| Company intelligence, résumé analysis (P2–P3) | new tables, new jobs |
| NestJS | only when you need webhooks or custom endpoints |

`companies`, `jobs`, and the entire sweep never change. They don't know users exist, and they
never will — that's the point of the shared-corpus split.

### Small, contained changes

**Scoring.** Keep `search_jobs(keywords, …)` exactly as-is for anonymous visitors and add a thin
wrapper that loads a signed-in user's saved config and calls the same core. An addition, not a
rewrite.

**Config.** Write `getConfig()` / `saveConfig()` in the UI from day one, reading `localStorage`
today and the database when a session exists. That's the same interface advice applied
client-side, and it turns "sign in to sync your settings" into a natural onboarding moment
rather than a migration.

### What you give up by starting here

**Anonymous feedback can't be attributed retroactively.** Events carry a random session id, so
when accounts arrive you can't reconstruct anyone's personal history from them. Acceptable — you
wanted aggregate signal from that table anyway, and it keeps working unchanged.

**Descriptions for tier 2 are a paid decision.** If semantic search across the whole corpus turns
out to matter, storing all descriptions is ~2 GB and you're on the $25/mo plan. Not a rework, just
a bill.

### The one thing not to do

**Don't precompute scores into a table.** It's the single choice that would break the upgrade
path, because it's what fails at ~20 users. Score-on-read serves both the anonymous version and
the multi-user one without modification.

Hosting is reversible too: GitHub Actions → a VM if the sweep outgrows CI, Supabase → self-hosted
Postgres, static site → Nest-served. None of these are one-way doors.

---

## Sources

- [GitHub Actions billing](https://docs.github.com/billing/managing-billing-for-github-actions/about-billing-for-github-actions)
- [Supabase pricing](https://uibakery.io/blog/supabase-pricing) — 500 MB, 5 GB egress, no backups
- [Supabase free tier limits 2026](https://aiagencyplus.com/supabase-free-tier-limits/) — pause-on-inactivity, Fair Use 402
- [Cloudflare Pages/Workers free tier](https://agentdeals.dev/vendor/cloudflare-workers)
