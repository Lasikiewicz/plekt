# Alpha promotion modes and review

Read for alpha promotion and its two approval stops. The skill gives the command order.

### 2 - Review and update README before promoting

Review `README.md` against the user-visible changes currently on `develop` and update
it before creating the promotion commit. At minimum, confirm the feature list, setup
guidance, Docker channel table, screenshots/links, and the top released-version marker
still describe the application. The marker must match the current stable version in
`package.json`/`changelog.json`; it is not the pending alpha build number.

Run the mechanical check after any edit:
```bash
npm run docs:check
```
The alpha workflow runs this check again, but CI cannot update a stale README. Keep any
README change in the same promotion commit so the alpha image and prerelease are built
from the documentation that was reviewed.

### 3 - Add develop's changelog as a new alpha build entry, locally
```bash
node scripts/promote-develop-to-alpha.js
```

For a release-tooling-only promotion with no user-facing application changes, use the
explicit tooling-only mode instead:

```bash
node scripts/rebuild-develop-changelog.js --check
node scripts/promote-develop-to-alpha.js --tooling-only
```

Use this only when the changelog check confirms there are no user-facing develop commits.
The script also requires `origin/alpha` to be an ancestor, rejects any changed path outside
the maintainer/tooling allowlist, and refuses a nonempty or stale develop changelog. It
creates a clearly marked alpha entry with no product bullets. The entry remains visible on
Alpha, but `promote-alpha-to-main.js` excludes it from the stable release. The normal
three-bullet quality gate remains in force for every ordinary alpha promotion. Review and
approve the tooling-only entry and running build through the same gates below.

For a single, urgent product bug fix with exactly one user-visible detail, use the guarded
hotfix mode:

```bash
node scripts/promote-develop-to-alpha.js --hotfix
```

This accepts only one conventional `fix:` commit, one detail that becomes one Fix bullet,
and no feature or tweak bullets. All other changelog quality checks still apply, and both
the changelog and running build require the same explicit approvals. Ordinary promotions
still require at least three bullets.

Then complete step 3a below and wait for the user's approval. Only after that:

```bash
git add README.md changelog.alpha.json changelog.develop.json public
git commit -m "chore: promote develop changelog to alpha"
```

`public` is staged because the promotion also restamps every local asset reference
with the new build's version (`?v=0.15.0.5`). Versioned assets are served with a
one-year immutable cache, so without that restamp every build in a cycle shares
one asset URL and a tester who pulls a new image keeps running the previous
build's JavaScript. Expect a large, entirely mechanical diff across `public/`.
This is `promoteDevelopToAlpha()` in `scripts/promote-develop-to-alpha.js`: it packages
develop's current entry as its own standalone alpha build entry and prepends it to
alpha's `entries` array (or starts a fresh array if main has moved on since the last
promotion), bumps the alpha build, and resets develop's `entries` and `resetCommit` for
the next cycle while carrying its release version and build number. If it
refuses with a release-process violation, that means a commit folded into develop's entry
still contains recognized process text; fix it on `develop` and repeat from step 1.

### 3a - Show the alpha entry and get explicit approval

**Do not commit or push until the user approves the entry in chat.** Print the new alpha
build entry that `promote-develop-to-alpha.js` just wrote - its version, headline, and
every bullet under New Features / Major Bug Fixes / Tweaks:

```bash
node -e "const a=require('./changelog.alpha.json'); const e=a.entries[0]; console.log(JSON.stringify({version:e.version,build:e.build,message:e.message,toolingOnly:e.toolingOnly,sections:e.sections},null,2))"
```

Ask the user to approve it or give replacement wording. If they revise it, edit
`changelog.alpha.json`'s top entry (`message`, and the `sections` bullets if they change
those), re-run the process-text check, and show it again. Only then stage and commit.
For a tooling-only entry, show that `toolingOnly` is `true`, state that there are no product
bullets and that the entry will be excluded from the next stable release, then wait for the
same explicit approval.

**Check the headline before showing it, and offer to rewrite it.** `synthesizeHeadline`
joins the subject of every product commit in the cycle, so two or more give a run-on such
as "This update includes make Up Next reliable across Plex, Emby, and Jellyfin and verify
the public documentation...". That is the generator working as designed, not a fault, but
it is what testers read. When the headline is a joined sentence, say so, propose a single
clean sentence covering the cycle, and write the approved wording into the entry's
`message` field before committing. This is the only point where it can be fixed: from here
it carries into the alpha build entry verbatim, and "Force to main" then consolidates from
these entries.

This gate is deliberate even though the entry is generated verbatim from develop's commit
messages: alpha builds are what testers read, and the wording is worth a look before it is
force-pushed. Note that the same text is reviewed again when "Force to main" consolidates
the cycle, so expect to approve it twice per cycle.

### 3b - Start the build being promoted and let the user check it

Everything is written locally and nothing has left the machine. Before the force-push,
show the user the build itself rather than only its changelog.

Stop every local server first, so nothing is left serving an older state and mistaken for
this build:

```bash
# Windows: stop anything on the app and website ports
Get-NetTCPConnection -LocalPort 5056,4321 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }
```

Then start the application as an alpha build, using the approved elevated
network-enabled execution path:

```bash
BUILD_CHANNEL=alpha npm start   # http://localhost:5056
```

`BUILD_CHANNEL=alpha` matters. Without it the local run reports the release channel,
because the channel is normally baked in at image build time, and Settings -> Changelog
would show the published releases rather than this alpha entry.

Report these together and wait:

1. **The app at `http://localhost:5056`**, naming the version it reports, so the user can
   confirm it matches the alpha version about to be published.
2. **Settings -> Changelog**, where the Alpha tab shows this entry as the current build.
3. **Anything in the cycle worth exercising**, named specifically - the features the
   entry's bullets describe are what a tester will try first.

Do not force-push until the user has looked and said to go ahead. If they want a change,
make it, re-run from step 3, and show this again.
