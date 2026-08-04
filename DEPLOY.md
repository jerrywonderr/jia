# Deploying — step by step

There is **no backend server**. What people usually mean by "the backend" is two hosted things:

| Piece | Where it runs | What it is |
|---|---|---|
| **Web** | Cloudflare Pages (or Netlify) | four static files |
| **Database + API** | Supabase | Postgres + an auto-generated REST endpoint |
| **The sweep** | GitHub Actions | a script on a 6-hour cron |

Nothing is always-on, so nothing costs anything. Total time: **~15 minutes.**

Do part 1 first — it gets you a working public URL before anything else exists.

---

## Part 1 — Deploy the web (3 min)

`web/` is four static files. With no database configured it runs in **live mode**: it fetches
company boards straight from the browser. Slower, samples a random slice, but genuinely works.
So you can publish now and wire up the database after.

### Cloudflare Pages (recommended — unlimited bandwidth)

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** tab → **Upload assets**
2. Project name, e.g. `job-intelligence`
3. Drag the **`v1.1/web`** folder onto the upload area
4. **Deploy site**

You get `job-intelligence.pages.dev`. That's live.

### Netlify Drop (fastest — no account needed to try)

Drag `v1.1/web` onto [app.netlify.com/drop](https://app.netlify.com/drop). Done in seconds.
Claim it to a free account if you want to keep the URL.

### GitHub Pages

Repo → **Settings** → **Pages** → Source: **Deploy from a branch** → `main` → folder `/`.
Note: Pages can't serve a subfolder directly, so you'd need `web/` at the repo root or a
small Action to publish it. The other two options are less fuss.

**Check it worked:** open the URL. The header badge should say `live`. Click **Search** — it
takes 20–40 seconds and returns a handful of jobs.

---

## Part 2 — Create the database (5 min)

1. [supabase.com](https://supabase.com) → sign up → **New project**
2. Fill in:
   - **Name:** anything
   - **Database password:** generate one and save it somewhere (you won't need it for this,
     but you can't retrieve it later)
   - **Region:** pick the one nearest you — this is your query latency
   - **Plan:** Free
3. Wait ~2 minutes while it provisions.

### Run the schema

**SQL Editor** (left sidebar) → **New query** → paste the entire contents of
`v1.1/supabase/schema.sql` → **Run**.

You should see `Success. No rows returned`. Check **Table Editor** — `companies`, `jobs`,
`runs`, and `feedback_events` should be there.

### Grab your keys

**Project Settings** (gear) → **API**. You need three values:

| Value | Used by | Secret? |
|---|---|---|
| **Project URL** | both | no |
| **anon / public** key | `web/config.js` | no — public by design |
| **service_role** key | `.env` and GitHub secret | **yes — never put this in `web/`** |

The anon key is safe to publish: row-level security limits it to reading the corpus and
inserting anonymous feedback. The service_role key bypasses RLS entirely.

---

## Part 3 — Fill the database (5 min)

On your own machine:

```bash
cd v1.1
cp .env.example .env
```

Edit `.env`:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOi...    # the service_role key
```

Then:

```bash
npm install
npm run seed          # ~15,862 companies, about a minute
```

First sweep — start small to confirm it works before committing to the full run:

```bash
npm run sweep -- --tier 2 --limit 300
```

Expect roughly: `live≈170  dead≈130  jobs≈4000`. About half the tokens returning 404 is normal
— the registry churns, and the sweep prunes as it goes.

Then the full run (~15 minutes cold, ~2 minutes on subsequent runs thanks to ETags):

```bash
npm run sweep
```

**If it fails:** `npm run sweep:dry` runs the whole pipeline with no database at all. If dry-run
works and the real one doesn't, the problem is your `.env`.

---

## Part 4 — Point the site at the database (2 min)

Edit `v1.1/web/config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',   // anon key, NOT service_role
};
```

Re-upload `web/` the same way as part 1. (Cloudflare Pages: project → **Create deployment** →
drag the folder again.)

The badge flips from `live` to `corpus`, the header shows job and company counts, and searches
become instant.

---

## Part 5 — Keep it fresh automatically (3 min)

Push the repo to GitHub, then:

**Settings** → **Secrets and variables** → **Actions** → **New repository secret**, twice:

| Name | Value |
|---|---|
| `SUPABASE_URL` | your project URL |
| `SUPABASE_SERVICE_KEY` | the service_role key |

`.github/workflows/sweep.yml` then runs every 6 hours. Trigger it manually the first time to
check: **Actions** tab → **sweep** → **Run workflow**.

> **Repo layout matters.** The workflow lives at `.github/workflows/sweep.yml` in the
> **repository root** and runs with `working-directory: v1.1`. So push the whole `job-board`
> folder as the repo. If you'd rather make `v1.1` the root, move the workflow to
> `.github/workflows/` there and delete the `working-directory` lines.

**Free minutes:** unlimited on a public repo, 2,000/month on a private one. A steady-state sweep
is ~2 minutes, so ~240 min/month — fine either way.

---

## Checklist

- [ ] Site loads, badge says `live`, search returns jobs
- [ ] Supabase project created, schema run, four tables visible
- [ ] `npm run seed` finished — `companies` has ~15,862 rows
- [ ] `npm run sweep -- --limit 300` produced jobs
- [ ] `web/config.js` filled in, site re-uploaded, badge says `corpus`
- [ ] Both GitHub secrets added, manual workflow run succeeded
- [ ] `service_role` key is **not** in `web/config.js` or anywhere in `web/`

---

## Troubleshooting

**Badge still says `live` after editing config.js** — you uploaded the old folder, or the
browser cached it. Hard-refresh (Cmd/Ctrl + Shift + R).

**`Missing SUPABASE_URL / SUPABASE_SERVICE_KEY`** — `.env` isn't being read. Confirm it's at
`v1.1/.env` and you're running from `v1.1/`.

**Searches return nothing in corpus mode** — the sweep hasn't run or found nothing matching.
Check `select count(*) from jobs;` in the SQL editor. Also drop the minimum-match slider: scores
are percentages of what your config could award, and realistic cutoffs are 15–40, not 80.

**`npm ci` fails in Actions** — `package-lock.json` must be committed. It's in `v1.1/`.

**Workflow doesn't appear in the Actions tab** — it must be at the repo root
`.github/workflows/`, not inside `v1.1/`. GitHub doesn't look in subfolders.

**Supabase project paused** — free projects sleep after a week of inactivity. Un-pause in the
dashboard; once the 6-hourly sweep is running it won't happen again.

**402 errors from Supabase** — you crossed a free-tier limit, most likely the 5 GB monthly
egress. It resets with the billing period.

---

## What it costs

| | Free tier | Expected |
|---|---|---|
| Cloudflare Pages | unlimited bandwidth | trivial |
| Supabase | 500 MB, 5 GB egress/mo | ~200 MB; egress is the first ceiling |
| GitHub Actions | unlimited public / 2,000 min private | ~240 min/mo |

**$0/month**, and storage stays flat no matter how many people use it — there's no per-user data.
The first thing you'd hit is Supabase egress at roughly 100k searches a month, and that's a
$25/mo Pro plan away.
