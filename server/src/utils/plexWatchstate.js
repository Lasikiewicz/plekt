export const PLEX_WATCHED_ROLLBACK_GRACE_MS = 5 * 60 * 1000;

// Plex can briefly publish viewCount=0 immediately after scrobbling a live
// session while retaining the session's positive viewOffset. That combination
// is not a trustworthy manual unwatch when Plembfin either saw the matching
// session cross its configured threshold or only just accepted Plex's watched
// transition. The short transition grace covers threshold rounding at the
// credits boundary; a later deliberate unwatch remains authoritative.
export function shouldRepairRecentPlexUnwatch({
  playstate,
  viewOffset = 0,
  hasPlaybackEvidence = false,
  now = Date.now(),
} = {}) {
  const transitionAt = Number(playstate?.updated_at || 0);
  const transitionAge = Number(now) - transitionAt;
  const justMarkedWatched = transitionAt > 0
    && transitionAge >= 0
    && transitionAge <= PLEX_WATCHED_ROLLBACK_GRACE_MS;
  return playstate?.state === "watched"
    && Number(viewOffset || 0) > 0
    && (hasPlaybackEvidence === true || justMarkedWatched);
}

// A stored resume position that Plex itself either reported or was given. When
// Plex later reports the item with no position and no view, the user cleared
// it there. A position that only another server holds, and that Plex never
// received, says nothing about Plex.
export function providerHeldStoredResume(progress, provider) {
  if (!progress) return false;
  const name = String(provider || "").toLowerCase();
  if (String(progress.source || "").toLowerCase() === name) return true;
  return new RegExp(`Target ${name} progress status:\\s*(success|fulfilled)`, "i")
    .test(String(progress.sync_dispatch_telemetry || ""));
}

export function plexHeldStoredResume(progress) {
  return providerHeldStoredResume(progress, "plex");
}

// The same rule for an Emby or Jellyfin unplayed callback: no watch was ever
// recorded, but the server held a resume position (or a held watched flag is
// waiting for review), so its clear must reach the other servers.
export function embyLikeUnplayedIsPartWatchedClear(provider, { playstate, watchedRecord, progress, pendingReview } = {}) {
  // Old imported watch rows (a Trakt or Simkl history import, say) can sit under
  // an item whose canonical state is already unwatched. They are not a current
  // watch, so they must not keep a cleared position off the forced unwatch.
  const currentlyWatched = playstate?.state === "watched"
    || (playstate?.state !== "unwatched" && Boolean(watchedRecord));
  return !currentlyWatched
    && (Boolean(pendingReview) || providerHeldStoredResume(progress, provider));
}

// Plex also publishes an unplayed viewstate (viewCount 0, no viewOffset) when
// it adds a new item to the library. That is not an unwatch: there is nothing
// to undo. An unplayed notification is only a transition when Plembfin holds a
// watched playstate or a watched history row for the item, or, for a part
// watched item that was never fully watched, a resume position Plex held or a
// provider watched flag still waiting for review. The last two make a clear on
// a part watched item an unwatch too, so the other servers drop their resume
// position instead of pushing it back to Plex.
export function plexUnplayedHasWatchEvidence({ playstate, watchedRecord, progress, pendingReview } = {}) {
  return playstate?.state === "watched"
    || Boolean(watchedRecord)
    || Boolean(pendingReview)
    || plexHeldStoredResume(progress);
}

// True when the only evidence is a part watched position or a held flag, with
// no recorded watch. The local state may already read unwatched, so the unwatch
// has to be forced out to the other servers to clear their resume position.
export function plexUnplayedIsPartWatchedClear({ playstate, watchedRecord, progress, pendingReview } = {}) {
  return embyLikeUnplayedIsPartWatchedClear("plex", { playstate, watchedRecord, progress, pendingReview });
}
