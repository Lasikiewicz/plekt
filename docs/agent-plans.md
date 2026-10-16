# Plan and backlog rules

## Documentation and backlog sync

[`todo.md`](../todo.md) is the single backlog: one line per plan, linking its summary,
never a detailed entry. Completed plans move to [`plan/archive/`](../plan/archive/) and leave the
TODO. There is no root `TODO.md` (retired 15 September 2026).

- **Links in `todo.md` are written from the project root** (`plan/<name>.md`), because the
  user opens it in the Claude desktop app, which resolves links from the project root.
- **`todo.md` order** (user-agreed 16 October 2026): title `# Plekt TODO`; **Now** (the 1 to 3
  plans being worked on, one line each: name, current step, next action, link); **Up next**,
  **Later** and **Deferred** (one line each, no history, command lines or PIDs); **Waiting on
  Jason** (actions only the user can take, each linking its plan); then, below a `---`
  divider, **Change log** (newest first, one short dated line per update, last 10 only).
  One consistent numbering, each plan exactly once. Whenever a plan's summary is updated, that
  plan moves into Now (dropping the oldest if there are more than three), in the same change.
- **`plan/updates.md` is a generated ledger** (see "Release commands"), not a plan summary; it
  is never listed in `todo.md`.
- **Small work with no plan of its own** (a bug found in passing, a follow-up check) becomes a
  new step in the loose-ends plan (`plan/loose-ends.md`), not a paragraph in `todo.md`. Work that
  belongs to an open plan becomes a step in that plan. Anything substantial gets its own plan.

### Plan layout

Each plan `<name>` has these parts (user-agreed 25 September 2026):

- `plan/<name>.md`, the **summary**, written for the user in plain English, in this order
  (user-agreed 16 October 2026): title and one-line purpose; "Where we are" (3 to 5 lines,
  current state only); "Waiting on you"; Steps (a ticked checklist linking each step file, with
  unticked sub-boxes for each outstanding check); then, below a `---` divider, "Background and
  history" (full purpose, dated notes, design and decision links); and one `Last updated:
  <date>` line at the very bottom (no "Updated:" line at the top). It is the only place status
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
  `summary.md` (see [`plan/archive/README.md`](../plan/archive/README.md)).

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

**After every step (not only at the end of a turn or a phase), update the owning plan's
summary ("Where we are" and the step ticks), the plan's line under Now in [`todo.md`](../todo.md),
and add one Change log line.** Not optional, not waiting to be asked. "Where we are" and Now
lines are rewritten to the current state, never appended to; dated detail goes only in the step
file's Results and the bottom Change log. Work with no plan becomes a step in the loose-ends
plan; if it is substantial, write its own plan.

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
