# Develop push reference

Read the section needed by the matching step of push-to-git. This preserves detailed
scope, dependency, documentation, message and consolidation rules; the skill gives the order.

Choose the scope from the user's wording before doing anything. Both commands run
the complete local changelog/build workflow below; they differ in which local work
may enter it:

- **"Push all to git"** (also accept **"push all the git"** and case variations)
  includes every relevant local change currently in the worktree and every pending
  local `develop` commit that can be safely consolidated. This is the command for
  publishing all local work.
- **"Push to git"** includes only files, lines, and commits created in the current
  chat. Before the first task edit, record the current `HEAD`, `git status`, and
  the pending `origin/develop..HEAD` commit list as this chat's baseline. Leave
  pre-existing worktree changes and commits untouched; do not use `git add .` in
  this mode. If old and current work are mixed in a file and cannot be separated
  safely, or if the baseline already has unpushed commits, stop and ask whether
  the user wants **"Push all to git"** or a narrower scope.

The selected scope applies to every review, documentation, staging, commit, and
consolidation step. Never interpret either phrase as running `git push` by itself.

### Git permission in the managed workspace

When either **"Push to git"** or **"Push all to git"** is requested, request
elevated repository access before the first Git command that mutates `.git`, and
use that elevated access consistently for the rest of the workflow. This managed
Windows workspace can protect `.git` metadata even when the worktree files are
writable, so the affected commands include `git fetch`, `git checkout`, `git merge`,
`git add`, `git commit`, `git reset --soft`, and `git push`. Read-only inspection
commands such as `git status`, `git diff`, and `git log` may run without elevation.
Do not work around the boundary with an alternate index, global Git configuration,
or indirect file writes. If the elevation request is rejected, stop and ask the
user to approve retrying the repository operation.

### 1 - Review the selected scope
```bash
git diff --stat HEAD
```
For **"Push all to git"**, read every relevant changed file and pending local
commit. For **"Push to git"**, compare the worktree with the baseline recorded at
the start of this chat and review only this chat's changes. A pre-existing local
commit ahead of `origin/develop` cannot be omitted from a normal branch push, so
the scope check must stop before committing when one is present.

### 1b - Check open dependency PRs (Dependabot)

Dependabot opens PRs against `main` (`.github/dependabot.yml`). They are never merged on
GitHub: merging one would publish a release with no changelog or version bump. They enter
`develop` only through this step, with the user's agreement, so the change ships in the
normal push and promotion flow.

```bash
gh pr list --author "app/dependabot" --state open --json number,title,headRefName,url
```

If none are open, say so in one line and continue. Otherwise:

1. **Apply each PR locally, one at a time.** Do not apply the PR diff, because several
   PRs editing `package-lock.json` conflict. Read the PR title for the package and target
   version, then run `npm install <package>@<version>` for an npm bump (this regenerates
   the lock file) or edit the `uses:` line by hand for a GitHub Actions bump. Skip this
   whole step and tell the user when `package.json`, `package-lock.json`, or the workflow
   file being changed already has uncommitted edits that are not this chat's own, because
   the bump could not be separated from them.
2. **Check it.** Run `npm test` and `npm run build` after each bump. For a bump that
   touches `better-sqlite3` or `sharp`, also confirm the Docker Build Check on the PR is
   green (`gh pr checks <number>`), because only the Docker build proves the native module
   loads.
3. **Judge the risk** from the version jump and the package's release notes:
   patch or minor with green checks is **safe**; a major version, a native module, or
   anything the release notes call breaking is **needs review**.
4. **Warn and ask.** Report one line per PR (package, old to new version, safe or needs
   review, test and build result) and ask with AskUserQuestion which to include. Revert
   any bump the user declines (`git checkout -- package.json package-lock.json`, or undo
   the workflow edit), and leave that PR open.
5. **Included bumps become part of this push.** Stage them with the rest of the work.
   Give them a commit-message bullet only when the bump fixes a security advisory or
   changes something a user of the app sees; otherwise add no bullet, and leave the
   `site-impact:` note as it is.
6. **Remember the PR numbers included.** They are closed in step 9, after the push succeeds
   and never before.

Never run `gh pr merge` on these PRs.

### 2 - Sync docs and README
For every selected changed file, check whether the corresponding doc **and** the relevant section of `README.md` need updating:

