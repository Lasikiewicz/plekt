# Release promotion and publication operations

Read only after website phase C. All approval stops remain required.

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
Get-NetTCPConnection -LocalPort 5056,4321 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
```

Then start both against this commit, with network access permitted. Set
`BUILD_CHANNEL=main` explicitly: `npm start` otherwise defaults to develop metadata:

```powershell
$env:BUILD_CHANNEL = "main"
npm start                 # application, http://localhost:5056
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
3. **The application, running this exact commit**, at `http://localhost:5056`. Name the
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

### 8b - Publish the reviewed website

The user's final approval in step 6 covers this publish; do not ask again (user decision,
12 October 2026). Run it once the release workflow and the demo check have passed, from
the main checkout while it still holds the pushed release commit, so the live website is
exactly the reviewed tree:

```bash
git status --short            # must be empty: publish the release commit, nothing else
cd website
npm run check:deploy
npm run build
npx --yes wrangler@latest pages deploy dist --project-name plembfin-website --branch main --commit-message "Publish Plekt website for v<version>" --commit-dirty=true
```

Do not deploy when a check or the build fails, and never deploy the `plembfin`
application Pages project. If Wrangler needs a Cloudflare login, stop and ask the user to
complete it; do not treat the Git-connected Pages build as a substitute.

Then verify the live site, not only the returned `pages.dev` URL:

Run `npm run release:verify-live -- <version>` from the release checkout. It checks the
live changelog, release guide links and homepage screenshot hashes/bytes. A failure stops
the release; it never publishes or writes files. The checks below remain the contract.

- `https://plekt.net/changelog/` shows the new version, and every guide link in the new
  changelog entry returns 200.
- On the homepage, fetch each screenshot URL the live page references and compare it with
  the local file of the same path in `website/public/`. Each URL must carry its `?v=`
  content hash and return the same bytes. Assets are cached as immutable for a year, so a
  retaken image that keeps an unversioned URL stays stale on the live site (v2.0.0 showed
  the old logo in the large light images for this reason).

If the publish or a check fails, report the release as incomplete: the application is
released but the website is not current.

### 9 - Point local develop at the release (local only, never pushed)

Once the workflow, the demo check, and the website publish have passed, move local `develop` onto the release
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
