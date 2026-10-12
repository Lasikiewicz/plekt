# CLAUDE.md

Agent instructions for working with this codebase.

> **Before changing anything, read the relevant parts of [`docs/architecture.md`](docs/architecture.md).**
> It is the master guide (big picture, complete file map, request flow, data layer, auth,
> environment variables). It is about 100 KB, so read "The big picture" and "Subsystem map"
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

## Token efficiency

Cost is driven by context size multiplied by the number of calls: every call re-sends the whole
conversation. Keep both small without cutting any verification.

**Session hygiene** (the agent cannot open sessions itself, so it says so to the user):

- **One task per session.** When a task is finished, and especially when the user asks "what's
  next", recommend a fresh session instead of carrying the history forward, and give a one-line
  handoff to paste into it: the summary path plus the current step and its step file (for
  example `Continue plan/custom-playlist-sync.md, step 6 (method in
  plan/active/custom-playlist-sync/step6-live-verification.md)`).
- **Checkpoint long runs.** Before starting a multi-phase job ("do it", "start phase N", `/goal`),
  write the current progress into the step file's Results and the next step into the summary,
  then recommend running each phase in a fresh session that starts from the summary.
- **Context budget.** A local hook (`.claude/hooks/context-budget.mjs`) reports the context size
  past 150k and 250k, at each prompt and once per level mid-task. Past 150k, "what's next" gets the next item plus a handoff line, not the
  item itself. Past 250k, finish only the current item, write the handoff into the summary, and
  recommend a fresh session. The audit that prompted this found 91% of input tokens were spent
  above 200k context (`plan/agent-token-efficiency.md`).
- **Stale sessions.** When a large session resumes after an hour or more away, its cache has
  expired and the whole context is paid for again; recommend starting fresh from the plan summary.

**Working style:**

- **Explore efficiently.** Run independent searches and reads in parallel in one message. Use
  Grep with small context, or Read with `offset`/`limit`, instead of `sed -n` ranges, whole-file
  dumps, or unbounded `git diff` output. Do not re-read a file already in context unless it
  changed. Delegate broad multi-file searches to an Explore subagent so only its conclusion
  enters the main context.
- **Edit with the Edit tool**, not ad-hoc Python/shell rewrite scripts.
- **Avoid permission prompts.** Each Bash call that is not allowlisted stops the user for approval.
  - Create and change files with Write/Edit, never `cat > file`, heredoc redirects, `sed -i`,
    `cp` backups, or inline `node`/`python` rewrites.
  - Put probe scripts and temporary files in the session scratchpad, not the repo root, so no
    `rm` cleanup is needed. Prefer `curl -s http://localhost:5056/...` or `node -e` over a new
    script file when a one-off query is enough. Run scratchpad scripts as
    `node "<absolute scratchpad path>/x.mjs" args` (the form a local allowlist can match); never
    through a shell variable (`Q=...; node $Q`) or after `cd`, which prompt every time.
  - Do not chain an allowlisted command (`npm test`, `node --test`, `npm run server:restart`,
    `curl` to localhost) with one that needs approval; one unapproved part prompts for the whole
    line. Run the part that needs approval as its own call, or find an allowlisted form.
  - Temporarily mutating source to prove a test fails is fine, but do it with Edit and revert
    with Edit.
- **Ask who checks the app, before starting.** When a task's verification includes looking at
  the running app, ask the user at the start (before writing code) whether they will do that
  check or want the agent to, with "you check" as the recommended option. If the user checks,
  finish the code and the unit tests/build, then give a short checklist (page, style and mode,
  width, what should appear) and record the check as waiting on the user in the plan step.
  One answer covers only that task's checks. Agent-run app checks are expensive (one browser
  check of six pages cost about 108k tokens).
- **Browser checks: text first, screenshots last.** Prefer `curl` against the API, page text
  (`get_page_text`), the accessibility tree (`read_page`), or a JavaScript probe. Take screenshots
  only when the check is genuinely visual, at reduced scale, and never inside large batches. Use
  one browser stack per session. Run multi-step browser verification in a subagent that returns
  only a pass/fail table with evidence, so screenshots and page dumps never enter the main
  context. Cap `preview_logs` at about 200 lines and use its `search` filter.