| Changed area | Doc to check | README section to check |
| --- | --- | --- |
| Webhook auth / `parsers.js` / webhook flow | `docs/webhooks.md` | ⚡ Webhook Setup |
| Scheduler / `scheduled.js` / `cron-sync` | `docs/scheduled-sync.md` | 🛠️ Architecture |
| Now-playing / `live_tracking_cache` | `docs/now-playing.md` | - |
| `schema.sql` / new SQLite tables | `docs/sqlite-schema.md` | ⚙️ Configuration Reference |
| Plex client / notification listener | `docs/plex.md` | ⚡ Webhook Setup |
| Emby client | `docs/emby.md` | ⚡ Webhook Setup |
| Jellyfin client | `docs/jellyfin.md` | ⚡ Webhook Setup |
| TMDB / TVDB / Fanart / OMDb gateways or caches | `docs/metadata.md` | ⚙️ Configuration Reference |
| Poster pipeline (`posterCache.js` / `images.js`) | `docs/posters-artwork.md` | - |
| Dashboard (`dashboard.js`) | `docs/dashboard.md` | 🌟 Key Features |
| Movies page | `docs/movies.md` | 🌟 Key Features |
| TV Shows page / show progress / next-airing | `docs/tv-shows.md` | 🌟 Key Features |
| Media detail / person pages / edit dialogs / watch actions | `docs/media-detail.md` | 🌟 Key Features |
| History page / search | `docs/history-search.md` | 🌟 Key Features |
| Stats page | `docs/stats.md` | 🌟 Key Features |
| Settings tabs / config store / maintenance tools | `docs/settings.md` | 🔧 Full Setup Guide |
| Auth / sessions / cookies / secrets | `docs/auth.md` + `docs/architecture.md` | 🔧 Full Setup Guide |
| Backups / destinations / backup UI | `docs/backups.md` | 💾 Backup & Restore System |
| SPA routing / state / module layout | `docs/frontend.md` | - |
| Scripts / CI workflows / Docker / release pipeline | `docs/development.md` | 🚀 Getting Started |
| New feature or setting | `docs/architecture.md` + the matching feature doc | 🌟 Key Features / 🔧 Full Setup Guide |
| New env variable | `docs/architecture.md` | ⚙️ Configuration Reference |
| New file, or a file moved/renamed | file map in `docs/architecture.md` | - |
| Any server-side breaking change | `docs/troubleshooting.md` | relevant setup section |
| Overall architecture change | `docs/architecture.md` + `docs/README.md` | 🛠️ Architecture |
| Docker / deployment change | `docs/development.md` | 🚀 Getting Started |
| Key Features list in README | - | 🌟 Key Features |
| Push-to-git / agent workflow change | `CLAUDE.md` | 🧑‍💻 Development Workflow |
| `syncOrchestrator.js`, `trackerDispatcher.js`, `loopStore.js`, or a `watch_history` insert path | `docs/decisions.md` + `docs/scheduled-sync.md` | - |
| `scripts/promote-*.js`, `scripts/rebuild-develop-changelog.js`, or a publish workflow | `docs/decisions.md` + `docs/development.md` | 🚀 Getting Started |
| Any other deliberate call where a plausible alternative was rejected | `docs/decisions.md` | - |

**Important**: Always read the actual README sections that correspond to changed areas - do not assume they are already up to date. README prose can become stale even when docs/ files are current.

Update any doc **and** the matching README section that is out of date before proceeding.

Documentation and README copy must stand on its own for a first-time reader. State the current behavior as a fact; avoid historical or relative wording such as "still", "previously", "formerly", "same as before", "no longer", or "new" unless the sentence is explicitly about an upgrade, migration, or changelog entry. For metadata source descriptions, say which source provides which data instead of referencing what another source used to provide.


### 3 - Sync in-app help
For every changed feature or setting, check the relevant frontend module in `public/modules/` or `public/app.js`:
- **Feature-owned help renderers and modal `helpHtml`** - update any setup copy if flows changed
- **`renderSettingsInlineHelp()`** - check that the inline help content in each settings panel still matches the current behaviour
- **`webhookWarning()` / `plexWebhookSetup()` / `embyWebhookSetup()` / `jellyfinWebhookSetup()`** - update if webhook setup steps changed (live in `modules/help-content.js` after refactor)
- **`cronSyncGuide()`** - update if scheduler endpoint or behaviour changed
- **`adminTokenGuide()`** - update if auth flow changed

