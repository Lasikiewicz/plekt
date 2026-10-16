# Application speed final verification - 19 September 2026

The closing verification for
[`plan/archive/application-speed-remediation/plan.md`](../../plan/archive/application-speed-remediation/plan.md), taken on
the `develop` working tree after step 62. It re-measures the server, the unauthenticated shell,
and the signed-in dashboard startup on the current code.

## What was and was not measured

- **The first attempt at the signed-in matrix was discarded.** The Chrome window holding the
  signed-in session was minimized, so Chrome throttled the harness and stopped painting; none
  of its 97 samples are used. Sections 1-6 were measured instead, without any password, session
  token, or API key.
- **The signed-in matrix was then re-run in a visible window** after the logo and font fixes
  (section 7): 160 cold document loads and 160 SPA transitions, every sample confirmed visible.
  Section 8 checks production caching on a second, `ROLE=web` server.

Environment: Windows 11, Intel i7-12700KF (20 threads), Node 22.23.1, Chrome 153. Library:
9,026 watch-history rows, 657 movies, 7,621 episodes across 310 shows, 677 MB database. Server:
`npm run dev` (`ROLE=all`, web and worker in one process, `PLEMBFIN_DEV_NO_CACHE_ASSETS=1`, so
every asset is re-sent: a cold asset cache), with Plex, Emby, Jellyfin, Trakt, and TMDB configured.

## 1. Document and shell delivery (Node, no credentials)

[`application-speed-2026-09-19-final-http.json`](application-speed-2026-09-19-final-http.json).
All 16 benchmark routes, six loads per route per population, two populations, first run of each
route discarded (160 measured loads), then every asset `index.html` references.

| | Population A | Population B |
| --- | ---: | ---: |
| Document TTFB median / p95 / max | 4.5 / 7.0 / 18.6 ms | 4.7 / 9.2 / 131.4 ms |
| Slowest complete document | 18.7 ms | 131.9 ms |
| Loads over 5 s | 0 | 0 |
| HTTP 429 / 5xx / errors | 0 / 0 / 0 | 0 / 0 / 0 |
| Shell assets referenced by `index.html` | 20, 347 KB on the wire, all compressed | same |

Per-route median TTFB was 4.2-5.8 ms in both populations. `/health`, `/version.json` (19-byte
body), and `/favicon.ico` (SVG) answered in 1.5-2.7 ms.

## 2. Stall probes (Node, no credentials)

[`application-speed-2026-09-19-final-stall-probes.json`](application-speed-2026-09-19-final-stall-probes.json).

- **Probe 1**, 4 minutes, one request every 500 ms (documents and `/health`): 463 samples,
  median 3.1 ms, p95 9.8 ms, **p99 442 ms, max 1,173 ms**. The five samples over 300 ms were
  all documents, all inside one 16-second window (09:28:39-09:28:55 UTC); the interleaved
  `/health` requests in that window were not slow. The cause was not identified: the live
  server's output goes to its own console, which was not available.
- **Probe 2**, 6 minutes, one request every 250 ms rotating document, `/health`, a static
  module, and `/version.json`: 1,372 samples, **none over 300 ms**. Document median 5 ms, p99
  24 ms, max 89 ms; `/health` max 251 ms.

The 5-second stall gate is met in both. The probe 1 cluster is recorded as observed and not
reproduced, not as explained.

## 3. Server-side surfaces (in-process, copy of the real database)

[`application-speed-2026-09-19-final-surfaces.json`](application-speed-2026-09-19-final-surfaces.json),
`scripts/benchmark-surfaces.js --runs 5` against a copy taken with the SQLite online backup API.
The copy had no provider keys, so its show-progress rebuild logged expected TMDB lookup failures.

| Surface | Median | Spread |
| --- | ---: | ---: |
| Dashboard payload | 202 ms | 4.9% |
| History page 1 / 5 / 10 | 193 / 211 / 210 ms | 3.5-8.1% |
| Movies and Shows pages, cached stats | under 1 ms | below the 50 ms floor |
| Cold full cache rebuild (one pass) | 1,099 ms | - |

## 4. Unauthenticated shell in a real browser (Chrome DevTools, visible, not throttled)