- **Large files: search, never read whole.** A hook denies whole-file `Read` of text files over
  60 KB (large plan step files, big route modules); Grep, then Read with
  offset/limit. Shell reads (`sed -n`, `cat`, `head`) and inline Python get a warning.
- **Server restarts are one call:** `npm run server:restart` (stop, start, wait for `/api/ping`,
  one line out). Do not hand-roll stop/start/sleep/probe loops.
- **Poll sparingly.** Every wake-up re-sends the full context; wait on a notification or a
  single well-timed check rather than repeated short sleeps.

**Plan files stay small.** Every plan, including a one-step plan, uses the layout in
"Plan layout" below. Open only the file the work at hand needs: the summary to see where things
stand, `plan.md` for the design, and the one step file being worked on. Record new evidence in
that step file's Results, and update the summary's "Where we are" and ticks.

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
| "Check requests" (case-insensitive) | `.claude/check-requests.md` |

Rules that hold regardless of which skill is running:

- A trigger phrase never means `git push` by itself; the push is one late step inside the
  workflow, after every gate has passed. Never deploy or push to any remote unless the user
  explicitly asked in that request.
- "Start the server": `npm run server:restart -- --if-down` (reuses a running server) on
  `http://localhost:5056`; `npm run server:restart` forces a restart. It needs outbound network
  access for providers; see `docs/development.md` "Windows provider-backed server launches".
- "Check requests" is local-only and read-only: inspect the registered Plex, Emby, and Jellyfin
  request pages in connected Chrome, compare status/votes/comments with the ignored local
  snapshot, and draft (never post) replies a maintainer needs. If a provider asks for login,
  stop at that provider and tell the user which session needs attention.
- Never bypass a hook with `--no-verify`, and never bypass the changelog rebuild.
- The `.githooks/post-commit`, `post-merge`, and `post-rewrite` hooks regenerate the ignored
  `plan/updates.md` ledger from committed history since `origin/main`. Refresh it with
  `npm run updates:refresh` before Push to git or Force to main and use its changelog bullets
  and website targets as the review inventory. It does not replace the committed changelog
  manifests or the human website gate.
- Before Push to git, Force to alpha, or Force to main, check GHCR Cleanup is not mid-run
  (`gh run list --workflow ghcr-cleanup.yml --limit 1`); each skill repeats this first.
- "Force to alpha" and "Force to main" force-push shared branches; follow each skill's
  changelog and running-build approval gates before pushing. "Force to main" approves the
  pinned alpha changelog and running build before website phases A/B/C, carries the reviewed
  website into that release, then stops for a final review of the exact commit before push.
- Neither force command pushes `develop`. If a procedure tells you to, it is out of date.

## Documentation and backlog sync

[`todo.md`](todo.md) is the single backlog: one line per plan, linking its summary,
never a detailed entry. Completed plans move to [`plan/archive/`](plan/archive/) and leave the
TODO. There is no root `TODO.md` (retired 15 September 2026).

- **Links in `todo.md` are written from the project root** (`plan/<name>.md`), because the
  user opens it in the Claude desktop app, which resolves links from the project root.
- **"Last worked on" at the top of `todo.md`** lists the last three plans worked on, newest
  first, each with its current step in a few words and its link. Whenever a plan's summary is
  updated, move that plan to the top of the list (dropping the fourth), in the same change.
- **Small work with no plan of its own** (a bug found in passing, a follow-up check) becomes a
  new step in the loose-ends plan (`plan/loose-ends.md`), not a paragraph in `todo.md`. Work that
  belongs to an open plan becomes a step in that plan. Anything substantial gets its own plan.

### Plan layout

Each plan `<name>` has these parts (user-agreed 25 September 2026):

