# External tracker connections

Add Simkl alongside Trakt with explicit provider limits and full local history.

## Waiting on you

Nothing right now. Reserve chosen 24 October: 20% of the daily allowance plus the
55-request safety reserve.

## Steps

- [x] [Step 1: Phase 0, check what Simkl's API actually does](active/external-tracker-connections/step1-phase0-spike.md)
  - [x] Record qualified capability answers, core fixtures and documentation conflicts.
  - [x] [Movie watched-date, duplicate replay, ratings, and cleanup](active/external-tracker-connections/step1a-movie-validation.md).
  - [x] [Expanded scenario audit and remaining compatibility gates](active/external-tracker-connections/step1b-scenario-audit.md).
  - [x] [Remaining provider probes and prerequisites](active/external-tracker-connections/step1d-final-probes.md).
  - [x] [Compatibility decisions before extraction](active/external-tracker-connections/step1e-compatibility-decisions.md).
  - Unrun paid, expiry, export and integration checks remain in the evidence files;
    downstream gates are recorded in step 6 and deferred imports in step 9.
- [x] [Step 2: Phase 1a, put Trakt behind a common tracker interface](active/external-tracker-connections/step2-phase1a-adapter.md)
- [x] [Step 3: Phase 1b, remove the "only Trakt" assumptions](active/external-tracker-connections/step3-phase1b-registry.md)
- [x] [Step 4: Phase 1c, record every tracker write before sending it](active/external-tracker-connections/step4-phase1c-write-intents.md)
- [x] [Step 5: Phase 1d, safety checks for several trackers at once](active/external-tracker-connections/step5-phase1d-safety.md)
  - [x] Account change starts fresh; old-account work cannot touch the new connection (unit-tested).
  - [x] Test that an automatic unwatch reaches the other trackers and does not bounce back (unit-tested).
  - [x] Remove the remaining Trakt-only branches in Sync Attention that are not deliberate (unit-tested).
  - [x] Rebuild the rating tables without the fixed provider list (unit-tested).
  - [x] Keep unknown tracker data from a restore untouched and show a warning card (unit-tested; rewritten card kept after your desktop check; 390px passed).
  - [x] Live Trakt reconnect (fresh baseline, no new history rows or errors).
  - [x] Live Trakt token refresh, forced and verified 21 October 2026 at the user's request.
- [x] [Step 6: Phase 2, the Simkl connection](active/external-tracker-connections/step6-phase2-simkl.md)
  - [x] AUTH V2 client foundation (eight unit tests; no connection activation).
  - [x] Auth persistence/routes and encrypted refresh storage (1,799 tests/build; local API checks pass).
  - [x] [Gated adapter primitives](active/external-tracker-connections/step6a-adapter.md): activity-first reads, identity/coverage holds, durable watched writes/readback, encrypted refresh and generation fences (1,815 tests/build; subagent review passes).
  - [x] [Persisted observations and dispatch](active/external-tracker-connections/step6b-persistence.md): exact-date write/readback/replay, changed delta persistence and committed-response-loss review hold pass live; restoration passes. Live fan-out verified (Phase D, 23 October).
  - [x] Simkl live consent, Settings persistence/reconnect and forced refresh through the app service.
  - [x] Auth-only Settings connection UI; automated flow tests and subagent local Settings/API safety checks.
  - [x] Subagent Settings mobile check at real 390px, after subtitle wrapping fix.
  - [x] Live baseline-only persistence and unchanged-cursor delta, rolled back without history changes.
  - [x] Already-watched live dispatch readback with POSTs blocked; synthetic recovery holds and desktop/390px review UI.
  - [x] New provider watched write, exact-date readback and settled replay without a duplicate POST; cleanup verified.
  - [x] Isolated pending inbox drain/conflict recovery and Emby/Jellyfin fan-out without bounce.
  - [x] Changed live delta persistence and real committed-response-loss review hold (22 October; exact dates and restoration verified).
  - [x] Live pending-observation fan-out and connected tracker/Plex delivery (Phase D Avatar Aang, 23 October).
  - [x] [Prerequisite review and bounded fan-out preparation](active/external-tracker-connections/step6c-fanout-prerequisites.md) (design only; no live calls or gate override).
  - [x] New offline truncated/ceiling persistence and episode-coverage disposition checks.
  - [x] Normal activation Phases A/B: user/event watched checks and safe rating integration (unit-tested).
  - [x] Phase C: Settings/onboarding copy and visible held/conflict rating explanations (unit-tested, delegated connected-screen and browser-fixture checks).
  - [x] Full build after concurrent changes: 1,989 tests pass (23 October).
  - [x] Live normal activation after quota/delta budget probe; Check now clean (23 October; Simkl connected).
  - [x] [Real Simkl ratings verification](active/external-tracker-connections/step6g-rating-verification.md): closed 23 Oct by decision: disposable-account movie/show set/clear, conditional reads and rating-drop review hold all passed.
  - [x] Production registration and natural device-code expiry.
  - [x] Live replacement-account isolation (automated generation fences pass). Closed 23 Oct by decision: hybrid live test accepted.
  - [x] Bounded real coverage/anime/special safety evidence accepted 24 October; native fallback and absence reconciliation remain disabled; real ceiling/silent-partial observations are follow-up.
  - [x] Deterministic 500/503/timeout handling through the real adapter/governor (injected evidence; actual outages are post-release).
  - Denial follows the documented pending/deadline contract; no distinct provider denial signal is documented. Natural token ageing remains post-release.
  - [x] [Complete auth-doc audit and read-only library candidate discovery](active/external-tracker-connections/step6d-auth-enquiry-and-fixture.md): dedicated guides answer auth questions; enquiry superseded; three Plex candidates found.
  - [x] Phase D restoration evidence reconciled; historical unrelated-intent row identity limitation accepted 24 October; original failed result and audit ledgers retained.
  - [x] [Release-gate evidence audit](active/external-tracker-connections/checks/release-gate-audit-2026-10-23.md), with optional/deferred work separated from release prerequisites.
- [x] [Step 6f: batched Simkl sends](active/external-tracker-connections/step6f-batched-simkl-send.md)
  - [x] Offline implementation, bounded requests, quota reserve and recovery tests.
  - [x] Fix offline-audited preflight reserve/repeated-failure gaps and preserve holds across restarts.
  - [x] Deliberate bulk manual/linked-backlog gathers: 100 items / 4 requests; 101 / 8, per-row outcomes; single watches unchanged (offline).
  - [x] Prove total live-test budget, including other Simkl traffic and cleanup.
  - [x] Full build after quota hardening and deliberate gather: 2,002 tests, 0 failures.
  - [x] Live two-movie batch delivery/restoration (23 October; Simkl stayed disabled).
- [x] [Step 6h: finish the remaining Simkl verification](active/external-tracker-connections/step6h-post-reset-verification.md) — core queue closed within accepted evidence limits.
  - [x] Offline Phase D evidence reconciled: fixture cleanup proven; historical unrelated-intent row identity gap remains explicit.
  - [x] Historical intent-preservation limitation accepted; exact manifests retained.
  - [x] Disposable-account live ratings and conditional-read verification accepted 23 October.
  - [x] Hybrid account isolation and bounded real coverage/identity accepted; deterministic failure proof passes.
  - [x] Bounded real multi-tracker import/date/deduplication check passes; original DB untouched; final build 2,172 tests passes.
- [x] [Step 7: Phase 2.5, add a tracker after first run](active/external-tracker-connections/step7-phase2-5-add-later.md)
  - [x] Simkl first-connection choice, durable progress, per-tracker date switch (unit-tested; subagent Settings check desktop/390px).
  - [x] Compare with Plekt and gating: read-only compare ran on your Trakt data; Simkl refused while gated (unit-tested; subagent API check).
  - [x] Older backlog is not sent silently to a newly added tracker (unit-tested).
  - [x] Small real Trakt full sync: Airplane! import already present; Ted sent and confirmed (23 October). Broader apply remains optional.
  - [x] Simkl compare on real data (23 October preview; no Simkl requests).
  - [x] Approved Simkl full sync ran (23 October): imports and confirmed sends completed; missing-progress episodes held for review (step 7a).
  - [x] Count accuracy for a real Fix Match renumbered show (fresh read-only Trakt check matches independent translated-coordinate counts, 22 October).
- [x] [Step 7a: item-by-item full sync preview, approve step and backup (visual OK; small Trakt apply done)](active/external-tracker-connections/step7a-full-sync-preview.md)
  - [x] Stored preview of every add, date update and removal, with skipped items and reasons; apply re-checks; backup first (offline/unit).
  - [x] Small live Trakt apply (Airplane! + Ted; Ted sent; Airplane already local).
  - [x] Real Simkl preview after activation (5,956 rows, built in 1.8s).
  - [x] Current saved 8,209-row Simkl preview rendered in connected Settings at 1280px/390px; screenshots and no-overflow checks pass, expired preview unchanged.
  - [x] Earlier saved 5,956-row fixture: desktop/390px DOM layout, expand/select and mocked date control pass; later connected checks above supersede its visual limitation.
  - [x] Send-side review hold for rated movies and shows without episode detail (unit-tested).
  - [x] Clean Simkl canary 3 after the earlier canary fixes (23 October).
  - [x] Simkl bulk apply: imports and confirmed sends completed; ~96 episodes rejected after missing-progress readback.
  - [x] Persistent review holds for audited missing-progress sends (implemented; focused tests pass).
  - [x] Restart and running-app API verification: held rows visible in Sync Attention and excluded from selectable sends.
  - [x] Date-preference switch at 390px persists after reload; original value restored and reload-verified.
  - [x] Synthetic 5,956-row preview at desktop/390px: no overflow; expand/select and mocked date-preference change pass (23 October).
  - Broader Trakt apply remains an optional future action, outside core completion.
  - [x] Preview panel on desktop and at 390px (Jason, 23 October).
- [x] [Step 8: Phase 3, pick trackers during first run](active/external-tracker-connections/step8-phase3-onboarding.md)
  - [x] State migration, provider grid, independent auth/import choices and shared wait (unit-tested; build passes).
  - [x] Local fixture checks for zero/one/two trackers, imports, review, options and restore; 390px DOM overflow check.
  - [x] Desktop 1440px and mobile 390px screenshot checks (Chrome fallback; no clipping, overlap or page overflow).
  - [x] Bounded real Trakt one-item + empty Simkl parallel imports complete; exact date/deduplication and source preservation pass. Full-account completion and actual media-server waiting are not claimed.
  - [x] Import & sync page includes Tautulli and Netflix (with Netflix plan step 2).
  - [x] Seerr onboarding is a separate skippable wizard step (Netflix plan step 2; Jason, 23 Oct).
- [x] [Step 8b: First-run initial outward sync](active/external-tracker-connections/step8b-initial-outward-sync.md)
  - [x] Writable destinations = trackers + media servers; skip outward sync when nothing to send (Jason, 23 Oct).
  - [x] Durable add-only outward coordinator, first-run consent, all-source barrier, pinned destinations, independent paced/batched sends and restart/restore holds (offline-tested).
  - [x] Chip above Sync/Idle plus Initial sync screen (per-destination remaining + item list); desktop/390px DOM and interaction checks pass; screenshots unavailable.
  - [x] Corrected live Simkl + Emby + Jellyfin canary: all three exact-date acknowledgements, job remaining 0, exact cleanup verified; first failed attempt retained. Simkl quota 450.
- [x] [Step 8c: Automatic multi-day Simkl full sync](active/external-tracker-connections/step8c-simkl-multiday-pacing.md)
  - [x] Durable selected-only continuation across resets/restarts, preserving normal-use and safety reserves (offline-tested).
  - [x] Large-library estimate and visible waiting/resume progress in Settings and Initial sync (desktop/390px DOM check passes).
  - [x] Simulated-reset failure/recovery checks and full build (2,203 tests pass).
  - [x] Desktop/390px UI checks of waiting, resume and cancel states (4 defects found, fixed and rechecked; DOM only, no screenshots).
  - [x] [One-movie paced canary harness](active/external-tracker-connections/checks/simkl-paced-canary-2026-10-24.md) built; 5 offline tests pass (no live calls).
  - [x] Live one-movie paced canary on disposable user 9159467 (24 October): run completed, exact date, cleanup verified; 18 Simkl calls. Real multi-day resets not live-tested.
- [ ] [Step 9: Deferred: watchlists, MyAnimeList and imports](active/external-tracker-connections/step9-deferred.md)
  - [ ] Review final request and sender, approve sending if desired, then obtain written eligibility/scope confirmation before implementation.
- [ ] [Step 10: Watchlist migration and streaming availability (merged in 16 October 2026; not started)](active/external-tracker-connections/step10-watchlist-migration-and-streaming.md)

## Where we are

Step 8c is complete. The paced Simkl worker passed its offline tests (2,207-test
build), the desktop/390px UI checks and, on 24 October, a live one-movie canary
through the production compare/start/runner path on the disposable account: the
run completed, Simkl held the exact date and cleanup left the account empty
(18 calls, quota 447 to 429). Real multi-day quota resets have not been
live-tested. Letterboxd has been dropped from planned work. Remaining deferred work is step 9 (watchlists, MyAnimeList and other imports) or step 10.

## Background and history

[Background and history](active/external-tracker-connections/history.md)

Last updated: 24 October 2026, 19:34
