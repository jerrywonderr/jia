-- ============================================================================
-- Job Intelligence Agent v1.1 — schema
-- Paste this whole file into the Supabase SQL editor and run it.
-- No auth, no user tables. Corpus is public-read; writes use the service key.
-- ============================================================================

-- ─── companies ──────────────────────────────────────────────────────────────
create table if not exists companies (
  id            bigserial primary key,
  ats           text    not null,             -- greenhouse | lever | ashby
  token         text    not null,
  name          text,
  tier          smallint not null default 2,  -- 0 watchlist · 1 active · 2 long tail
  status        text    not null default 'unknown',  -- live | dead | error
  etag          text,                         -- conditional requests; CI has no local state
  last_fetched  timestamptz,
  last_success  timestamptz,
  fail_count    int     not null default 0,
  job_count     int,
  unique (ats, token)
);

create index if not exists companies_tier_idx   on companies (tier, status);
create index if not exists companies_status_idx on companies (status);

-- ─── jobs ───────────────────────────────────────────────────────────────────
create table if not exists jobs (
  id           bigserial primary key,
  company_id   bigint not null references companies(id) on delete cascade,
  source       text   not null,
  external_id  text   not null,
  title        text   not null,
  location     text,
  remote       boolean not null default false,
  description  text,                          -- tier 0-1 only; null for long tail
  url          text   not null,
  posted_at    timestamptz,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  dedup_key    text   not null,
  raw_key      text,                          -- object-storage key, not the payload
  search_vector tsvector generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) stored,
  unique (source, external_id)
);

create index if not exists jobs_search_idx    on jobs using gin (search_vector);
create index if not exists jobs_posted_idx    on jobs (posted_at desc nulls last);
create index if not exists jobs_last_seen_idx on jobs (last_seen desc);
create index if not exists jobs_dedup_idx     on jobs (dedup_key);
create index if not exists jobs_company_idx   on jobs (company_id);

-- ─── run log ────────────────────────────────────────────────────────────────
create table if not exists runs (
  id               bigserial primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  companies_probed int default 0,
  companies_live   int default 0,
  companies_304    int default 0,
  companies_dead   int default 0,
  jobs_found       int default 0,
  jobs_new         int default 0,
  errors           int default 0,
  notes            text
);

-- ─── anonymous feedback (no identity, insert-only) ──────────────────────────
create table if not exists feedback_events (
  id         bigserial primary key,
  job_id     bigint references jobs(id) on delete cascade,
  action     text not null,               -- clicked | saved | dismissed
  session    text,                        -- random client id, not a person
  created_at timestamptz not null default now()
);
create index if not exists feedback_job_idx on feedback_events (job_id);

-- ============================================================================
-- Row-level security: corpus is world-readable, feedback is insert-only.
-- The browser uses the anon key. Writes to the corpus use the service key,
-- which bypasses RLS.
-- ============================================================================

alter table companies      enable row level security;
alter table jobs           enable row level security;
alter table runs           enable row level security;
alter table feedback_events enable row level security;

drop policy if exists public_read_companies on companies;
drop policy if exists public_read_jobs      on jobs;
drop policy if exists public_read_runs      on runs;
drop policy if exists anon_insert_feedback  on feedback_events;

create policy public_read_companies on companies for select using (true);
create policy public_read_jobs      on jobs      for select using (true);
create policy public_read_runs      on runs      for select using (true);
create policy anon_insert_feedback  on feedback_events for insert with check (true);

-- ============================================================================
-- Stateless scoring. No user_id — the browser passes its config each call.
--   p_keywords: {"react native": 30, "typescript": 15}
-- Score is normalized to a percentage of the achievable total, matching
-- TDD v0.2 §7.6. Realistic cutoffs are 15-40, NOT 80.
-- ============================================================================

create or replace function search_jobs(
  p_keywords      jsonb,
  p_exclude       text[]  default '{}',
  p_remote_only   boolean default false,
  p_max_age_days  int     default 45,
  p_min_score     real    default 0,
  p_limit         int     default 60
)
returns table (
  id bigint, title text, company text, location text, url text,
  source text, posted_at timestamptz, remote boolean,
  score real, matched text[]
)
language sql stable
as $$
  with w as (
    select key as term, (value)::real as weight
    from jsonb_each_text(p_keywords)
    where (value)::real > 0
  ),
  total as (select coalesce(sum(weight), 0) as tw from w),
  hits as (
    select
      j.id,
      j.title,
      c.name        as company,
      j.location,
      j.url,
      j.source,
      j.posted_at,
      j.remote,
      w.term,
      w.weight,
      ts_rank(j.search_vector, plainto_tsquery('english', w.term)) as rank
    from jobs j
    join companies c on c.id = j.company_id
    cross join w
    where j.last_seen > now() - make_interval(days => p_max_age_days)
      and (not p_remote_only or j.remote)
      and (
        cardinality(p_exclude) = 0
        or not (j.title ilike any (select '%' || x || '%' from unnest(p_exclude) x))
      )
  ),
  agg as (
    select
      hits.id, hits.title, hits.company, hits.location, hits.url,
      hits.source, hits.posted_at, hits.remote,
      -- weighted hits, capped at 100% of achievable
      least(
        100.0 * sum(case when hits.rank > 0 then hits.weight else 0 end)
              / nullif((select tw from total), 0),
        100.0
      )::real as score,
      array_remove(array_agg(case when hits.rank > 0 then hits.term end), null) as matched
    from hits
    group by hits.id, hits.title, hits.company, hits.location,
             hits.url, hits.source, hits.posted_at, hits.remote
  )
  select * from agg
  where agg.score >= p_min_score
  order by agg.score desc, agg.posted_at desc nulls last
  limit p_limit;
$$;

-- Lightweight stats for the UI header.
create or replace function corpus_stats()
returns table (
  total_jobs bigint, total_companies bigint, live_companies bigint,
  last_run timestamptz
)
language sql stable
as $$
  select
    (select count(*) from jobs),
    (select count(*) from companies),
    (select count(*) from companies where status = 'live'),
    (select max(finished_at) from runs);
$$;

grant execute on function search_jobs   to anon;
grant execute on function corpus_stats  to anon;
