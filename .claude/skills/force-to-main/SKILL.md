---
name: force-to-main
description: "Promote Plekt alpha to main when the user says Force to main exactly, or resume a named phase B/C handoff. Preserve candidate, changelog, website and final-review approvals; never push develop."
model: opus
---

# Force to main

Route handoffs first: **phase B (capture only)** runs only the named captures.md assignment
(no release prechecks/lock/worktree); **phase C** reads the run summary and resumes at 4.
Only the exact initial trigger starts at 0. Never reconstruct this flow from memory.

At every stop and phase end, show this checklist with done boxes ticked,
the stop marked "here" and a one-line next action:

- [ ] 1 Main build candidate running and changelog preview shown
- [ ] 2 Suggested changelog updates made
- [ ] 3 User accepts changelog and build
- [ ] 4 Website phase A: guides reviewed, capture list written
- [ ] 5 Website phase B: release-capture subagent takes the captures (report)
- [ ] 6 Website phase C: images accepted, website checks pass
- [ ] 7 Release promoted and committed locally (website carried in)
- [ ] 8 Final review: release build presented for the user
- [ ] 9 Force-push main and publish workflow
- [ ] 10 OCI demo verified, website published, local develop reconciled

## Standing approvals (no stops between the named STOPs)

The only stops are the bold **STOP** gates below (changelog and build approval, phase B
NEEDS HUMAN or FAIL, final review) and publication rules, which are unchanged. Everything else
in phases A to C is pre-approved; do it, record it in the step file, and keep going:

- Writes to the local server and the connected test apps in `.claude/local-environment.md`
  (Plex, Emby, Jellyfin, Trakt, Seerr test instances): live states, dismissals, played or
  unplayed marks, settings toggles, playback, and any echo they cause. Signing in with the
  credentials in that file. Starting or restarting the test containers.
- Browser checks: the agent does them itself, through preview or connected Chrome. Never ask
  who checks. Retry a failed click or snapshot by another route (element ref, DOM, API, other
  browser) instead of stopping after 2-3 failures.
- Context size: the context-budget hook is silent while the release lock is held. Never hand
  off to a fresh session for context; keep reads bounded and continue.
- Judgement calls (which count, which episode, which selector, catalogue vs local notes): pick
  the one the capture catalogue needs and record why. Do not ask.
- A live state that still cannot be created after trying every route: record it as skipped
  with the reason, carry it as a leftover for the user's website check, and continue.
- Waiting on a background job is not a stop: never ask anything while waiting.

## 0. Precheck, lock and run record

Read [candidate operations](../../../docs/agent-release-candidate.md) for steps 0–2,
including the run templates and process ownership rules. From the main checkout:

Before any command, read `plan/next-release-checks.md` and its checklist. An unchecked **Before Force to main**
item, unresolved prior post-publication result, or missing plan/checklist blocks the release; stop
before acquiring the lock.

```
npm run release:precheck
node scripts/release-lock.js acquire "force to main"
git fetch origin
```
Recheck cleanup after fetching and before push; never work around a refused lock.
Record baseline, pins, paths/PIDs and approvals in the run templates; keep existing changes
and filenames consistent.
Lock expires after 30 minutes: inspect/reconcile on resume, reacquire if needed.
Keep it across handoffs; release on completion/abandonment, only in the main checkout.

## 1–2. Pinned candidate, changelog and build approval

On develop, follow candidate operations: an unused external detached worktree at the pin,
npm ci, releaseMessage, BUILD_CHANNEL=main. Never patch candidate code, copy credentials or
run develop and candidate concurrently on shared data.

```
node scripts/promote-alpha-to-main.js --preview
# In the disposable candidate only, following the documented setup:
node scripts/promote-alpha-to-main.js --confirm --defer-website-gate
```
The website gate waits for step 5, after the reviewed website is carried in; other refusals STOP.

Record this JSON with the run notes:
`{ "alpha": "<full pin>", "main": "<full pin>", "worktree": "<absolute path>",
"pid": 1234, "baseUrl": "http://localhost:5056", "version": "<version>" }`.
Run `npm run release:candidate -- <absolute-record.json>` before presentation and C resume.
Pass PLEKT_CHECK_COOKIE privately if needed; verify process ownership against recorded paths.
Checks establish identity, never approval.

Show full entry and running build together; recommend wording changes with reasons (or none).
Edit only after agreement.
**STOP for explicit approval of both changelog and running main build before phase A.**
Build changes need develop/Force to alpha and new approval.

