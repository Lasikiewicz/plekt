# Application speed Phase G matrix - 18 September 2026

The release-verification matrix for
[`plan/archive/application-speed-remediation/plan.md`](../../plan/archive/application-speed-remediation/plan.md),
taken after step 49 on the `develop` working tree. It covers the 12 main routes plus Ludwig,
Reacher, Bad Grandpa, and A Quiet Place, six samples per route per population, two
back-to-back populations, the first round of each population discarded.

## Method

- **Harness:** [`scripts/browser-route-benchmark.js`](../../scripts/browser-route-benchmark.js),
  run in the user's signed-in Chrome 153 profile. The app sends `X-Frame-Options: DENY`, so
  samples load in one same-origin popup window; the harness reads that window's Navigation,
  Paint, LCP, Resource Timing, and `plembfin:detail-primary-ready` entries and never handles
  credentials.
- **Document populations:** full document loads with a unique `?bench=` query, paced 1.2 s
  apart. A sample settles after 800 ms without new resources (and, on detail pages, after the
  primary-ready mark), capped at 12 s.
- **SPA populations:** one `/about` document per population, then `history.pushState` +
  `popstate` to each route (the path the app's own navigation uses). Time is measured from the
  push to the end of the last response the transition issued.
- **Server:** `npm start` (`ROLE=all`, the default combined web + worker process) with
  `PLEMBFIN_DEV_NO_CACHE_ASSETS=1`, so every document load re-downloads the versioned shell
  (a cold asset cache). Plex, Emby, Jellyfin, Trakt, and TMDB were configured and reachable.
- The load event on this server fires at about 80-100 ms, before the module graph finishes, so
  it is not treated as the user-experience metric (section 7 of the plan). FCP, LCP, the
  settled request inventory, and the detail primary-ready mark are reported beside it.

Raw summaries: [cold document JSON](application-speed-2026-09-18-phase-g-cold-matrix.json),
[SPA JSON](application-speed-2026-09-18-phase-g-spa-matrix.json).

## Cold document loads (`ROLE=all`)

Population A / population B medians. Shell = the document plus every non-API, non-image
resource.

| Route | Load (ms) | TTFB p95 (ms) | FCP (ms) | LCP (ms) | Primary ready (ms) | Requests | API | Images | Shell requests / transfer / decoded |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `/` | 92 / 77 | 12 / 19 | 192 / 192 | 240 / 252 | - | 75 | 17 | 23 | 35 / 350 KB / 1.71 MB |
| `/movies` | 88 / 102 | 21 / 10 | 188 / 176 | 360 / 396 | - | 110 | 10 | 66 | 34 / 334 KB / 1.66 MB |
| `/tvshows` | 92 / 86 | 16 / 11 | 184 / 176 | 356 / 372 | - | 95 | 13 | 48 | 34 / 334 KB / 1.66 MB |
| `/upcoming` | 85 / 95 | 20 / 9 | 188 / 284 | 188 / 284 | - | 68 / 78 | 15 / 20 | 23 / 26 | 32 / 309 KB / 1.56 MB |
| `/discover` | 99 / 83 | 9 / 11 | 172 / 180 | 404 / 396 | - | 71 | 15 | 24 | 32 / 307 KB / 1.55 MB |
| `/watchlist` | 83 / 91 | 9 / 166 | 172 / 160 | 232 / 412 | - | 71 | 12 | 27 | 32 / 307 KB / 1.55 MB |
| `/ratings` | 90 / 88 | 10 / 10 | 164 / 176 | 288 / 260 | - | 71 | 12 | 28 | 32 / 307 KB / 1.55 MB |
| `/custom-lists` | 92 / 81 | 9 / 12 | 164 / 172 | 256 / 268 | - | 48 / 50 | 12 | 4 | 32 / 307 KB / 1.55 MB |
| `/history` | 84 / 85 | 9 / 9 | 168 / 168 | 792 / 780 | - | 73 | 21 | 18 | 34 / 334 KB / 1.66 MB |
| `/stats` | 83 / 82 | 24 / 9 | 176 / 188 | 220 / 240 | - | 48 | 10 | 12 | 26 / 281 KB / 1.45 MB |
| `/settings` | 93 / 88 | 23 / 13 | 184 / 188 | 184 / 188 | - | 70 | 16 | 2 | 52 / 514 KB / 2.33 MB |
| `/about` | 95 / 86 | 23 / 18 | 176 / 172 | 176 / 176 | - | 36 | 9 | 2 | 25 / 275 KB / 1.43 MB |
| Ludwig (TV) | 87 / 89 | 13 / 9 | 164 / 172 | 680 / 748 | 726 / 748 | 83 / 82 | 16 / 15 | 21 | 46 / 475 KB / 2.21 MB |
| Reacher (TV) | 87 / 82 | 18 / 14 | 156 / 176 | 492 / 740 | 750 / 706 | 84 | 14 | 24 | 46 / 475 KB / 2.21 MB |
| Bad Grandpa (movie) | 88 / 88 | 13 / 19 | 160 / 160 | 336 / 356 | 289 / 286 | 89 | 15 | 28 | 46 / 475 KB / 2.21 MB |
| A Quiet Place (movie) | 84 / 86 | 13 / 10 | 164 / 180 | 312 / 328 | 277 / 275 | 94 | 14 | 34 | 46 / 475 KB / 2.21 MB |

Across the 160 measured samples: **TTFB median 8.8 ms, p95 19.3 ms, max 166.3 ms**; slowest
load event 354 ms; **0 loads over 5 s**; 0 HTTP 429; 0 HTTP 5xx. One `/tvshows` sample hit
the 12 s settle cap because its poster grid kept loading; its timings are still valid. Ten
samples were taken while the controlling tab was hidden, which affects pacing only.

TV detail total transfer was 583-606 KB and movie detail 584-594 KB, all under the 2.0 MB
budget.

## SPA transitions (`ROLE=all`)

| Route | Settled (ms, A / B) | p95 (ms, A / B) | Primary ready (ms) | Requests | API | Images |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/` | 419 / 419 | 443 / 511 | - | 4 | 4 | 0 |
| `/movies` | 98 / 106 | 115 / 110 | - | 41 | 1 | 40 |
| `/tvshows` | 193 / 200 | 206 / 225 | - | 21 | 2 | 19 |
| `/upcoming` | 89 / 90 | 96 / 593 | - | 2 | 2 | 0 |
| `/discover` | 117 / 117 | 136 / 133 | - | 3 | 3 | 0 |
| `/watchlist` | 61 / 64 | 65 / 66 | - | 4 | 2 | 2 |
| `/ratings` | 96 / 105 | 396 / 855 | - | 4 | 3 | 1 |
| `/custom-lists` | 23 / 23 | 24 / 23 | - | 2 | 2 | 0 |
| `/history` | 472 / 481 | 740 / 503 | - | 2 | 2 | 0 |
| `/stats` | 27 / 26 | 34 / 337 | - | 2 | 2 | 0 |
| `/settings` | 32 / 33 | 39 / 34 | - | 6 | 6 | 0 |
| `/about` | 23 / 22 | 147 / 23 | - | 1 | 1 | 0 |
| Ludwig (TV) | 234 / 235 | 274 / 288 | 223 / 224 | 17 | 2 | 15 |
| Reacher (TV) | 221 / 200 | 234 / 728 | 213 / 220 | 17 | 2 | 15 |
| Bad Grandpa (movie) | 196 / 196 | 608 / 219 | 36 / 77 | 25 | 4 | 21 |
| A Quiet Place (movie) | 130 / 107 | 863 / 136 | 73 / 33 | 26 | 3 | 23 |

0 transitions over 5 s, 0 settle-cap hits, 0 HTTP 429, 0 HTTP 5xx. An earlier SPA attempt
the same evening recorded zero requests because Chrome's 250-entry Resource Timing buffer had
filled; the harness now enlarges the buffer and that attempt is not used.

## Gate results

| Gate | Result |
| --- | --- |
| Document TTFB p95 <= 500 ms (localhost) | **Pass**: 19.3 ms over 160 cold samples |
| No navigation stall above 5 s | **Pass**: 0 of 192 document loads and 0 of 192 SPA transitions |
| Main-route load <= 2.0 s | **Pass**: slowest load event 354 ms; slowest LCP 792 ms (`/history`) |
| TV detail primary ready <= 2.5 s; <= 30 API; <= 35 images; <= 2.0 MB | **Pass** cold and SPA: 706-750 ms cold, 213-224 ms SPA; 14-16 API; 21-24 images; about 0.6 MB |
| Movie detail primary ready <= 2.0 s | **Pass** cold and SPA: 275-289 ms cold, 33-77 ms SPA |
| Critical shell <= 35 requests / 600 KB / 1.75 MB (Dashboard and About, the Phase C gate) | **Pass**: Dashboard 35 / 350 KB / 1.71 MB; About 25 / 275 KB / 1.43 MB |
| Two populations within 15% (load and ready time) | **Ready time passes** (every detail page within 6%). **Load passes on 13 of 16 routes**; `/` (-15.9%), `/discover` (-16.2%), and `/movies` (+15.4%) differ by 14-16 ms on medians of about 85 ms, at the timer noise floor. Recorded as a measured exception, not a pass. |

Not a gate but worth recording: the heavier route shells are Settings (52 / 514 KB / 2.33 MB)
and the detail pages (46 / 475 KB / 2.21 MB). The plan's shell budget is written for the
first-paint shell; these routes are above it once their own route graph has settled.
