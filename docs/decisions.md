# Decision record

Why the non-obvious calls in this codebase were made, and what was rejected.

The rest of `docs/` states what the system does today. `CHANGELOG.md` states what
shipped. This file states *why*, for the small number of decisions where a reasonable
alternative existed and was deliberately not taken. It exists so that the reasoning
survives a squashed commit history, and so that a decision made after a production
incident is not quietly undone by someone who never saw the incident.

## When to add an entry

Add one when all three are true:

1. A plausible alternative existed and was rejected.
2. The reason is not visible from reading the code.
3. Undoing it later would cost real time, data, or user trust.

Do not add an entry for ordinary implementation choices, for anything already stated in a
feature doc, or for release bookkeeping. A dozen entries a year is the expected volume.

## Format

Entries are numbered, appended in date order (oldest first), and never renumbered.
Superseded entries stay in place with their status changed and a pointer to the entry that
replaced them, so the trail stays readable.

```
### N. Short title
**Date:** YYYY-MM-DD  |  **Status:** Active | Superseded by #M | Relaxed by #M
**Context:** what forced the decision.
**Decision:** what was chosen.
**Rejected:** what was not chosen, and why.
**Enforced by:** the code, test, hook, or workflow that keeps it true.
```

---

### 1. Ambiguous sync signals are dropped, not recorded
**Date:** 2026-07-26  |  **Status:** Active (one scoped relaxation, see #5)

**Context:** Phantom rewatches were appearing in watch history. Emby and Jellyfin
`item.markplayed`, and Plex `lastViewedAt`, are all set by Plembfin's own outbound sync and
can be read back hours or days later, at which point they look like fresh plays.

**Decision:** Accurate tracking is the product. When an inbound signal is ambiguous, drop it
rather than record a watch that may not have happened. A phantom watch is a worse failure
than a missed one. Require real playback evidence, and prefer the timestamp reported by the
source server over `Date.now()`, since webhook delivery can lag by hours.

**Rejected:** Treating a media server's played flag as evidence of a play, and relying on
time-based echo guards (short loop windows, same-calendar-day checks) to catch the resulting
false positives. Those guards are not sufficient on their own, because the read back can
happen well outside any reasonable window.

**Enforced by:** `server/src/utils/watchDates.js`, the source-played-date handling in
`server/src/scheduled.js`, and the phantom-watch audit and repair endpoints added in
`f725da31` (2026-07-27).

---

### 2. Data repairs ship as a read-only audit plus a separate confirmed repair
**Date:** 2026-07-27  |  **Status:** Active

**Context:** Fixing bad rows in a user's live watch history is irreversible, and the data has
no upstream source of truth to re-derive from.

**Decision:** Every bulk data repair is two endpoints: a `GET` audit that only counts and
samples what would change, and a `POST` repair that performs it after the operator has seen
the audit. New repairs mirror this shape rather than inventing a new one.

**Rejected:** A single "fix it" action. The audit step is what makes a wrong repair
survivable, and it is also what makes a support conversation possible before anything is
written.

**Enforced by:** `/api/phantom-watch-audit` and `/api/phantom-watch-repair`, later
`/api/stale-trakt-import-audit` and `/api/stale-trakt-import-repair`, in
`server/src/routes/maintenance.js` and `server/src/utils/dataRepo.js`.

---

### 3. Release notes are gated on content, not on reviewer attention
**Date:** 2026-07-13  |  **Status:** Active

**Context:** Single-line commits were producing empty Settings → Changelog entries, and
release-process bookkeeping ("consolidate changelog", "reset build counter") was leaking into
user-facing release notes.

**Decision:** Enforce changelog quality mechanically at three independent points. The
`commit-msg` hook rejects `feat`, `fix`, `security`, `enhance`, and `docs` commits with no
meaningful bullet. The changelog rebuild re-runs the same validation while walking real git
history, so a commit made with hooks bypassed still cannot reach a published entry. And
recognized release-process text is stripped by content at the alpha and main boundaries.

**Rejected:** Relying on review discipline alone. The rules are correct, but they are applied
at the end of a long session, which is exactly when they get skipped.

**Enforced by:** `.githooks/commit-msg`, `validateReleaseMessage` and
`changelogEntryProcessViolations` in `scripts/changelog-message.js`.

---

### 4. A new `watch_history` row must carry settled dispatch telemetry
**Date:** 2026-08-19  |  **Status:** Active

**Context:** A feature that imported every individual Trakt play inserted watch rows with no
`sync_dispatch_telemetry`. `syncPendingManualDispatches` in `server/src/scheduled.js` treats
incomplete telemetry as pending work, so it re-dispatched each row to every active target on
every scheduler tick. Trakt's `/sync/history` is not idempotent: every POST adds a new play.
Each push produced a new Trakt history id, which the next poll re-imported as a new play and
pushed again. That is an unbounded once-a-minute loop. It flooded the user's real Trakt
account within minutes of deployment, the container had to be force-stopped from Portainer,
and the duplicated history had to be cleaned up by hand with no tooling for it.

**Decision:** Any code path inserting a row with `sync_action: "watched"` outside the normal
webhook and `applyWatchedTransition` path must either run it through `syncMediaPlaystate`
once immediately, so real telemetry is written, or set `sync_dispatch_telemetry` explicitly
to a settled shape covering every possible active target. Changes to Trakt outbound dispatch
or watch-history insertion get a regression test rather than manual review.

**Rejected:** Leaving telemetry null and letting the retry sweep sort it out, which is the
exact failure above. Also rejected: making the sweep smarter about what counts as pending,
which would have made the invariant implicit instead of explicit at the insertion site.

**Note:** the outbound echo guard in `server/src/utils/trackerDispatcher.js` matches
`source.includes("trakt")`, not `=== "trakt"`, because two Trakt-sourced values exist
(`trakt` for live sync, `trakt_import` for both importers) and both must be excluded. A new
Trakt-sourced ingest path must keep a source string containing `trakt`, or update the guard.

**Enforced by:** `test/trackerPlayHistoryImport.test.js`, `importTraktPlayHistory` in
`server/src/utils/trackerSync.js`.

---

### 5. Detail-page Force Sync may import a flagged play, anchored to the release date
**Date:** 2026-08-21  |  **Status:** Active (scoped relaxation of #1)

**Context:** Episodes bulk-marked watched through a media server's own library UI carry a
played flag with no reliable played timestamp, so #1 caused them to be skipped entirely,
including when the user explicitly asked Plembfin to import that title's state.

**Decision:** Import them, but only through the detail-page Force Sync "Import Watched
Status" action, and use the episode's own release date as `watched_at`.

**Rejected:** Using `Date.now()`, which recreates the original failure by fabricating "just
watched" timestamps that corrupt recency. Also rejected: extending the relaxation to
scheduled, background, or webhook sync. This action is explicit, user-triggered, and scoped
to one title, so it cannot manufacture a library-wide phantom-watch burst the way trusting
the flag in the background poll could. #1 still applies in full to every automatic path.

**Enforced by:** `remoteItemToMedia` in `server/src/utils/mediaForceSync.js`.

---

### 6. Changelog content is computed locally before every push, never by CI
**Date:** 2026-08-29  |  **Status:** Active

**Context:** CI jobs were reading GitHub's push-event commit list to build changelog entries.
That payload is only reliable for a plain incremental push. `alpha` and `main` are always
reached by force-push, where the event's commit list is empty or incomplete, so entries came
out truncated or blank.

**Decision:** All three changelog files are written locally, as part of the push command that
produces them, using real local git history. The publish workflows only build, verify, and
publish using values already committed; none of them writes back to its branch.

**Rejected:** Detecting the force-push case in CI and reconstructing the commit range from the
GitHub API. That is a workaround for a data source that is structurally wrong for this
branching model, and it would keep the failure mode alive in a less obvious form. Local git
history is always complete, so computing there removes the class of bug rather than handling
it.

**Enforced by:** `scripts/rebuild-develop-changelog.js`, `scripts/promote-develop-to-alpha.js`,
`scripts/promote-alpha-to-main.js`, and the pre-push hook's `--check` pass.

---

### 7. Build versions are four segments, not five
**Date:** 2026-08-21  |  **Status:** Superseded by entry 18 (2026-09-12)

**Context:** The tiered changelog cascade shipped with a five-segment build version
(`0.8.6.8.0`).

**Decision:** Use `baseVersion.build`, four segments (`0.14.0.3`).

**Rejected:** Keeping the fifth segment. No comparison logic ever read it; it only appeared as
visual noise in the changelog UI and in the sidebar.

**Enforced by:** `scripts/promote-develop-to-alpha.js`.

---

### 8. `main` is not synced back into `alpha` after a release
**Date:** 2026-08-26  |  **Status:** Active

**Context:** The Force to main procedure ended by folding the release commit back into both
`develop` and `alpha`.

**Decision:** Do not sync `alpha`. (Amended 2026-09-12 by entry 18: the release is no
longer folded into `develop` either, and nothing is pushed to `origin/develop`. The half of
this entry that still stands, and the reason it stands, is that syncing `alpha` is wasted
work.)

**Rejected:** Also syncing `alpha`. The next Force to alpha force-pushes `develop`'s tip onto
`alpha` regardless of what `alpha` holds, so anything synced there is discarded rather than
built on. The alpha half cost an extra checkout, merge, push, and CI run for nothing.

**Enforced by:** the "Force to main" step 5 procedure in `CLAUDE.md`.

---

### 16. Main release state is synchronized to remote `develop`
**Date:** 2026-09-11  |  **Status:** Superseded by entry 18 (2026-09-12)

**Context:** The previous implementation merged the main release commit into only the
local `develop` checkout. The remote branches could therefore diverge: `main` carried the
release stamp while `origin/develop` carried newer application work. The next alpha
promotion had to merge those histories, and release-only metadata changes still collided
with files changed by that newer work.

**Decision:** The final step of "Force to main" must push its already-gated merge of
`origin/main` into `origin/develop`. "Force to alpha" checks that `origin/main` is already
an ancestor of `origin/develop` before attempting a repair merge. The separate alpha
sync remains rejected because alpha is replaced wholesale by the next alpha promotion.

**Rejected:** Leaving the merge local and relying on the next "Force to alpha" to repair
the remote branch. That makes every release carry avoidable merge risk and can delay the
alpha build with conflicts unrelated to the release itself.

**Enforced by:** `.claude/skills/force-to-main/SKILL.md` step 5,
`.claude/skills/force-to-alpha/SKILL.md` step 1, and the branching guidance in
`CLAUDE.md` and `docs/development.md`.

---

### 9. A changelog-only push to `develop` does not rebuild the develop image
**Date:** 2026-08-31  |  **Status:** Superseded by entry 18 (2026-09-12)

**Context:** Force to alpha step 4 pushes a commit to `develop` that contains only the reset
`changelog.develop.json` and the promoted `changelog.alpha.json`, no app code. That triggered
a full image build and publish.

**Decision:** `paths-ignore` skips the develop publish job when every changed file is one of
those two changelog files. Any push that also touches real code still builds normally.

**Rejected:** Dropping the push. It exists so `origin/develop` holds the correct file for the
app's own live changelog comparison, which reads GitHub's copy directly
(`fetchRemoteDevelopChangelog` in `server/src/routes/maintenance.js`) and is therefore
independent of what any built image bundles. The push is needed; the rebuild was not.

**Enforced by:** `paths-ignore` in `.github/workflows/docker-publish-develop.yml`.

---

### 10. Alpha promotion restamps every public asset URL
**Date:** 2026-09-05  |  **Status:** Active

**Context:** Public assets are served with a one-year immutable cache keyed on their `?v=`
query string. Every build in a cycle shared one asset version, so a tester who pulled a new
alpha image kept running the previous build's JavaScript against the new server.

**Decision:** Promotion to alpha rewrites every local asset reference with the new build's
version. This produces a large, entirely mechanical diff across `public/` on every promotion,
which is expected.

**Extended 2026-09-12 (entry 18):** "Push to git" now restamps too, with the develop build's
own five-segment version, because the same failure applied to every develop build inside a
cycle. `scripts/asset-versions.js` derives the expected version from
`changelog.develop.json` before `changelog.alpha.json`, so the `npm run build` check agrees
with whichever command stamped last.

**Rejected:** Shortening the cache lifetime, which gives up the performance win for every end
user in order to fix a problem that only affects testers mid-cycle.

**Enforced by:** the `scripts/asset-versions.js --write` step inside
`scripts/promote-develop-to-alpha.js`.

---

### 11. TMDB image URLs are not treated as cached artwork
**Date:** 2026-09-05  |  **Status:** Active

**Context:** `isCachedStorageImageUrl()` decides whether an artwork URL is already a local
cached file. TMDB URLs are always resolvable and superficially look like a reasonable thing to
include.

**Decision:** It returns true only for `/media/posters/` and `/media/backdrops/`.
`image.tmdb.org` URLs are not cached storage.

**Rejected:** Including TMDB URLs. They are a remote dependency, not a local file, so counting
them as cached skips the poster pipeline that would otherwise fetch, resize, and persist a
local copy, leaving artwork dependent on TMDB availability at render time.

**Enforced by:** `isCachedStorageImageUrl` in `public/modules/images.js`, alongside the
separate `isLocalArtworkUrl` for the same-origin endpoints that are safe to render directly.

---

### 12. A Plex session Plex does not name is matched on account id, not dropped
**Date:** 2026-09-09  |  **Status:** Active

**Context:** Now Playing filtered live Plex sessions by comparing `<User title>` against the
configured Plex username. Plex returns `<User />` with no attributes at all on some sessions,
including an owner watching their own server. `user.title` is then empty, the comparison fails,
and the session is silently discarded, so Plex never appears in Now Playing. The username it
was being compared against is not typed by the operator either: `resolveConnectedProviderConfig`
overwrites `plex.username` from the connection record on every config load, so clearing the
Settings field does not change it and reconnecting Plex rewrites it. There was no configuration
route out of the failure.

**Decision:** An episode or movie session matches the configured user when either the session's
`<User title>` matches the username, or `<Player userID>` resolves to the same account id via
`/accounts`. The account lookup reuses `resolvePlexAccountId()` in `plexClient.js`, which the
watched-history sync already used for the same question, rather than adding a second mechanism.

**Rejected:** Accepting any session Plex declines to attribute. `/status/sessions` reports every
stream on the server, not just the operator's, so an unattributed session can belong to another
household account. Recording someone else's play as the configured user's is exactly the phantom
watch that #1 exists to prevent, so an unattributable session still does not match. Also rejected:
dropping the username filter entirely, for the same reason.

**Enforced by:** `plexSessionMatchesUser()` in `server/src/utils/liveSessions.js`, the
`client.userId` the Plex parser now carries, and a `console.warn` naming every session the filter
rejects so this cannot fail silently in either direction again.

---

### 13. Paused playback is a live session, not a stopped one
**Date:** 2026-09-09  |  **Status:** Active

**Context:** The live-session fetchers only kept Plex sessions in `playing`/`buffering`, and
rejected Emby/Jellyfin sessions reporting `IsPaused`. A paused session therefore vanished from
the poll result, and `refreshLiveSessions()` can only read an absent session as one that ended.
Observed live: pausing for roughly sixteen seconds removed both rows from `live_tracking_cache`,
recorded a stopped play, and pushed resume progress outbound to Plex, Emby and Jellyfin. The
webhook path disagreed with the poller about the same event, because `media.pause` and
`PlaybackPause` are classified as phase `active`, so whether a paused card survived depended on
how chatty that server's webhooks were.

**Decision:** `LIVE_SESSION_PLAYBACK_STATES` includes `paused`, and sessions carry `paused` /
`playbackState` through the cache round trip to the API and the Now Playing card. Only a session
the media server no longer reports at all is treated as a stop.

**Rejected:** Suppressing the stop path for paused sessions instead of retaining them. That would
have stopped the bad write but still lost the card and the progress, and it would have left the
poller and the webhooks disagreeing about what a pause means. Also rejected: dropping the poller
to its idle interval while everything is paused, which would delay resume detection to 45s on
Emby and Jellyfin, neither of which has a push channel.

**Enforced by:** `LIVE_SESSION_PLAYBACK_STATES` and `isSessionPaused()` in
`server/src/utils/liveSessions.js`, and the "a paused Plex session is still reported as a live
session" test in `test/liveSessions.test.js`.

---

### 14. A live session is keyed by client *and* item, never client alone
**Date:** 2026-09-09  |  **Status:** Active

**Context:** `sessionKey()` built a `live_tracking_cache` id from the source, the client id, and
the season and episode numbers. For Plex the client id is `Player machineIdentifier`, which is
the device and is stable across playbacks. Movies have no season or episode, so two movies played
back to back on one client produced the *same* key: the second overwrote the first, reconciliation
saw the id still present and skipped it, and the first movie's completion was never processed.
The watch was lost with nothing logged.

**Decision:** The key includes a `mediaId` (Plex `ratingKey`, Emby/Jellyfin item id) alongside the
client. The client component stays, because it is what survives a transcode or quality switch.

**Rejected:** Switching the identity to Plex's own per-session `sessionKey`. It changes when Plex
reassigns a session mid-playback, which is the churn `MISSING_LIVE_SESSION_CONFIRMATION_POLLS`
exists to absorb; adopting it would have made a solved problem load-bearing again. Note the key
format changed, so a session live across the upgrade is reconciled once as a stop. The data that
writes is genuine, so this is a one-time cosmetic effect rather than a phantom watch.

**Enforced by:** `sessionKey()` in `server/src/utils/liveSessions.js` and the two session-key
tests in `test/liveSessions.test.js`, one for distinctness across movies and one for stability
across a transcode.

---

### 15. Episodes are keyed on series ids, and the repair refuses to guess which
**Date:** 2026-09-09  |  **Status:** Active

**Context:** Episodes are keyed on the *series* provider ids plus season and episode, which is
what `watch_history` has always stored. Payloads do not reliably carry those ids.
`parsePlexMediaIds()` tried to prefer them from `grandparentGuid`, but Plex's modern agent sends
`plex://show/<internal>` there, carries no external id in it, and sends no grandparent `<Guid>`
children, so the preference silently fell through to the episode's own ids. Emby and Jellyfin omit
`SeriesProviderIds` on their flat webhook templates. The result was episode ids stored where
series ids belong: 92 watch records and 4 resume positions that joined to nothing, rendering with
no artwork and no metadata and not matching the other watches of the same show.

**Decision:** Two parts. Ingestion resolves the series identity from the media server via
`withSeriesIdentity()`, using the `seriesItemId` the parsers now carry, cached and non-throwing so
an unreachable server leaves the ids untouched rather than breaking ingestion. Existing rows are
repaired by `repairEpisodeSeriesIdentity()`, which runs automatically on scheduler leadership and
proves series ids locally: a provider id carried by two or more distinct episodes of a show cannot
be an episode id.

**Rejected:** Resolving the remaining rows by searching a metadata provider for the show title.
Where the local proof is unavailable, every watched episode of that show carries episode-level ids,
so a title search is the only option left and it is a matching heuristic. Attaching a watch to the
wrong show is worse than leaving it unresolved, so those rows are left alone and counted in the log
line instead. They resolve on their own once any correctly keyed record for that show exists, which
ingestion now produces. Also rejected: repairing only the symptom in the artwork lookup, which
would have left the wrong identity stored and the records still unmatched.

**Enforced by:** `server/src/utils/seriesIdentity.js`, `repairEpisodeSeriesIdentity()` and
`seriesIdsForShowTitle()` in `server/src/utils/dataRepo.js`, and the repair's invocation in
`server/src/workerCoordinator.js`.

---

### 17. Trakt history writes are paced, retried, and cancelled between canonical items
**Date:** 2026-09-12  |  **Status:** Active

**Context:** Marking a long TV series watched can enqueue hundreds of Trakt history
remove/add requests. The normal outbound governor prevents unbounded concurrency but still
allowed a burst large enough for Trakt to return `429`, leaving a show partially synced.
Cancelling between the remove and add halves of one canonical replay could also leave that
item in an indeterminate state.

**Decision:** Serialize Trakt write starts with a short interval, retry rate-limited writes
with bounded backoff, and reserve one queue slot for each canonical remove/add pair. A
cancellation prevents the next item from starting but never interrupts the pair already in
flight. Local media-server writes remain a separate, concurrent phase that completes before
the Trakt queue is drained.

**Rejected:** Launching every Trakt write through the general outbound pool, which recreates
the burst that triggers `429`, and checking cancellation between the remove and add requests,
which can leave Trakt with neither the old history nor the replacement history.

**Enforced by:** `trackerDispatcher.js`, `syncOrchestrator.js`, `mediaForceSync.js`, and
`test/mediaForceSyncTrackerPhases.test.js`.

---

### 18. Build versions are five meaningful segments, and no release state is pushed to `develop`
**Date:** 2026-09-12  |  **Status:** Active, supersedes entries 7, 9, and 16; amends 8; extends 10

**Context:** Every "Force to alpha" and every "Force to main" published two images: the
intended channel image, and a second, meaningless `develop` one. `docker-publish-develop.yml`
carried a `paths-ignore` for the two changelog JSON files meant to prevent exactly that, but
`paths-ignore` only skips a workflow when *every* changed path matches, and the promotion
commit also carries the `public/` asset restamp, `README.md`, and on a release
`package.json`/`package-lock.json`. The filter never matched. Entry 9 believed the push was
required so `origin/develop` held the right file for the app's live develop comparison;
entry 16 required a merge of `origin/main` into `origin/develop` so release metadata did not
go stale. Both existed to carry state that git and the local manifests already hold.

Separately, alpha and develop builds could not be ordered against each other at all. Alpha
was four segments (`1.1.0.3`) while the comparators read only three, so `1.1.0.3` and
`1.1.0` compared equal. `semverGt` in `promote-alpha-to-main.js` was worse: it split on `.`,
read three positions, and coerced anything non-numeric to `NaN`, which `(NaN || 0)` then
silently turned into `0` - and that function decides which version ships to every user.

**Decision:**
1. Build versions are five numeric segments, `major.minor.patch.alpha.dev`. The alpha
   counter resets on "Force to main", the dev counter on "Force to alpha". Both comparators
   read all five with zero-fill, so an existing four-segment `1.0.2.1` still equals
   `1.0.2.1.0` and no shipped version is reinterpreted. Display trims *trailing* zeros and
   never goes below three segments, so a release still reads `v1.1.0`.
2. `package.json` and `package-lock.json` keep the three-segment released semver only. Five
   segments is not valid semver and npm rejects or mishandles it.
3. Neither force command pushes to `origin/develop`, and "Force to main" does not merge
   `main` into `develop`. Each promotion writes the new numbers locally and the next
   ordinary "Push to git" publishes them. (Amended 2026-09-24: after "Force to main", local
   `develop` is moved onto the release commit so new work starts from the released build,
   once a check shows every `develop` commit is already in the release. It is still never
   merged or pushed by the command; the next "Push to git" carries it with real work, so
   no empty develop image is published.)
4. `promote-alpha-to-main.js` reads the released history from `origin/main:changelog.json`
   rather than the working tree, and refuses the promotion if the merged history is missing
   any prior release or does not add exactly one.

**Rejected:**
- *Keeping the develop sync and splitting the promotion into two commits so `paths-ignore`
  finally matches.* Works, but preserves the bookkeeping rather than removing the reason for
  it, and leaves the same trap for the next file added to a promotion commit.
- *Semver prerelease tags (`1.2.0-alpha.1`).* Requires committing to the next release number
  at alpha time, so a cycle that turns out to be a patch release inverts the ordering and
  testers silently stop seeing releases. It also forces real prerelease precedence into both
  comparators, where a mistake ships a wrong version.
- *Reviving entry 7's four-segment scheme.* Entry 7 cut the fifth segment because it was
  always zero, no comparison read it, and it rendered as noise (`v0.14.0.3.0`). Both halves
  are now false: the segment carries develop's build counter, the comparators read it, and
  display trims it. Do not cut it again without reading this entry.
- *Entry 16's objection that dropping the merge leaves the branches to diverge and makes the
  next alpha promotion resolve conflicts.* There is no merge left to conflict: entry 16's
  failure mode was conflict during the repair merge, and this removes the repair merge
  instead of trying to make it succeed. The staleness it worried about is gone because
  nothing is carried - every changelog generation point writes the release version from the
  manifests.
- *Entry 9's objection that `origin/develop` must hold the reset file for the app.*
  `describePendingDevelopBuild()` flags a pending build only when the remote build is
  greater at equal version. With no sync, `origin/develop` and any running develop image sit
  at the same pre-promotion build, so it correctly reports nothing pending until the next
  "Push to git".
- *Writing `CHANGELOG.md` and `changelog.json` from the working tree.* The release is built
  from alpha's checkout, and with no merge back neither branch holds main's history, so each
  release would publish a changelog containing only itself. Worse, the loss compounds:
  release N is absent from develop, next cycle's alpha is missing it, and release N+1 is
  appended to that. Every release would erase the one before it, in the shipped image and on
  the website. Hence reading `origin/main` plus the verification gate - a truncated history
  cannot be recovered once users have pulled the image.

**Enforced by:** `scripts/version.js`; `parseSemver`/`compareSemver` in
`server/src/routes/maintenance.js`; `semverGt` and `verifyReleaseHistory` in
`scripts/promote-alpha-to-main.js`; `currentAssetVersion()` in `scripts/asset-versions.js`;
steps 1 and 5 of `.claude/skills/force-to-alpha/SKILL.md`; steps 0 and 7 of
`.claude/skills/force-to-main/SKILL.md`; step 6 of `.claude/skills/push-to-git/SKILL.md`.

### 19. Up Next writes a sub-threshold resume position to mirror the calculated provider rails
**Date:** 2026-09-13  |  **Status:** Active

**Context:** Plex Continue Watching, Emby Resume, and Emby Next Up are calculated by those
servers from their own playstate. Their APIs expose a hide operation and a membership read,
but no way to add an arbitrary future item. The managed `Plembfin Up Next` playlist was added
as the durable, writable provider-side mirror, and it works, but it is a separate list rather
than the rail users actually look at. The only mechanism that places an item on those rails is
a playback position.

**Decision:** After the playlist is reconciled, the push writes a five-second position to Plex
and Emby for queue items that are not already on that provider's resume feed and do not have a
real position being propagated by the normal resume path.

**Rejected:** Leaving the playlist as the only mirror, which is honest but leaves the rail the
user reads permanently out of step with Plembfin. Also rejected: a position large enough to be
visible in the provider UI's progress bar, which would be indistinguishable from a real
part-watch.

**Why this is safe, and why the exact value matters:** five seconds is below
`minResumePositionSec` (default 60). That threshold is enforced by `shouldSyncResumeProgress`
on the outbound path and on both ingestion paths (`syncResumableMedia` in `scheduled.js` and
the `ended` webhook phase in `routes/sync.js`), and by `actionableResume` in the projection. A
seeded position is therefore never stored in `playback_progress`, never rendered as a
part-watch, and never dispatched onward to Trakt. This is the whole safety argument: if the
seed were ever raised to or above that threshold, or if `MIN_RESUME_POSITION_SEC` were lowered
to meet it, a fabricated part-watch would enter the canonical record and fan out. The seed
refuses to run when `minResumePositionMs()` is at or below the seed value rather than
proceeding, and `test/upNextRailSeed.test.js` asserts the ordering directly.

**Also deliberate:** an item already on the provider's successfully refreshed resume feed is
skipped unconditionally, so a real checkpoint is never replaced by the token one.

**Enforced by:** `RAIL_SEED_POSITION_MS` and `railSeedBlockedReason()` in
`server/src/utils/upNextRailSeed.js`; `shouldSyncResumeProgress` in
`server/src/utils/syncOrchestrator.js`; `actionableResume` in
`server/src/utils/upNextService.js`; `test/upNextRailSeed.test.js`.

### 20. Jellyfin is a full Up Next participant again, read and written
**Date:** 2026-09-13  |  **Status:** Superseded by #25 for native-rail mapping and by #28 for the managed playlist;
Jellyfin remains an active provider participant

**Context:** Up Next was narrowed to Plex and Emby on the reasoning that Jellyfin's Next Up is a
calculated GET feed with no per-item write, so it could be neither reconciled nor dismissed.
Two things then showed that reasoning was incomplete. Jellyfin's Next Up feed was, in practice,
the only feed returning correct data: with 20 accurate entries while Emby's Resume and Next Up
both returned zero, excluding it removed the one working source and left real, playable episodes
missing from the queue. And the write problem had the same answer already adopted for Plex and
Emby: a managed playlist for the durable list, and a sub-threshold resume position for the
calculated rails (entry 19). Jellyfin's playlist API is Emby-derived and its
`setJellyfinProgress` already existed.

**Decision:** Jellyfin is read as a provider observation source, receives the managed
`Plembfin Up Next` playlist, and is seeded like the others. The exact native-rail mapping is
defined by entry 25.

**Rejected:** Write-only participation, which would have let Plembfin drive Jellyfin's rails
without trusting its feeds. Rejected because the feed is accurate and excluding it was the
original defect, not a safeguard.

**Consequence to know:** `/Shows/NextUp` is requested with `EnableResumable` on both Emby and
Jellyfin, so a seeded episode becomes its series' Next Up entry there. That is the mechanism
that makes Next Up controllable at all, and it is also why Next Up can hold only one episode
per series and never holds movies.

**Enforced by:** `PROVIDERS` in `server/src/utils/upNextProviderSync.js`; `UP_NEXT_PROVIDERS` in
`upNextService.js`, `upNextRepository.js`, `upNextCache.js`, and `public/modules/up-next.js`;
`EMBY_LIKE_CLIENTS` in `server/src/utils/upNextProviderPlaylists.js`;
`test/upNextProviderSync.test.js`.

### 21. The Up Next rail seed is a real playback position, made safe by a ledger rather than by its size
**Date:** 2026-09-13  |  **Status:** Active, amends entry 19

**Context:** Entry 19 seeded five seconds, on the reasoning that a position below
`minResumePositionSec` could never be mistaken for real progress by any Plembfin path. That
reasoning was sound and the result did not work. Measured against live servers: Plex accepted
the request with a 200 and stored no `viewOffset` at all; Emby stored 0.194% of runtime and
then filtered it out of its Resume feed; only Jellyfin surfaced it. All three apply a minimum
resume percentage, 5% by default, before an item counts as in progress. A position small enough
to be self-evidently synthetic is, by the same token, too small for any of them to keep.

**Decision:** Seed 6% of the item's runtime, and record every seed in `up_next_rail_seeds`
(provider, native id, exact position). Ingestion rejects a seeded position by identity instead
of by size.

**Rejected:** Leaving the rails to the playlist alone, which keeps the rail the user actually
reads permanently out of step. Also rejected: seeding only Jellyfin, the one server where the
small value worked, which would have made behavior differ per provider for no reason the user
could see.

**What the safety now rests on:** the ledger, checked in `syncResumableMedia` (scheduled feed
ingestion), the `ended` webhook phase, and the projection, which strips the position so a seeded
card never renders a progress bar. A seed is matched within 2s to absorb provider rounding, and
a position that has moved away from the seed is treated as genuine and forgets the seed, so the
first real resume after a seed is never swallowed. The reserved Emby seed device id is also
rejected by the webhook and active-session storage paths, and existing synthetic rows are purged
at the Now Playing projection boundary on upgrade. Seeds expire after 30 days.

**Why 6%:** it clears the providers' 5% minimum with room for their rounding and stays far below
the watched threshold. An item whose runtime is unknown is reported as skipped rather than
seeded with a guessed absolute, which would be under the minimum for a feature and over it for
a short.

**Verified live:** Plex stored 213768ms of 3562800ms (6.000%) and listed the item in Continue
Watching, having discarded the five-second write entirely.

**Enforced by:** `railSeedPositionMs` in `server/src/utils/upNextRailSeed.js`;
`server/src/utils/upNextSeedLedger.js`; migration 37 in `server/src/db.js`;
`mediaIsUpNextRailSeed` guards in `server/src/scheduled.js` and `server/src/routes/sync.js`;
`isUpNextSeedDeviceId` in `server/src/utils/embyClient.js`;
the webhook and active-session guards in `server/src/routes/sync.js` and
`server/src/utils/activeSessions.js`; `withoutRailSeedProgress` in
`server/src/utils/upNextService.js`; `test/upNextRailSeed.test.js`,
`test/activeSessions.test.js`, and `test/webhookContentType.test.js`.

### 22. An empty Emby resume feed is not evidence that nothing is resumable
**Date:** 2026-09-13  |  **Status:** Active

**Context:** `fetchEmbyResumableItems` preferred `/Users/{id}/Items/Resume` and fell back to the
generic `Filters=IsResumable` query only on a 404, because that generic query returns an empty
snapshot on some Emby versions while Continue Watching is full. On this installation the
opposite is true: `/Items/Resume` answers 200 with zero items while `Filters=IsResumable`
returns every resumable item, including a genuine part-watch sitting at 36 minutes. Emby's Up
Next feeds read as empty throughout this work, which was taken for a consequence of an earlier
force sync; it was the endpoint.

**Decision:** Try the native endpoint first, and when it succeeds with zero items, ask the
legacy query before concluding there is nothing to resume.

**Rejected:** Switching to `Filters=IsResumable` outright, which would reintroduce the original
failure on the versions the 404 fallback was written for.

**Note:** this repairs what Plembfin reads. Emby's own Continue Watching row appears to use the
same empty endpoint, so a seeded item can be correctly stored and still not appear in Emby's UI;
that part is server-side and outside Plembfin's control.

**Enforced by:** `fetchEmbyResumableItems` in `server/src/utils/embyClient.js`;
`test/upNextProviderSync.test.js`.

### 23. Up Next dismissals are server state, not browser state
**Date:** 2026-09-13  |  **Status:** Active

**Context:** Dismissing an Up Next card wrote to `localStorage` and nothing else. The server's
projection never knew, so the queue Plembfin held and the queue the user saw were different
lists, differing by however many items that one browser had dismissed. Every consumer outside
that browser session saw the unfiltered list: the API, a second browser, a phone, anything
scheduled. This was found the hard way - a push driven through the API sent 55 seeded positions
to three media servers, including 16 items the user had dismissed and could not see.

**Decision:** Dismissals live in `up_next_dismissals` and are applied inside
`buildUpNextProjection`, so every consumer gets the same queue. `/api/up-next/dismissed` lists
them and `/api/up-next/restore` puts one or all back.

**Rejected:** Keeping them client-side and having the push subtract them before sending, which
fixes only the one caller that remembers to do it and leaves every other consumer wrong.

**Identity:** a dismissal stores the item's full alias set plus a `coordinate:<show>:s<n>:e<n>`
key and a show identity alias for episodes, so it survives a re-match or a provider id change and
removing one episode keeps the whole show out of the rail. Native episode provider ids remain in
the set for exact identity and restore snapshots.

**Deliberate carry-over:** a dismissed show returns when one of its episodes has a newer *real*
position, exactly as the browser-local rule did. A dismissal is "not now", not "never".

**Migration:** an existing browser posts its stored dismissals once on first load and then
clears them, so a device that dismissed things before this change does not see them reappear.

**Enforced by:** `server/src/utils/upNextDismissals.js`; migration 38 in `server/src/db.js`;
the dismissal filter in `buildUpNextProjection`; `test/upNextDismissals.test.js`.

### 24. Emby rail seeds are reported as a playback session, not written as UserData
**Date:** 2026-09-13  |  **Status:** Active, completes entry 21 for Emby

**Context:** The 6% seed worked on Plex and Jellyfin and not on Emby. Emby stored the position
correctly - the item's own page showed it, `PlayedPercentage` read 6.000, and the
`Filters=IsResumable` query returned it - but `/Users/{id}/Items/Resume` stayed empty and Emby's
home screen showed no Continue Watching row. The endpoint returned zero under every parameter
combination tried: bare, `MediaTypes=Video`, `Recursive`, `IncludeItemTypes`, `ParentId` per
library, and limit-only. The user's home layout was checked too and holds no section
preferences, so Emby was on defaults, which include the row.

The break came from a control case: the user started watching an episode for real, and it
appeared on the rail immediately. Comparing its UserData against the seeded items ruled out
every field in turn. `PlayCount` was the obvious candidate and was tested directly - writing
`PlayCount: 1` with an identical position and a fresh `LastPlayedDate` still did not put the
item on the rail. The only remaining difference was that one had been through a playback
session.

**Decision:** Seed Emby by reporting the position the way a client does -
`/Sessions/Playing`, `/Sessions/Playing/Progress`, `/Sessions/Playing/Stopped`, with an
`X-Emby-Authorization` device identity - then write UserData once to restore `PlayCount` and pin
the exact position. Verified live: the item joins the rail and stays there with `PlayCount` back
at its original value and `Played` still false.

**Rejected:** Treating it as an unfixable Emby-side problem, which is what the evidence looked
like until the real play gave us something to compare against.

**Consequences worth knowing:** the session call increments `PlayCount`, so the UserData write
afterwards is not cosmetic - without it Plembfin would be inventing play counts. Clearing an
Emby seed also needs `hideEmbyFromResume`, because zeroing the position does not remove the
entry from a rail the playback index drives. And this explains entry 22: `/Items/Resume` lists
what the playback index knows, so an item whose session data is gone - the user's own 36-minute
part-watch of a film - is missing from it while `IsResumable` still finds it. Both queries are
needed, for different reasons.

**The session is real, and that has a cost.** A bare `/Sessions/Playing/Stopped` was tested on
its own and does not reach the rail, so the seed genuinely opens playback for a moment. Emby
reports that back through `/Sessions`, where Plembfin's live poller read it as playback: three
phantom Now Playing cards, and the items dropped out of Up Next because something playing is not
something queued. The seed therefore identifies itself with a fixed `DeviceId`, and both the
Emby and Jellyfin session readers skip it. Nothing reached watch history or
`playback_progress` while this was live - the seed ledger held - but the queue was visibly wrong
until the sessions aged out.

**Enforced by:** `reportEmbyResumePosition` and `UP_NEXT_SEED_DEVICE_ID` in
`server/src/utils/embyClient.js`; `touchEmbyResumeRail` there too, whose next-up rail touch
skipped the restore and added an Emby play to the next-up item on every automatic sync run
until 2026-09-22 (verified live in the Up Next matrix step 4); `isUpNextSeedSession` in `server/src/utils/liveSessions.js`;
the Emby branch of `writeSeed` and `clearStaleSeeds` in `server/src/utils/upNextRailSeed.js`;
`test/upNextProviderSync.test.js`; `test/upNextRailSeed.test.js`.

### 25. Plembfin targets the user-facing equivalent native rail on each provider
**Date:** 2026-09-13  |  **Status:** Active for the rail mapping; the managed playlist it refers to was removed by #28

**Context:** Jellyfin exposes two different calculated sections: Continue Watching contains
genuine part-watched progress, while Next Up contains the upcoming episode for a show. Treating
Jellyfin Resume as the queue made Plembfin disagree with the section the user actually uses, and
trying to clear that feed after a push risked deleting real playback progress. Emby also exposes a
separate Next Up feed, but the requested equivalent of Plembfin Up Next there is Continue Watching.

**Decision:** Plembfin's native queue mapping is Plex Continue Watching, Emby Continue Watching
(the provider's Resume API), and Jellyfin Next Up. Provider Resume/Continue Watching feeds that
are not the target mapping are still read when useful as a protection boundary, but they are not
projected into the provider-backed queue and are never reconciled or cleared as stale queue items.
(Amended 2026-09-23: such a Resume row may lend its native id to a card a canonical resume row
already backs, so a Jellyfin part-watch absent from Jellyfin Next Up still gets its Jellyfin
item. It never creates, keeps, or repositions a card.)
The Jellyfin Next Up feed is a calculated GET with no per-item dismissal API, so the push reports
stale native entries and leaves them unchanged. For a desired ready-to-watch episode, the push
may now remove only Plembfin's own ledger-tracked synthetic resume position and update only the
immediately preceding watched episode's `LastPlayedDate`. Jellyfin uses that date to order the
series on Next Up; the write preserves the predecessor's `PlayCount`, watched flag, and resume
position, and the nudge is marked so its UserData callback cannot become a new Plembfin watch.
The managed `Plembfin Up Next` playlist remains the exact writable mirror on every provider.

**Rejected:** Running a broad clear-progress command after the push, or toggling the predecessor
unwatched and watched. A position written by a real viewer is indistinguishable from a seed by
size alone, and clearing the Jellyfin Continue Watching feed would erase genuine part-watches.
Jellyfin's unwatch operation also resets `PlayCount` and `LastPlayedDate`; marking it watched again
replaces them with a count of one and a fresh date. Seed cleanup is therefore limited to positions
recorded in the seed ledger, and the ordering nudge is limited to a verified ready Next Up item
whose earlier released episodes are watched.

**Enforced by:** `PLEMBFIN_UP_NEXT_FEED_BY_PROVIDER` and
`isPlembfinPrimaryUpNextFeed` in `server/src/utils/upNextRepository.js`; the primary-feed filters
in `planUpNextProviderSync` and `buildUpNextProjection`; protected native-feed ids in
`syncUpNextToProviders`; Jellyfin Next Up refresh in `server/src/scheduled.js`; the partial
`updateJellyfinUserData` write and nudge echo marker in `server/src/utils/jellyfinClient.js` and
`server/src/utils/syncOrchestrator.js`; and `test/upNextProviderSync.test.js`,
`test/upNextQueue.test.js`.

### 26. Refresh every native Up Next rail from a watched predecessor; never seed resume progress
**Date:** 2026-09-13  |  **Status:** Active, supersedes the synthetic-position part of entries 21, 24, and 25; the managed playlist it refers to was removed by #28

**Context:** A calculated rail has no arbitrary "add" operation. The earlier implementation
worked around that by writing 6% progress, which required a ledger, provider-specific cleanup,
and special handling for Emby's short-lived playback session. It also made a queue card look
part-watched and could surface a synthetic session as Now Playing. The user-facing target remains
Plex Continue Watching, Emby Continue Watching, and Jellyfin Next Up.

**Decision:** For every ready episode in Plembfin Up Next, resolve the native series inventory,
verify that the target is released and unwatched, and require every earlier released episode to
be watched. Then refresh the provider's calculated rail from the immediately preceding watched
episode. Plex and Emby receive their native watched mark, with outbound echo markers protecting
Plembfin's canonical history. Jellyfin receives only a merged `LastPlayedDate` update, preserving
its play count, watched flag, and resume position. A genuine target resume position is never
overwritten. The managed `Plembfin Up Next` playlist remains the exact queue mirror.

The old ledger is retained only as an upgrade path: a clear-only migration removes positions
written by older builds, and no current sync writes a new synthetic position or opens a playback
session.

**Rejected:** Reusing the 6% marker, clearing all provider progress after every push, or toggling
the predecessor unwatched and watched. Those approaches either create false playback state,
discard genuine part-watches, or reset provider play counts and timestamps unnecessarily.

**Enforced by:** the provider-neutral native rail refresh in `server/src/utils/upNextProviderSync.js`,
the clear-only legacy migration in `server/src/utils/upNextRailSeed.js`, outbound playstate echo
markers in `server/src/utils/syncOrchestrator.js`, and the provider sync tests.

### 27. Preserve positive Up Next resume positions in the projection
**Date:** 2026-09-13  |  **Status:** Active, supersedes the projection masking described in entries 21 and 26

The native rail refresh no longer needs to create new synthetic resume positions. Existing provider
and canonical rows can therefore retain their positive positions in Plembfin's Up Next projection,
so the dashboard shows the same part-watched state as the media detail view. The seed ledger remains
available for ingestion guards and cleanup of legacy provider state; it is no longer consulted when
rendering an Up Next card.
### 28. The managed provider playlist is removed; the native rail refresh is the whole push
**Date:** 2026-09-14  |  **Status:** Active, supersedes the managed-playlist part of entries 19, 20, 25, and 26; its push-dismissal step is superseded by entry 36

**Context:** The `Plembfin Up Next` playlist was introduced (entry 19) because the native rails are
calculated and cannot be handed an arbitrary future item, so it was the only writable provider-side
representation of the queue. Entry 26 then made the rails genuinely controllable by restamping the
target's watched predecessor, and the playlist was kept alongside it as an exact mirror. Re-checking
what it still carried, against the code rather than the intent, found almost nothing:

- Movies enter Up Next only through a real resume position (`buildUpNextProjection` merges
  `canonicalResume`, `providerResume`, `providerNextUp`, and `localNextUp`; the last two are
  episode-only). A movie with a real position is already on Continue Watching by that position.
- A new season is fully covered by the rail refresh: the previous season's finale is the watched
  predecessor, so it passes every gate.
- A series opener cannot appear at all. `localNextUpCandidates` iterates `getCachedShows()`, which is
  built from `watch_history` episode rows, so a show that has never been watched is never a
  candidate.

What remained was a fallback for items the rail refresh reports as skipped or failed, queue ordering
beyond one episode per series, and an exact list on Jellyfin Next Up where stale entries cannot be
hidden. None of that justified writing a second, parallel list into three servers on every push.

**Decision:** Delete the managed playlist entirely. `syncUpNextToProviders` performs the feed read,
the dismissals, the known-progress replay, and the native rail refresh, and nothing else. The
provider clients lose their playlist create/read/add/remove helpers, which existed only for this.
`pushedProviders` is now the set of configured push providers whose rail refresh did not fail and
whose dismissals all succeeded, rather than the set whose playlist reconciled completely.

**Rejected:** Keeping the playlist behind its own opt-out setting. That preserves a redundant
representation, a second failure mode in the push summary, and roughly 260 lines plus fifteen
provider-client functions, for a fallback nobody asked for.

**Consequence to know:** nothing deletes a playlist an earlier build already created. An upgraded
installation keeps a stale `Plembfin Up Next` list in Plex, Emby, and Jellyfin until the user removes
it by hand. A one-shot cleanup was considered and left out deliberately: it would mean shipping
playlist-deletion calls to three providers in order to retire a feature, and a list the user may have
since edited or come to rely on is not Plembfin's to delete without being asked.

**Enforced by:** `syncUpNextToProviders` in `server/src/utils/upNextProviderSync.js`;
`test/upNextProviderSync.test.js`.

### 29. Queue Up Next provider reconciliation when the projection changes
**Date:** 2026-09-14  |  **Status:** Active

**Context:** The dashboard could show a newly added or changed Up Next item while the
provider's native rail stayed stale until the next scheduled catch-up or a manual header
push. A browser-only trigger would also fail when the dashboard was closed.

**Decision:** Queue a durable singleton `up_next_sync` job from canonical resume/watch
mutations, changed provider snapshots, changed projections, and dismissal changes. The
worker builds the latest mixed queue at execution time and pushes up to 100 items through
the configured native rails. A stable content/order fingerprint suppresses duplicate
pushes, and a mutation observed during a push requests one follow-up job. Provider feed
reads performed as part of that push opt out of the trigger, preventing a feedback loop.
The 15-minute scheduled feed refresh remains the external-change backstop, and disabling
Up Next sync prevents automatic provider writes.

**Rejected:** Triggering the push only from the dashboard. That depends on an open browser,
can miss queue changes received by webhook or another device, and makes provider state
depend on which page is currently open.

**Enforced by:** `upNextAutoSync.js`, the `up_next_sync` worker job, the queue invalidation
hooks in `dataRepo.js`, `upNextRepository.js`, `upNextDismissals.js`, and `upNextCache.js`,
and `test/upNextAutoSync.test.js`.

### 30. Scope the historical watched-sync opt-out to Plex, and make a policy skip a reported outcome
**Date:** 2026-09-15  |  **Status:** Active

**Context:** Plembfin is the source of truth for watched state, and every provider is
supposed to end up agreeing with it. The providers are not equally capable of that. Trakt
keeps exact play dates and rewatch history. Emby accepts the original date through
`DatePlayed` on its mark-played endpoint, and Jellyfin through `datePlayed`. Plex has no
supported historical-date setter on its server API: `/:/scrobble` is the only watched-state
write available, and it always records the Plex server's own clock. A Trakt or Tautulli
import, a restore onto a new server, or a library-wide push therefore lands in Plex as a
flood of activity dated today. There is no way to make that date correct through a
supported API, so the only honest choices are to accept it or to skip the write.

**Decision:** One Plex-scoped setting, `tuning.plexHistoricalWatchedSync`, default on, that
governs only *historical* watched projections: imports, restores, backdated manual marks,
and library-wide pushes. It never gates a live watch, a **Now** manual mark, a per-item
Force Sync, or any unwatch. Turning it off never affects Emby, Jellyfin, or Trakt, which
keep receiving the original date. Intent is carried explicitly on the media payload
(`syncIntent`) and resolved in one place, `watchSyncPolicy.js`, which both
`syncOrchestrator.js` and the Plex adapter consult. A suppressed target is reported as
`skipped_by_policy` - a terminal, non-retryable outcome distinct from `failed`,
`unsupported`, and `already_matching` - so an import summary can say Plex was skipped by
the selected policy rather than reporting a silent success.

**Rejected:**

- *Inferring "historical" from an old timestamp.* A user can mark something watched today
  from the calendar picker, and an imported play can be from an hour ago. Guessing from the
  date would both block current actions and let imports through.
- *A global "disable history sync" switch.* Users would reasonably read that as stopping
  all history sync, and it would take Emby, Jellyfin, and Trakt down with a limitation only
  Plex has.
- *Making the setting default off to avoid the activity flood.* State consistency between
  Plembfin and Plex is the more common expectation; a Plex library that silently disagrees
  is the worse surprise. The flood is explained before an import and can be opted out of.
- *Working around the Plex limitation.* Editing the Plex database, moving the server or host
  clock, and using `/:/timeline` as a date setter are all explicitly out of bounds. The last
  is a playback timeline endpoint, not a historical watch-date API, and misusing it risks
  corrupting real playback state on the user's server.
- *Exempting a per-item Force Sync.* This was the original call and it was **wrong**; see
  the amendment below.

**Consequence to know:** with the setting off, a new Plex server will not receive older
watched history from Plembfin, and Plex badges and counts can disagree with Plembfin until
the user marks those items there. Existing Plex watch history is never removed or changed.

**Amendment, 16 September 2026 - off means off.** The first implementation exempted a
per-item Force Sync, on the reasoning that it was a targeted repair the user had just asked
for and was the escape hatch for items the policy leaves behind. The maintainer rejected
that: unchecking the setting means the user has decided historical watches should not reach
Plex *at all*, and only genuinely new watches should. An exemption that quietly pushes old
watches to Plex defeats the setting, and the setting itself - not a side door - is how a
user asks for their history to be pushed.

So `force_sync` now resolves to `historical`, and `syncCanonicalPlaystate` defaults to
`historical` rather than inheriting the `manual` source it rewrites onto the payload. Every
replay of a watch Plembfin already holds - Force Sync, availability repair, a webhook
reconcile of an older watch - is therefore gated. A caller restoring genuinely live state
passes an explicit `syncIntent: "live"`, which wins; the Plex adaptive poller's
transient-unwatch repair is the one such caller, because that watch just happened with
threshold playback evidence and Plex dropped it itself.

Without the `syncCanonicalPlaystate` default the setting would have been close to
decorative: the source rewrite to `"manual"` exempted every replay, so a library's worth of
history could still reach Plex through ordinary reconciliation after the user turned the
setting off. This was observed in testing before it was fixed.

**Enforced by:** `server/src/utils/watchSyncPolicy.js`, the target filter in
`syncMediaPlaystate`, the `syncCanonicalPlaystate` intent default, and the adapter guard in
`markPlexPlayed`; `test/historicalWatchSyncPolicy.test.js`.

### 31. An exact live-session completion may revive a manual unwatch; a provider watched flag may not
**Date:** 2026-09-19  |  **Status:** Active

**Context:** A manual unwatch in Plembfin used to be permanent against every provider
watched signal. That rule exists because providers report watched state that is not
evidence of a play: a generic played flag, a reconciliation echo, or a Trakt callback can
all arrive after the user deliberately cleared a watch, and letting them win put phantom
watches back. The rule was too broad in one case. While verifying the application-speed
plan, the user unwatched Ludwig episodes in Plembfin and then really watched them again in
Emby. The accepted live-session completions were recorded, but the canonical state stayed
unwatched, so a genuine later watch was lost.

**Decision:** A manual unwatch is superseded only by a media-server row that carries exact
live-session provenance (`ingest_path=live_session`, `event=playback.complete`,
`phase=completed`, `confidence=exact`), and only when **both** of its clocks are newer than
the unwatch: the provider's `source_timestamp` and Plembfin's own `created_at` for the row.
Every other provider watched signal stays subordinate to the manual unwatch and continues
to go to manual review.

**Rejected:**

- *Keeping the unwatch absolute.* It drops real later watches, which the user then has to
  re-mark by hand, and it is the one place the live pipeline's exact threshold evidence
  was being ignored.
- *Comparing only the provider's `source_timestamp`.* The first implementation did this.
  It compared the media server's clock with Plembfin's, so a provider clock running ahead
  could revive an unwatch made after the playback really ended.
- *Comparing only Plembfin's receive time.* A late-ingested or replayed completion of an
  older playback would then revive an unwatch the user made after watching.
- *Accepting any media-server watched row that is newer.* That reintroduces the played-flag
  phantom watches this guard was written to stop.

**Enforced by:** `acceptedLiveWatchSourceTime` and `acceptedLiveWatchIsNewerThanManual` in
`canonicalTransitionIsNewer` (`server/src/utils/dataRepo.js`);
`test/mediaForceSyncCanonicalState.test.js` covers the accepted revival, the generic-flag
safeguard, the late replay, and the skewed provider clock.

### 32. Provider watched flags while locally unwatched enter review instead of disappearing
**Date:** 2026-09-19  |  **Status:** Active

**Context:** Plex library notifications and Emby/Jellyfin played-flag callbacks do not always
identify whether a person clicked Mark watched or whether the provider is replaying an older
state. The previous safeguard discarded generic flags while Plembfin was unwatched. That kept
stale echoes from resurrecting canonical history, but it also made a genuine provider-side
mark invisible to the user.

**Decision:** When the current watched-flag import policy requires review, a provider watched
flag is queued for Manual Watch review even while Plembfin is locally unwatched. It never writes
canonical watch history or propagates to another provider before the user confirms or dismisses
the review. The existing outbound-echo guard still drops Plembfin's own watched writes, and
non-review import modes retain their existing automatic policy.

**Rejected:** Silently discarding every generic flag while locally unwatched. It avoids stale
echoes at the cost of losing a user-visible provider action; review gives the user a safe,
recoverable decision boundary instead.

**Enforced by:** provider notification handling in `server/src/scheduler.js`, webhook handling
in `server/src/routes/sync.js`, and the scheduled provider-history paths in `server/src/scheduled.js`.

### 33. Rating conflicts on timestamp-less providers are decided by undelivered local intent, not scan time
**Date:** 2026-09-22  |  **Status:** Active

**Context:** Personal rating sync imports a change seen on any provider and fans it out to the
others (maintainer decision, 22 September 2026), unless the local value is genuinely newer. Trakt
reports a real `rated_at`; Plex, Emby, and Jellyfin report no rating-modified time. The first
correction used the scan's detection time as the remote change time for those three. In the
manual provider matrix that made any local edit made before the next scan lose to an older Plex
value: Plembfin took Plex's old value, fanned it out, and then Plex's own still-pending queue row
wrote the stale local value to Plex, leaving Plembfin and Plex permanently diverged. The same pass
found every delivered value being re-imported as a "remote change" on the next scan.

**Decision:** For Plex, Emby, and Jellyfin the local value is newer exactly when a local intent
for that provider is still undelivered (`pending`, `processing`, `failed`, `reauth_required`); that
provider alone is re-queued. When a remote value is accepted instead, the source provider's own
stale undelivered row is dropped. Trakt keeps the `rated_at` comparison. A remote value equal to
the last delivered one, with nothing different observed from that provider since the delivery,
is an echo and changes nothing.

**Rejected:** Detection time as a timestamp proxy (local can never win, and the provider diverges);
"local always wins" (a provider-side edit made after a delivered local edit would be reverted,
which the maintainer ruled out); importing echoes (redundant writes to every provider on every
change, and a reset of their retry backoff).

**Enforced by:** `applyRemoteObservation` in `server/src/utils/personalRatingSync.js`, with
`getOutstandingPersonalRatingIntent`/`supersedePersonalRatingIntent` in
`server/src/utils/personalRatingRepository.js`.

### 34. A resolved provider id always outranks the single-known-title-profile default
**Date:** 2026-09-22  |  **Status:** Active

**Context:** `canonicalizePlaybackProgressRecord` in `server/src/utils/dataRepo.js` folds a
resume event with no resolved identity onto the one show `watch_history` has already proven
for that title, so an id-less event still joins the right canonical row instead of forming a
duplicate cluster. Verified live in the Up Next manual provider matrix: a real Plex play of
the original "Scrubs" (2001, correctly resolved to `tt0285403` by Plex's own metadata) was
silently rewritten to `tt40197357` - "Scrubs (2026)" - because Jellyfin's own library has a
genuinely mismatched "Scrubs" entry, and that mismatch was the only "Scrubs" profile
`watch_history` had ever proven, from an earlier Emby-sourced watch. The single-profile
default treated its own guess as more authoritative than a fresh, provider-verified series
lookup for the specific event in hand.

**Decision:** The single-known-profile default is skipped when the incoming record carries a
TMDB or TVDB id (a provider's own series-level lookup succeeded for this event) and none of its
ids agree with the sole known profile; the record's own ids are kept, rather than treating
"only one profile has ever been seen" as proof it is correct. An IMDb-only record still folds
onto the profile: providers leak the episode's own IMDb id into that slot when their series
lookup misses (an Emby Ted Lasso S04E06 event carried only the episode id `tt38494472`), and
the first version of this entry, which trusted any disagreeing id, re-split those episodes
into duplicate rows (caught by `test/episodeIdentityRepair.test.js`, narrowed 2026-09-22).

**Rejected:** Always preferring the single known profile (the shipped behavior until this
entry - actively wrong whenever the one provider that established the profile has a mismatched
library entry, and the corruption is invisible until a differently-matched provider disagrees);
preferring whichever provider synced most recently (same failure, just relabeled - a later
correct sync would still lose to an earlier wrong one, and vice versa).

The same rule applies to the scheduled `repairEpisodeSeriesIdentity` job (`seriesIdsForRow`,
`sameProgressGroupRows`): verified live, the ingest kept the 2001 ids and the next repair tick
rekeyed the row onto the reboot profile. It only holds if the record reaches it with its series
ids, so the Plex/Emby/Jellyfin live-session stop and completion paths resolve them with
`withSeriesIdentity` like webhooks and Continue Watching do (added 2026-09-22).

**Enforced by:** `disagreesWithSoleProfile` and its callers `canonicalizePlaybackProgressRecord`,
`seriesIdsForRow`, and `sameProgressGroupRows` in `server/src/utils/dataRepo.js`. In the Up Next
projection (`server/src/utils/upNextService.js`, 2026-09-22): `canonicalIdsDisagreeWithShow`
keeps a disagreeing canonical row's own series ids (`seriesKeyedRowIds`), series-keyed playstate
rows also index their own identity, and provider feed episodes are stored with the series ids of
their native series handle (`withUpNextFeedSeriesIdentity` in `upNextRepository.js`), so the
title index no longer decides their show. Title and coordinate alias matching of episode
playstate and history rows (`setPlaystateForMediaIdentitySync`, `getPlaystateForMediaSync`,
`siblingWatchRowsFor`, `clearWatchHistoryForMediaIdentitySync`,
`findLatestWatchedByAnyMediaKeySync`, 2026-09-23) skips a row whose ids resolve to a different
proven series profile of the same title (`episodeRecordsNameDifferentShows`); ids proven for no
profile still converge by title, so rematch aliases fold as before, unless both records carry
TMDB and TVDB ids that both disagree and share no id (`unprovenSeriesIdsConflict`, 2026-09-23:
a UK "The Assembly" unplay superseded the Australian show's only watch).

### 35. Clear progress outranks an older provider position, and the automatic push re-checks it
**Date:** 2026-09-22  |  **Status:** Active

**Context:** Verified live in the Up Next manual provider matrix (step 2): after Clear progress
on Scrubs S01E04, the episode came back as a 245s resume card and every provider was set back
to 245s. Two paths did it. The projection let a provider resume row through whenever the
canonical state was `unwatched`, regardless of timestamps, so the providers' not-yet-refreshed
feed snapshot still produced a resume. And the automatic Up Next provider sync had built its
projection seconds before the clear, then pushed that stale 245s to every provider after it.

**Decision:** A provider resume observation is subject to the same timestamp rule as a canonical
row: an explicit watched/unwatched transition newer than the provider's last-played time blocks
it; only a genuinely newer play can start it again. A provider "resume" membership with no
position after an explicit unwatch (Plex keeps the cleared episode in Continue Watching as its
next episode) is shown as `next_up` from 0. The automatic sync skips its resume-position writes
when the data version moved after its projection was built, does not remember that run's
fingerprint, and reruns from fresh state.

**Rejected:** Keeping the unwatched bypass (it is what made a clear undo itself on every
provider); re-reading canonical state per pushed item (the data-version check covers every
canonical table in one comparison, and the rerun already exists).

**Enforced by:** the `providerResume` filter and the membership reclassification in
`buildUpNextProjection` (`server/src/utils/upNextService.js`); `isStale` in
`runAutomaticUpNextSync` (`upNextAutoSync.js`) and `propagateKnownProgress`
(`upNextProviderSync.js`). Tests: `test/upNextQueue.test.js` (cleared-episode cases) and
`test/upNextProviderSync.test.js` ("a stale automatic sync ...").

### 36. The Up Next push never hides a native rail item because Plembfin's queue lacks it
**Date:** 2026-09-23  |  **Status:** Active, supersedes the push-dismissal step of entries 25 and 28

**Context:** Reported as a major bug: items were disappearing from the Up Next sections of the
media apps. Since 4 September the push (automatic and header-button) read each native target rail
and hid every entry that was not in Plembfin's projection: `removeFromContinueWatching` on Plex,
`HideFromResume` on Emby. The projection is built from the last recorded feed snapshots and is
deliberately filtered (one card per show, no specials, local watched state, first-unwatched gating,
dismissals, shows never watched locally), and the automatic push runs after almost every queue
change. So anything Plembfin had not ingested yet (a show just started in the app, Plex's own next
episode) or had filtered out was hidden in the app. Both hides are sticky: the item stays hidden
until a new play. The `isStale` guard from entry 35 covered only resume-position writes, not these
hides.

**Decision:** The push only adds to native rails (predecessor refresh and known resume positions).
A native entry missing from the queue is reported as `retained` and left in place. An item leaves an
app's rail only as the direct result of the user's own Clear progress or Remove from up next action,
which already hides it on every provider at the moment of the action (`hideUpNextAcrossProviders`
in `routes/sync.js`).

**Rejected:** Keeping omission-based hides with narrower guards (build the projection after the
fresh feed read, skip hides when the data version moved). That still hides everything the projection
filters out on purpose, and the filters change often; a wrong hide costs the user an item they
cannot see or easily get back, while a stale extra entry costs nothing. Same principle as entry 1:
a missing item is not evidence.

**Consequence to know:** entries hidden by earlier builds are not restored; Plex and Emby show them
again after the next play. Stale entries the user never touched now stay on the app rails until the
app itself drops them or the user removes them.

**Enforced by:** `planUpNextProviderSync` and `syncUpNextToProviders` in
`server/src/utils/upNextProviderSync.js`; `test/upNextProviderSync.test.js` ("pushing the merged Up
Next rail never hides native entries missing from Plembfin's queue").

### 37. The Up Next rail refresh re-reads the predecessor's canonical state around each restamp
**Date:** 2026-09-23  |  **Status:** Active

**Context:** Up Next manual matrix step 6: after Mark unwatched on Scot Squad S01E02, Plembfin
re-marked it played on Jellyfin with its old watch date (defect O). The native rail refresh had
picked S01E02 as the watched predecessor of the next-up S01E03 from a queue and a provider
inventory read before the unwatch, then restamped it (unplayed, then played) after the unwatch.

**Decision:** Before each restamp, a predecessor whose canonical `playstate` is `unwatched` is
skipped. After a restamp, if it has become `unwatched` in the meantime, the unplayed mark is sent
again.

**Rejected:** The entry 35 data-version `isStale` check. Playback-progress writes also move the
data version, so during any active playback the rail refresh would keep standing down; and the
rerun it triggers does not undo a restamp already made (the rerun sees the target as watched on the
provider and skips it, so the phantom watch stays).

**Enforced by:** `canonicalPredecessorUnwatched` in `refreshProviderRail`
(`server/src/utils/upNextProviderSync.js`); `test/upNextProviderSync.test.js` ("the native rail
refresh never restamps a predecessor Plembfin has as unwatched", "an unwatch that lands during the
rail restamp is sent to the provider again").

### 38. Rail refresh callbacks are consumed by provider item id, whatever the canonical state
**Date:** 2026-09-23  |  **Status:** Active

**Context:** Ted Lasso S04E03 sat in Up Next behind a watched S04E04 (defect AG). The Emby rail
refresh restamped S04E04, then S04E03, as predecessors. Their `item.markunplayed` callbacks
carried Plembfin's own unplayed mark, but the generic echo check lets an unplayed callback through
whenever the playstate row it resolves is not `watched`, so a real user unwatch is not swallowed by
an old marker. The webhook resolved the series-keyed rows (an older explicit unwatch), while the
refresh had read the newer watch stored under leaked episode-level ids. The echoes were applied as
user unwatches and deleted a real Emby watch from history. Entry 37's "re-send the unwatch" step
then re-sent the unplay to Emby, because canonical state now read unwatched.

**Decision:** The refresh records a short-lived marker keyed by the predecessor's provider item id
only (no title or provider-id keys, so a same-title show's episode at the same coordinate is never
covered). For 2 minutes, an Emby or Jellyfin unplayed or played-flag callback for that item is
consumed before any canonical lookup. A genuine user unwatch of that exact predecessor inside those
2 minutes is lost; that trade is accepted because the alternative deleted history.

**Rejected:** Making the webhook and the refresh read the same playstate row. Which row wins
depends on id resolution (leaked episode ids, title aliases, series ids), and any remaining split
would let the echo through again.

**Enforced by:** `recordOutboundRailRefresh` / `isRecentOutboundRailRefresh`
(`server/src/utils/syncOrchestrator.js`), the webhook guard in `handleWebhook`
(`server/src/routes/sync.js`); `test/webhookContentType.test.js` ("a native rail refresh callback
never unwatches or deletes watch history").

### 39. A manual watch review that local state already answers is closed, not hidden
**Date:** 2026-09-24  |  **Status:** Active

**Context:** The review listing filtered out reviews whose item Plembfin already had watched (or
had already unwatched) but left them `pending`. They stayed invisible in the database: 549 pending
rows on 24 September 2026, of which the page showed one. Review `499b5d89` (Marshals S01E02) was
one of them.

**Decision:** When the listing finds a review that local state already answers (the same
`reviewIsAlreadyWatched` rules that used to hide it), it sets the review to `dismissed` with
`decision_mode` `resolved_by_local_state`. This changes the status only. Nothing is written to
history and nothing is sent to a provider. The same provider snapshot stays suppressed, and a
changed snapshot can queue a fresh review. Separately, a Plex/Emby/Jellyfin library import no
longer queues a review for an item Plembfin already has watched (`libraryHistoryDecision`).
Decision 32 still holds for locally unwatched items.

**Rejected:** *Hiding them.* Hidden pending rows pile up without limit, and the counts disagree with
what the user can act on. *Dismissing them through the normal dismiss path.* That path is a
Plembfin-wide unwatch and would unmark watched items on every provider.

**Enforced by:** `listPendingManualWatchReviews` (`server/src/utils/manualWatchReview.js`) and
`libraryHistoryDecision` (`server/src/scheduled.js`). Tests: `test/manualWatchReview.test.js`
("pending reviews are hidden after the item becomes canonically watched") and
`test/scheduledLibraryHistoryAuthority.test.js`.

### 40. An ambiguous Emby/Jellyfin title search writes to nothing, not to every match
**Date:** 2026-09-24  |  **Status:** Active

**Context:** When an episode or movie carries no id its Emby or Jellyfin library can resolve (an
Emby review carries only the episode's own ids, a Plex review none), the client falls back to a
title search and writes to every title match. On 24 September 2026 a "Scrubs" (2001) S01E03
dismissal also marked "Scrubs (2026)" S01E03 unplayed on Emby, and an S01E04 restore wrote both
series on Emby and Jellyfin. Jellyfin names both series plain "Scrubs"; Emby names the revival
"Scrubs (2026)", and its search did not return `ProductionYear`, so even a request titled
"Scrubs (2026)" matched the 2001 series.

**Decision:** When the title matches include two items whose provider ids or years disagree, the
search returns nothing, so the write reports `not_found`. Matches that agree (one series in two
libraries) still all count. A year or the series' own ids still pick exactly one item: the search
now leaves the year out of the search term, and Emby asks for `ProductionYear` so the year check
works.

**Rejected:** *Writing to every match* (the old behavior): it marks the wrong show, a phantom
watch or unwatch that then spreads. *Picking the match whose name has no year:* Jellyfin names
both "Scrubs", so there is nothing to pick by.

**Enforced by:** `titleMatchNamesSeveralItems` in `server/src/utils/embyClient.js` and
`server/src/utils/jellyfinClient.js`; `test/sameTitleSeriesSearchFallback.test.js` ("an ambiguous
title with no year or show id writes to neither same-title series").

### 41. The automatic retry resends to Trakt only after a transient failure, and checks history first
**Date:** 2026-09-29  |  **Status:** Active

**Context:** The background retry queue covered only Plex, Emby and Jellyfin, so a Trakt write
that failed for a temporary reason (429, a Trakt server error, a timeout, a dropped connection)
stayed failed until someone pressed Retry. The local data held three 429 failures from 12
September that were never retried. Trakt's `/sync/history` adds a play on every call, and a
timeout or 5xx does not prove Trakt did not write it.

**Decision (user, 29 September 2026):** Trakt joins the queue, with the same backoff and
10-attempt cap, but only when its telemetry line is an error whose text shows a 429, a 5xx, a
timeout, or a connection failure, and only while Trakt is connected. Before re-adding a watched
play, the retry reads Trakt's history for that item within one minute of the row's
`watched_at`; if the play is there, the row is marked synced and nothing is written.

**Rejected:** *Retrying every Trakt error:* `not_found` never succeeds and would burn ten
attempts per show Trakt does not carry. *Resending without the history check:* a timeout after
Trakt accepted the write would add a duplicate play, the same kind of damage as the
2026-08-19 rewatch flood.

**Enforced by:** `traktNeedsRetry` in `server/src/scheduled.js`, `findExistingTraktPlay` in
`server/src/utils/trackerDispatcher.js`; `test/pendingManualDispatchTraktRetry.test.js`.

### 42. Paused in the credits then closed is a finished play; a Plex rating is not a play
**Date:** 2026-09-29  |  **Status:** Active

**Context:** The core-sync-health audit found two opposite errors. The live poller never
completed a session it last saw paused, so pausing at 95% in the credits and closing the player
recorded nothing unless a webhook arrived. Plex's `user.playrate` (a rating) was in the list of
completed events, so rating a title recorded a watch dated now and sent it to every target and
Trakt.

**Decision (user, 29 September 2026):** Since paused sessions stay live (entry 13), one that
disappears was closed. It completes when its paused position is at or past the watched threshold
and the row is fresh (seen within five minutes); below the threshold it never does.
`user.playrate` is ignored entirely.

**Rejected:** *Leaving paused completion to webhooks only:* Emby and Jellyfin without the webhook
plugin would never record that play. *Sending a Plex rating to Manual Watch review:* it carries
no playback evidence to review.

**Enforced by:** `canInferLiveSessionCompletion` in `server/src/utils/liveSessions.js` and
`PLEX_COMPLETE_EVENTS` in `server/src/utils/parsers.js`; `test/livePollerCompletion.test.js`,
`test/liveSessions.test.js`, `test/parsers.test.js`.

### 43. Force to main approves the release candidate before website review
**Date:** 2026-09-30  |  **Status:** Active

**Context:** The previous order reviewed the website on `develop` before pinning and approving
the alpha build. Since `develop` can contain application changes that are not in alpha, its
pages and screenshots could describe behavior that would not ship. Website work could also be
wasted if the changelog or release build was then changed or declined.

**Decision (user, 30 September 2026):** Pin alpha, preview the release entry, start that exact
build, and obtain approval of both the changelog and running candidate before phase A. Review
and capture the website against that candidate in phases A/B/C, then carry the reviewed
website from local `develop` into the same pinned alpha release before promotion and final
review.

**Rejected:** *Review the website first against `develop`*: that build can be ahead of alpha,
so the public documentation can claim unreleased behavior and screenshots may be stale at the
moment of release. Release-first review ties every website change to the source the user
approved.


### 44. Plekt keeps legacy identifiers to preserve existing installs
**Date:** 2026-10-09  |  **Status:** Active

**Context:** Changing the product name can reset an install if database paths,
credential keys, cookies, provider identities or backup formats are renamed without
compatibility. Existing users must keep their state after changing only the image.

**Decision:** Rename visible copy to Plekt. Accept both environment-variable and
webhook-secret header names, preferring nonblank new values. Keep existing
`plembfin.db` databases, backup folders, cookies, browser storage keys, provider
device ids, persisted source values and legacy API routes. New databases and backups
use Plekt names; old backups still restore, list and prune. New backup output is not
restorable on older builds. Existing provider connections keep their old display
name; fresh connections announce Plekt. The Windows installer retains its AppId and
migrates the service/data folder with conflict checks; actual upgrade verification
is still pending. New Unraid installs use `/mnt/user/appdata/plekt`; old paths stay.
Publish both old image names for at least six months after the rebrand release.

**Rejected:** A global identifier rename: it can make history disappear, invalidate
credentials or webhooks, orphan backups and register a second Windows service.
Compatibility is established before display changes; real upgrades run against
copies of old data. This work is local preparation and does not authorize publishing.
