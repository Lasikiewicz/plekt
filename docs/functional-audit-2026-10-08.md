# Plembfin functional audit, 8 October 2026

This is the audit of feature behavior, sync handling, playback detection, and recovery requested after the initial UI audit. It supersedes that report for the requested scope.

**Result: six reproduced behaviors: two P1, three P2, and one P3.** The main weaknesses are inconsistent ordering between playback evidence and explicit edits, discarded evidence after storage failures, and reporting success without completing the intended remote operation. No P0 was demonstrated. This is not a certification that every feature is defect-free.

**Review note (8 October 2026):** a second pass checked every cited location against the code at `efb218e3` and read the saved probe results; the probes were not rerun. All six behaviors are present in the code. The original report rated four P1 and two P2; F2 and F3 were lowered to P2 and F5 to P3 because of how narrow their triggers are, two fixes were simplified (F2, F5), F4's fix was widened, and the work order was changed. Each change is explained under its finding.

## Scope and evidence

- Checkout: `efb218e3`. Application source, user data, and connected providers were not modified. The existing local server was left running unchanged.
- Reviewed the webhook/manual-state routes, live session reconciliation, resume authority, outbound orchestration and leases, dispatch retries, Force Sync planning/execution, Trakt ordering, imports, personal ratings/watchlist/playlists, and backup/restore contracts.
- The full suite run earlier in this audit passed **1,520 tests**, with no failures or skips; the build checks passed. After clarifying the functional scope, **183 focused backend tests** passed across 24 test files. These are existing tests, not regression tests for the new findings.
- Added isolated fault/race probes under ignored `scratch/`. Each sets a fresh temporary `DATA_DIR` before importing server modules. Remote requests are mocked; the playback storage probes use temporary SQLite triggers. No real provider writes were sent.
- The probes exercise production functions with controlled failure conditions. Emby was the directly reproduced remote adapter. Similar shared paths affect other providers, but their live server behavior was not established here.

Severity: P1 means a priority correctness or data-preservation defect; P2 means a conditional defect or misleading feature outcome; P3 means a reporting gap with no confirmed wrong state. Recommendations below are proposed fixes; none have been applied.

## Findings

### F1 (P1): cached playback completion can reverse a newer manual unwatch

**Locations:** `server/src/scheduled.js:817`, `:839`, `:894`–`:896` (`processCompletedSession`).

The completed-session path checks whether an already-watched item qualifies as a new-day rewatch. It does not reject cached completion evidence older than the item's newer canonical `unwatched` state. It then inserts watched history and upserts watched state.

**Reproduction:** seed a cached movie session at 95%, last seen 20 seconds earlier; set the movie's canonical playstate to unwatched now; allow two successful empty live polls. The state changes from **unwatched to watched**, and one watched-history row is inserted. No new playback occurred after the unwatch.

**Impact:** a manual unwatch can appear to succeed and then be undone by the poller. The resulting watched record also enters outbound dispatch. Partial-progress authority protections do not prevent this completed-session path.

**Window:** the unwatch has to land between the session's last sighting and the second confirming poll, and a row older than 5 minutes is never used to infer a completion (`LIVE_SESSION_COMPLETION_MAX_AGE_MS`). The window is short, and longer when a source poll is failing. It stays P1 because the outcome is a phantom watch dispatched to every target.

**Fix:** apply the rule the stopped-session path already uses (`resumeProgressBlockedByPlaystate` in `resumeAuthority.js`): when the canonical state is `unwatched` and its `updated_at` is at or after the cached row's `updated_at`, consume the row without inserting or dispatching. Check it where `knownPlaystate` is read and again just before the insert.

**Regression cases:** cached completion before manual unwatch; truly newer playback after unwatch; same-day duplicate; next-day rewatch; aliases from different providers.

### F2 (P2): failed local writes cause playback evidence to be discarded

**Locations:** `server/src/scheduled.js:839`, `:974`, `:2192`–`:2209`.

Completion marks the live tracking row complete before storing watched history. The caller converts a processing exception into `null`, treats it as disposable evidence, and deletes the row. Partial playback similarly catches a progress-storage failure and still removes the cached session.

**Reproduction A:** inject a temporary insert failure for the completed movie's `watch_history` row. After disappearance confirmation, remove the failure and poll again. The cache is already empty, and watched history remains empty.

**Reproduction B:** inject a temporary `playback_progress` insert failure for a session stopped at 60%. Remove the failure and poll again. The cache no longer contains the session and no resume row exists.

**Impact:** a transient database error becomes permanent loss of the observed watch or resume position. Other catch-up mechanisms may later discover provider state; this path does not retain the original evidence for retry or guarantee recovery of its time/position.

