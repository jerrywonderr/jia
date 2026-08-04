# Job Intelligence Agent — v1.1

Searches ~15,862 company job boards across Greenhouse, Lever, and Ashby, ranks results
against your keywords, and shows them in a static page.

**No accounts. No server. $0/month.**

Between v1 (the local prototype in `../test/`) and v2 (the full agent with digests and AI),
hence v1.1.

---

## Deploy in about 10 minutes

You can do this in two stages. **Stage 1 gets a working public site in ~3 minutes** with no
backend at all. Stage 2 makes it fast.

### Stage 1 — the site, right now (3 min)

The front end has a **live mode**: with no backend configured it fetches company boards
directly from the browser. Slower and it samples a random slice, but it genuinely works.

`web/` is plain HTML, CSS, and JavaScript. **No build step, no bundler, no dependencies.**
To try it locally, just open the file:

```bash
open v1.1/web/index.html          # macOS
xdg-open v1.1/web/index.html      # Linux
```

That works because all four upstream APIs send `Access-Control-Allow-Origin: *`, so the browser
allows the requests even from `file://`. If your browser is strict about local files, or you'd
rather have a real origin so `localStorage` behaves normally:

```bash
cd v1.1 && npm run web            # → http://localhost:8080
```

That's just `npx serve` — any static server does the same job. Nothing in `web/` needs one.

To publish, drag the `web/` folder onto any static host:

- **Cloudflare Pages** — dash.cloudflare.com → Workers & Pages → Create → Pages → *Upload assets*
- **Netlify Drop** — app.netlify.com/drop
- **GitHub Pages** — push and enable Pages on the `web/` folder

That's a live, public, working site. No database, no keys, no bill.

### Stage 2 — the corpus, for real speed (7 min)

Live mode samples ~30 random companies per search. To search all 15,862 instantly, you need
the sweep and somewhere to put it.

**1. Create the database** *(2 min)*

