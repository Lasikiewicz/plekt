---
name: push-to-git
description: "Run the full develop push workflow for Push to git, Push all to git or push all the git (any case), including scope, docs/help, dependencies, changelog rebuild and consolidation."
---

# Push to git

Follow in order. Never interpret the trigger as a raw push. Read the matching sections of
[push reference](../../../docs/agent-push-reference.md) as each step starts; they preserve
the detailed dependency, documentation mapping, message and consolidation rules.

## 0. Scope and prechecks

"Push to git" includes ONLY this chat's files/lines/commits. Record HEAD, status and pending
origin/develop..HEAD before the first task edit. Baseline pending commits or inseparable
mixed changes require asking for all-scope or narrower scope, never git add . or a reset
that absorbs old work. "Push all to git"/"push all the git" includes all relevant local
changes and safely consolidated pending develop commits.
Save narrow baseline as JSON {"head":"<hash>","pending":[],"status":"<recorded status>"};
run `node scripts/workflow-check.js scope <baseline.json>` before staging/consolidating.

```
npm run push:precheck
node scripts/release-lock.js acquire "push to git"
```
The precheck reads cleanup/lock/security status, prints baseline and refuses blockers.
Report EVERY security alert with file/severity. High/critical or changed-file alerts
require an explicit user decision; unavailable auth/disabled alerts also require agreement.
Never dismiss alerts to clear a check. Keep GHCR cleanup dry-run until its new-package
results are reviewed. Wait for running cleanup, and check again before push.
Do not work around a refused lock; release on completion/abandonment.
Respect the current environment's Git permission boundary; never use alternate indexes or
indirect writes to bypass it.

## 1. Review and dependency PRs

Review selected diff and pending commits. Read reference "Check open dependency PRs":
```
gh pr list --author "app/dependabot" --state open --json number,title,headRefName,url
```
No PRs: report and continue. Otherwise apply each locally one at a time, skipping files
with unrelated edits. npm install package@version for npm bumps; edit Actions uses for
Actions bumps. Test AND build each. Native better-sqlite3/sharp also needs green Docker
Build Check. Classify patch/minor green as safe, major/native/breaking as needs review.
Report package/versions/risk/check results; STOP for the user's inclusion choice.
Undo only declined bump edits; leave their PR open. Remember included PR numbers.
Never gh pr merge; normal inclusion ships through develop.

## 2–3. Docs, README and in-app help

Read the reference's changed-area doc/README table. Read actual relevant README sections,
update stale docs, file maps and help renderers/inline help/setup guides for changed flows.
Prose describes current behavior for first-time readers. Do not edit website for app work:
record its review targets for Force to main.
Read CLAUDE.md when changing agent workflows; decisions.md for cautious guards/release code.

## 4. Message and website decision

Use conventional type (feat/fix/security/chore/docs), concise subject and meaningful
"- " body details for EVERY significant user-visible outcome, not subject repetition.
Keep agent/tooling/process work in separate chore commits, outside product bullets.
Every new commit, including bookkeeping, needs:
```text
site-impact: <valid docSlug list, or none>
Website review: <changed behavior, copy and image candidates; or not required with reason>
```
Slugs come from website/src/data/app-surface.json. These are metadata, never changelog
bullets. Squashing unions guides/reasons and preserves all distinct product outcomes;
none only if all constituents need no review. Older missing notes contribute mapped guides.
Use a message file or real multiline arguments, verify git log -1 --format=full.
Commit hooks and changelog rebuild enforce bullet/process rules; never bypass them.

## 5. Stage and commit

Stage ONLY chosen scope. Never stage data/, backups/, node_modules/, secrets or force-add
local archives. Run `node scripts/workflow-check.js staged`; inspect staged diff.
Commit using the reviewed message; existing approvals and scope rules remain mandatory.

## 6. Refresh/rebuild

```
npm run updates:refresh
npm run push:prepare
```
Read plan/updates.md changelog-ready changes and website targets. push:prepare rebuilds
and commits changelog.develop.json AND public restamps, then checks pending commits and
committed changelog. A validation error needs fixing, never bypassing. No user-facing
commits means no extra manifest commit; repeated preparation must not burn build numbers.

## 7. Consolidate

Read reference "Consolidate pending local commits". Show origin/develop..HEAD.
All-scope squashes pending product/changelog commits; narrow scope only when the baseline
had no pending commits. Preserve all distinct product bullets and website reasons/guide
union; keep tooling out of product text. Soft-reset only the approved scope to
origin/develop, commit its consolidated message, then rerun step 6 and inspect final
recorded message. Never reset over unknown work.

## 8. Push

```
node scripts/workflow-check.js before-push push
git push origin develop
```
The hook checks exact committed changelog, pending shape and FULL build. Never --no-verify.
Only develop moves; no alpha/main/package release changes or latest tag.
If diverged, fetch and reconcile with merge (ff-only if possible), then repeat checks/push.
Pause on conflicts or unfamiliar source changes. Never silently absorb unrelated work.

## 9. Finish

Only after successful push, close included/agreed dependency PRs with the pushed SHA,
using the closure comment from the reference workflow. Never close declined/unshipped PRs.
Then release the lock. Report what shipped and any unavailable security coverage honestly.

## Example requests

> Push to git

> Push all to git
