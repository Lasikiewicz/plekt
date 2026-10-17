# Agent conduct reference

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
- **Test setup comes from `.claude/local-environment.md`.** Read it before any test, including
  browser checks, and use only the local server and connected test instances it lists. Live
  services are in `.claude/live-environment.md` and are used only when the user explicitly asks.
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
