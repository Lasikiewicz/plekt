# Development, CI & Release Pipeline

How to run, check, ship, and release the app: npm scripts, the build check, git hooks,
GitHub Actions, Docker, and the changelog/versioning machinery.

## Related projects

- **Jellyfin plugin** - `C:\Github\jellyfin-plugin-plekt`, a separate repository for the
  Plekt Jellyfin server plugin. All work on the plugin is done from this plekt project; the
  plugin's own build and release steps are in its README. See [jellyfin.md](jellyfin.md#related-project-jellyfin-plugin).

## Workflow checks

Repository-local skills give the ordered release procedures and explicit approval stops.
Detailed candidate, website and publication operations are linked by phase, rather than
loaded for every step. Agents start with CLAUDE.md.

Read-only entry points: `npm run push:precheck`, `npm run alpha:precheck`, and
`npm run release:precheck` (each accepts `-- --dry-run`; prechecks never mutate anything).
They query GitHub cleanup/security state and local Git/lock facts; they do not fetch,
acquire locks, promote, push or treat successful checks as approval. API/auth failures
fail loudly; existing user-decision exceptions remain in the skills.

The push precheck prints GitHub's open security alerts. CodeQL #64
(`website/scripts/recapture.mjs`) is the old `main` instance; its image-source allow-list
is in `develop`. Dependabot #15 (`braces`) is auto-dismissed. Dependabot #17 (`sprintf-js`)
still refers to the legacy Devvit lockfile on the default branch; the Devvit source and
lockfile are retired from `develop`, and GitHub should close the alert after that removal
reaches the default branch. The exact #17 fingerprint is logged as a temporary note only
while the source is absent. The check does not dismiss alerts. Any other alert, changed
fingerprint, or missing fix keeps the normal blocking rule for high/critical or changed-file
findings. See [decision 50](decisions.md#50-retire-the-reddit-release-app-from-the-repository).

`npm run release:candidate -- <record.json>` checks pinned refs, detached HEAD, port 5056
ownership and release metadata. `node scripts/workflow-check.js staged` checks sensitive
paths, README consistency and asset stamps against an index-matching worktree.
`before-push push|alpha|main` reruns the
publication checks without bypassing the pre-push build hook. `release:reconcile` refuses
missing develop content; only source/asset and known root-manifest version fields are
normalized. Every listed commit still needs human review.
`release:verify-live -- <version>` verifies the published website.

These checks cannot establish wording quality, capture privacy/accuracy or user approval.
Candidate startup uses an absolute launcher path so the checker can tie its PID to the
recorded checkout; manual process ownership review remains required.
The candidate `--confirm`/outstanding-website ordering contradiction
is recorded for a separately approved fix; no bypass was introduced.

## Formerly Plembfin

Use the new image and repository names in new examples. Existing Docker installs
change only the image name and retain their tag, volumes, data and secrets; both
old image names remain published for at least six months after the rebrand release.
Stable releases publish both GHCR names and both Docker Hub names; alpha/develop
publish both GHCR names only. `PLEKT_*` variables are preferred, with nonblank new
values taking precedence over `PLEMBFIN_*`; both webhook-secret header names work.

Persisted identifiers remain deliberately unchanged: old databases (`plembfin.db`),
`backups/plembfin`, cookies, browser storage, provider device ids, database source
values and `/api/plembfin-backups` routes. Fresh databases and new backups use Plekt
names. Old backups remain supported, but new ones cannot restore on older builds.
The Windows installer prepares an in-place service/data-folder migration; real
upgrade verification remains required. See [decision 44](decisions.md#44-plekt-keeps-legacy-identifiers-to-preserve-existing-installs).

The local lifecycle skill is `plekt-local-stack`; checkout path, server log and release lock
retain their existing identifiers. Renaming the checkout also requires migrating local
agent memory and path settings. The demo hostname and Cloudflare project retain
their configured names until the separate website release work.

GHCR cleanup targets `plekt` explicitly and stays in dry-run mode until the new
package results are reviewed. The repository rename, raw changelog redirect probe,
registry publication and live upgrade checks have not been performed as part of
this local preparation.

## Local development

```bash
npm install       # prebuilt binaries for better-sqlite3 + sharp; also installs git hooks (prepare)
npm start         # serve the local checkout as a develop build
npm run dev       # same, with --watch auto-reload
npm test          # node:test suite in test/**/*.test.js
npm run test:multiprocess # real isolated web/worker replica test
npm run docs:check # verify README setup guidance matches package/runtime requirements, and docs/code-index.md is current
npm run code-index # regenerate docs/code-index.md after adding, removing or renaming a route, source file or export
npm run build     # syntax check + npm test + server boot gate
npm run seed:demo # insert fictional demo movies/shows with generated posters
npm run server:restart # stop whatever listens on PORT, start detached, wait for /api/ping (--if-down reuses)
```

`npm test` preloads `scripts/test-data-setup.js`, which points `DATA_DIR` at a temp folder per
test worker. Run single files with `npm test -- test/foo.test.js`, not bare `node --test`: under
the test runner `db.js` refuses to open the real `data/` folder, so files that import server
modules statically fail without the preload instead of touching the local database.

`server:restart` (`scripts/restart-server.js`) writes the server output to
`plembfin-local-server.log` in the OS temp directory and prints one status line, or the last log
lines when `/api/ping` does not answer within 90 seconds. It stops any process listening on the
port, including one started by hand in a terminal.

Any test that needs the running app, the local server, or the connected test services (Plex,
Emby, Jellyfin, Trakt, Seerr) starts by reading the gitignored `.claude/local-environment.md`,
which holds the local sign-in, test-instance URLs, and the test rules. Live and remote services
are in `.claude/live-environment.md` and are used only when the user explicitly asks.

A fresh install's admin username defaults to `admin`; without `ADMIN_PASSWORD` a random password
is printed once to the logs (override with `ADMIN_USERNAME` / `ADMIN_PASSWORD`). First boot
writes `data/config.json` with the admin credentials, a generated API key, and a session secret.

### Windows provider-backed server launches

`npm start` is the canonical local application command and defaults to the `develop`
channel. The `dev` command uses the same channel with file watching enabled. Set
`BUILD_CHANNEL=release` or `BUILD_CHANNEL=alpha` explicitly when you need to inspect
another local channel. When the user says **“Start the server”**, treat that as the
Plekt application-server workflow: start or reuse `npm start` (or `npm run dev` when
auto-reload is requested) on `http://localhost:5056`. When the server is started by
Codex on Windows, the command must run through `exec_command` with
`sandbox_permissions: "require_escalated"` and a justification that network access is
needed for connected providers. Do not launch it from the restricted sandbox. The
restricted sandbox can allow the UI/API to listen on port `5056` while denying outbound
connections to Plex, Emby, Jellyfin, Trakt, TMDB, or TVDB with `EACCES`.

This is an execution-environment requirement, not a second app mode: an ordinary
PowerShell window on the host can continue to use `npm start` or `npm run dev` directly.
After an agent start, verify both the local health endpoint and the network bind:

```powershell
Invoke-WebRequest http://127.0.0.1:5056/api/ping
netstat -ano -p tcp | Select-String ':5056\s+.*LISTENING'
```

A sandboxed agent workspace may also deny Git access to `C:\Users\<user>\.config\git\ignore`.
For read-only status checks there, pass a repository-local excludes file per command, and never
change global or repository Git config to work around it:

```powershell
git -c core.excludesFile=C:\path\to\plekt\.git\info\exclude status --short --branch
```

There is no separate linter configured. A local `.env` at the repo root is loaded by
`server/src/env.js` (existing env vars win). Data lands in `<repo>/data/` (override
with `DATA_DIR`).

When implementation work completes an item in [`todo.md`](../todo.md), remove it in
the same change, move its verified plan folder from `plan/active/<name>/` into
`plan/archive/<name>/` with the summary (`plan/<name>.md`) as `summary.md`, and refresh the
relevant documentation and README section if the completed work changes user-visible behavior.
The plan layout (summary, design, and step files) is described in `CLAUDE.md` "Plan layout".

## Module size limits

`public/app.js` stays under 3,000 lines; `public/modules/*.js` and `server/src/routes/*.js`
have a soft limit of 1,200 and a hard limit of 1,500 lines; `server/src/index.js` stays under
500. The rules for working with the files below (do not grow them, split only with explicit
approval) are in `CLAUDE.md` "Module discipline".

Grandfathered files, already over their limit (measured 2026-09-08):

| File | Lines | Limit |
| --- | --- | --- |
| `public/app.js` | 3428 | 3000 |
| `public/modules/media-detail-show.js` | 2541 | 1500 |
| `public/modules/app-events.js` | 2225 | 1500 |
| `public/modules/sync-activity.js` | 2199 | 1500 |
| `public/modules/manual-watch-review.js` | 2155 (added 2026-09-24) | 1500 |
| `public/modules/explorer.js` | 2098 | 1500 |
| `public/modules/edit-dialogs.js` | 1932 | 1500 |
| `public/modules/media-detail-events.js` | 1774 | 1500 |
| `public/modules/watch-action.js` | 1680 | 1500 |
| `public/modules/tools-maintenance.js` | 1541 | 1500 |
| `public/modules/sync.js` | 1355 | 1200 soft |
| `public/modules/tools-backups.js` | 1276 | 1200 soft |
| `server/src/routes/sync.js` | 3389 | 1500 |
| `server/src/routes/metadata.js` | 1505 | 1500 |
| `server/src/routes/maintenance.js` | 1399 | 1200 soft |
| `server/src/routes/media.js` | 1311 | 1200 soft |

## The build check (`scripts/build-check.js`)

`npm run build` is the gate used by the pre-push hook and every CI job. It:

1. runs `node --check` over every `.js` file in `public/`, `server/`, `scripts/`
2. runs the `node:test` suite (the same tests exposed by `npm test`)
3. runs `scripts/docs-check.js` to keep the README's released-version marker, Node.js,
   and password setup guidance aligned with the enforced package/runtime configuration
4. parses `package.json`, `package-lock.json`, `changelog.json`
5. verifies every routed API handler is either intentionally public or calls
   `requireAdmin`, `requireInstallAdmin`, `resolveAdminPrincipal`, or `verifyWebhookToken`
6. **rejects any bare `fetch(` outside `server/src/utils/outbound.js`** - outbound
   calls must use `fetchWithTimeout`, which enforces timeouts and validates both
   initial and redirected URLs
7. boots the real server once against a temp `DATA_DIR` with
   `PLEKT_BUILD_CHECK=1` (the server exits immediately after `listening`)

## Git hooks

`npm install` runs `scripts/install-git-hooks.js` (via the `prepare` script), which
points `core.hooksPath` at `.githooks/`. The `.githooks/post-commit`, `post-merge`, and
`post-rewrite` hooks regenerate the ignored local `plan/updates.md` ledger from committed
history after every local commit, merge, amend, or rebase. The ledger groups changed application paths with the website
guides they affect, collapses duplicate changelog bullets, and is refreshed again by the
push and Force to main workflows. The `.githooks/commit-msg` hook rejects
user-visible release commits whose body has no meaningful changelog bullet (a repeat
of the subject does not count). The `.githooks/pre-push` hook reads the actual push
refspec from stdin: for a same-name push (e.g. `alpha` → `alpha`) it runs
`git pull --no-rebase origin <branch>` first; for every push to `develop` it then
validates the changelog in the exact commit being pushed with
`node scripts/rebuild-develop-changelog.js --check`; finally it runs `npm run build`.
A stale or missing develop changelog blocks the push and prints the local rebuild
command. A cross-ref push (e.g. the alpha-onto-main force-push in "Force to main")
skips the sync step entirely, since that content has already been deliberately
reconciled by hand. The sync merges rather than rebases deliberately - `alpha`'s
history routinely contains a real merge commit folding a release commit back in from
`main`, and `--rebase` walks full ancestry rather than just the first-parent chain, so
it silently drops merge commits and replays both sides' commits individually instead
of leaving the already-resolved merge alone.

A failed pre-push test run leaves the remote branch unchanged. For the known transient
test-run failure, rerun `npm test` once. If it passes, retry the original push normally;
the hook runs the complete `npm run build` gate again and that full rerun must pass. If
the focused rerun or the second full gate fails, treat it as repeatable and investigate
it. Do not use `--no-verify` to promote any branch.

## Branching model (`develop` → `alpha` → `main`)

Day-to-day work lands on `develop`. `alpha` only moves when `develop` is deliberately
promoted to it, and `main` only moves when `alpha` is deliberately promoted to it -
each promotion to `main` becomes exactly one release.

Changelog content for all three branches is computed **locally**, before each push, as
part of running the command itself - never by a CI job reading GitHub's push-event
commit list afterward. That payload is only reliable for a plain incremental push;
`alpha` and `main` are always reached by a force-push, for which it's empty or
incomplete. See [Changelog and update check](#changelog-and-update-check) for the
full generation/rendering detail; the summary here is what each publish workflow itself
does, which in every case is now just "verify, then build and publish the image using
values already committed" - none of them write anything back to their branch.

- **"Push all to git"** includes every relevant local worktree change and every pending
  local `develop` commit, rebuilds `changelog.develop.json` from its `resetCommit`
  anchor, consolidates the pending work into one commit, and pushes it to `develop`.
  **"Push to git"** uses the same changelog/build workflow but scopes staging and
  committing to work created in the current chat only. The agent records the chat's
  baseline first, leaves pre-existing edits and commits untouched, and stops for
  clarification if changes are mixed or older local commits are already ahead of
  `origin/develop`; it never uses `git add .` for this narrow-scope command. In both
  cases, the pre-push hook independently verifies that the committed changelog covers
  every user-facing commit before allowing the push. `docker-publish-develop.yml` checks README
  consistency, then builds, verifies, and publishes a rolling image to
  `ghcr.io/lasikiewicz/plekt:develop` (also tagged `develop-<build>`) using the build
  number already in the pushed commit. `develop` carries the current main release in
  `changelog.develop.json` and starts each release cycle at build 0. Its build counter
  increments when a rebuild finds user-facing work; "Force to alpha" clears the current
  entry and anchor and returns the counter to 0 for the new alpha build, and "Force to
  main" sets the version to the released semver and returns the counter to 0. The sidebar
  and About show the five-segment build version itself, with trailing zeros trimmed, so
  the third develop build after the first alpha of v1.1.0 reads `1.1.0.1.3`.
  **`develop` is covered by `secret-scan.yml`** (while `security.yml` runs on `main` and
  `alpha` alongside scheduled scans).
- Before the push workflow rebuilds its changelog, and before Force to main begins its
  website gate, it runs `npm run updates:refresh`.
  The resulting ignored `plan/updates.md` file is the deduplicated
  inventory of committed local changes and the mapped website guides/captures to inspect;
  it is a review aid, while `changelog.develop.json`, `changelog.alpha.json`, and
  `changelog.json` remain the published sources of truth.
- **"Force to alpha"** runs `scripts/promote-develop-to-alpha.js` locally (packages
  develop's current entry as its own standalone alpha build entry, prepended to alpha's
  `entries` array - one entry per "Force to alpha" call, not a rolling merge - self-healing
  to a fresh `baseVersion`/build 1/empty `entries` whenever `main`'s version has moved on
  since the last alpha build, and resets develop for the next cycle). Before that
  promotion commit, the operator reviews/updates `README.md` and runs `npm run docs:check`,
  which also verifies that the top released-version marker matches `package.json`.
  The alpha workflow repeats the mechanical check. The operator then
  force-pushes `develop`'s state onto `alpha` (`git push origin HEAD:alpha --force`; merge
  `origin/main` into `develop` first if it has moved on). The alpha publish workflow
  checks README consistency again before building and publishing. This is where
  secret/vulnerability scanning first applies. `docker-publish-alpha.yml` builds,
  verifies, and publishes to `ghcr.io/lasikiewicz/plekt:alpha` (also tagged
  `alpha-<build>`) using the build number already in the pushed commit, creates or updates
  the matching numbered GitHub prerelease with the formatted notes from
  `scripts/generate-release-notes.js`, then posts that one build's own changelog entry to
  Discord (see "Discord release notifications" below). The promotion then stops: nothing
  is pushed to `origin/develop`. The reset `changelog.develop.json` stays on the local
  branch and the next ordinary "Push to git" publishes it, which is what keeps a
  promotion to one channel from also publishing a second develop image. See
  `docs/decisions.md` entry 18.
  For a tooling-only release-process change, `--tooling-only` is an explicit opt-in: it
  requires a current empty develop changelog and changes limited to maintainer/tooling
  paths, records an alpha entry with no product bullets, and excludes that entry from the
  next stable release. For an urgent single-fix alpha, `--hotfix` accepts only one
  conventional `fix:` commit with exactly one user-visible Fix detail and no feature or
  tweak bullets; the remaining changelog checks and both approval gates still apply.
  Ordinary alpha promotions still require at least three bullets.
- **"Force to main"** pins `origin/alpha`, writes a concise `releaseMessage`, previews the
  accumulated release entry, and starts that exact alpha build. The user approves both the
  changelog and running candidate before any website work. Website phases A/B/C then review
  and update the Astro documentation against that candidate, hand capture-only work to a
  cheaper agent, and check/commit the accepted website on local `develop`. The procedure
  carries that website into the same pinned alpha checkout, re-runs the website-impact gate
  and release preview, reviews `README.md`, and only then runs
  `scripts/promote-alpha-to-main.js --confirm` (consolidates every alpha build entry
  accumulated this cycle into one clean release entry; bumps the real semver; writes
  `changelog.json`/`package.json`/`package-lock.json`/`CHANGELOG.md`; resets alpha and
  develop to the released version at build 1 for the next cycle). After the local release
  commit passes `npm run docs:check`, build gates, and a final user review of the exact
  running app and website, it is force-pushed to `main`
  (`git push origin HEAD:main --force`) and triggers the release pipeline below. A first
  pre-push test failure follows the bounded retry procedure above; never bypass the gate.
  The promotion command refuses to mutate anything without `--confirm`.
- After the main image workflow succeeds, its `Deploy public demo to OCI` job pulls the
  exact released tag on the dedicated Oracle Cloud Compute instance serving
  [demo.plekt.net](https://demo.plekt.net/), keeps `PLEKT_DEMO_MODE=1` and the
  existing `/data` mount, and verifies the released version plus the public-demo
  health/guardrail checks. Publishing to GHCR alone does not restart this container.
  Portainer is local-only and is not used by the release gate.
- After the release pipeline publishes from that commit, the procedure stops. `main` is
  not merged into `develop` and nothing is pushed to `origin/develop`. Nothing needs
  carrying: `promote-alpha-to-main.js` reads the released history from
  `origin/main:changelog.json` rather than the working tree, and every changelog
  generation point writes the released version from the local manifests, so `develop`
  reconciles itself on its next "Push to git" with no merge. "Force to alpha" therefore
  has no ancestry check to satisfy. See `docs/decisions.md` entry 18.

### Promotion commands

Use the following refspecs for the supported branch promotions. Review the commit range
before each force-push and wait for the corresponding GitHub Actions workflow to finish.
See CLAUDE.md's "Push to git" / "Force to alpha" / "Force to main" sections for the full
step-by-step, including the local changelog-generation step each one runs first.

```bash
# Push work to develop
node scripts/rebuild-develop-changelog.js && git add changelog.develop.json && git commit -m "chore: rebuild develop changelog"
git push origin develop

# Promote develop to alpha
git fetch origin
git checkout develop
git merge --ff-only origin/develop
git merge origin/main --no-edit
npm run docs:check
node scripts/promote-develop-to-alpha.js && git add README.md changelog.alpha.json changelog.develop.json public && git commit -m "chore: promote develop changelog to alpha"
git log origin/alpha..HEAD --oneline
git push origin HEAD:alpha --force
git push origin develop

# Promote alpha to main
git fetch origin
git checkout -B alpha origin/alpha
npm run docs:check
node scripts/promote-alpha-to-main.js --preview   # show the concise release changelog and get user approval before continuing
node scripts/promote-alpha-to-main.js --confirm && git add README.md changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json && git commit -m "chore: promote alpha to main"
git log origin/main..HEAD --oneline
git push origin HEAD:main --force

# Point local develop at the release (local only; check nothing on develop is missing from it first)
git log --oneline origin/main..develop
git checkout -B develop origin/main
git branch -u origin/develop
```

The alpha workflow reads the alpha build metadata already committed and publishes
`:alpha` plus an `alpha-<build>` tag. The main workflow reads the version already
committed, publishes a multi-architecture `:latest` plus version tag for AMD64 and
ARM64 hosts, and then deploys that exact version to the OCI demo job. After that check
the procedure moves local `develop` onto the release commit so new work starts from the
released build, and ends; it pushes neither `develop` nor `alpha`.

For a demo-only catch-up, run the **Deploy Public Demo** workflow manually from the
`main` ref. Type `DEPLOY` in its confirmation input and leave the version blank to use
that ref's `changelog.json`, or enter an already-published numbered release tag. This
workflow pulls an existing image, does not rebuild or publish anything, does not move a
branch, and performs the same live demo verification as the main release job.

## Release pipeline (push to `main`)

Building the release itself happens locally, as part of "Force to main" (see
[CLAUDE.md](../CLAUDE.md) and the "Promotion commands" above) - `promoteAlphaToMain()`
in `scripts/promote-alpha-to-main.js`, run before the force-push:

1. Consolidates every alpha build entry accumulated since the last release - each one
   already has a clean headline and bullet-point `details` from when
   `scripts/promote-develop-to-alpha.js` built it, since that already happened locally on
   `develop` (`scripts/rebuild-develop-changelog.js`) and `alpha` - so there is nothing
   left to backfill from individual commits at this point, only multiple builds' worth of
   already-clean entries to fold into one.
2. Merges each entry's own `entry.sections` directly (`mergeSections`, exported from
   `promote-develop-to-alpha.js`) rather than re-running `categorizeEntries()` over the
   entries themselves - an entry's `message` is a synthesized cross-commit headline
   sentence, not a commit-message bullet, and re-categorizing it would land it in tweaks
   as a garbled duplicate. Uses the reviewed, single-line `releaseMessage` from
   `changelog.alpha.json` as the Main headline instead of concatenating every alpha
   build headline. The command refuses to mutate without `--confirm` after the preview
   has been approved. Bumps the real semver - the patch segment, honouring a manually-set higher
   `package.json` version instead (a deliberate major/minor bump). `public/app.js` and
   `generate-changelog-md.js` render `entry.sections` -
   `newFeatures`/`majorBugFixes`/`tweaks` - as separate "New Features" / "Bug Fixes" /
   "Tweaks" headed groups in Settings → Changelog and `CHANGELOG.md` whenever
   any section is populated, falling back to the flat `entry.details` list otherwise.
   Alpha and main promotion automatically derive thematic `entry.sectionGroups`
   (including Up Next & watch-state, Manual Watch review, Discover & recommendations,
   and sync recovery); a reviewed release may override those defaults. They render as
   `####` headings beneath the three impact sections while the flat section arrays
   remain the compatibility source for release tooling.
3. Runs the same release-content check (`changelogEntryProcessViolations` in
   `scripts/changelog-message.js`) the alpha promotion already ran, and throws instead
   of writing the entry if any recognized release-process text survives (changelog
   consolidation, folded-in or trimmed bullets, branch build-counter resets, and
   similar) - it cannot tell a bullet inside an otherwise legitimate `feat`/`fix` commit
   apart from one that just narrates an investigation with no resulting product change
   (e.g. "diagnosed a report of X; turned out to be a stale session, no code change
   needed"); avoid writing that kind of bullet in a release commit's body in the first
   place, or keep it as unbulleted prose so `bulletPointsFrom` skips it. A release built
   from many small iterative alpha commits (a feature added, then throttled, then
   disabled, then re-enabled within the same day) can still read as noisy because the
   generator cannot infer which product bullet supersedes another; consolidate those
   product bullets on `develop` before promotion rather than fixing it up after.
4. Writes `changelog.json` + `package.json` + `package-lock.json` + regenerates
   `CHANGELOG.md`, and resets `changelog.alpha.json`/`changelog.develop.json` for the
   next cycle - all committed locally as one commit, force-pushed straight to `main`.

`.github/workflows/update-changelog.yml` (workflow name "Publish Main Release") then
runs on the push to `main` - in practice this means every "Force to main" run, not every
individual commit - reads the version already committed, checks README consistency, runs
the full build gate again in CI, builds and pushes a multi-architecture Docker image to
GHCR and to Docker Hub (`docker.io/plembfin/plekt`, logged in with the
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` repository secrets) tagged `latest` + the
version, creates
or updates the matching GitHub Release with the formatted body from
`scripts/generate-release-notes.js`, then posts the `changelog.json` entry to Discord via
`scripts/notify-discord-release.js main` (see "Discord release notifications" below).
The dependent `Deploy public demo to OCI` job then pulls the exact version tag on the
Oracle instance and runs the public-demo verification. It does not write anything back
to `main`.
`docker-publish.yml` is a manual (`workflow_dispatch`) image build that skips the
changelog step.

### Oracle-hosted public-demo release gate

The public application demo at [demo.plekt.net](https://demo.plekt.net/) runs on
the dedicated Oracle Cloud Compute instance in `uk-london-1`, behind the Cloudflare
reverse proxy. The release job deploys the exact `ghcr.io/lasikiewicz/plekt:<version>`
image with `PLEKT_DEMO_MODE=1`, `BUILD_CHANNEL=main`, and the existing isolated data
mount. It does not use the local Portainer installation or the local-only
`plembfin.lasikie.co.uk` environment.

Demo-mode HTTP responses include `X-Robots-Tag: noindex`, and `/robots.txt` disallows
crawling. Self-hosted installs do not receive the noindex header.

Configure these GitHub Actions settings before the next main promotion:

- Variables: `OCI_DEMO_HOST`, `OCI_DEMO_KNOWN_HOSTS`, `OCI_DEMO_CONTAINER`,
  `OCI_DEMO_DATA_DIR`, and `OCI_DEMO_RUNTIME` (`podman` or `docker`).
- Optional variables: `OCI_DEMO_USER` (defaults to `opc`) and `OCI_DEMO_PORT` (defaults
  to `80`).
- Secret: `OCI_DEMO_SSH_KEY`, containing the private key for the `opc` account.

The instance must have the configured container runtime installed, passwordless
`sudo` for `opc`, and the existing demo container/data mount identified by the Actions
variables. The deploy helper reuses the current `/data` mount, pulls the exact release
tag, recreates only the configured demo container, and refuses an unexpected listener
on the public port. The verification script checks `/api/ping`, the root public-demo
guardrail, and `/changelog.json` against the release version. If an OCI setting is
missing or the deployment/verification fails, the main release workflow remains
failed instead of reporting the demo as current.

Traks analytics for `demo.plekt.net` load only when `PLEKT_DEMO_MODE=1` (or its legacy
alias). The demo uses site key `pb_live_z70rk17kytof4pd9ejy1ovl6` and loads
`https://plembfin-traks-collect.lasikie.workers.dev/t.js`; its CSP permits that origin
for scripts and connections. It honors browser Do Not Track and Global Privacy Control.
Self-hosted installs have analytics disabled and retain their local-only script and
connection CSP. The public website uses a separate site key. No analytics credentials
or environment changes are needed for the next demo deployment.

Pushes to `main` and `alpha` trigger `.github/workflows/windows-installer.yml`. That job
runs on a Windows runner, installs and probes the Windows builds of `better-sqlite3` and
`sharp`, stages the self-contained Node runtime plus the optional notification-area
companion, compiles the Inno Setup installer, and uploads a checksum alongside it.
Release-channel installers built from `main` are attached to a `v<version>` GitHub
Release, and alpha installers are attached to their numbered `v<base-version>-alpha.<build>`
GitHub prerelease. Both release bodies are generated from the committed changelog by
`scripts/generate-release-notes.js`; manual builds remain Actions artifacts. The
workflow also supports manual builds for any of the three channels. Configure
`WINDOWS_SIGNING_CERTIFICATE_BASE64` and `WINDOWS_SIGNING_CERTIFICATE_PASSWORD` as
repository secrets to sign the installer; signing is skipped, without failing the
build, when those secrets are absent.
The force-push events used by the promotion procedures are mapped explicitly: `Force to
alpha` builds the alpha manifest/build from `alpha`, and `Force to main` builds the
release manifest/version from `main`. Manual runs default to following the selected
branch (`auto`) unless an explicit channel is chosen.

The in-app update check compares the bundled `changelog.json` against the published one
on GitHub - see [Changelog and update check](#changelog-and-update-check).

### Discord release notifications

Both `update-changelog.yml` (main) and `docker-publish-alpha.yml` (alpha) end with a
"Notify Discord releases channel" step that runs
`node scripts/notify-discord-release.js <main|alpha>`. The script reads the changelog
file already committed by the local promotion step (`changelog.json`'s `entries[0]` for
main, `changelog.alpha.json`'s `entries[0]` for alpha), builds a Discord embed from it,
and posts it to the webhook URL in the `DISCORD_RELEASES_WEBHOOK` repository secret. If
that secret is unset the script logs a message and exits `0` - it never fails the
build, so forks and clones without the secret configured are unaffected. Run it locally
with a trailing `--dry-run` to print the embed JSON instead of posting it, useful for
checking formatting without a webhook. The webhook itself is configured on the Discord
side (Server Settings → the target channel → Integrations → Webhooks); paste its URL
into the GitHub repository secret to wire it up, or omit the secret to leave the
channel silent.

### Reddit release announcements

The Devvit release app is retired from this repository. Its legacy installation was
uninstalled from r/plembfin on 2026-10-19, and a follow-up CLI listing showed no apps
installed there. This did not archive the Developer Platform listing or change other
community installations. See [`reddit-app/README.md`](../reddit-app/README.md).

## Changelog and update check

Each build ships with a bundled `changelog.json` at the repo root (served verbatim at
`GET /changelog.json`) that records the version this instance was built from - this is what
the Changelog screen reads. A small `GET /version.json` response carries only that installed
version for the sidebar badge. On dashboard load `loadAppVersion()` calls `/api/changelog`
with `?refresh=1` for a quick update check; when a newer release exists the badge changes
from `v0.2.15` to `v0.2.15 - Update available` (accent-tinted).

`GET /api/changelog` (`handleChangelog` in `routes/maintenance.js`) layers an update check on top: it
reads the bundled `changelog.json` for the current version and fetches the published
`changelog.json` from GitHub raw (`Lasikiewicz/plekt@main`), cached in-process for one
minute (8-second fetch timeout). `?refresh=1` from an admin session bypasses that cache and
re-fetches immediately. The browser cannot reach GitHub directly because the CSP is
`connect-src 'self'`, so the server proxies and caches it.

Settings -> Changelog carries a Main / Alpha toggle in the card heading, centred on the title
row (it stacks under the title on phones). The page's rebrand help card is `data-help-static`,
so it has no "Read more" collapse. The toggle is available on every
channel, because `/api/changelog` returns the alpha branch's live manifest whatever is
installed, so a release install can read alpha build notes. Reading them never changes the
reported installed version and never raises an update prompt: the server forces
`alphaBuild.newerBuildAvailable` to false off the alpha channel. An alpha or develop install is
told separately about a newer build on its own channel and a newer published release, rather
than only whichever check ran first. Alpha builds left over from an earlier release are kept after the
current cycle's builds, without a heading, and so are not read as builds of the installed one. Display formatting
for the five-segment build version (`formatBuildVersion()`, `versionDisplayLabel()`) lives in
core `public/modules/utils.js`, because the sidebar badge renders it on every page; it trims
trailing zero segments so a release reads `v1.1.0` and an alpha build `v1.1.0.1`. The Settings
changelog renderer itself is `public/modules/changelog-channels.js`, loaded with that route.

Each alpha build entry carries `sections` (`newFeatures`/`majorBugFixes`/`tweaks`),
produced by `categorizeEntries()` in `scripts/promote-develop-to-alpha.js` from that
build's own develop commits. A main-release entry's `sections` are produced by merging
every alpha build entry's own `sections` directly (`mergeSections()`, also in
`promote-develop-to-alpha.js`, used by `scripts/promote-alpha-to-main.js`) rather than
re-categorizing the entries themselves - an entry's `message` is a synthesized headline
sentence, not a commit-message bullet, and re-categorizing it would land it in tweaks as
a garbled duplicate. Settings → Changelog (`renderChangelogDetails()` in `public/app.js`)
and the generated `CHANGELOG.md` (`scripts/generate-changelog-md.js`) render `sections`
as separate headed groups whenever any of the three is non-empty, falling back to the
flat `entry.details` list otherwise. Alpha and main promotion automatically derive
optional `sectionGroups` for thematic `####` subheadings; a reviewed release may
override those defaults without changing the flat arrays. Develop's entry stays flat,
since it never carries `sections` at all (see below). Main release entries may also carry
`websiteUrl`; GitHub-facing renderers use a Markdown link, while Reddit and the app/website
views render the same URL through their own compatible output instead of assuming GitHub
Markdown will be interpreted everywhere.

Both promotion scripts run the same release-content check
(`changelogEntryProcessViolations` in `scripts/changelog-message.js`) on the entry they
just assembled, and refuse to write it - throwing rather than publishing - if any
recognized release-process text survives (changelog consolidation, folded-in release-note
bullets, branch build-counter resets, and similar). This is the only gate; there is no
separate CI validation step.

The two entry lists are merged rather than one replacing the other: entries are keyed by
commit (falling back to version + message), remote copies win on conflict except that a
local entry's `details` are kept when the remote one has none, and the result is sorted
newest-first by semver then date. A release that exists only in the bundled file therefore
stays visible alongside releases that exist only on GitHub. The response is
`{ current, channel, alphaBuild, latest, updateAvailable, remoteAvailable, remoteError, newer, entries }`,
where `latest` is the highest version across the remote manifest and the merged entries,
`newer` lists releases with a higher semver than the running build, `updateAvailable` is
true when `latest` outranks `current`, and `channel` is `"alpha"` when the image was built
with `BUILD_CHANNEL=alpha` (the `ghcr.io/lasikiewicz/plekt:alpha` image) or `"release"`
otherwise. `current` itself always stays a plain semver string so entry-matching and
update comparisons are unaffected; the frontend appends " alpha" (and, on alpha, the build
number) only where the version is displayed - the sidebar badge and About's
current-version banner - never in the value compared against changelog entries. If GitHub
is unreachable the bundled entries are served on their own.

`alphaBuild` is populated only on the `alpha` channel, read from the bundled
`changelog.alpha.json` (`readLocalAlphaChangelog()` in `routes/maintenance.js`): a rolling
build counter and one changelog entry per build accumulated so far this cycle, separate
from `changelog.json`'s real semver and reset on the next "Force to main".
`scripts/promote-develop-to-alpha.js` writes this file, run locally as part of "Force to
alpha" (before the force-push): it packages develop's current entry as its own standalone
alpha build entry and prepends it to `entries` - so a fresh "Force to alpha" call adds
another entry rather than updating one in place, and a user can see exactly what changed
in each build they haven't pulled yet - bumps `build`, and resets to a fresh `baseVersion`,
build 1, and an empty `entries` array whenever `changelog.alpha.json`'s `baseVersion`
differs from `changelog.json`'s version (i.e. main moved forward since the last alpha
push). Build version segments are described at the end of this section.
`docker-publish-alpha.yml` reads the build number already in the pushed
commit and tags the published image `alpha-<build>` alongside the rolling `alpha` tag; it
does not write anything back.

`handleChangelog` also fetches `changelog.alpha.json` from the `alpha` branch on GitHub raw
(`fetchRemoteAlphaChangelog()`, same one-minute cache and `?refresh=1` bypass as the main
remote fetch) and passes the local and remote alpha manifests through
`describePendingAlphaBuild()` (a pure, exported function - no I/O - so it's unit-tested
directly rather than through the route) to add `alphaBuild.latestBuild` /
`alphaBuild.newerBuildAvailable` / `alphaBuild.pendingEntries` to the response.
`newerBuildAvailable` is true when the remote's `build` is higher than the running
instance's own, or its `baseVersion` differs (a release cycle moved on) - a distinct signal
from a main release existing, answering "has a newer `:alpha` image been published since
this one was built," which the running build's own bundled file can never know on its own.
`pendingEntries` is the actual changelog bullets for those not-yet-pulled builds - read from
the *remote* manifest, not the local one, since a build that hasn't been pulled yet can only
ever appear in GitHub's copy of the file - so the UI can show what changed before the user
updates, not only after.

About renders the current version, a status banner, and the full release list
with newer versions highlighted. On the `alpha` channel the banner never shows the
"Update available" treatment for the semver gap: alpha's bundled semver only advances when
it is merged into `main`, so it always trails main's latest release right after every merge
even though the running alpha build may already contain newer commits than that release -
flagging that gap as an actionable update would be misleading. It shows the real
"Update available" treatment instead when `alphaBuild.newerBuildAvailable` is true, naming
the newer build number and prompting a pull of the latest `:alpha` image; otherwise the
banner states that alpha is a rolling pre-release channel and, if `newer` is non-empty,
notes how many releases have landed on `main` since this build for context. The sidebar/About
version label itself still distinguishes one alpha build from the next via the build number
(`v0.8.0.7 alpha`), and the release list shows a separate "New since your build - not pulled
yet" section (tagged "Not pulled yet", `alphaBuild.pendingEntries`) above the "Current alpha
build" section (`alphaBuild.entries` - every build entry accumulated so far this cycle,
newest first, not just the one this instance has installed) whenever either is non-empty,
so a newer build's changes are visible without updating first.

`developBuild` (populated only on the `develop` channel, read from `changelog.develop.json`
via `readLocalDevelopChangelog()`) carries the current build version and its rolling cycle
counter, `{ version, build, resetCommit, entries }`. `scripts/rebuild-develop-changelog.js`,
run locally as part of "Push to git" (before the push), fully recomputes the single entry
from every real commit between `resetCommit` and HEAD, rather than appending one entry per
push - there is only ever one entry to read, and it is always current. It also stamps the
build's own version onto every `?v=` public asset reference, so each develop build gets its
own immutable-cache URL. `build` starts at 0 when "Force to main" completes and bumps by one
on every later rebuild that finds real content. `promoteDevelopToAlpha()` clears the current
entry, moves the anchor, and returns the counter to 0 for the new alpha build;
`promoteAlphaToMain()` sets the released version and returns it to 0 for the next cycle.
`describePendingDevelopBuild()` compares versions before build numbers so an older remote
cycle cannot look newer merely because its counter is higher.

Build versions are five numeric segments, `major.minor.patch.alpha.dev`: the released
semver, then alpha builds since that release, then develop builds since the last alpha
build. `scripts/version.js` owns parsing, comparison, and display for them, and
`parseSemver`/`compareSemver` in `routes/maintenance.js` read all five so a pre-release
build can be ordered against another and against the release that follows it. Missing
segments zero-fill, so a four-segment version written by an earlier promotion still means
what it did. Display trims trailing zeros and never goes below three segments, so a release
reads `v1.1.0`, an alpha build `v1.1.0.1`, and a develop build `v1.1.0.0.2`. `package.json`
and `changelog.json` keep the three-segment released semver only, because five segments is
not valid semver. See `docs/decisions.md` entry 18.

## Other CI

| Workflow | What it does |
| --- | --- |
| `security.yml` | `npm audit --audit-level=high` + CodeQL, on push to `main`/`alpha`, PRs targeting `main`, and daily. CodeQL loads `.github/codeql/codeql-config.yml`, which excludes the `js/request-forgery` query repo-wide - every outbound request funnels through the centralized, validated fetch guard in `server/src/utils/outbound.js`, and admin-configured LAN media server URLs make that query permanently false-positive for this app |
| `secret-scan.yml` | TruffleHog verified-secret scan on push to `main`/`alpha`/`develop` and PRs targeting `main`/`develop` |
| `docker-build-check.yml` | Checks README consistency, then builds the image on every PR targeting `main`, without pushing anything, and runs `better-sqlite3` and `sharp` inside it, so a broken Dockerfile or dependency install is caught before a PR merges. The runtime probe matters because production dependencies install with `--ignore-scripts`: a native module with no usable binary for the platform still builds cleanly and would fail on first database open |
| `docker-publish-alpha.yml` | On every push to `alpha`: checks README consistency, builds the image, runs the same native-module probe as `docker-build-check.yml`, then pushes it to `ghcr.io/lasikiewicz/plekt:alpha` and `ghcr.io/lasikiewicz/plekt:alpha-<build>` (reading the build number already committed by "Force to alpha"), creates or updates the matching numbered GitHub prerelease with generated notes, and posts the changelog entry to Discord (see "Discord release notifications"). Never writes anything back to `alpha`; never touches `changelog.json`, the package version, or the `:latest` tag |
| `windows-installer.yml` | On every push to `main` or `alpha` (and on manual dispatch), builds the x64 Windows installer on a Windows runner, probes native modules, packages the Node server as a Windows service with an opt-in notification-area companion, uploads a checksum, and publishes main installers to GitHub Releases plus alpha installers to numbered GitHub prereleases |
| `ghcr-cleanup.yml` | Weekly (and on manual dispatch): currently dry-run only against the `plekt` package pending review. When enabled, prunes numbered `develop-<n>`/`alpha-<n>` tags beyond the newest 15 of each, and deletes untagged images older than a day left behind whenever a mutable tag (`latest`/`develop`/`alpha`) moves to a new manifest. Never touches those mutable tags or a semantic-version release tag |
| `dependabot.yml` | Dependency update PRs |

## Docker

- **`Dockerfile`** - `node:25-trixie-slim`, production deps only, non-root `plembfin`
  user (uid 1000), `VOLUME /data`, and a separate SQLite worker-health probe so
  synchronous maintenance cannot make the container fail its HTTP healthcheck; entrypoint
  (`scripts/docker-entrypoint.sh`) chowns `/data` and drops privileges via gosu when
  started as root. Dependencies install with `npm ci --omit=dev --ignore-scripts`:
  better-sqlite3 ships a `binding.gyp`, and npm runs `node-gyp rebuild` for any package
  that has one, which needs a Python and compiler toolchain the image does not carry.
  Skipping install scripts leaves the prebuilt binary that already ships in the package
  for this platform, which is the binary its loader prefers. better-sqlite3 is the only
  production dependency with an install script.
- **`docker-compose.yml`** - default quick-start: pulls `ghcr.io/lasikiewicz/plekt:latest`,
  port 5056, `./data:/data`, and requires `ADMIN_PASSWORD` from `.env`.
  It sets `PLEKT_PUBLISHED_PORT=5056` for the startup webhook port advisory
  (see [webhooks.md](webhooks.md#port-advisory)). `docker-compose.quickstart.yml` is identical.
- **`docker-compose.dev.yml`** - local source-build overlay, with `build: .`, local
  image `plekt:dev`, optional Trakt OAuth credentials, `no-new-privileges` and CPU/memory
  limits: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build`.
- **`docker-compose.split.yml`** - optional same-host overlay that runs one
  `ROLE=web` service and one HTTP-less `ROLE=worker` service using the published image on the same local data
  volume: `docker compose -f docker-compose.yml -f docker-compose.split.yml up -d`.
- **`docker-compose.secure.yml`** - hardened overlay (read-only rootfs, tmpfs `/tmp`,
  required secrets, forced `COOKIE_SECURE`); usage in
  [hardening.md](hardening.md).
- **`.dockerignore`** - keeps `data/`, `docs/`, markdown, and scratch files out of the
  image; whitelists only the install, entrypoint, and worker-health scripts the image needs.

## One-shot operational scripts

| Script | Purpose |
| --- | --- |
| `scripts/exportPlexHistory.js` | Import a Plex server's watch history into Plekt via `/api/import` (env: `PLEX_URL`, `PLEX_TOKEN`, `API_KEY`) |
| `scripts/forcePushHistory.js` | Replay Plekt's `/api/history` against Plex/Emby/Jellyfin as mark-played calls (env: all three platforms' credentials + `API_KEY`) |
| `scripts/seed-demo-content.js` | Seed fictional demo content for screenshots/dev |
| `scripts/generate-synthetic-library.js` | Build a disposable library at a stated scale for performance measurement: `node scripts/generate-synthetic-library.js --data-dir <path> [--movies 3000] [--shows 400] [--episodes-per-show 24] [--history-rows N] [--tmdb-entries N] [--tmdb-blob-kb 24] [--posters 8] [--seed 1]`. Refuses the repository's own `data/` directory and any directory holding a database it did not create. |
| `scripts/benchmark-surfaces.js` | Record the server-side surface baseline against a generated library: `node scripts/benchmark-surfaces.js --data-dir <path> [--runs 5] [--output docs/benchmarks/<file>.json]` |
| `npm run assets:update` | Restamp every local `public/` asset reference with the current build's version. Both promotion scripts run it automatically; run it by hand after editing frontend files locally, since versioned assets are cached immutably and the browser will otherwise keep the previous copy |

## Performance measurement

Two debug env flags produce numbers without a profiler, in the same style as
`PLEKT_DEBUG_OUTBOUND`. Both log through the diagnostic logger, so their output is
visible in Settings → Logs as well as the console.

- `PLEKT_DEBUG_CACHE_REBUILDS=1` logs one line per derived-cache rebuild: which cache,
  the generation it rebuilt for, the labelled caller that advanced that generation, and
  how long the rebuild took. Counting invalidations alone cannot tell an expensive one
  from a free one, because a bump only costs something when a cache it invalidated is
  then read.
- `PLEKT_DEBUG_SCHEDULER=1` logs each scheduler step's name, its start offset within
  the tick, its duration, and whether it exhausted its time budget, plus a per-tick
  summary carrying the achieved interval between tick starts.

The counters behind both are collected whether or not the flag is set; the flag only
controls logging. They cost one timestamp pair per rebuild or per step, never per row.

Repeatable benchmarks live in `docs/benchmarks/`, which is committed so a result travels
with the workload that produced it. `scripts/benchmark-surfaces.js` records the
server-side surfaces against a library from `scripts/generate-synthetic-library.js`; see
[`capacity.md`](capacity.md) for the two commands and the one scale limit worth knowing
before reading a result. Frontend first-paint timing is a manual browser protocol and is
deliberately not scripted here.

## Asset versions track the build

Public assets are referenced at a canonical `?v=<version>` query and served with a one-year
immutable cache, so that query has to change whenever the files do.

The version is **the alpha build's version while a cycle is open** (`0.15.0.4`), and the
package version once a release to main resets alpha (`0.15.1`). `scripts/asset-versions.js`
derives it, and both `promote-develop-to-alpha.js` and `promote-alpha-to-main.js` restamp
every reference while promoting, so each published build serves its own asset URLs.

Before this, every alpha build in a cycle shared one asset version: a tester who pulled a new
image could still be running the previous build's JavaScript, and the same caught local
development after editing a module. If you edit frontend files and the browser does not pick
them up, run `npm run assets:update`.

Tests must not assert a specific asset version for this reason - assert that a URL is
versioned, not which version it carries today.

The checker reads references two ways, because a URL built at runtime is not a literal. The
first pass matches a complete quoted reference such as `"/modules/utils.js?v=0.15.0.5"`. The
second reads the version query on its own, wherever it sits on a managed `/icons/`,
`/modules/`, `/app.js` or `/styles.css` path, so an assembled URL like
`` `/icons/${target}.svg?v=0.15.0.5` `` is checked and restamped as well. Both passes run in
`npm run assets:check` and in `--write`. A reference the first pass cannot see is exactly how
a hardcoded token once survived several releases while the browser fetched the same icon
under two different URLs.

## Conventions that CI enforces or assumes

- Commit messages follow `type: summary` with `- ` bullet bodies. The commit hook and
  the local changelog scripts (`rebuild-develop-changelog.js`,
  `promote-develop-to-alpha.js`, `promote-alpha-to-main.js`) reject user-visible release
  messages with missing or title-repeating details. Release-process notes such as
  changelog consolidation and branch build-counter resets are filtered from every
  branch's entry and rejected by the same scripts' release-content check.
- The version in `package.json`/`changelog.json` is set locally by
  `scripts/promote-alpha-to-main.js` as part of "Force to main"; only set it manually
  for a deliberate major/minor bump.
- `data/` is never committed and never in the image; all state must live under
  `DATA_DIR`.