**Severity:** lowered from P1. It needs a local SQLite write to fail, which is rare with one process and one database file.

**Fix:** no new pending store is needed; the cached row is already the durable evidence.

- Completion: call `markLiveTrackingComplete` after the history insert and playstate upsert, not before. In `refreshLiveSessions`, tell a thrown error apart from a deliberate `null` and leave the row in the cache on a throw.
- Stopped session: stop swallowing the `upsertPlaybackProgress` error, and leave the row in the cache when it fails.
- Retry is already bounded and duplicate-safe: the row is retried on later polls until the 5 minute staleness cap drops it, and a retry after a half-finished completion is caught by the existing watched-playstate and any-key checks, so no second history row is created. Confirm with a test that a history row left without dispatch telemetry is picked up by catch-up dispatch.

**Regression cases:** failed history insert, failed playstate update, failed progress insert, successful recovery on a later tick, duplicate-safe replay after restart.

### F3 (P2): an old resume write can land after a newer unwatch

**Locations:** `server/src/utils/syncOrchestrator.js:1451`, `:1505`; compare the watched/unwatched state lease at `:1399`.

`syncMediaProgress` calls the provider progress client directly. Unlike watched/unwatched propagation, it does not participate in the shared per-media/per-target state lease or check that its intent is still current immediately before writing.

**Reproduction:** start an old Emby resume dispatch at 600,000 ms and delay the item lookup response. Complete a newer unwatch, then release the lookup. Captured remote operations are:

1. Progress set to **0** by the unwatch.
2. Mark-unplayed request.
3. Progress set to **600,000 ms** by the older dispatch.

Both summaries report success. The mocked provider's final resume position is 600,000 ms.

**Impact:** an older operation resurrects resume progress after the user clears it. The shared dispatch structure exposes the ordering gap to other media servers; only Emby was directly exercised. Emby's progress payload also includes `Played: false`, so overlap with watched propagation needs its own regression test.

**Severity:** lowered from P1. An in-flight progress write has to overlap an unwatch within seconds, and the result is a stray resume position on one server, not a wrong watched state.

**Fix:** run each target's progress write under the same `runWithOutboundStateLease` key as watched/unwatched, and inside the lease recheck `resumeProgressBlockedByPlaystate` against the current canonical state before calling the provider. Check in the same change that the provider progress callback this can trigger is still recognized as Plembfin's own write.

**Regression cases:** delayed old progress versus newer unwatch/watch; newer legitimate progress; different identities and targets; restore begins during lookup.

### F4 (P1): malformed or shrunken rating scans can clear existing ratings

**16 October 2026:** implemented with regression coverage: response/page validation,
processing-error gate, and persistent review for at least two removals over 20%.
Full verification is recorded in the functional-audit-fixes plan; live UI review remains open.

**Locations:** `server/src/utils/embyClient.js:1015`; equivalent fallback in `jellyfinClient.js:960`; missing-row reconciliation in `personalRatingSync.js:486`–`:524`.

The Emby rating adapter treats a successful JSON response without `Items` as an empty item list. The coordinator accepts that list as a complete snapshot and interprets previously rated items missing from it as remote clears.

**Reproduction:** import a normal Emby snapshot containing a movie rated **8**, establishing a complete baseline. Return HTTP 200 with `{ "Message": "Unexpected response shape" }` for the next scan. The run reports **succeeded**, `complete: true`, `scanned: 0`, `cleared: 1`, and the canonical rating is removed.

**Impact:** a malformed successful upstream response can remove local ratings and, when other send targets are active, generate outgoing clear intent. The local deletion is reproduced; fanout was disabled in the fixture. This requires an unexpected provider/proxy response, not an ordinary valid empty snapshot.

**Likelier trigger (added on review, not reproduced):** a well-formed but shrunken snapshot goes through the same missing-row pass. An unmounted library, a changed user id, or changed library access makes the provider return far fewer items with a perfectly valid shape, and every rating missing from it is treated as a remote clear. Shape validation alone does not cover this.

**Fix:**

- Adapter (Emby and Jellyfin): a response without an `Items` array is a scan error. Compare the number of items read with `TotalRecordCount` and fail the scan on a mismatch, so a short page mid-scan cannot pass as a complete snapshot.
- Coordinator: skip the missing-row pass when the first pass recorded any processing error.
- Coordinator: add a mass-clear guard. When a scan would clear more than a set share of a provider's previously rated items, hold the clears and report the run as needing review. The threshold and what the user sees are behavior decisions to ask when this work starts.

**Regression cases:** HTTP 200 malformed object, malformed later page, count below `TotalRecordCount`, small legitimate clear, large drop from an established baseline, per-record normalization failure, first scan versus established baseline. Apply matching validation to Jellyfin and review Plex/Trakt adapters.