## 3. Website A

Read [website operations](../../../docs/agent-release-website.md) and
[website update contract](../../../docs/websiteupdate.md).
Use the approved candidate throughout A/B/C. On develop:
```
npm run updates:refresh
npm run check:website-impact
```
Reconcile targets with pinned commits/website notes and actual diffs/images. Source paths
alone never mandate retakes. Record each capture's reason/commit; user-narrowed scope wins.
Review copy, prepare capture-run.json, required live states and captures.md from the
template. New or renamed guides get their `website/src/data/app-surface.json` entry here
(docSlug, sourcePaths, formerDocSlugs); `npm run check:content` in `website/` must pass. Run recapture --check and the scratch framing trial required by website
operations. Fix catalogue framing/app defects rather than blindly retaking WARNs.
If no captures are needed, record that explicitly and skip B.

## 4. Website B handoff and C

Phase B: delegate to the `release-capture` subagent (`.claude/agents/release-capture.md`) with
the version and captures.md path, then wait for its report. PASS: continue to phase C
automatically. NEEDS HUMAN or FAIL: STOP and ask the user.

Phase C reads the run summary, reconciles lock/source, reruns release:candidate.
Read website operations for image, privacy, caption, link and full-gate checks:
```
# From website/
npm run captures:inventory
npm run check
npm run build
```
Inspect EVERY staged image and WARN. A framing/app defect needs correction or reporting.
Complete website items or record explicit user acceptance of leftovers. Commit on develop;
never push it.

## 5. Carry, preview, promote

Read [promotion/publication operations](../../../docs/agent-release-publish.md) now for the
exact carry, stage and cleanup commands.
Require a clean main checkout, switch to the pinned alpha, carry website from develop,
restore approved wording, review README and run:
```
npm run docs:check
node scripts/promote-alpha-to-main.js --preview
```
Compare version/headline/ALL bullets with approval. Website outstanding must be empty.
Changed preview requires renewed approval; changed remote main/alpha requires reconciliation.
Then --confirm, docs:check, stage manifests/README/package files/public/website,
run `node scripts/workflow-check.js staged`, inspect staged scope and commit one release.
Safely stop/remove only this run's verified candidate per publication operations;
unexpected work blocks cleanup. Preserve the approval/preview records.

## 6. Exact final review: STOP

Start app (BUILD_CHANNEL=main) and website from the exact committed release after verifying
ownership and stopping old listeners. Show full changelog entry, changed/stamped guides and
accepted leftovers, app URL/version and website URL including /changelog.
**Wait for explicit final go-ahead.** Requested changes need checks and renewed review
(app/changelog changes return to the release approvals). Do not blindly promote again.

## 7–8. Push, demo, website

Before the main push, check and record every item under **During Force to main, before publishing
main** in `plan/active/next-release-checks/step1-checklist.md`; any open check blocks publication.
A conditional item is complete only if its condition did not occur or its recovery was carried out.
After publication, record results and carry unresolved items into the next run's preflight; they
block its release lock.

After approval, run `node scripts/workflow-check.js before-push main --record=<record.json>`,
show `git log origin/main..HEAD --oneline`, then:
```
git push origin HEAD:main --force
```
Never bypass hooks. After a first hook failure, run npm test once and retry the SAME push
only if it passes; a second failure stops for investigation.
Wait for Publish Main Release AND its OCI deployment/version verification to succeed.
Missing OCI configuration/failure means incomplete release; never seed demo fixtures here.
A failed Publish Main Release on a small non-user-facing fix (tests, CI, tooling) defaults to a
hotfix on main, then develop brought up to it (the next Force to alpha rebuilds alpha). No full re-run.

Follow publication operations to deploy the clean pushed release website to
plembfin-website only (check:deploy, build, Wrangler). Final approval already covers this.
Login failure stops for user login. Verify live links and image bytes: `npm run release:verify-live -- <version>`. Failure means
release incomplete.

## 9. Local reconciliation

Only after workflow/demo/website success:
```
npm run release:reconcile
```
Review all develop-only commits/hunks as documented, including recognized version stamps.
Missing work means STOP. Otherwise record old tip, locally
`git checkout -B develop origin/main`, set upstream origin/develop and report status.
Never push develop or merge/fold the release back. Release lock; update step/summary/todo
each phase and run todo:check. Apply publication operations' rebrand checks unchanged.
Then offer Announce release (drafts only); run it only on acceptance.

## Example request

> Force to main