- Sign up at [supabase.com](https://supabase.com), create a project (free tier, no card)
- SQL Editor → paste all of `supabase/schema.sql` → **Run**
- Project Settings → API → copy the **Project URL**, the **anon** key, and the **service_role** key

**2. Seed the registry** *(2 min)*

```bash
cd v1.1
cp .env.example .env          # paste URL + service_role key
npm install
npm run seed                  # ~15,862 companies
```

**3. First sweep** *(2 min)*

```bash
npm run sweep -- --tier 2 --limit 500     # start small to sanity-check
npm run sweep                             # then the lot
```

**4. Point the site at it** *(1 min)*

Edit `web/config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGci...',      // anon key — public by design, safe to commit
};
```

Re-upload `web/`. The badge in the header flips from `live` to `corpus` and searches become
instant.

> The **anon** key is meant to be public — row-level security limits it to reading the corpus
> and inserting anonymous feedback. The **service_role** key must never appear in `web/`.

**5. Keep it fresh** *(1 min)*

Push to GitHub, then Settings → Secrets and variables → Actions → add `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY`. `.github/workflows/sweep.yml` then runs every 6 hours.

Free minutes: unlimited on a public repo, 2,000/month on a private one. A steady-state sweep
takes ~2 minutes, so roughly 240 min/month — comfortably inside either.

---

## Verified working

Everything below was run against the live APIs on 2026-08-03.

**Pipeline** (`npm run sweep:dry`, 24 random companies):

```
24/24  live=14  304=0  dead=10  err=0  jobs=204
204 jobs -> 196 after dedupe
live rate 58%    elapsed 6.1s
```

**Front end** (`node web/verify.mjs`, live mode, 25 companies):

```
probed 25 · live 18 (72%) · gone 7 · jobs 185 · matched 3 · took 11.4s

  55%  Staff Frontend Engineer     vetcove   react native, react, typescript, frontend, mobile
  51%  Senior Software Engineer    vetcove   react native, react, typescript, frontend, mobile
```

The 58–72% live rate matches the 54–56% measured during design. Roughly half the registry has
churned, which is why the sweep prunes as it goes.

---

## Layout

```
v1.1/
├── supabase/schema.sql       tables, RLS, search_jobs() RPC — paste and run
├── src/
│   ├── sources.ts            three ATS connectors + normalizers
│   ├── pipeline.ts           dedupe keys, concurrency pool, gzip/ETag fetch
│   └── db.ts                 Supabase client (service key)
├── scripts/
│   ├── seed.ts               one-off: load ~15,862 company tokens
│   └── sweep.ts              the pipeline; runs in CI every 6h
├── web/                      the static site — this is what you deploy
│   ├── index.html            plain HTML/CSS/JS · no build · no dependencies
│   ├── app.js                live mode + corpus mode
│   ├── style.css
│   ├── config.js             ← your Supabase URL + anon key
│   └── verify.mjs            headless test harness (dev only, not deployed)
└── .github/workflows/sweep.yml
```

**Two independent halves.** `web/` is static files with zero dependencies — deploy it anywhere,
open it straight off disk. `src/` and `scripts/` are the Node side that fills the database, and
they only run on your machine or in CI. The site never imports them, and Node isn't needed to
*use* the site — only to sweep.

The single external script the page loads is the Supabase client from a CDN, and that's only
used in corpus mode. In live mode nothing is loaded at all.

## Commands

| | |
|---|---|
| `npm run seed` | load the company registry (once) |
| `npm run sweep` | full tier-aware sweep |
| `npm run sweep:dry` | **no database needed** — proves the pipeline works |
| `npm run sweep -- --tier 0 --limit 50` | narrow run |
| `npm run web` | optional local static server (`npx serve`) — or just open `web/index.html` |
| `node web/verify.mjs` | headless front-end check (needs `npm i jsdom`) |

---

## How it works

**Registry-shaped, not search-shaped.** ATS APIs can't be searched — you can only look up one
company at a time. So the pipeline holds a registry of ~15,862 company tokens, fetches all of
them, and does the filtering locally. See `../TDD-v0.2.md` §4.

**Tiered polling.** Tier 0 (watchlist) every 6h, tier 1 (recently relevant) every 12h, tier 2
(long tail) daily. Descriptions are fetched only for tiers 0–1 — they're ~98% of the payload.

**gzip + ETag.** Both cut the sweep dramatically: gzip is a 12× payload reduction, and an
unchanged board returns a 0-byte `304`. Steady state should be >80% 304s, which is the
difference between a 15-minute and a 2-minute sweep.

**Scores are percentages of what your config could award** — not raw points. Realistic cutoffs
are 15–40. A threshold of 80 returns nothing; the highest score across 1,081 real postings
during testing was 44%.

---

## Costs and limits

| | Free tier | Expected usage |
|---|---|---|
| Supabase | 500 MB, 5 GB egress | ~200 MB corpus; egress is the first ceiling (~100k searches/mo) |
| GitHub Actions | unlimited (public repo) | ~240 min/month |
| Cloudflare Pages | unlimited bandwidth | trivial |

Storage stays flat no matter how many people use it — there's no per-user data. The first thing
you'd hit is Supabase egress, and that's a $25/mo Pro plan away.

**Two things to know:** free Supabase projects pause after a week of inactivity (the 6-hourly
sweep prevents this), and the free tier has no backups — though with no accounts there's nothing
irreplaceable, since the whole corpus rebuilds from one sweep.

---

## Known limits

- **Live mode samples randomly.** ~30 companies out of 15,862 per search, so results differ
  each time and most searches find little. That's expected — it's a fallback so the site works
  before the corpus exists.
- **GitHub cron drifts** 15–30 minutes at peak. Fine for a corpus refresh.
- **Lever occasionally times out** at 15s. Adjust in `src/pipeline.ts`.
- **Tier-2 jobs have no descriptions**, so they score on title alone until promoted.
- **No dedupe across sources yet** beyond the normalized key — MinHash is deferred, see
  `../BOTTLENECKS.md` §5.

## Being a good citizen

These APIs are free and unauthenticated. The sweep uses ETags so unchanged boards cost nothing,
caps concurrency per host, and identifies itself in the user-agent. Don't raise
`--concurrency` much past 12.

Job data belongs to the companies posting it. The site links to the original posting and never
hosts applications.