- `plan/<name>.md`, the **summary**, written for the user in plain English: Purpose, "Waiting on
  you" (just above the steps), Steps (a ticked checklist linking each step file, with unticked
  sub-boxes for each outstanding check), and "Where we are" (3 to 5 lines, after the steps). It is the only place status
  lives, and it holds no file names or code.
- `plan/active/<name>/plan.md`, the **design**: scope, decisions (with the user's answers and
  dates), safety rules, contract, acceptance criteria. No status.
- `plan/active/<name>/stepN-<topic>.md`, one small file per step: Work, Tests, and Results
  (dated entries). There are no separate `-results` or `-reference` files; bulky evidence goes
  in the step it belongs to. Keep each file under about 15 KB; split a step (5a, 5b) rather
  than grow it.
- Files a plan creates (check scripts, probes, fixtures, data) live in a subfolder of its
  folder, for example `plan/active/speed/checks/`, never in the repo root or loose in `plan/`.
- On completion the folder moves to `plan/archive/<name>/` and the summary moves in as
  `summary.md` (see [`plan/archive/README.md`](plan/archive/README.md)).

`plan/` is git-ignored, so moving or deleting a plan file cannot be undone from git; keep a copy
in the session scratchpad before a restructure.

When implementing or finishing planned work, update its step file and summary in the same
change. If user-visible behavior changes, also update the relevant `docs/` page and README
section. Before closing a plan, verify code and docs both describe current behavior.

### MANDATORY: what plans contain

- **A plan holds what the user wants, how to implement it, and how to test it**, plus status
  (summary only), progress notes, and results (step files). Nothing else becomes a work step.
- **Ask behavior decisions when they come up.** When implementation reaches a product or
  behavior choice (what the user sees, when something syncs or deletes, thresholds, conflict
  rules), stop and ask the user then, with the recommended option first, and record the answer
  in `plan.md` as a decision. Never pick a default, build it, and log it as a "scoping call
  awaiting review". Pure implementation details (module layout, helper functions) need no
  question.
- **"Waiting on you" holds only what blocks the plan now**: a question asked while the plan is
  running whose answer the next piece of work needs, or an action only the user can take
  (a sign-in, an account, a manual check) that the current step needs. Questions for a later
  step are written into that step file's Work ("when this step starts, ask ...") and asked
  then, never listed in advance. When nothing blocks, it says "Nothing."
- **No website work in feature plans.** Website captures, recaptures, website doc edits, and
  website preview checks happen only inside a "Force to main" run (its website update gate).
  A plan or handoff line that names website work does not authorize it; skip it and remove it
  from the plan.

### MANDATORY: keep the TODO current, and never overstate status

**Before ending any turn that changed code, and before starting a new phase of work, update
[`todo.md`](todo.md) and the owning plan's summary ("Where we are" and the step
ticks) with the real status.** Not
optional, not waiting to be asked. Also move the plan to the top of "Last worked on". Work with
no plan becomes a step in the loose-ends plan; if it is substantial, write its own plan.

- **Distinguish "implemented", "unit-tested", and "verified".** Compiling is not tested; tests
  that stub the network are not verified against the real service. Only make true claims.
- **A step is ticked only once its own tests and checks have actually been run**, and a plan is
  `Completed` only when every step is ticked. Until then the summary says what is built and
  tested in plain words, with each outstanding check as its own unticked sub-box under its step.
- **Archive completed plans immediately**: in the change that closes the TODO item, move
  `plan/active/<name>/` to `plan/archive/<name>/`, move the summary in as `summary.md`, and fix
  relative links crossing the archive boundary. Never archive plans with unverified or deferred
  checks; incomplete, deferred, blocked, and merely implemented plans stay outside the archive.
- **List what is NOT verified explicitly, with the failure mode**, in the owning step file.
  "Emby `DatePlayed` unconfirmed - a wrong format degrades silently to watched-dated-today while
  still reporting success" is useful; "some testing remains" is not. The summary's sub-box says
  the same in plain words.
- **Record the user's answers to behavior decisions** in `plan.md` (see "what plans contain");
  unanswered behavior choices are asked, not recorded as pending reviews.
