// Shared watched-date/release-date helpers used by the scheduled sync engine
// (scheduled.js) and the force-sync planner (forceSyncPlanner.js).

export function localCalendarDay(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function dateOnlyIso(value = "") {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`).toISOString();
}

export function isoDateTime(value = "") {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function embyLikePlayedDate(item = {}) {
  return isoDateTime(
    item.UserData?.LastPlayedDate ||
      item.UserData?.PlayedDate ||
      item.UserData?.DatePlayed ||
      item.LastPlayedDate ||
      item.PlayedDate ||
      item.DatePlayed ||
      item.LastWatchedDate,
  );
}

export function isEmbyLikePlayed(item = {}) {
  const value = item.UserData?.Played ?? item.UserData?.IsPlayed ?? item.Played ?? item.IsPlayed;
  return value === true || value === "true" || value === 1 || value === "1";
}

// True when an item is flagged played but was never actually played through:
// marking an item watched over the API (which is what our own playstate sync
// does) leaves PlayCount at 0 and writes no played date. Emby reports these
// back to us on the next poll, so recognising them keeps our own writes from
// looking like watches with broken metadata.
export function isEmbyLikeApiMarked(item = {}) {
  if (embyLikePlayedDate(item)) return false;
  if (!isEmbyLikePlayed(item)) return false;
  // Require an explicit zero. A missing PlayCount means the server did not tell
  // us, which is not the same as telling us the item was never played - that
  // case stays a reportable "missing played date".
  const raw = item.UserData?.PlayCount ?? item.PlayCount;
  if (raw === undefined || raw === null || raw === "") return false;
  const count = Number(raw);
  return Number.isFinite(count) && count === 0;
}

// A played flag without a played timestamp is historical state, not evidence of
// a watch occurring during the current poll. Never manufacture a current-time
// watch date here: doing so turns an existing Emby library into a burst of new
// watch-history rows after a restore, rebuild, or first connection.
export function watchedAtForEmbyLikeItem(item = {}) {
  const playedAt = embyLikePlayedDate(item);
  if (playedAt) return { watchedAt: playedAt, reason: "played" };

  if (isEmbyLikePlayed(item)) {
    // Distinguish "we marked this" from "played but the server lost the date",
    // so only the latter is worth surfacing as a data gap.
    return { watchedAt: "", reason: isEmbyLikeApiMarked(item) ? "marked without playback" : "missing played date" };
  }

  return { watchedAt: "", reason: "" };
}

// Plex's viewed flag is historical state unless Plex supplies the actual view
// timestamp. A library refresh must never become a new watch at poll time.
export function watchedAtForPlexItem(item = {}) {
  const raw = item.lastViewedAt ?? item.viewedAt;
  if (raw === undefined || raw === null || raw === "") {
    return { watchedAt: "", reason: "missing viewed date" };
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) {
    return { watchedAt: new Date(seconds * 1000).toISOString(), reason: "viewed" };
  }

  const viewedAt = isoDateTime(raw);
  return viewedAt
    ? { watchedAt: viewedAt, reason: "viewed" }
    : { watchedAt: "", reason: "invalid viewed date" };
}

export function releaseDateForItem(item = {}) {
  return dateOnlyIso(
    item.PremiereDate ||
      item.OriginalReleaseDate ||
      item.originallyAvailableAt ||
      (item.ProductionYear ? `${item.ProductionYear}-01-01T00:00:00.000Z` : ""),
  );
}

export function releaseDateForPlexItem(item = {}) {
  return dateOnlyIso(
    item.originallyAvailableAt ||
      item.OriginallyAvailableAt ||
      (item.year ? `${item.year}-01-01T00:00:00.000Z` : ""),
  );
}

// A played flag raised by a library action is not playback evidence. When the
// source does not provide a trustworthy play timestamp, use the item's release
// day as the stable historical date rather than the time Plembfin happened to
// receive the flag (or the time somebody clicked "Mark watched").
export function releaseDateForSourceItem(item = {}, source = "") {
  return String(source || "").toLowerCase() === "plex"
    ? releaseDateForPlexItem(item)
    : releaseDateForItem(item);
}

// Plex's library-state notification reports that the watched flag is set, but
// it cannot distinguish a threshold-reaching playback from a manual "Mark
// watched" action. Only use Plex's viewed timestamp when the caller has
// independently confirmed playback; otherwise anchor the manual state to the
// item's release day instead of the click/notification time.
export function resolvePlexWatchDate(item = {}, { hasPlaybackEvidence = false } = {}) {
  const viewedAt = watchedAtForPlexItem(item).watchedAt;
  const releaseDate = releaseDateForPlexItem(item);
  if (hasPlaybackEvidence && viewedAt) {
    return { watchedAt: viewedAt, manualMark: false, sourceTimestamp: viewedAt, note: "" };
  }
  if (releaseDate) {
    return {
      watchedAt: releaseDate,
      manualMark: true,
      sourceTimestamp: "",
      note: "Plex reported a watched library flag without a recent threshold-reaching playback session; the release date was used instead of the manual mark time.",
    };
  }
  return {
    watchedAt: "",
    manualMark: true,
    sourceTimestamp: "",
    note: "Plex reported a watched library flag without a reliable playback timestamp or release date.",
  };
}

function normalizeShowKey(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .toLowerCase();
}

function showTitleForTiming(media = {}) {
  return media.showTitle
    || media.show_title
    || String(media.title || "").split(/\s+-\s+S\d{1,2}E\d{1,2}(?:\s+-\s+.*)?$/i)[0]
    || "";
}

function runtimeMinutesForTiming(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function timingSeparationMs(reference = {}, target = {}) {
  const runtimeMinutes = runtimeMinutesForTiming(
    reference.runtimeMinutes
      ?? reference.runtime_minutes
      ?? target.runtimeMinutes
      ?? target.runtime_minutes,
  );
  // Match the media-page date picker: one minute of breathing room is added
  // after a reference episode, and the same gap is subtracted before a later
  // reference episode. If runtime is unavailable, keep the same one-minute
  // fallback used by the page.
  return (runtimeMinutes * 60_000) + 60_000 || 60_000;
}

function validTimingRow(row = {}) {
  if (!row || String(row.sync_action || row.syncAction || "watched").toLowerCase() !== "watched") return false;
  const watchedAt = isoDateTime(row.watched_at || row.watchedAt);
  return Boolean(watchedAt);
}

/**
 * Find the same-season watched episode used by the media-page "before/after"
 * picker. The scanner has less metadata than the page, so runtime falls back
 * to the incoming provider item and then to a one-minute separation.
 */
export function episodeTimingWatchDate(media = {}, historyRows = [], fallbackDate = "") {
  if (String(media.type || media.media_type || "").toLowerCase() !== "episode") {
    return isoDateTime(fallbackDate) || "";
  }
  const season = Number(media.season);
  const episode = Number(media.episode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return isoDateTime(fallbackDate) || "";

  const targetShowKey = normalizeShowKey(showTitleForTiming(media));
  if (!targetShowKey) return isoDateTime(fallbackDate) || "";

  const candidates = (Array.isArray(historyRows) ? historyRows : [])
    .filter(validTimingRow)
    .filter((row) => Number(row.season) === season && Number(row.episode) !== episode)
    .filter((row) => normalizeShowKey(row.show_title || row.showTitle || row.title) === targetShowKey)
    .map((row) => ({ ...row, watchedAt: isoDateTime(row.watched_at || row.watchedAt) }))
    .filter((row) => row.watchedAt);

  const previous = candidates
    .filter((row) => Number(row.episode) < episode)
    .sort((a, b) => Number(b.episode) - Number(a.episode))[0];
  if (previous) {
    return new Date(Date.parse(previous.watchedAt) + timingSeparationMs(previous, media)).toISOString();
  }

  const next = candidates
    .filter((row) => Number(row.episode) > episode)
    .sort((a, b) => Number(a.episode) - Number(b.episode))[0];
  if (next) {
    return new Date(Date.parse(next.watchedAt) - timingSeparationMs(next, media)).toISOString();
  }

  return isoDateTime(fallbackDate) || "";
}

/**
 * Apply the configured policy to a provider watched snapshot. A real playback
 * timestamp is always trusted; the policy only decides what to do with a
 * manual/library flag that has no threshold-reaching playback evidence.
 */
export function resolveWatchImportDate({
  mode = "review",
  manualMark = false,
  sourceTimestamp = "",
  releaseDate = "",
  fallbackDate = "",
  media = {},
  historyRows = [],
  now = Date.now(),
} = {}) {
  const observedAt = isoDateTime(sourceTimestamp);
  const fallback = isoDateTime(fallbackDate);
  if (!manualMark && observedAt) {
    return { watchedAt: observedAt, previewWatchedAt: observedAt, requiresReview: false, reason: "source timestamp" };
  }

  const normalizedMode = ["now", "release_day", "episode_timing", "review"].includes(String(mode || "").toLowerCase())
    ? String(mode).toLowerCase()
    : "review";
  const release = dateOnlyIso(releaseDate);
  const nowIso = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now()).toISOString();
  if (normalizedMode === "review") {
    return {
      watchedAt: release || fallback || nowIso,
      previewWatchedAt: release || fallback || nowIso,
      requiresReview: true,
      reason: "manual flag requires review",
    };
  }
  if (normalizedMode === "release_day") {
    return {
      watchedAt: release || fallback || nowIso,
      previewWatchedAt: release || fallback || nowIso,
      requiresReview: false,
      reason: release ? "release day" : "release day unavailable; now used",
    };
  }
  if (normalizedMode === "episode_timing") {
    const timed = episodeTimingWatchDate(media, historyRows, release || fallback || nowIso);
    return {
      watchedAt: timed || release || fallback || nowIso,
      previewWatchedAt: timed || release || fallback || nowIso,
      requiresReview: false,
      reason: timed ? "episode timing" : "episode timing unavailable; now used",
    };
  }
  return { watchedAt: nowIso, previewWatchedAt: nowIso, requiresReview: false, reason: "now" };
}

export function runtimeMinutesForSourceItem(item = {}, source = "") {
  const normalizedSource = String(source || "").toLowerCase();
  if (normalizedSource === "plex") {
    const milliseconds = Number(item.durationMs ?? item.duration);
    return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds / 60_000 : 0;
  }
  const durationMs = Number(item.durationMs ?? item.Duration);
  if (Number.isFinite(durationMs) && durationMs > 0) return durationMs / 60_000;
  const ticks = Number(item.RunTimeTicks);
  if (Number.isFinite(ticks) && ticks > 0) return ticks / 600_000_000;
  const runtime = Number(item.RunTime ?? item.Runtime);
  return Number.isFinite(runtime) && runtime > 0 ? runtime : 0;
}
