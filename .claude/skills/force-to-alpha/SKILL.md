---
name: force-to-alpha
description: "Promote queued Plekt develop to alpha when the user says Force to alpha exactly. Review README, approve changelog before commit, approve running alpha before force-push; never push develop."
---

# Force to alpha

## 0. Precheck and lock

```
npm run alpha:precheck
node scripts/release-lock.js acquire "force to alpha"
git fetch origin
git checkout develop
git merge --ff-only origin/develop
node scripts/workflow-check.js stable-base
```
Wait for queued/running GHCR Cleanup. Keep cleanup dry-run until its new-package results
are reviewed. Do not bypass a refused lock; release it on completion/abandonment.
Never merge origin/main or impose the obsolete main-ancestor gate. If the stable base
differs from origin/main, STOP and ask rather than promoting stale history.

## 1. README

Read [alpha modes and review](../../../docs/agent-alpha-reference.md) for the detailed
README checklist, exceptional modes, entry presentation and running-build setup.
Read actual feature/setup/channel/screenshot links and released-version marker.
Update stale text in the same promotion commit. Marker is current stable, never alpha.
```
npm run docs:check
```

## 2. Generate alpha locally

Ordinary:
```
node scripts/promote-develop-to-alpha.js
```
Only for verified tooling-only work:
```
node scripts/rebuild-develop-changelog.js --check
node scripts/promote-develop-to-alpha.js --tooling-only
```
Only for exactly one urgent fix commit/detail: --hotfix.
Read exceptional-mode conditions in the reference before selecting either; normal
three-bullet quality/process checks remain. Failure is fixed on develop, never bypassed.

## 3. Changelog approval — STOP before commit

Show the WHOLE new alpha entry: version, headline and every feature/fix/tweak bullet.
Tooling-only: show toolingOnly true, no product bullets, exclusion from stable.
Check for a joined/run-on headline, offer one clean sentence; edit only approved wording.
Wait for explicit entry approval in chat. Revisions need process check and another display.
Then:
```
git add README.md changelog.alpha.json changelog.develop.json public
node scripts/workflow-check.js staged
git commit -m "chore: promote develop changelog to alpha"
```
Include every public restamp with manifests; inspect staged scope. Follow project commit
website-metadata rules. Never commit the entry before approval.

## 4. Running alpha approval — STOP before push

Following the reference's startup/ownership procedure, stop older listeners and start
the approved committed app with BUILD_CHANNEL=alpha and network access.
Show http://localhost:5056, the reported alpha version, Settings → Changelog Alpha tab,
and specific changed features to exercise. Verify served metadata matches this entry.
Wait for explicit go-ahead after the user has looked. Requested changes repeat generation,
checks and both affected approvals.

## 5. Force alpha only

```
node scripts/workflow-check.js before-push alpha
git log origin/alpha..HEAD --oneline
git push origin HEAD:alpha --force
```
Never bypass hooks. docker-publish-alpha.yml publishes the already-computed version;
optionally inspect gh run list --branch alpha --limit 1.
Release the lock. STOP. Never push develop or merge/fold the release back into alpha;
develop's local reset/restamps wait for the user's next ordinary push.
Rationale: docs/decisions.md entry 18.

## Example request

> Force to alpha
