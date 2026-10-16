# CLAUDE.md

Project instructions for all agents.

> **Before changing anything, read the relevant parts of [`docs/architecture.md`](docs/architecture.md).**
> It covers architecture, file ownership, request flow, data, auth and environment.
> Read "The big picture" and "Subsystem map"
> (top ~85 lines) first, then only the file-map subsection and topic sections for the area
> you are touching. The routing table at the end of this file names the doc that owns each area.

## Agent Guidelines

- **No Git Pushes** - Never run `git push` or push to any remote unless the user explicitly instructs it in their request.
- **Local commits only at the end of a chat** - `git add` and `git commit` run without a prompt, so never commit mid-task. Commit once, as the last step when the chat's work is finished.
- **No Deployments** - Never deploy or run deployment commands unless explicitly instructed.
- **No Unsolicited Actions** - Do exactly what the user asks. No unsolicited refactors, extra features, or edits outside the request's scope.
- **No Browser Actions Unless Asked** - Never open browsers/browser tools unless explicitly requested. Test commands are part of the normal project checks: run `npm test` or `npm run build` when a change touches code covered by those checks or when the user asks for verification.
- **Act immediately on simple requests** - Make clear, specific changes directly without preamble or planning steps. Save analysis for genuinely complex or ambiguous tasks.

## Quick edits

When the user says **"enable quick edits"**, keep quick-edit mode active until they say **"disable quick edits"** or the conversation ends:

- Make only the requested changes, then briefly report what changed. The user will test the changes and report anything that needs correction.
- Do not run tests, builds, linters, browser checks, or other verification during quick-edit mode, even when normal instructions would call for them. Do not claim the work was tested.
- If the user reports a problem, make the requested fix and leave testing to them while quick-edit mode remains active.
- When the user says they are happy or asks for full testing, exit quick-edit mode and run the full relevant checks before any local commit. Commit only when the user explicitly asks. Never push or deploy without explicit instruction.
- This mode changes the test and feedback workflow; it does not waive the other project instructions or safety and approval requirements.

## Website work is isolated (mandatory)

- Website/Traks work uses only the local `website/` tree, its own checks/build, and direct
  Wrangler deployment to the separate `plembfin-website` Cloudflare Pages project. It must
  never use GitHub, modify `main`, run application CI, run the root Plekt build, or touch
  the `plembfin` application project, unless the user explicitly requests **"Force to main"**.
- Read the website deployment docs and skill before acting. Website update requests follow
  [`docs/websiteupdate.md`](docs/websiteupdate.md): discover the verification baseline recorded
  by the website, review and document all changes after it, and visually check affected pages
  locally. Publishing setup follows [`docs/website-deployment.md`](docs/website-deployment.md).
  Never push or deploy the website without an explicit user request.

## Local testing context

When local-server or connected-browser testing is explicitly requested, read
`.claude/local-environment.md` first if it exists (machine-specific URLs and signed-in browser
sessions; gitignored, so absent on fresh clones).

## Agent conduct and efficient work

Read [docs/agent-conduct.md](docs/agent-conduct.md) for session/context thresholds,
checkpointing, efficient exploration and verification ownership before multi-phase work
or app verification. Preserve the 150k/250k interruption rules and fresh-session handoffs.
Use one browser stack, text probes first; delegate broad searches/multi-step browser checks.
Use the environment's edit tool and permission rules. Restart with server:restart, not loops.

## Branching model: `develop` → `alpha` → `main`

Day-to-day work lands on `develop`, never directly on `alpha` or `main`; those move only through
"Force to alpha" and "Force to main", and nothing is pushed back into `develop` afterwards
(`docs/decisions.md` entry 18). Changelog content and versions are computed locally by the push
command that produces them, never by CI (`docs/decisions.md` entry 6). Versioning, changelog
scripts, and promotion detail are in [`docs/development.md`](docs/development.md); procedures
live in the skills below.

## Release commands: use the matching skill

These phrases trigger a named procedure. **Invoke the skill (or workflow file) and follow it
exactly. Never improvise or reconstruct these procedures from memory.**

| The user says | Invoke |
| --- | --- |
| "Push to git", "Push all to git", "push all the git" (any case) | `push-to-git` |
| "Force to alpha" (exactly) | `force-to-alpha` |
| "Force to main" (exactly) | `force-to-main` |
| "Push website live" (case-insensitive) | `push-website-live` (website-only publish of local `website/` to `plembfin-website` via Wrangler; no GitHub push, no root build, no application CI) |
| "Start the website" (case-insensitive) | `start-website` (local Astro preview on `http://localhost:4321/`; never publishes or runs the root build) |
| "Start the server" (case-insensitive) | Start or reuse the Plekt application server (see below) |
| "Check requests" (case-insensitive) | `check-requests` |