- **Never mark a downstream plan unblocked** until the upstream plan reaches `Completed`.

A task is finished when it is verified, not when it is written.

### Decision records

[`docs/decisions.md`](docs/decisions.md) preserves the reasoning behind deliberate calls. Add a
numbered entry only when all three hold: a plausible alternative was rejected, the reason is not
visible from the code, and undoing it would cost real time, data, or user trust. Not for ordinary
implementation choices, things already in a feature doc, or release bookkeeping. Append in date
order, never renumber, and mark reversed decisions superseded with a pointer instead of deleting.
Before changing behavior that looks unnecessarily cautious (a dropped sync signal, an extra
confirmation, a seemingly redundant guard), check `docs/decisions.md` first.

## Commands

`npm start` (UI + API + scheduler on `http://localhost:5056`), `npm run dev` (auto-reload),
`npm test` (`node:test` suite), `npm run build` (syntax check, tests, JSON validation,
outbound-fetch guard, one-shot boot). No linter. Details, first-boot credentials, and the
sandboxed-agent launch and Git-check rules are in [`docs/development.md`](docs/development.md).
An outbound-fetch `EACCES` from an agent-launched server is an execution-environment failure,
not an application result: restart it with network access before diagnosing.

## Module discipline (frontend and backend)

Size limits: `public/app.js` is orchestrator only, under **3,000 lines**.
`public/modules/*.js` and `server/src/routes/*.js`: soft limit **1,200**, hard limit **1,500**
lines; split by feature area before adding to a file past the soft limit.
`server/src/index.js` is the route table only, under **500 lines** (currently 190).

### Grandfathered files

Files already over their limit are listed in `docs/development.md` "Module size limits"; the
limits apply in full to every other file.

- **Do not grow them.** New code for these areas goes into a new or existing sibling module.
- **Do not split one on your own initiative.** Being over the limit is not a task. Split only
  when the requested work already touches that file, and only after proposing the extraction
  and getting the user's explicit go-ahead. These files own a lot of behavior; a careless split
  breaks more than it tidies.
- **When a split is approved, do it properly.** Move whole feature units or handler groups, not
  line ranges; keep named exports working or update every importer; check nothing else imported
  what moved. Frontend: add the `modulepreload` link in `index.html` (or register a route module
  in `route-modules.js`) and update the module table in `docs/frontend.md`. Backend: update the `dispatch()` entries in `server/src/index.js` and the API area table.

`server/src/routes/sync.js` deserves particular care: it owns webhook ingestion, manual watch and
unwatch, playback progress, sync job/history APIs, cron and force sync, preview plans, and now
playing, and several incident-driven rules in [`docs/decisions.md`](docs/decisions.md) constrain it.

### Where new frontend code goes

Before adding frontend code, look up the owning module in the feature-area table in
[`docs/frontend.md`](docs/frontend.md) ("Where new frontend code goes") and place the code in the
most specific module listed there. Create a new module only when the area fits none of them and
would exceed 150 lines; follow that doc's "Adding a new module" steps (core-graph modules get a
`modulepreload` link, route modules are registered in `route-modules.js` instead) and add the new
module to the table.

**Dependency rules:** modules may import from `state.js`, `utils.js`, `images.js`, `auth.js`,
`logs.js`, `settings.js`, `settings-ui.js`. `sync.js` may be imported by `dashboard.js` and
`media-detail.js`, not the reverse. No module imports from `app.js`. No circular dependencies;
shared logic for A↔B belongs in a third module.

### Where new route code goes

Add the route entry in `dispatch()` in `server/src/index.js` and put the handler in the owning
`server/src/routes/*.js` module. Keep helpers in `server/src/utils/` only when more than one
route module needs them. No imports back into `server/src/index.js`; route modules may import
utilities and data-layer modules directly. The owning module for each API area is in the
`server/src/routes/` table of `docs/architecture.md` (scheduler tick and Plex notification
listener: `server/src/scheduler.js`).

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