### Website decision on every new commit

Every new commit created by this workflow, including tooling, documentation, and release
bookkeeping commits, must record an explicit website decision. Use the existing trailer:
`site-impact: <docSlug>, <docSlug>` means **website check required**;
`site-impact: none` means **website check not required**. Never omit it. Before committing,
inspect the staged change and decide whether website readers could encounter changed
behaviour, controls, layout, setup, limitations, or stale guidance. Required means review
at Force to main, not an automatic image retake or a cosmetic guide edit.

For each required guide, record in the commit body (as plain non-bullet metadata):
`Website review: <what changed; copy to check; image IDs/sections to compare, or images: none and why>`.
For `site-impact: none`, record `Website review: not required - <specific reason>`.
Do not put these notes in user-facing changelog bullets. Missing metadata must be fixed
on new local commits before push; do not rewrite already-published history just to add it.
When squashing, preserve all review reasons and image candidates, union required guides,
and use `none` only if every constituent change needs no website review. Recheck the
final commit message after consolidation; bookkeeping commits also need an explicit note.

### 4 - Write the commit message
Use this format - the first line becomes the changelog `message`; bullet-point body lines are parsed into `details` by `scripts/rebuild-develop-changelog.js` in step 6:

```
<type>: <concise one-line summary of the session>

- Key change 1 (user-visible description, no code jargon)
- Key change 2
- Key change 3
...

site-impact: <docSlug>, <docSlug>
```

The last line is the website note. Do **not** edit `website/` for app changes here: the
website is only updated during "Force to main", once the release is final. The note just
records which website guides this change will need then, so that review knows where to
look. Use the `docSlug` values from `website/src/data/app-surface.json` (for example
`site-impact: dashboard, media-details`), or `site-impact: none` when nothing a website
reader sees has changed (internal refactors, tests, tooling). Without a note, Force to main
falls back to every guide the changed files map to, which for a shared file like
`public/index.html` is a dozen guides. A misspelled slug fails the Force to main gate.

Types: `feat` (new feature), `fix` (bug fix), `security` (security change), `chore` (maintenance), `docs` (docs only).

List every significant user-visible change as its own bullet. Skip internal refactors that don't affect behaviour.

Keep release-process bookkeeping - such as consolidating changelog entries, trimming
folded-in bullets, or resetting a branch build counter - out of release bullets. The
shared changelog filter removes recognized process notes at the alpha/main boundary,
and the target workflow rejects any recognized process text that survives.

The changelog is for changes to the app itself, not to the project's own tooling. When
a session's work also touched git hooks, CI workflows, or the changelog/promotion
scripts, never fold a summary of that into a `feat`/`fix` commit's bullet list just
because it landed in the same push - use a separate `chore:` commit for it instead (see
"Backend Module Discipline" for where chore work belongs). A `fix`/`feat` commit's own
bullets should describe only what changed for someone using the app.
`isReleaseToolingText()` in `scripts/changelog-message.js` strips bullets that describe
the release pipeline's own machinery by content as a safety net, but it isn't a
substitute for keeping the two kinds of work in separate commits to begin with.

Do not create single-line commits for user-visible changes. If the change affects behavior, UI, docs, setup, data sources, sync, caching, or settings, the commit body must include bullet-point details. The changelog generator only reads body lines that start with `- ` or `* `; without them, the Settings → Changelog entry will be sparse. If you are about to commit without bullet details, stop and rewrite the commit message before committing.

This is an enforced release requirement, not optional guidance. Before committing, compare the staged diff with the bullet list and make sure every significant user-visible outcome is represented. A bullet that merely repeats the subject is not a detail. Use separate `-m` arguments (or a commit-message file) so the body is actually recorded:

```bash
git commit -m "fix: concise summary" \
  -m "- First concrete user-visible outcome
- Second concrete user-visible outcome"
```

