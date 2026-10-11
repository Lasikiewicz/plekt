---
name: force-to-main
description: "Promote Plekt alpha's current tip onto main as a single release when the user says \"Force to main\" exactly, or resume a named phase B/C handoff. Get changelog and running-build approval first, complete website phases A/B/C against that build, then promote, obtain final approval, force-push main, and verify the OCI demo. Never push develop."
---

# Force to main

When the user says **"Force to main"** exactly, follow this order. The release candidate
comes from the fetched alpha tip; website edits live on local `develop`. Approval of the
changelog and running candidate closes the release phase before website work begins.
The final committed release has its own review and go-ahead before pushing.

**Route handoffs before any pre-checks.** A request naming `phase B (capture only)`
executes only its named capture file and stops after the result table and return line.
A request naming `phase C` reads `plan/force-to-main-<version>.md` and resumes phase C
in step 4, including lock/source reconciliation. Neither request starts a new release,
creates another worktree, or repeats completed approvals. Only the exact initial
`Force to main` request starts at step 0.

**Show the flow at every stop.** Every time the run pauses for the user (and at the end of
each phase), finish the message with this checklist, ticking what is done, marking the
current stop with "here", and saying in one line what happens next. Keep the wording fixed
so the user can follow the stage at a glance:

```text
- [ ] 1 Main build candidate running and changelog preview shown
- [ ] 2 Suggested changelog updates made
- [ ] 3 User accepts changelog and build
- [ ] 4 Website phase A: guides reviewed, capture list written
- [ ] 5 Website phase B: cheaper agent takes the captures (handoff line)
- [ ] 6 Website phase C: images accepted, website checks pass
- [ ] 7 Release promoted and committed locally (website carried in)
- [ ] 8 Final review: release build presented for the user
- [ ] 9 Force-push main and publish workflow
- [ ] 10 OCI demo verified, local develop reconciled
```

### 0 - Pre-checks, release lock, and run plan

Check GHCR Cleanup first: it deletes tags from the same package this release publishes.

```bash
gh run list --workflow ghcr-cleanup.yml --limit 1
node scripts/release-lock.js acquire "force to main"
git fetch origin
```

If cleanup is `in_progress` or queued, wait for it to finish before proceeding and check
again before pushing. If the lock refuses, do not work around it: wait for the other
session, or clear it only when it is known to be gone. Keep the lock across the capture
handoff; record ownership and resumption details in the run summary. The current lock
expires after 30 minutes: on resume, check `node scripts/release-lock.js status` in the
main checkout and reconcile any intervening work before reacquiring. Do not assume a
handoff reserves the checkout indefinitely, or run the lock script in the linked worktree
(its `.git` is a file). Release it when the workflow finishes or is abandoned:

```bash
node scripts/release-lock.js release
```

Record the starting branch, `git status --short`, and local `develop` tip. Preserve existing
changes; do not checkout/reset over them or include unrelated work in a release commit.
Fetch origin, record its main and alpha hashes, and pin that alpha hash for this run.

Create the run plan before release work. Use `plan/force-to-main-<version>.md` and
`plan/active/force-to-main-<version>/`, with step files for release candidate, website A,
website B captures, website C, promotion/final review, and push/demo. If the version is
not known yet, use `pending` consistently in the filenames and contents. After the preview,
rename the summary and step folder and replace `pending` with the release version everywhere.
Copy `assets/run-plan-summary.template.md` to the summary, then copy these step templates:

| Destination | Template |
| --- | --- |
| `step1-release-candidate.md` | `run-plan-step1-release-candidate.template.md` |
| `step2-website-a.md` | `run-plan-step2-website-a.template.md` |
| `step3-website-b.md` | `run-plan-step3-website-b.template.md` |
| `step4-website-c.md` | `run-plan-step4-website-c.template.md` |
| `step5-promote-review.md` | `run-plan-step5-promote-review.template.md` |
| `step6-push-demo.md` | `run-plan-step6-push-demo.template.md` |

