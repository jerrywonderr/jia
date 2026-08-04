# End-to-end test

A single-page proof that the registry-shaped pipeline works. Plain HTML/CSS/JS —
no server, no build step, no API keys, no dependencies.

## Run it

```bash
open index.html
```

That's it. `file://` works because all four upstream endpoints send
`Access-Control-Allow-Origin: *` — I checked before building:

```
raw.githubusercontent.com    access-control-allow-origin: *
boards-api.greenhouse.io     access-control-allow-origin: *
api.lever.co                 access-control-allow-origin: *
api.ashbyhq.com              access-control-allow-origin: *
```

If your browser is strict about local files, serve it instead:

```bash
python3 -m http.server 8000    # then open http://localhost:8000
```

## What it does

The full pipeline from the design docs, in order:

| Stage | What happens |
|---|---|
| **Registry** | Downloads the public token lists (8,333 Greenhouse + 4,368 Lever + 3,161 Ashby) |
| **Sample** | Random draw of N companies, plus any watchlist tokens you pin |
| **Fetch** | Concurrency pool with per-request timeouts; counts live vs. 404 |
| **Normalize** | Three different response shapes → one `Job` |
| **Dedupe** | Normalized `company + title + location` key (strips legal suffixes, seniority, punctuation) |
| **Filter** | Drops titles containing your exclusion terms |
| **Score** | Weighted keywords, title hits worth more than description hits, normalized to a % |
| **Render** | Ranked list with matched/missing keyword chips |

## Verified run

Live, 2026-08-03, sampling 30 random companies plus `stripe, ramp, leverdemo`:

```
probed           39
live             21 (54%)
dead / 404       18
jobs found     1081
after dedupe   1054
after filter    952
above cutoff    159
elapsed        30.2s
```

Top match was `React Native Engineer, Merchant Experience Mobile` at Stripe — which is
the pipeline doing exactly what it's for.

Two things that run confirmed:

- **The 54% live rate matches the 56% predicted** from the earlier sampling. Roughly
  half the registry has churned, so pruning is mandatory, and 404 detection is the
  cheap way to do it.
- **`minimumScore: 80` from the TDD would have returned zero jobs.** The highest score
  in a 1,081-job sample was 44%. Because the denominator is every point the config
  *could* award, and no real posting matches every keyword plus every bonus, realistic
  cutoffs live in the 15–40 range. Worth recalibrating in the spec.

## Scoring

Score is a **percentage of what's achievable**, not raw points — this fixes the
ambiguity flagged in `BOTTLENECKS.md` §6:

```
max   = sum(all keyword weights) + enabled bonuses
raw   = matched weights (title hits full, description hits × 0.6)
        + 20 remote + 10 salary-shown + up to 10 recency (decays over 30 days)
score = round(min(raw / max, 1) × 100)
```

Recency decays linearly rather than a flat cliff, so a 2-day-old post outranks a
25-day-old one.

## Optional: headless verification

`verify.mjs` loads this same page in jsdom and clicks Run, so you can check the
pipeline from a terminal:

```bash
npm install jsdom
node verify.mjs
```

Not part of the app — it's how the numbers above were produced.

## Known rough edges

- **Lever occasionally times out** at the 15s limit. Bump `REQUEST_TIMEOUT_MS` in
  `app.js` if you see it often.
- **Pinned watchlist tokens are tried against every enabled source**, so
  `ashby/stripe → failed` is expected noise (Stripe is on Greenhouse, not Ashby).
- **Dedupe looks weak** (~2.5% removed) because a random sample rarely contains the
  same job twice. Cross-source duplicates only show up at larger scale — that's where
  the MinHash tier from `BOTTLENECKS.md` §5 would earn its place.
- **No ETag caching.** The browser's HTTP cache does some of this for free, but the
  real implementation should store ETags per company as described in `BOTTLENECKS.md` §2.
- **Greenhouse needs `content=true`** for descriptions (bigger payload); Lever and
  Ashby include them free. The checkbox controls this.

## Be a polite citizen

These endpoints are free and unauthenticated. Keep the sample size and concurrency
modest while experimenting — there's no reason to sweep thousands of boards from a
browser tab.
