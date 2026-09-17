-- ============================================================================
-- Job Intelligence Agent v1.1 — fix search_jobs perf bug + scheduled cleanup
-- Paste this whole file into the Supabase SQL editor and run it.
-- ============================================================================

-- ─── 1. fix search_jobs ─────────────────────────────────────────────────────
-- The old version cross-joined every filtered job against every keyword and
-- called ts_rank() on all of them (rows × keywords), never using the GIN
-- index on search_vector. This filters to actual matches first via `@@`
-- (index-backed), then ranks only those. Same results, far less work — and
-- it stops getting slower as the corpus grows.

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
      j.id, j.title, c.name as company, j.location, j.url,
      j.source, j.posted_at, j.remote,
      w.term, w.weight,
      ts_rank(j.search_vector, plainto_tsquery('english', w.term)) as rank
    from jobs j
    join companies c on c.id = j.company_id
    join w on j.search_vector @@ plainto_tsquery('english', w.term)
    where j.last_seen > now() - make_interval(days => p_max_age_days)
      and (not p_remote_only or j.remote)
      and (
        cardinality(p_exclude) = 0
        or not exists (
          select 1 from unnest(p_exclude) x where j.title ilike '%' || x || '%'
        )
      )
  ),
  agg as (
    select
      hits.id, hits.title, hits.company, hits.location, hits.url,
      hits.source, hits.posted_at, hits.remote,
      least(100.0 * sum(hits.weight) / nullif((select tw from total), 0), 100.0)::real as score,
      array_agg(distinct hits.term) as matched
    from hits
    group by hits.id, hits.title, hits.company, hits.location,
             hits.url, hits.source, hits.posted_at, hits.remote
  )
  select * from agg
  where agg.score >= p_min_score
  order by agg.score desc, agg.posted_at desc nulls last
  limit p_limit;
$$;

grant execute on function search_jobs to anon;

-- ─── 2. cleanup functions ───────────────────────────────────────────────────
-- Nothing older than the UI's own 90-day max slider is ever returned by
-- search_jobs anyway, so deleting past that point changes nothing users see.

create or replace function cleanup_old_jobs(p_max_age_days int default 90)
returns void
language sql
as $$
  delete from jobs
  where last_seen < now() - make_interval(days => p_max_age_days);
$$;

-- also drop companies that have been dead a while and have no jobs left
create or replace function cleanup_dead_companies()
returns void
language sql
as $$
  delete from companies c
  where c.status = 'dead'
    and c.last_fetched < now() - interval '30 days'
    and not exists (select 1 from jobs j where j.company_id = c.id);
$$;

-- ─── 3. schedule both nightly via pg_cron ──────────────────────────────────
-- If this errors with "extension pg_cron is not available", enable it first
-- from Database -> Extensions in the dashboard, then re-run this block.
-- cron.schedule() upserts by job name, so this file is safe to re-run.

create extension if not exists pg_cron;

select cron.schedule(
  'cleanup-old-jobs',
  '0 3 * * *',
  $$ select cleanup_old_jobs(90); select cleanup_dead_companies(); $$
);

-- ============================================================================
-- Run this part separately, AFTER the above succeeds
--
--   select cleanup_old_jobs(30);
--   select cleanup_dead_companies();
-- ============================================================================
