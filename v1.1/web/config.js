/* ============================================================================
   Deployment config. Safe to commit — the anon key is public by design
   (row-level security limits it to reading the corpus).

   Leave these blank and the app runs in LIVE mode: it fetches ATS boards
   directly from the browser. Slower, but works with no backend at all,
   so you can deploy the static site before Supabase exists.

   Fill them in and it switches to CORPUS mode: instant queries against the
   swept database.
   ========================================================================== */

window.APP_CONFIG = {
  SUPABASE_URL: '',       // e.g. 'https://abcdefgh.supabase.co'
  SUPABASE_ANON_KEY: '',  // the "anon / public" key, NOT the service key

  // Live mode only: how many random companies to sample per search.
  LIVE_SAMPLE: 30,
  LIVE_CONCURRENCY: 6,
};
