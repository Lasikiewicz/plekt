# File map: repository root, docs, scripts and tests

Part of the file map (with [file-map-server.md](file-map-server.md) and [file-map-public.md](file-map-public.md)). To look up a route or an exported function, use the generated [code-index.md](code-index.md). The architecture overview is in [architecture.md](architecture.md).

## Repository root

| File | What it is |
| --- | --- |
| `README.md` | User-facing GitHub readme: features, setup guide, configuration reference, screenshots. |
| `changelog.json` | Bundled release history. `scripts/promote-alpha-to-main.js` appends an entry and bumps the version locally, as part of "Force to main"; served verbatim at `GET /changelog.json` and consumed by the in-app changelog/update check. |
| `package.json` | Dependencies and npm scripts (`start`, `dev`, `test`, `build`, `docs:check`, `demo:verify`, `seed:demo`, `prepare`). Version is set locally by `scripts/promote-alpha-to-main.js` as part of "Force to main". |
| `package-lock.json` | Locked dependency tree. Version field is CI-managed alongside `package.json`. |
| `Dockerfile` | `node:25-trixie-slim` image: installs prod deps, copies `server/`, `public/`, `changelog.json`, creates the non-root `plekt` user, and uses the separate SQLite worker-health probe so synchronous maintenance cannot make the container fail its HTTP healthcheck. |
| `docker-compose.yml` | Published-image quick-start: port 5056, `./data:/data`, required admin password from `.env`. |
| `docker-compose.dev.yml` | Local source-build overlay with local image, optional Trakt credentials and resource limits. |
| `docker-compose.secure.yml` | Hardened overlay: read-only rootfs, tmpfs `/tmp`, required env vars (`ADMIN_PASSWORD`, `SESSION_SECRET`, `API_KEY`, `WEBHOOK_SECRET`), forces `COOKIE_SECURE=true`. |
| `.dockerignore` | Excludes `node_modules`, `data`, `docs`, `scratch`, markdown, and secrets from the Docker build context while whitelisting the required runtime scripts. |
| `.env.example` | Commented template of every supported environment variable - copy to `.env` (loaded by `server/src/env.js`). The variables are documented in the README [Configuration Reference](../README.md#configuration-reference); conventions are in [architecture-flows.md](architecture-flows.md#environment-variables). |
| `website/` | Static Astro documentation site. Its build reads the root release data and shared assets, runs the website checks, and outputs `website/dist/` for Cloudflare Pages. |
| `.editorconfig` | Editor whitespace/indent conventions. |
| `.gitattributes` | Normalizes line endings to LF; marks image formats binary. |
| `.gitignore` | Ignores `node_modules`, `data/`, logs, local env files. |
| `.githooks/commit-msg`, `.githooks/pre-push` | Git hooks installed by `scripts/install-git-hooks.js`: release commit messages must contain meaningful changelog bullets; a same-name push merges `origin/<current-branch>` first, a push to `develop` validates its committed changelog with `rebuild-develop-changelog.js --check`, and every push runs `npm run build`. Cross-ref pushes skip the sync step because their branch state was reconciled by the promotion workflow. |
| `.claude/skills/` | Repository-local release, publishing, and local-development procedures referenced by `CLAUDE.md`, including the `push-website-live` and `start-website` website workflows. |
| `LICENSE.md` | Project license. |
| `SECURITY.md` | Vulnerability reporting policy. |
| `CONTRIBUTING.md` | Contribution guidelines. |
| `CODE_OF_CONDUCT.md` | Community code of conduct. |

## `.github/`

| File | What it is |
| --- | --- |
| `workflows/update-changelog.yml` (workflow name "Publish Main Release") | On every push to `main`: runs the full build gate, reads the version already committed by "Force to main" (`scripts/promote-alpha-to-main.js`, run locally before the push), builds/pushes a multi-architecture Docker image to GHCR tagged `latest` + the version, creates or updates the matching formatted GitHub Release through `scripts/publish-github-release.js`, then deploys the exact version tag to the OCI-hosted public demo and verifies it. Does not write anything back to the branch. |
| `workflows/docker-publish-alpha.yml`, `workflows/docker-publish-develop.yml` | The same shape for `alpha`/`develop`: verify, then build/push a rolling image (`alpha`/`alpha-<build>`, `develop`/`develop-<build>`) using the build number already committed by "Force to alpha" / "Push to git". Alpha also creates or updates its matching numbered GitHub prerelease with generated notes. Neither writes anything back to its branch. `docker-publish-develop.yml` has `paths-ignore` for `changelog.develop.json`/`changelog.alpha.json`, since "Force to alpha" step 4 pushes to `develop` with only those two files changed - the app's own live remote-fetch changelog comparison reads that file straight from GitHub regardless of whether a new image was built, so that push was never meant to also trigger a full rebuild. |
| `workflows/docker-publish.yml` | Manual (`workflow_dispatch`) Docker build & push to GHCR, without touching the changelog. |
| `workflows/security.yml` | `npm audit` (high+) and CodeQL on push/PR/daily schedule. |
| `workflows/secret-scan.yml` | TruffleHog verified-secret scan on push/PR. |
| `dependabot.yml` | Automated dependency update PRs. |
| `ISSUE_TEMPLATE/bug_report.md`, `ISSUE_TEMPLATE/feature_request.md`, `ISSUE_TEMPLATE/config.yml` | GitHub issue forms. |
| `PULL_REQUEST_TEMPLATE.md` | PR description template. |

## `docs/`

See [README.md](README.md) for the documentation index, including
[architecture.md](architecture.md), the file map files and the per-feature sources of truth.
`code-index.md` is generated by `npm run code-index` (route paths and exported names per
source file); never edit it by hand.
`decisions.md` records why the non-obvious design and release-pipeline calls were made,
and what was rejected; the feature docs describe current behavior, so read `decisions.md`
before reversing something that looks unnecessarily cautious.
`docs/screenshots/` holds the PNG screenshots embedded in the root README (`bio.png`,
`history.png`, `media.png`, `movies.png`, `now-playing.png`, `part-watched.png`,
`search.png`, `stats.png`, `tvshows.png`).

## `scripts/`

`workflow-check.js` provides read-only push/alpha/main prechecks, narrow-scope baseline,
candidate identity, staged-path and safe local develop-reconciliation gates.
`verify-release-website.js` checks the released website's changelog, guide URLs and
homepage screenshot content hashes/bytes. Neither script acquires a lock or publishes.

| File | What it is |
| --- | --- |
| `build-check.js` | The `npm run build` gate: syntax-checks every JS file, runs `docs-check.js`, validates the JSON manifests, rejects bare `fetch(` in `server/` (must be `fetchWithTimeout`), then boots the server once against a temp DATA_DIR (`PLEKT_BUILD_CHECK=1`). |
| `docs-check.js` | `npm run docs:check` - derives the required Node.js version from `package.json`, checks the README badge and setup text, rejects weak/default Docker password examples, and fails when `docs/code-index.md` is stale or would exceed 60 KB. |
| `generate-code-index.js` | `npm run code-index` - writes `docs/code-index.md`: every `dispatch()` route with its handler and file, and the sorted exported names of each `server/src/` and `public/modules/` file (first 8 per row). No line numbers, so it only changes when a route, file or export name does. |
| `changelog-message.js` | Shared changelog-message formatting, bullet extraction, release-detail validation, noise/release-process detection, and the `changelogEntryProcessViolations` safety check used by the local hooks, tests, and the three changelog scripts below. `synthesizeHeadline()` folds every commit/entry headline bundled into a release entry into one sentence naming all of them, rather than only the most recent one. `isReleaseToolingText()` strips bullets describing the release pipeline's own machinery (git hooks, CI workflows, the promotion scripts) by content, regardless of which commit type carried them, so a real feat/fix commit's bullet list can't leak dev-tooling notes into a changelog end users read. |
| `changelog-git-helpers.js` | Shared git plumbing for the changelog scripts: walks real commit history between an anchor and HEAD (`commitsSinceLastEntry`), lists a commit's changed files, and reads the current HEAD commit/author. |
| `validate-commit-message.js` | CLI used by the commit-message hook to reject user-visible release commits with missing or title-repeating details. |
| `rebuild-develop-changelog.js` | Run locally as part of "Push to git" (CLAUDE.md), before the push: fully recomputes `changelog.develop.json`'s single entry from every real commit between its `resetCommit` anchor and HEAD, replacing it rather than appending. Its `--check <commit>` mode validates the committed changelog tree used by the develop pre-push guard without modifying files. |
| `promote-develop-to-alpha.js` | Run locally as part of "Force to alpha", before the force-push: packages develop's current entry as its own standalone alpha build entry, prepended to alpha's `entries` (`promoteDevelopToAlpha`), bumps the alpha build, and resets develop for the next cycle. Also exports `categorizeEntries`/`simplifyEntries`/`formatSections`/`mergeSections`, shared with the script below. |
| `promote-alpha-to-main.js` | Run locally as part of "Force to main", before the force-push: consolidates every alpha build entry accumulated this cycle into one release entry (`promoteAlphaToMain`), bumps the real semver (honouring a manually-set higher `package.json` version), writes `changelog.json`/`package.json`/`package-lock.json`/`CHANGELOG.md`, resets alpha, and resets develop to the released version at build 1 for the next cycle. `--preview` runs the same computation read-only and prints the would-be release entry so a human can approve the changelog before anything is staged or pushed; it lists any website guides the content-impact gate still needs without stopping, while `--confirm` refuses until none remain. |
| `deploy-oracle-demo.sh` | Copied to the dedicated OCI instance by the main-release workflow; pulls one exact GHCR release tag, recreates only the configured demo container, preserves its `/data` mount, and starts it in isolated public-demo mode. |
| `verify-oracle-demo.js` | Main-release smoke check: confirms the OCI public demo's health endpoint, public-demo guardrail, and `/changelog.json` all match the released version. |
| `generate-release-notes.js` | Renders the committed main or alpha changelog entry into the formatted GitHub Release body: categorized changes, safe-start guidance, limitations, Docker tags, Windows installer status, and project links. Supports a local Markdown preview with `node scripts/generate-release-notes.js <main|alpha>`. |
| `publish-github-release.js` | CI helper called by the main image, alpha image, and Windows installer workflows: creates or updates the matching GitHub Release from `generate-release-notes.js`, marks alpha builds as prereleases, and handles two workflows finishing at the same time without duplicate releases. |
| `notify-discord-release.js` | CI helper called by `update-changelog.yml` (`main`) and `docker-publish-alpha.yml` (`alpha`): builds a Discord embed from the newest `changelog.json`/`changelog.alpha.json` entry and posts it to the `DISCORD_RELEASES_WEBHOOK` secret. No-ops if the secret isn't set; supports `--dry-run` to print the embed instead of posting. |
| `install-git-hooks.js` | Sets `core.hooksPath` to `.githooks` (runs automatically via npm `prepare`). |
| `docker-entrypoint.sh` | Container entrypoint: chowns `/data` when starting as root, then drops to the `plekt` user via gosu. |
| `exportPlexHistory.js` | Standalone one-shot importer: reads a Plex server's watch history over its API and posts it to `/api/import` in chunks. Driven by env vars (`PLEX_URL`, `PLEX_TOKEN`, `API_KEY`). |
| `forcePushHistory.js` | Standalone one-shot replicator: fetches Plekt's `/api/history` and replays every row against Plex/Emby/Jellyfin as mark-played calls. |
| `seed-demo-content.js` | `npm run seed:demo` - inserts fictional movies/shows with generated poster art for demo screenshots/dev. |
| `generate-synthetic-library.js` | Builds a disposable library at a stated scale for performance measurement, parameterized by movies, shows, episodes per show, history rows, TMDB cache blob size, and poster pool. Writes only to the `--data-dir` it is given, refuses a directory holding a database it did not create, and drops a `synthetic-library.json` marker recording the parameters and resulting counts. |
| `browser-route-benchmark.js` | Browser-side route benchmark for the application-speed plan: pasted or injected into a signed-in tab, it drives one same-origin popup (the app sends `X-Frame-Options: DENY`) through document loads or SPA transitions and reports TTFB, load, FCP, LCP, detail primary-ready, request/transfer/decoded totals, the shell subset, and a per-path request inventory. Never handles credentials. |
| `browser-route-benchmark-playwright.js`, `phase-g-*-playwright.js` | Phase G helpers for the application-speed plan. Each file is one Playwright page function pasted into the Playwright MCP browser tool, not a `node` script: the warm route matrix, the non-mutating smoke pass, the CLS diagnostic and follow-up, and isolated auth expiry/restoration. None enters credentials or changes provider state. |
| `benchmark-surfaces.js` | Records the server-side surface baseline against a generated library (dashboard payload, stats, History/Movies/Shows page N, and a cold full cache rebuild) and writes it to `docs/benchmarks/`. Each measured result includes a SHA-256 payload fingerprint so before/after timing runs can also prove byte-identical output. Makes no database writes: the cold rebuild is measured from a fresh process's first read of each cache rather than by forcing a miss. |

## `test/`

The focused `node:test` suite run by `npm test` and the build check. Each file runs in
its own process; DB-backed tests point `DATA_DIR` at a temp directory before importing
server modules.

| File | What it covers |
| --- | --- |
| `changelogMessage.test.js` | Changelog subject formatting, bullet extraction, and rejection of missing or title-repeating release details. |
| `parsers.test.js` | Webhook normalization (Plex/Emby/Jellyfin/custom payload parsing, phases, GUID extraction). |
| `mediaKey.test.js` | Canonical `mediaKeyFor`/`canonicalTitleKey` derivation and specials (season 0) normalization in watch records. |
| `syncOrchestrator.test.js` | Target routing, resume-progress actionability, loop-store echo detection. |
| `mediaForceSync.test.js` | Title-scoped Force Sync mode/target normalization, watched Plex/Emby item shaping, and duplicate-quality Jellyfin episode matching. |
| `mediaForceSyncTrackerPhases.test.js` | Local-first detail Force Sync ordering, independently bounded Trakt work, combined partial outcomes, and cancellation of queued tracker items. |
| `scheduledResumeAuthority.test.js` | Timestamp and canonical-state precedence for webhook and scheduled resume candidates, including stale acknowledgements and explicit unwatches. |
| `staleRestoreScheduler.test.js` | Scheduler admission recovers orphaned restores while preserving fresh heartbeats and replacement operation owners. |
| `defaultShowSeason.test.js` | Latest regular season selection, preserving collapsed seasons, explicit season links, and load-ready deep-link scrolling. |
| `syncRetry.test.js` | Scheduled-dispatch retry backoff schedule/eligibility, retry columns, permanent `sync_history` pagination. |
| `bulkMarkWatchedPerformance.test.js` | Bulk-watch dispatch identity grouping, scheduler deferral threshold, provider fan-out, and single-flight series/episode lookup coverage. |
| `metadataCaches.test.js` | Fanart response cache (hits and negative misses), TMDB details cache freshness, light-vs-full cache row semantics. |
| `tenancySingleProcess.test.js` | Single-process multi-user tenancy core, `users.json` registry, AsyncLocalStorage context, per-user DB isolation, `/u/<name>/api/ping`, and stopped-user 503 enforcement. |
| `sharedAssets.test.js` | Shared artwork (`data/media/`), concurrent atomic artwork writes, non-admin clear-cache/wipe-data protection, shared provider metadata caches (`shared-metadata.db`), shared metadata API keys, and tenant secret isolation. |
| `multiUserWebhooksAndAuth.test.js` | Multi-user sign-in, session isolation, admin user switching (`open`), `/api/users` management actions, per-user webhook and API-key routing, and in-place admin migration/downgrade safety. |
| `exportPlexHistory.test.js` | The standalone Plex history export script's episode-record shaping (specials season zero). |
| `trackerSettings.test.js` | Live Trakt Sync Now completion summary counts and wording. |
| `upNextIdentity.test.js` | Canonical mixed movie/episode identity, provider-ID aliases, deterministic ordering, and queue merging. |
| `upNextQueue.test.js` | Unified Up Next projection, local resume precedence, canonical watched-state filtering, and bounded metadata fallback. |
| `upNextProviderFeeds.test.js` | Generation-based provider feed snapshots, last-good retention, source-ledger metadata, and credential-redacted errors. |

## Reddit release app (retired)

The Devvit implementation and dependency lock have been removed. The `reddit-app/`
directory retains its README, privacy policy and terms because the external Developer
Platform listing may still link to them. The legacy installation in r/plembfin was
uninstalled on 2026-10-19; a follow-up CLI listing showed no apps installed there. The
Developer Platform listing remains, and other community installations were not changed;
see [`reddit-app/README.md`](../reddit-app/README.md).