Replace every `<version>` and remaining placeholder. The summary records purpose, waiting
on the user, phase checkboxes, current state, and next handoff. The release-candidate file
records the pinned alpha hash, previous develop tip, worktree path, data directory, server
PID/logs, preview version and entry, approved `releaseMessage`, and approval evidence.
Update the open step's Results and the summary at every phase end so an interruption
resumes from this record. Create the separate `captures.md` from
`assets/captures.template.md` at the end of phase A; do not use a run-plan template for the
phase B assignment.

### 1 - Check out alpha's tip separately and approve the changelog

Keep the main checkout on `develop` for website work. Use an external detached worktree
for the pinned alpha source, rather than switching the main checkout or using a stale
local alpha branch. PowerShell example, run from the main checkout:

```powershell
$releaseRepo = (Get-Location).Path
$releaseAlpha = git rev-parse origin/alpha
$releaseWorktree = Join-Path (Split-Path -Parent $releaseRepo) "plembfin-release-candidate"
# Confirm this path is unused before adding; never remove an existing directory to reuse it.
git worktree add --detach "$releaseWorktree" "$releaseAlpha"
Set-Location -LiteralPath $releaseWorktree
```

Verify this alpha tip includes the preview change from reorder step 1: `--preview` must
report outstanding website guides without stopping. If it still blocks on those guides,
stop and report that alpha needs the release tooling update through the normal develop /
Force to alpha workflow. Do not silently patch the candidate's application source.

Review the accumulated alpha sections and write one concise, single-line `releaseMessage`
in this worktree's `changelog.alpha.json` (maximum 240 characters). For example:

```json
"releaseMessage": "This update makes media and library pages faster, adds manual watch controls, and redesigns season and episode details."
```

```bash
node scripts/promote-alpha-to-main.js --preview
```

This reads without promoting or resetting any manifests. Show the exact new version,
headline, and every section bullet. Outstanding website guides are information at this
point; `--confirm` remains fail-closed later. Save the preview and approved message in
the run plan. Do not ask for changelog approval here: the user approves the changelog and
the running main build together in step 2, after seeing the app. Incorporate requested
wording changes by editing `changelog.alpha.json` and repeating the preview and step 2.
Do not begin website work yet.

### 2 - Build and start the main release candidate, then obtain one approval

**The user tests the MAIN build, not the alpha source.** "Force to main" means the candidate
they see reports the new stable version (`v<version>`, channel `release`) and carries the new
Stable changelog entry. Never show the pinned alpha source with alpha metadata as the
candidate, and never ask for changelog approval before the app is running.

Install this worktree's own dependencies with `npm ci`. Run `node scripts/promote-alpha-to-main.js --confirm`
inside the detached release worktree (never the main checkout). This is safe: the worktree is
disposable, `--confirm` only rewrites manifests and restamps assets, and nothing is committed
or pushed. It yields exactly the release the final promotion will produce, except the
reviewed website and README, which are carried in later (step 5). The worktree's
`changelog.alpha.json` `releaseMessage` edit from step 1 must be in place first.

Stop the develop server on 5055 before starting the candidate: both use the main checkout's
data, and must never run against it concurrently. Verify the listening process belongs to
this app before stopping it; record how to restore it if the release is abandoned. Do not
copy `.env` or credentials into the worktree. Read `.claude/local-environment.md` in the
main checkout if present; carry any required local environment settings explicitly, without
printing secrets.

PowerShell example (the variables are from step 1):

```powershell
Set-Location -LiteralPath $releaseWorktree
npm ci
node scripts/promote-alpha-to-main.js --confirm
$releaseListeners = Get-NetTCPConnection -LocalPort 5055 -State Listen -ErrorAction SilentlyContinue
# Inspect ownership first, then stop only the verified Plekt listener(s).
$releaseListeners | Select-Object OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
$env:DATA_DIR = Join-Path $releaseRepo "data"
$env:PORT = "5055"
$env:BUILD_CHANNEL = "main"
$releaseServer = Start-Process -FilePath (Get-Command node).Source -ArgumentList "scripts/start-local.js" -WorkingDirectory $releaseWorktree -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $releaseWorktree "server.stdout.log") -RedirectStandardError (Join-Path $releaseWorktree "server.stderr.log")
Invoke-WebRequest http://localhost:5055/health
```

