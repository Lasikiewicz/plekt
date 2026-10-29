# Plan and backlog rules

## Documentation and backlog sync

[`todo.md`](../todo.md) is the single backlog: one line per plan, linking its summary,
never a detailed entry. Empty standing backlogs, including `plan/bugs.md` when it has no open
bugs, are not listed. Completed plans move to [`plan/archive/`](../plan/archive/) and leave the
TODO. There is no root `TODO.md` (retired 15 September 2026).

- **Links in `todo.md` are written from the project root** (`plan/<name>.md`), because the
  user opens it in the Claude desktop app, which resolves links from the project root.
- **Plan checkboxes show progress**: use `- [ ]` for work not started and `- [-]` for work
  in progress. The latter renders as the orange single-line checkbox in the user's Markdown
  viewer. Apply this to TODO entries and plan/step checklist items; completed items use `- [x]`.
- **`todo.md` layout** (user-agreed 26 October 2026): title `# Plekt TODO`, then
  **Release: vX.Y.Z (Expected)** with **Work in Progress**, **Requires Remote Testing**, and
  **Not Started** subsections; **Post Release (vX.Y.Z)**; and **Future Release**. Do not add
  separate Last edited or Deferred sections. Work deferred from the current release belongs in
  Future Release. Keep the current Release above Post Release while both name the unreleased
  candidate version. After that version is released, move its Post Release section above Release
  while post-release tasks remain; when empty, keep Release above it. Each plan appears exactly
  once in the applicable release and status subsection, as two lines, the first ending in a `\` hard line
  break so they render separately:
  `**Title** - [](plan/<name>.md) - 16 October 2026, 18:42` (or
  `**Title - Not Started** - [](plan/<name>.md) - 16 October 2026, 18:42` when the plan has not
  started; the link has no text, so the desktop app shows only the plan file's chip; the date last worked on, with the
  time when known, then ` (<branch>)` when the work is on a branch other than `develop`), and a
  very brief summary (a few words). A blank line separates entries, and each subsection is
  ordered by that date, newest first. Plan bookkeeping (moves, merges, link fixes) does not count as work
  on a plan. Keep each plan in the appropriate release and status subsection when its state changes. There is no "Waiting on"
  section or change log: what the user must do lives in each plan's "Waiting on you", and history
  lives in the plans.
- **Release assignment for new work**: when creating a new plan or feature, ask which release
  bucket it belongs in unless the user already specified one. Offer exactly three choices
  (user-agreed 27 October 2026): Hotfix (a fix to the released version, listed under Post
  Release), Next release (the expected version, listed under Release), or Future release.
  Record the answer in the
  plan and list it in that TODO section. Defer work by assigning it to a future release, not by
  creating a Deferred category. Derive the current release from the latest
  published changelog entry and the next expected version from the release tooling/package
  version; if the expected version cannot be determined, ask instead of guessing.
- **`plan/updates.md` is a generated ledger** (see "Release commands"), not a plan summary; it
  is never listed in `todo.md`.
- **Every open item belongs to a specific plan.** Add work to its existing owner plan when one
  exists; otherwise create a focused plan for that feature or follow-up. Do not create or use a
  catch-all loose-ends plan, and do not put individual work items directly in `todo.md`.

### Plan layout

Each plan `<name>` has these parts (user-agreed 25 September 2026):

- `plan/<name>.md`, the **summary**, written for the user in plain English, in this order
  (order revised by the user 23 October 2026): title and one-line purpose; "Waiting on you";
  Steps (a ticked checklist linking each step file, with unticked sub-boxes for each outstanding
  check); "Where we are" (one short current-status paragraph, normally 3 to 5 source lines,
  at most 120 words and 900 characters); "Background and history" containing only a link to
  the plan folder's `history.md`; and one `Last updated: <date>` line at the very bottom
  (no "Updated:" line at the top). The summary holds current status only, never dated journals,
  detailed results, implementation notes or inline historical sections.
- In every plan with steps, place "Where we are" after the complete steps section (after
  all step sections when there are several), before background/history. Apply this order to
  existing plans and plan templates as well as new plans. Reordering alone is bookkeeping:
  preserve status text, checkboxes, plan dates and TODO entry order.
- `plan/active/<name>/history.md` holds background, previous summary/status notes and dated
  cross-step history. Archived plans keep it beside `summary.md`. A standing backlog with
  another folder layout keeps `history.md` in its own associated folder. Keep the summary's
  history link relative and valid when moving or archiving it. Detailed progress, test evidence
  and results for a specific step belong in that step's Results; design decisions belong in
  `plan.md`. Preserve older migrated material in history rather than discarding it.
- `plan/active/<name>/plan.md`, the **design**: scope, decisions (with the user's answers and
  dates), safety rules, contract, acceptance criteria. No status.
- `plan/active/<name>/stepN-<topic>.md`, one small file per step: Work, Tests, and Results
  (dated entries). There are no separate `-results` or `-reference` files; bulky evidence goes
  in the step it belongs to. Keep each file under about 15 KB; split a step (5a, 5b) rather
  than grow it.
- Files a plan creates (check scripts, probes, fixtures, data) live in a subfolder of its
  folder, for example `plan/active/speed/checks/`, never in the repo root or loose in `plan/`.
- On completion the folder moves to `plan/archive/<name>/` and the summary moves in as
  `summary.md` (see [`plan/archive/README.md`](../plan/archive/README.md)).

`plan/` is git-ignored, so moving or deleting a plan file cannot be undone from git; keep a copy
in the session scratchpad before a restructure.

When implementing or finishing planned work, update its step file and summary in the same
change. If user-visible behavior changes, also update the relevant `docs/` page and README
section. Before closing a plan, verify code and docs both describe current behavior.

### MANDATORY: what plans contain

- **A plan holds what the user wants, how to implement it, and how to test it**, plus status
  (summary only), progress notes and results (step files), and background/history (`history.md`).
  Nothing else becomes a work step. Every future update must keep this separation: rewrite
  the current-status paragraph, put dated step evidence in Results, and put cross-step history
  in `history.md`. Never append a journal to "Where we are" or expand the summary's history link.
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

**After every step (not only at the end of a turn or a phase), update the owning plan's
summary ("Where we are" and the step ticks), and in [`todo.md`](../todo.md) keep the plan in its
assigned release and status subsection and rewrite its brief summary with the current date and time.**
Not optional, not waiting to be asked. "Where we are" and TODO summaries
are rewritten to the current state, never appended to;
dated detail goes only in the step file's Results. Work without an existing owner plan gets its own
focused plan. `npm run todo:check` (also the stop hook) compares
todo.md against the summaries and the markdown step files only: run output a tool writes into a
`plan/active/` folder (logs, id chunks, run JSON, the capture tool's `captures/` folder) does not
make todo.md stale, so a background check or capture run never forces repeated TODO edits.

`npm run todo:check` also validates summary layout and history links. Fix violations instead
of bypassing the check. Layout-only migrations preserve plan dates and TODO ordering; save
TODO after the migration so its freshness check reflects that bookkeeping.

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

[`docs/decisions.md`](decisions.md) preserves the reasoning behind deliberate calls. Add a
numbered entry only when all three hold: a plausible alternative was rejected, the reason is not
visible from the code, and undoing it would cost real time, data, or user trust. Not for ordinary
implementation choices, things already in a feature doc, or release bookkeeping. Append in date
order, never renumber, and mark reversed decisions superseded with a pointer instead of deleting.
Before changing behavior that looks unnecessarily cautious (a dropped sync signal, an extra
confirmation, a seemingly redundant guard), check `docs/decisions.md` first.