Read [shared workflow rules](docs/agent-workflow-rules.md) when running any release/push
procedure. Never bypass hooks/changelog rebuilding. Refresh plan/updates.md for push/main
review. GHCR Cleanup must not overlap publication. Force commands require their stated
changelog/build approvals; neither pushes develop. Start-server requests follow the local
stack skill in AGENTS.md. Check requests is read-only: draft replies, never post; stop at
any provider requiring login.

## Plans, documentation and backlog

Read [docs/agent-plans.md](docs/agent-plans.md) before creating/updating plans or todo.md.
After EVERY step update its Results, summary (current state/steps at top, history below),
todo Now line and dated change log; run npm run todo:check. Keep plans small and truthful:
implemented, unit-tested and live-verified are different. Untested checks remain unticked;
archive only when all checks pass. Ask behavior decisions when encountered, before building.
Do not put website work in feature plans; it belongs to Force to main unless user-authorized.
User-visible changes also update relevant docs and README. Review decisions.md before
changing cautious guards; record decisions only under its documented three-part criteria.

## Commands

`npm start` (UI + API + scheduler on `http://localhost:5056`), `npm run dev` (auto-reload),
`npm test` (`node:test` suite), `npm run build` (syntax check, tests, JSON validation,
outbound-fetch guard, one-shot boot). No linter. Details, first-boot credentials, and the
sandboxed-agent launch and Git-check rules are in [`docs/development.md`](docs/development.md).
An outbound-fetch `EACCES` from an agent-launched server is an execution-environment failure,
not an application result: restart it with network access before diagnosing.

## Module discipline

Read [docs/agent-modules.md](docs/agent-modules.md) before frontend/backend edits and the
owning module tables in docs/frontend.md and docs/architecture.md.
public/app.js is orchestration only (<3,000 lines); modules/routes soft 1,200/hard 1,500;
server/src/index.js is routing only (<500). Never grow grandfathered files; extraction
requires an explicit user go-ahead and all importer/preload/route/documentation updates.
No circular imports or imports from app.js/index.js into owned modules. Shared logic goes
in a third module; helpers become shared utilities only when multiple route modules need them.

## Architecture: read the docs, do not rely on this file

| Touching | Read |
| --- | --- |
| Anything, first time in a session | [`docs/architecture.md`](docs/architecture.md) (relevant sections, see top of this file) |
| Why a guard or a cautious-looking behavior exists | [`docs/decisions.md`](docs/decisions.md) |
| A watch that looks wrong, or an episode that will not match | [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| Webhook parsing, phases, auth | [`docs/webhooks.md`](docs/webhooks.md) |
| Scheduler, catch-up polling, manual dispatch queue | [`docs/scheduled-sync.md`](docs/scheduled-sync.md) |
| Plex / Emby / Jellyfin clients | [`docs/plex.md`](docs/plex.md), [`docs/emby.md`](docs/emby.md), [`docs/jellyfin.md`](docs/jellyfin.md) |
| TMDB / TVDB / Fanart / OMDb | [`docs/metadata.md`](docs/metadata.md) |
| Posters, backdrops, the image cache | [`docs/posters-artwork.md`](docs/posters-artwork.md) |
| SQLite tables, columns, migrations | [`docs/sqlite-schema.md`](docs/sqlite-schema.md) |
| SPA routing, state, module layout | [`docs/frontend.md`](docs/frontend.md) |
| Login, sessions, API key, webhook secret | [`docs/auth.md`](docs/auth.md) |
| Backups and restore | [`docs/backups.md`](docs/backups.md) |
| Build checks, git hooks, CI, Docker, releases | [`docs/development.md`](docs/development.md) |

Worth knowing before opening any of them:

- **One process, one SQLite file.** The default `ROLE=all` process serves the UI, `/api/*`, and
  the per-minute scheduler against `data/plembfin.db`. No cloud function, external database, or
  separate production environment.
- **`dispatch()` in `server/src/index.js` is the whole route table.** Handlers live in the owning
  `server/src/routes/*.js` module, never in `index.js`.
- **Derived caches are memoized against a shared data version.** `bumpDataVersion()` in
  `server/src/db.js` makes every process reload; forgetting it is why a change can look like it
  did not take effect.