Wait for readiness before the health request. Record the PID and paths; inspect errors
if startup fails. Verify the served source is the pinned alpha hash plus the `--confirm`
changes (`git rev-parse HEAD` equals the pin), and that `/version.json` and `/api/changelog`
report the new version with channel `release` and `current` equal to `<version>`. The
sidebar should read `v<version>` with no channel label. Give the user `http://localhost:5055/`
to check, with a short checklist (sidebar version, Settings → Changelog Stable tab showing
the new entry, the pages the release changed, mobile width). Show the changelog entry text
alongside it.

Only once the build is serving, review the entry as a stable-release reader would and
recommend specific changelog changes if any are warranted: bullets to drop (alpha or
develop only mechanics, internal fixes stable users never saw), reword, or merge; bullets
that are too long or visual-detail heavy; anything missing that the build shows; and the
`releaseMessage`. Give each recommendation with its reason, or say the entry needs no
changes. Do not make edits until the user agrees; do not ask the user to decide wording
before the build is running.

**Wait for one explicit approval of both the changelog and this running main build before
phase A.** The user decides when they have checked both; do not treat silence, or approval
of the preview text alone, as approval. A build change invalidates this approval: fix it
through develop / Force to alpha and restart with the new pinned tip. A changelog wording
change alone is made in `changelog.alpha.json`; discard the worktree's `--confirm` changes
(`git checkout -- . ` then re-edit and re-run `--confirm`) and restart. Leave the approved
candidate running through website phases A, B, and C, including across the cheaper-agent
handoff.

### 3 - Website phase A: review against the approved running build

Return to the main checkout on `develop`. Follow `docs/websiteupdate.md` for baseline
discovery, change review, content quality, and visual/privacy checks. Its Force-to-main
section defines phases A/B/C; the app target is the running main-build candidate on 5055. Never
restart the develop app to review or take captures. Only describe behaviour present in
the approved release source, including in website pages already edited on develop.

```bash
npm run updates:refresh
npm run check:website-impact
```

Read `plan/updates.md` (Website check targets, Website images to retake, Changelog-ready changes, and commit inventory).
The develop inventory can include later application work: reconcile targets against the
pinned alpha changes and preview's outstanding list. The definitive impact check is run
in the alpha checkout after carrying in the reviewed website in step 5.

Review affected guides and shared site surfaces against the running candidate. Make
website copy edits on `develop`, identify required captures, and start the website preview
from `website/` with `npm run dev`. List the images to retake with `npm run captures:stale`
in `website/` (files changed since `origin/main`, every view of each image), reconciled
against the pinned alpha changes like the inventory; `npm run captures:retake -- <ids>`
retakes them as `website/capture-catalogue.json` describes. A placed image whose size
differs from the catalogue fails `npm run check:catalogue`, so update its catalogue sizes. A guide that remains accurate may instead be recorded
in `website/src/data/release-review.json` with a reason; `publishedVersion` must match the
version live on `origin/main`, so old reviews never excuse this release.

End phase A by copying [assets/captures.template.md](assets/captures.template.md) into
`plan/active/force-to-main-<version>/captures.md`, with the staging folder `captures/`
beside it. Fill every placeholder and repeat the image entry for each required capture;
if no captures are needed, state that explicitly. Include the approved source hash,
worktree, served alpha version, app URL, usable signed-in browser tab, exact routes and
states, style/mode, viewport width and height, framing, scroll container and composition
instructions, key risk, and intended website section/caption. The file must stand alone:
copy in all capture and privacy instructions rather than asking phase B to read this skill,
the run summary, local credentials, or website docs. Keep credentials out of the file.
Verify the browser session and capture-tool/dependency availability before handing off;
if sign-in cannot be shared, record that phase B must report the login blocker.
Verify the served channel/build through `/api/changelog` as described in the capture
template (the main candidate reports channel `release` and `current` = the new version).
Record the sidebar label separately; it should read `v<version>`.
Record the phase result and exact capture-list path in the run summary, then stop.