Fresh isolated browser contexts, cache bypassed. Without a session every route renders the
sign-in shell, so this measures the document, the core module graph, fonts, and the logo.

| Load | TTFB | FCP / LCP | CLS | Requests | Transfer |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/about`, desktop | 11 ms | 120 ms | 0 | 25 | 323 KB |
| `/about`, desktop | 6 ms | 96 ms | 0 | 26 | 323 KB |
| `/`, desktop | 6 ms | 92 ms | 0 | 33 | 378 KB |
| `/about`, 390 px, Slow 4G | 243 ms | 3,684 ms | 0 | 26 | 323 KB |

The Slow 4G first paint waits for the module graph (DOMContentLoaded 3,074 ms); the plan sets no
Slow 4G budget. No horizontal scroll at 390 px.

**First visit to a new browser profile:** FCP was about 2 s. Google Fonts is loaded by an
`@import` on line 1 of `public/styles.css` (unchanged from before this plan); the font CSS
request took 1.07 s and is render-blocking, and an `@import` is only discovered after
`styles.css` downloads. Repeat visits are cached. The 788 ms TTFB on those first loads was spent
inside Chrome before the request was sent (`fetchStart` 0, `requestStart` 785 ms); the server
answered in 3 ms.

## 5. Signed-in dashboard startup (user's Chrome, one fresh load after the step 62 fixes)

In the first 5 s: `/api/history`, `/api/up-next` (`allowStale`), the manual-review summary,
sync attention, setup status, `/api/config`, and `/api/appearance` once each. Before the step 62
fix the same check showed `/api/history` two to three times. Tracker, rating-sync, and
watchlist-sync status do not load on the dashboard (Settings-scoped since step 25). The Up Next
snapshot on that load was fresh, so no follow-up request was needed.

Separately, on the first check of this pass the dashboard's Up Next cards issued seven
`/api/media-app-links` provider lookups in parallel, three taking about 8 s. They do not block the
dashboard (history and Up Next rendered first) and are the provider-availability path already
tracked as `plan/active/speed/step15-findings-scorecard.md` finding AJ.

## 6. Header logo (Phase F), before the fix

Phase F recorded "one header-logo transfer per initial load". That holds only when the page's
theme is dark. `index.html` hard-codes the dark image for the sidebar and sign-in logos, and
`initializeTheme()` switches them after `app.js` runs, so **every light-mode load downloads both
images (the unused dark one is 60 KB)**. A `<picture>` with a `prefers-color-scheme` source was tried in this
pass: it fixed the no-saved-theme case but made a saved dark theme on a light-preference system
(the configuration of the user's own browser) fetch both, because the preload scanner cannot
read the saved theme. It was reverted. The user then asked for a correct fix; section 9 describes it.
While testing, Chrome also replayed a learned preload of whichever logo was the LCP image on
earlier visits; a fresh profile does not show it.

## 7. Signed-in route matrix, re-run on the final code

[`application-speed-2026-09-19-final-signed-in.json`](application-speed-2026-09-19-final-signed-in.json).
Same harness and routes as the 18 September Phase G matrix, run in the user's signed-in Chrome with
the window visible (maximized, 2560x1392) and the measurement popup beside it. Every one of the
320 measured samples was recorded as visible. Server: `npm run dev` (`ROLE=all`, cold asset cache).

**Cold document loads** (160 measured): 0 incomplete, 0 over 5 s, 0 HTTP 429/5xx. TTFB median
11.7 ms, p95 34.4 ms. Route load-event medians 91-186 ms. Detail primary-ready medians: Ludwig
969 / 996 ms, Reacher 559 / 585 ms, Bad Grandpa 265 / 256 ms, A Quiet Place 221 / 234 ms, all
inside the 2.5 s / 2.0 s budgets, with 14-16 API and 24-34 image requests per detail page. Shell
(document plus non-API, non-image resources): Dashboard 34 requests / 306 KB / 1.65 MB decoded,
About 24 / 303 KB / 1.38 MB, both inside the 35 / 600 KB / 1.75 MB budget.

Three samples in one stretch of population A had slow TTFB: `/custom-lists` 1,986 ms (load
2,222 ms, the only sample over 2 s), A Quiet Place 940 ms, `/watchlist` 479 ms. This matches the
stall-probe cluster in section 2: documents slow while `/health` is not. That fits the libuv
thread pool (file reads and gzip for every re-sent asset in this no-cache mode, plus poster
`sharp` work) being saturated rather than the event loop. Not proven; section 8 shows that
production caching removes nearly all of that per-load file and compression work.

**SPA transitions** (160 measured): 0 timed out, 0 over 5 s, 0 HTTP 429/5xx, slowest settle
1,574 ms. Compared with 18 September: `/history` 472 -> about 930 ms, Dashboard 419 -> 657 ms,
TV detail primary-ready about 220 -> 330 ms. The `/history` time is the `dedupe=false` history
page query: about 200 ms of synchronous SQLite work per request on a copy of the database
(552 ms cold), 400-730 ms on the busy live server, during which other requests wait (a parallel
`/api/now-playing` waited exactly as long). The query and its index are unchanged by this plan;
the cost has grown with the library. The `/history` LCP (1.5-1.6 s, was 792 ms) follows from it.

## 8. Production caching (second server, `ROLE=web`, `PLEMBFIN_DEV_NO_CACHE_ASSETS=0`)

The user's dev server was left running (stopping it was not permitted), so a second web-only
process on port 5057 served the same code with release caching; it runs no worker. Headers:
`theme-boot.js`, the fonts, both versioned logos, `styles.css`, and `app.js` are
`public, max-age=31536000, immutable`; the document is `no-cache`; the CSP is
`style-src 'self' 'unsafe-inline'; font-src 'self'`.

| Load (fresh browser context, dark scheme) | Result |
| --- | --- |
| First visit to `/about` | 26 requests, 363 KB, one logo, one font file, no external hosts, CLS 0 |
| Repeat visit | FCP 84 ms; only the document and three small requests (`/analytics-config.json`, `/version.json`, `/api/auth/status`) reach the network, 32 KB |
| Four theme toggles | The light logo downloads once (53,688 B); every later toggle is served from cache |

## 9. Fixes made after this report's first version

- **Header logo.** A blocking `theme-boot.js` in `<head>` applies the saved or system theme
  before first paint and gives each `img[data-theme-logo]` its variant as it is parsed; the
  logo `<img>` tags carry no `src`, so the preload scanner cannot fetch the wrong one. Verified
  in fresh browser contexts for all four combinations (saved light, dark, or none; system light
  or dark): exactly one logo request each, CLS 0, no horizontal scroll at 390 px. The logos are
  now versioned, so production caches them immutably.
- **Fonts.** Outfit and JetBrains Mono are self-hosted from `public/fonts/` (copied from the
  `@fontsource-variable` packages the website already installs; SIL Open Font License texts
  included). The Google Fonts `@import` is gone and the CSP no longer allows Google origins.
  JetBrains Mono's Cyrillic, Greek, and Vietnamese subsets are not included; those characters
  fall back to the system monospace font.
- Final `npm run build`: 1,035/1,035 with documentation and asset-version checks.

## Gates

| Gate | Result |
| --- | --- |
| Document TTFB p95 <= 500 ms | **Pass**: 7.0 / 9.2 ms over 160 loads |
| No navigation stall over 5 s | **Pass**: 0 of 160 loads and 0 of 1,835 probe requests; one unexplained 16 s cluster up to 1.17 s |
| Main-route load <= 2.0 s (medians) | **Pass**: signed-in route medians 91-186 ms; one single sample reached 2,222 ms during the TTFB cluster (section 7) |
| Critical shell <= 35 requests / 600 KB / 1.75 MB | **Pass**: signed-in Dashboard 34 / 306 KB / 1.65 MB, About 24 / 303 KB / 1.38 MB |
| Detail primary ready (TV <= 2.5 s, movie <= 2.0 s) | **Pass**: 221-996 ms cold, 73-354 ms SPA |
| One header-logo transfer per load | **Pass after the section 9 fix**: one logo in all four saved/system combinations; toggles hit the cache in production |
| No external requests on the critical path | **Pass after the section 9 fix**: no Google Fonts requests |
| No CLS regression | **Pass**: 0 on every measured load |
