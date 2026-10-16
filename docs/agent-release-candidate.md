# Release candidate operations

Read for Force to main steps 0–2. Commands and approval order are unchanged.
Skill asset paths below resolve from `.claude/skills/force-to-main/`.

Known contradiction (16 October 2026): step 2's candidate `--confirm` refuses outstanding
website guides, although website review follows candidate approval. The user explicitly
requested preserving behavior and recording this for a separate fix. Stop on that failure;
never bypass the website gate or patch the pinned candidate to get past it.

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

Stop the develop server on 5056 before starting the candidate: both use the main checkout's
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
$releaseListeners = Get-NetTCPConnection -LocalPort 5056 -State Listen -ErrorAction SilentlyContinue
# Inspect ownership first, then stop only the verified Plekt listener(s).
$releaseListeners | Select-Object OwningProcess -Unique |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
$env:DATA_DIR = Join-Path $releaseRepo "data"
$env:PORT = "5056"
$env:BUILD_CHANNEL = "main"
$releaseServer = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"{0}"' -f (Join-Path $releaseWorktree "scripts/start-local.js")) -WorkingDirectory $releaseWorktree -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $releaseWorktree "server.stdout.log") -RedirectStandardError (Join-Path $releaseWorktree "server.stderr.log")
Invoke-WebRequest http://localhost:5056/health
```

Wait for readiness before the health request. Record the PID and paths; inspect errors
if startup fails. Verify the served source is the pinned alpha hash plus the `--confirm`
changes (`git rev-parse HEAD` equals the pin), and that `/version.json` and `/api/changelog`
report the new version with channel `release` and `current` equal to `<version>`. The
sidebar should read `v<version>` with no channel label. Give the user `http://localhost:5056/`
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