### 4 - Website phase B handoff, then phase C completion

**Stop after phase A and print this one line for the user to paste into a cheaper agent:**

```text
Force to main v<version>, phase B (capture only): read plan/active/force-to-main-<version>/captures.md and follow it.
```

When invoked with **phase B (capture only)**, read only the named `captures.md` for
instructions and execute its list; do not restart the full release procedure or acquire,
release, or renew its lock. Use the approved running app, save project outputs only in
the staging folder, do not edit `website/` or commit, and write `captures/results.md`
with a pass/fail table, source/version checks, actual dimensions/scroll positions, and
privacy findings. A failed item stays failed; do not substitute a different view or build.
Return the table and the phase C handoff line from the file, then stop.

Do not take over phase B's captures in the phase A session. Record the waiting state and
leave the worktree, server, and lock available. The handoff back is:

```text
Force to main v<version>, phase C: read the run summary.
```

When invoked with **phase C**, resume here from `plan/force-to-main-<version>.md` and
the recorded capture results; do not rerun promotion or earlier approvals. Reconcile the
lock as described in step 0. Verify the same alpha hash and server are still in use,
then inspect every staged image and its result before bringing accepted images into
`website/`. Reject stale states, wrong views, errors, or visible secrets; apply the privacy
rules in `docs/websiteupdate.md` and record all published images in the privacy manifest.
Complete captions, links, themes, affected-page visual checks, and the full website gate.
Run from `website/`:

```bash
npm run captures:inventory
npm run check
npm run build
```

Review inventory changes and resolve gate failures. Automated checks cannot establish
that captions and captures are current. Every unticked release website item must be done
or explicitly accepted by the user in chat as shipping without it; record accepted
leftovers for the final review. Commit website changes on local `develop` before step 5.
Do not push develop, and do not run Force to alpha again for website-only work.

`website/` is taken from local `develop` so reviewed edits remain available permanently.
The release commit is never merged back; website work confined to alpha would be lost.
Cloudflare Pages publishes only `main`, so these local develop edits are not public yet.

### 5 - Carry the website, check README, preview again, and promote

Keep the candidate server running while preparing the final alpha checkout. Once the
main checkout's worktree is clean and its website changes are committed on `develop`,
switch it to the pinned alpha source (not a newly fetched or changed alpha tip):

```powershell
Set-Location -LiteralPath $releaseRepo
git checkout -B alpha $releaseAlpha
git checkout develop -- website/
git status --short website/
```

Show what was brought in and confirm all pages describe the approved build. Restore the
approved `releaseMessage` (and any approved alpha-entry wording edits) from the run record
into this checkout's `changelog.alpha.json`; the detached worktree changes were not commits.

Review README's feature list, setup, channel table, screenshots/links, and released-version
marker. Before promotion the marker must match the stable package/changelog version,
not the pending preview version. Include any README correction in the single release commit.

```bash
npm run docs:check
node scripts/promote-alpha-to-main.js --preview
```

Compare this preview's version, headline, and bullets to the approved record. Its website
list must now be empty. If it differs, obtain renewed changelog approval before continuing;
if website items remain, return to develop, fix/review and commit them, then repeat the carry.
If origin/main or origin/alpha changed during the run, stop and reconcile before promotion;
do not substitute a different source or release history under the existing approval.

Only now run the mutating promotion:

```bash
node scripts/promote-alpha-to-main.js --confirm
npm run docs:check
git add README.md changelog.json changelog.alpha.json changelog.develop.json CHANGELOG.md package.json package-lock.json public website
git commit -m "chore: promote alpha to main v<version>"
```