### F5 (P3): unwatch reports success when clearing resume progress fails

**Locations:** `server/src/utils/syncOrchestrator.js:1413`–`:1417`.

Unwatch attempts to clear progress and then mark the item unplayed. A progress-clear exception is logged as non-fatal and discarded; the target outcome reflects only the mark-unplayed request.

**Reproduction:** Emby progress/UserData POST returns HTTP 500; mark-unplayed DELETE returns HTTP 200. The aggregate summary reports **success**, says “Successfully synced to Emby,” and gives the target status success/200.

**Impact:** the feature's resume-clearing step failed, but users and retry logic receive a successful result. Whether the item remains in Continue Watching depends on the provider's mark-unplayed semantics; that UI consequence was not tested against a real server.

**Severity:** lowered from P2. The code marks the progress clear as non-fatal on purpose, and mark-unplayed is expected to reset the resume position on the server by itself, which would make the separate clear a safeguard whose failure changes nothing. That expectation is not verified here.

**Fix:** first check on a live Emby, Jellyfin, and Plex item that mark-unplayed alone clears the resume position. If it does on all three, only add the clear failure to the target's detail text and leave the outcome as success. If a provider keeps the position, treat that provider as the original report proposed: report a partial outcome and retry the clear.

**Live result (16 October 2026, step 6):** run against the connected Emby, Jellyfin, and Plex test instances with `scratch/functional-audit-f5-live.mjs`. On each, a test movie was given a 600000 ms resume position, then only mark-unplayed was sent. The position read back as 0 on all three and the item stayed unplayed, so the first branch applies: the remaining fix is to add the progress-clear failure to the target's detail text and keep the outcome as success. The test movies were left unplayed at position 0, their starting state. The fix is applied (commit `0f083fc6`): the target detail reports a failed progress clear and the outcome stays success.

**Regression cases:** clear fails/mark succeeds; clear succeeds/mark fails; providers that clear position implicitly.

### F6 (P2): Force Sync counts a missing item as a completed action

**16 October 2026:** implemented with regression coverage: distinct missing count/title
list, partial/failed plan outcomes, unsuccessful background jobs and accurate UI wording.
Live UI review remains open; full verification is recorded in the owning plan.

**Locations:** `server/src/utils/forceSyncExecutor.js:93`–`:94`, `:124`, `:143`.

The executor explicitly recognizes `not_found` only when deciding whether to record item-specific echo markers. It still increments completed actions and reports overall success because no exception was thrown.

**Reproduction:** execute a confirmed, non-destructive plan with one Emby mark-played action, a matching watched-count fingerprint, and a provider lookup returning no item. Result: **success: true, plannedActions: 1, completedActions: 1, failedActions: 0**. No remote played mutation occurred.

**Impact:** the Force Sync result says the plan completed successfully while leaving the requested target state unapplied. Count-based plan verification does not prove that the individual target item still exists.

**Related (added on review, not reproduced):** when an exception escapes after the recovery snapshot was taken, the outer `catch` at `:145` stores the plan with status `completed` and `success: false`. The ternary at `:140` also yields `completed` on both branches.

**Fix:** count `not_found` as its own outcome (`missingActions`) instead of completed, set `success` false when any action is missing or failed, and list the missing items in the stored result. Give a plan that ended with failures, missing items, or an escaped exception a status other than `completed`. How the result is worded in the UI is a behavior decision to ask when this work starts.

**Regression cases:** missing item, partial missing batch, provider error, cancellation, exception after snapshot; completion totals must reflect applied actions.

## Feature coverage

“Checked” below means source review and relevant automated contracts were examined; it does not mean live-provider certification.