The `.githooks/commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits that have no meaningful bullet, and `rebuild-develop-changelog.js` in step 6 applies the same `validateReleaseMessage` check again while walking real git history, so bypassing local hooks (or a commit from before this repo had the hook) still cannot reach a published changelog entry. After committing, verify the recorded message with `git log -1 --format=full` before pushing.

### 5 - Stage and commit
For **"Push all to git"**, stage all modified files **except** `data/`,
`backups/`, `node_modules/`, and any secrets. For **"Push to git"**, stage only the
files or lines created in this chat and leave the baseline changes unstaged. Commit
using the message written in step 4.

`backups/` holds local data-directory archives containing `data/config.json` (admin
password hash, API key, session secret) and the full watch-history database, at
hundreds of megabytes each. It is gitignored, but never stage it even if an ignore
rule is missing on some checkout. Never use `git add -f` on it.

### 6 - Rebuild the develop changelog

**This step is not optional and must not be skipped.** A push whose develop changelog
does not cover the commits being pushed is rejected by the pre-push hook, so skipping it
only costs a failed push.

Refresh the local update ledger immediately before rebuilding so the complete committed
change set is available while reviewing the changelog:

```bash
npm run updates:refresh
```

Read `plan/updates.md`, especially **Changelog-ready changes** and
**Website check targets**. It is regenerated from the current local history, so a later
commit that touches an existing app area updates that target in place and exact duplicate
bullets are collapsed. Use it as the review inventory; the structured changelog manifests
remain the files that are committed and published.

```bash
npm run push:prepare
```

That is the whole step. It rebuilds the changelog, stages `changelog.develop.json` and
`public` together, commits them, then re-runs the pending-commit and committed-changelog
checks and prints exactly what will be pushed. It is safe to run repeatedly: when the
changelog is already current it commits nothing and says so. It refuses to run when there
are uncommitted changes outside the changelog and assets, so product work cannot be
swept into a chore commit that contributes no bullets.

It replaced three separate commands, because all three were once skipped in one go:

```bash
node scripts/rebuild-develop-changelog.js
git add changelog.develop.json public
git commit -m "chore: rebuild develop changelog"
```

`public` must be staged. The rebuild now also stamps the develop build's own
five-segment version (`<release>.<alpha>.<dev>`) onto every `?v=` asset reference,
so each develop build gets its own immutable-cache URL instead of every build in a
cycle sharing one - the same failure `docs/decisions.md` entry 10 fixed for alpha,
which that entry now also covers for develop. Expect a large, entirely mechanical
diff across `public/`.

Leaving it unstaged would break CI: `scripts/asset-versions.js` derives the expected
version from `changelog.develop.json` and `npm run build` checks every reference
against it, so a committed manifest with unstaged assets fails the build gate.
For **"Push all to git"**, this intentionally walks every real commit from
`changelog.develop.json`'s `resetCommit` anchor (set by the last "Force to alpha")
through the commit just made in step 5, inclusive, and recomputes the single
develop entry from scratch. For **"Push to git"**, run this step only after the
scope check has confirmed that no older local commit is pending; earlier commits
already published on `origin/develop` remain represented in the rolling entry,
but pre-existing local work is not staged or pushed by this chat. If it prints
"No user-facing commits since the last reset", nothing changed the file; skip
`git add`/`git commit` for it. If it exits with a validation error, fix the
offending commit message(s) it names before continuing - do not bypass it.

### 7 - Consolidate pending local commits
Check what is about to be pushed:
```bash
git log origin/develop..HEAD --oneline
```
For **"Push all to git"**, squash all pending local product/changelog commits into
one clean commit before pushing so history on `develop` stays one commit per push.
For **"Push to git"**, do this only when the baseline had no pending local commits;
then it consolidates only this chat's product/changelog commits. Never use the
consolidation reset to absorb baseline commits in the narrow-scope mode:
```bash
git reset --soft origin/develop
git commit -m "<type>: <consolidated summary>" \
  -m "- consolidated bullet 1
- consolidated bullet 2"
```
Take the commit message from step 4's product commit - step 6's "chore: rebuild develop
changelog" commit has no product bullets of its own and contributes nothing to the
message. `git reset --soft` preserves the working tree exactly, so the changelog file step
6 already rebuilt is included in this final commit untouched. In all-scope mode, if more
than one *product* commit is being squashed, combine their bullet lists into one
list that keeps every user-visible bullet (drop only a bullet that just restates another
one in the group, and bullets about agent guidance or release tooling), merge their
`site-impact:` notes into one line listing every guide named (`none` only when every
squashed commit said `none`; a commit with no note contributes its mapped guides from
`plan/updates.md` **Website check targets**), and re-run step 6
afterward so the rebuilt
entry reflects the final, consolidated message rather than the pre-squash one.