`--confirm` consolidates alpha sections, uses the approved headline, preserves released
history from origin/main, bumps semver (honouring a manually-set higher version), writes
manifests and CHANGELOG, resets alpha/develop counters, and restamps public assets and
website baselines. It refuses outstanding website guides or release-process text. Fix
process-text failures in the source on develop, repeat Force to alpha, and restart approval.
Both `public` and `website` must be staged: missing public restamps fail asset-version checks;
missing website changes/baselines would publish stale documentation. Inspect the staged diff
so no unrelated change enters the release commit.

Before final review, stop the recorded candidate process and remove its worktree. Preserve
the approved message/preview in the plan, verify the resolved path equals this run's external
worktree, and inspect `git -C "$releaseWorktree" status --short`. Only its recorded candidate
wording edits, the step 2 `--confirm` output (manifests, restamped assets, version bump), and
server logs may be discarded; stop if there is unexpected work.

```powershell
Stop-Process -Id $releaseServer.Id -Force -Confirm:$false
Set-Location -LiteralPath $releaseRepo
git worktree remove --force "$releaseWorktree"
```

Use the saved PID/path on resume, verifying process ownership before stopping. Record the
cleanup and release commit in the run summary; the final review starts fresh servers below.

### 6 - Final review: show the user the exact state about to be published

Everything is committed locally now and nothing has left the machine. This is the last
point at which the release can be changed, so show the user what is actually going to be
published rather than describing it.

Stop every local server first, so nothing is left serving the pre-release state and
mistaken for the release:

```powershell
# Windows: verify ownership, then find and stop anything on the app and website ports
Get-NetTCPConnection -LocalPort 5055,4321 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
```

Then start both against this commit, with network access permitted. Set
`BUILD_CHANNEL=main` explicitly: `npm start` otherwise defaults to develop metadata:

```powershell
$env:BUILD_CHANNEL = "main"
npm start                 # application, http://localhost:5055
# In a separate terminal at the main checkout:
Set-Location website
npm run dev               # website, http://localhost:4321
```

Report all four of these together:

1. **The changelog that will go live.** Print the new release entry in full - version,
   headline, and every bullet under each section - from `changelog.json`. Not a summary:
   this is the text that reaches the GitHub Release, the app, and the website.
2. **What the documentation now says.** State which `website/` pages changed in this
   release and that their `sourceVersion` markers are stamped to the new version, so the
   user knows the published documentation describes this release and not the previous one.
   List any website items the user agreed in phase C to ship without (or say there are none).
3. **The application, running this exact commit**, at `http://localhost:5055`. Name the
   version it reports so the user can confirm it matches the release.
4. **The website, running this exact commit**, at `http://localhost:4321`, and point at
   `http://localhost:4321/changelog` specifically, since that is where the release entry
   and the Stable/Alpha tabs appear.

Wait for the user here. Do not continue to the force-push until they have looked and said
to go ahead. If they ask for a change, make it, amend the local release commit, repeat
the relevant checks, and show this again.
If application code or changelog content changes, return to the release approval phase
and repeat the affected website review; do not blindly run promotion again after its
alpha entries have been reset.

### 7 - Force main to match this commit
Show the user what is about to land before running this - it is a force push to the
shared `main` branch:
```bash
git log origin/main..HEAD --oneline
```
Then:
```bash
git push origin HEAD:main --force
```

The pre-push hook runs the complete build gate before changing `main`. If that gate
reports a test failure, do not bypass the hook and do not report the promotion as
blocked after the first failure. Run `npm test` once to check for the known transient
test-run failure. If that rerun passes, retry the exact same force-push command; its
pre-push hook must then run and pass the complete `npm run build` gate before the push
can proceed. If the focused rerun fails, or the retried full gate fails again, stop the
promotion and investigate the repeatable failure. Never use `--no-verify`.

`update-changelog.yml` (workflow name "Publish Main Release") reads the version already
in this commit, checks README consistency, runs the build gate again in CI, and publishes
`:latest` + `:<version>` - it does not write anything back. Wait for this workflow to
finish successfully before checking the OCI demo deployment. Optionally confirm it succeeded:
```bash
gh run list --branch main --limit 1
```

### 8 - Rebuild and verify the OCI public demo

