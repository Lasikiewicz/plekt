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

If the generated develop entry fails changelog quality checks, fix it automatically
on develop before retrying. Review the queued changes and consolidate duplicates and
related details into accurate, user-facing bullets; remove internal paths and
process-only text. Keep all unique user-visible tweaks without a count limit, but
fold fixes to features newly introduced in this release into their feature descriptions.
Preserve meaningful product changes and avoid
inventing behavior. Edit the develop entry locally, rerun the promotion and its quality
checks, and resolve any remaining reported issues. Do not switch modes or bypass checks
to make it pass. The complete resulting alpha entry still requires the approval below.

## 3. Changelog approval — STOP before commit

Review the whole entry for duplicate tweaks and fixes to features introduced in this
release; retain all other distinct user-visible tweaks without a count limit.
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