| Feature | Checked behavior and result | Limits / remaining validation |
| --- | --- | --- |
| Webhook watched/unwatched ingestion | Event normalization, explicit unwatch versus generic flags, echo suppression, manual review, duplicate/rewatch rules, shared dispatch | Real provider event variants and concurrent delivery need recorded-payload end-to-end replay |
| Playback detection and now playing | Threshold handling, paused sessions, two successful missing polls, failed-source preservation, stale-evidence rejection; F1/F2 reproduced | Device-specific session disappearance and long outage/restart behavior not live-tested |
| Resume / Continue Watching | Source-time authority, equal-position acknowledgement, watched/unwatched guards, stop progress, outbound progress; F2/F3/F5 reproduced | Live provider rail behavior and implicit clearing semantics not tested |
| Manual watch/unwatch and identity | Shared mutation routes, alias/episode identity tests, restore queue behavior | State precedence needs the new cross-path regressions above |
| Background dispatch / catch-up | Target-specific retries, bounded batch/concurrency, backoff/exhaustion, successful-target telemetry carry-forward, Trakt retry history check | Long backlog soak and cross-process crash recovery were not fault-tested |
| Force Sync | Scan-error blocking, role/TTL/count staleness checks, destructive snapshot, cancellation, action outcomes; F6 reproduced | Identity-preserving library changes with unchanged counts and overlap with manual edits need stronger tests |
| Trakt synchronization | Existing outbound ordering and poll-race contracts passed; fresh-edit priority over bulk-import backlog reviewed | OAuth expiry/rate limits and actual remote eventual consistency not exercised |
| Tautulli/imports | Older-than-unwatch, preserved watch dates, episode separation and historical-import contracts passed | Very large real imports and interrupted provider reads not replayed |
| Personal ratings | Snapshot baselines, local/remote conflict handling, readback acknowledgement, durable queue; F4 reproduced | Malformed/incomplete snapshot validation needs broader provider coverage |
| Personal watchlist | Complete-snapshot gate, managed ownership, container identity boundary, newer local-intent preservation, queue tests passed | Connected account watchlist and provider-side recreation not live-tested |
| Playlists | Managed-entry ledger, pull/push behavior, show conversion and shared identity tests passed | Large lists, duplicates and provider ordering need live acceptance tests |
| Backup / authoritative restore | Streamed backup and restore tests, authentication-before-mutation approach, restore outbound blocking and queued-work behavior checked | Power-loss, disk-full and production-size restore exercises not performed |
| Worker coordination | Scheduler lease/background job architecture and startup scan contracts reviewed | No new multi-process leader-loss or crash-injection run in this audit |

## Additional risks to validate

These are code-review observations, not additional reproduced defect counts:

- **Force Sync uses direct provider writers.** `forceSyncExecutor.js:24` bypasses the orchestrator's watched/unwatched state lease. Its concurrency assumption covers actions within one plan; it does not establish ordering against a simultaneous manual edit or webhook. Add a controlled overlap test and use a shared mutation boundary if the newer user edit can be overwritten.
- **Force Sync fingerprints are counts.** `forceSyncPlanner.js:709` checks age, connection/role revision, and watched-item counts. Equal counts can conceal changed item identities or state. Consider a state revision or item-level revalidation when destructive actions require the reviewed plan to remain authoritative.
- **Now Playing freshness during outages.** Failed-source polls preserve cached rows, and `routes/sync.js:2850` filters completion/terminal states but not age. Verify whether old cached sessions appear indefinitely as current during an outage; expose stale/unreachable status or expire display membership separately from retained sync evidence.
- **Rating per-record errors and absence.** The missing-row pass is gated on the previous complete baseline, while current processing errors are evaluated afterward. Ensure an incomplete current observation can never authorize destructive absence handling, even after adapter shape validation.

## Recommended work order

Each step converts its probe into a regression test first, then fixes the code. Steps 1 to 4 are small and worth doing; steps 5 and 6 are optional.

1. **F4, rating scans.** The only finding that deletes data and can fan the deletion out to other servers. Adapter validation and the processing-error gate are small; the mass-clear guard needs the threshold decision.
2. **F1, completion versus newer unwatch.** One comparison reusing the existing resume-authority rule.
3. **F2, keep evidence on a failed write.** Reorder the completion marker and keep the cached row on a throw. Same function as step 2, so do them together.
4. **F6, Force Sync accounting.** Count missing items separately and fix the stored plan status.
5. **F3, progress under the state lease.** Do it only if the echo check in its fix stays simple; the race is narrow and the damage small.
6. **F5, live check.** One manual check per provider decides whether anything beyond a clearer detail message is needed.

Out of scope unless a real incident points at them: the "Additional risks" above, and the recorded-payload, soak, and crash-injection exercises listed under "Limits" in the coverage table. They are open-ended and none has a reproduced defect behind it.

Rerun the full suite and build after the fixes. Passing existing tests alone is insufficient: the six reproductions above currently coexist with a green suite.

## Local reproduction artifacts

Scratch files are ignored by Git and are supplemental; the scenarios and observed results above remain in this report.

- `scratch/functional-audit.mjs` and `functional-audit-results.json`: stale unwatch/completion and storage failures.
- `scratch/functional-audit-outbound.mjs` and `functional-audit-outbound-results.json`: progress ordering and hidden clear failure.
- `scratch/functional-audit-features.mjs` and `functional-audit-features-results.json`: Force Sync missing target and malformed rating snapshot.
- `scratch/functional-audit-tests.log`: 119 focused tests passed.
- `scratch/functional-audit-backend-tests.log`: 64 further focused tests passed.

Run the three probes with `node scratch/<script>.mjs`. Each creates its own temporary database and mocks remote traffic. They document current faulty behavior; convert them into assertions for the intended behavior when implementing fixes.