Publishing GHCR does not pull or restart the public demo. The live demo at
`https://demo.plembfin.com/` is served by the dedicated Oracle Cloud Compute instance
in `uk-london-1`, behind the Cloudflare reverse proxy. Portainer is local-only and is
not part of this release gate.

The `Publish Main Release` workflow now builds an AMD64/ARM64 image and its dependent
`Deploy public demo to OCI` job copies `scripts/deploy-oracle-demo.sh` to the instance
over pinned SSH, pulls the exact `ghcr.io/lasikiewicz/plekt:<version>` tag, and
recreates only the configured demo container while preserving its `/data` mount. It
then runs `scripts/verify-oracle-demo.js` against `https://demo.plembfin.com/`.

Before the first release using this gate, configure the repository's GitHub Actions
variables `OCI_DEMO_HOST`, `OCI_DEMO_KNOWN_HOSTS`, `OCI_DEMO_CONTAINER`,
`OCI_DEMO_DATA_DIR`, and `OCI_DEMO_RUNTIME` (`podman` or `docker`). The optional
variables `OCI_DEMO_USER` and `OCI_DEMO_PORT` default to `opc` and `80`. Configure
`OCI_DEMO_SSH_KEY` as a repository or environment secret for the `opc` account. The
instance must have the selected runtime installed and passwordless `sudo` for `opc`.
If any setting is missing, the deploy, or the released-version verification fails, stop
and report the release as incomplete rather than claiming that the demo is current.

Do not call `npm run demo:assets` or `npm run demo:seed` as part of this refresh; those
commands prepare fixture content and are separate from pulling the released image.

### 9 - Point local develop at the release (local only, never pushed)

Once the workflow and the demo check have passed, move local `develop` onto the release
commit so all further work starts from the released build. Do not merge, and do not push
`develop`: it reaches `origin/develop` only with the user's next "Push to git", together
with their new work.

First confirm that local `develop` holds nothing the release lacks. `develop` can be ahead
of the alpha tip that was released, and moving the branch would drop that work:

```bash
git status --short
git log --oneline origin/main..develop
base=$(git merge-base develop HEAD)
git diff develop HEAD -- $(git diff --name-only "$base"...develop)
```

The working tree must be clean. Every commit listed must already be in the release: in
practice the website commits phase C made, which step 5 carried in, and anything taken
from `develop` like them. Every hunk in the diff must be release restamping only
(`sourceVersion` markers, `?v=` asset versions, version fields). If any `develop` commit
carries application or documentation work that is not in the release, stop and report it
to the user instead of moving the branch.

Then:

```bash
git checkout -B develop origin/main
git branch -u origin/develop
git status -sb
```

`develop` now equals the release commit and shows as ahead of `origin/develop` by a
fast-forward. Tell the user the previous `develop` tip hash (recoverable from the reflog).

Do not merge `origin/main` into `develop`, and do not push `develop`. The old step merged
the release commit into `develop` and pushed it straight away. That push carried the
`public/` asset restamp, `package.json`, and `package-lock.json`, so
`docker-publish-develop.yml`'s `paths-ignore` never matched and every release published a
second, meaningless develop image on top of the release one.

Nothing needs carrying. `promote-alpha-to-main.js` reads the released history from
`origin/main` rather than the working tree, and every changelog generation point writes the
release version from the manifests, so `develop` reconciles itself on its next "Push to
git" with no merge.

This supersedes `docs/decisions.md` entry 16; see entry 18 for the reasoning and for why
entry 16's conflict concern no longer applies. Entry 8 still stands: do not fold the
release into `alpha` either, because the next "Force to alpha" force-pushes `develop`'s tip
onto `alpha` regardless.

## Plekt rebrand release gate

Before the first Plekt release, verify that old raw changelog URLs still resolve after the repository rename, the new documentation domain serves the rebranded website, both legacy image targets remain published for at least six months after this release, and the release preview contains the image migration guidance. Keep GHCR cleanup in dry-run mode until the new-package results are reviewed. Do not rename the local checkout or deployment data/container identities as part of promotion.
