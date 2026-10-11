import { batchInsertWatchRecords, getCachedHistory, mediaKeyFor } from "./dataRepo.js";
import { canonicalShowTitleKey } from "./dataRepo.js";
import { releaseDateForSourceItem } from "./watchDates.js";
import { TARGET_DECISIONS, watchTargetPolicy } from "./watchSyncPolicy.js";

export const TAUTULLI_SOURCE = "tautulli_import";
const TARGETS = ["plex", "emby", "jellyfin"];

function text(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value === undefined || value === null || value === "") return "";
  const raw = text(value);
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (numeric <= 0) return "";
    if (numeric > 100_000_000_000) return new Date(numeric).toISOString();
    if (numeric > 0) return new Date(numeric * 1000).toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function guidIds(...values) {
  const ids = {};
  for (const value of values) {
    const raw = decodeURIComponent(text(value));
    if (!raw) continue;
    const imdb = raw.match(/(?:imdb|com\.plexapp\.agents\.imdb)[/:]+(tt\d+)/i);
    const tmdb = raw.match(/(?:themoviedb|tmdb|com\.plexapp\.providers\.themoviedb)[/:]+(\d+)/i);
    const tvdb = raw.match(/(?:thetvdb|tvdb|com\.plexapp\.agents\.thetvdb)[/:]+(\d+)/i);
    if (imdb && !ids.imdb) ids.imdb = imdb[1];
    if (tmdb && !ids.tmdb) ids.tmdb = tmdb[1];
    if (tvdb && !ids.tvdb) ids.tvdb = tvdb[1];
  }
  return ids;
}

function rowIds(row = {}, mediaType = "") {
  const provider = row.provider_ids || row.providerIds || {};
  const ids = {
    imdb: text(row.imdb_id || row.imdb || row.imdbid || provider.imdb || provider.Imdb),
    tmdb: text(row.tmdb_id || row.tmdb || row.tmdbid || provider.tmdb || provider.Tmdb),
    tvdb: text(row.tvdb_id || row.tvdb || row.tvdbid || provider.tvdb || provider.Tvdb),
    ...guidIds(row.guid, row.parent_guid, row.grandparent_guid),
  };
  return Object.fromEntries(Object.entries(ids).filter(([, value]) => value));
}

function selectedUserValue(row = {}) {
  return text(row.user_id ?? row.userId ?? row.user);
}

function releaseFallback(row) {
  const year = text(row.year || row.parent_year || row.grandparent_year);
  return releaseDateForSourceItem({ ProductionYear: year, year }, "tautulli");
}

function dateWithinFromDate(value, fromDate) {
  if (!fromDate) return true;
  const date = new Date(value);
  const floor = new Date(`${String(fromDate).slice(0, 10)}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && !Number.isNaN(floor.getTime()) && date >= floor;
}

export function mapTautulliHistoryRow(row = {}, { userId = "", userName = "" } = {}) {
  const mediaType = text(row.media_type || row.mediaType || row.type).toLowerCase();
  if (!["movie", "episode"].includes(mediaType)) return { status: "rejected", reason: "unsupported_media_type" };
  if (String(row.watched_status ?? row.watchedStatus ?? "") !== "1") return { status: "skipped", reason: "incomplete" };
  if (text(userId) && selectedUserValue(row) !== text(userId)) return { status: "rejected", reason: "user_scope_mismatch" };

  const ids = rowIds(row, mediaType);
  const sourceTimestamp = timestamp(row.stopped) || timestamp(row.date) || "";
  const missingTimestamp = !sourceTimestamp;
  const watchedAt = sourceTimestamp || releaseFallback(row);
  if (!watchedAt) return { status: "rejected", reason: "missing_watch_date" };
  const title = text(mediaType === "episode"
    ? row.grandparent_title || row.show_title || row.grandparentTitle
    : row.title || row.full_title || row.movie_title);
  const season = mediaType === "episode" ? number(row.parent_media_index ?? row.parentMediaIndex ?? row.season) : null;
  const episode = mediaType === "episode" ? number(row.media_index ?? row.mediaIndex ?? row.episode) : null;
  if (!title || (mediaType === "episode" && (season === null || episode === null))) {
    return { status: "rejected", reason: "unresolved_identity" };
  }
  const episodeTitle = mediaType === "episode" ? text(row.title || row.episode_title) : "";
  const fullTitle = mediaType === "episode"
    ? `${title} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`
    : title;
  const percent = number(row.percent_complete);
  const itemId = text(row.row_id || row.rating_key || row.ratingKey);
  const provenance = {
    event: "history_import",
    phase: "tautulli",
    source: TAUTULLI_SOURCE,
    user: text(userName),
    item_id: itemId,
    source_timestamp: sourceTimestamp || watchedAt,
    ...(percent !== null ? { percent_complete: percent } : {}),
  };
  return {
    status: "ready",
    record: {
      title: fullTitle,
      show_title: mediaType === "episode" ? title : undefined,
      episode_title: episodeTitle || undefined,
      media_type: mediaType,
      watched_at: watchedAt,
      source: TAUTULLI_SOURCE,
      imdb_id: ids.imdb,
      tmdb_id: ids.tmdb,
      tvdb_id: ids.tvdb,
      season,
      episode,
      watch_provenance: provenance,
      sync_action: "watched",
      _tautulli_year: text(row.year || row.parent_year || row.grandparent_year),
      _tautulli_missing_timestamp: missingTimestamp,
    },
  };
}

function dayKey(value) {
  const raw = text(value);
  const isoDay = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoDay) return isoDay[1];
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function titleKey(value) {
  return text(value).toLowerCase().replace(/\s*\(\d{4}\)\s*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function titleYear(value) {
  const match = text(value).match(/\((\d{4})\)\s*$/);
  return match ? match[1] : "";
}

function providerIds(record) {
  return [record.imdb_id, record.tmdb_id, record.tvdb_id].filter(Boolean).map(String);
}

// Tautulli ids can be show-level (a show's IMDb guid on every episode), so a
// shared id alone let one episode's play match a different episode and be
// skipped as its duplicate. Two episodes that both carry coordinates must
// share them; a row missing either coordinate still matches on ids.
function episodeCoordinatesDiffer(record, existing) {
  if (record.media_type !== "episode") return false;
  const known = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  if (![record.season, record.episode, existing.season, existing.episode].every(known)) return false;
  return Number(existing.season) !== Number(record.season) || Number(existing.episode) !== Number(record.episode);
}

function identityMatches(record, existing) {
  if (!existing || existing.media_type !== record.media_type) return false;
  const sameDay = dayKey(existing.watched_at) === dayKey(record.watched_at);
  if (!sameDay && !record._tautulli_missing_timestamp) return false;
  if (episodeCoordinatesDiffer(record, existing)) return false;
  const incomingIds = providerIds(record);
  const existingIds = providerIds(existing);
  if (incomingIds.some((id) => existingIds.includes(id))) return true;
  if (record.media_type === "episode") {
    return Number(existing.season) === Number(record.season)
      && Number(existing.episode) === Number(record.episode)
      && canonicalShowTitleKey(existing.show_title || existing.title) === canonicalShowTitleKey(record.show_title || record.title);
  }
  if (titleKey(existing.title) !== titleKey(record.title)) return false;
  const incomingYear = text(record._tautulli_year) || titleYear(record.title);
  const existingYear = titleYear(existing.title);
  return !incomingYear || !existingYear || incomingYear === existingYear;
}

// A date Plembfin approximated rather than observed. The app writes these on a
// round clock hour (release-day and episode-timing anchoring, older manual
// backfills); a real playback timestamp lands on an exact hour about once in
// 3600 plays, so this is a reliable enough tell.
const APPROXIMATED_CLOCK_RE = /T\d{2}:00:00(?:\.0+)?Z?$/;

export function isApproximatedWatchDate(value) {
  return APPROXIMATED_CLOCK_RE.test(text(value));
}

const DAY_MS = 86_400_000;
// A real play landing within this many days of an approximated record is the
// same viewing, not a rewatch: the approximation was simply a day or two out.
export const APPROXIMATED_MERGE_WINDOW_DAYS = 2;
// Further out than that, two plays of the same item inside this window are
// genuinely ambiguous - a rewatch, or the same viewing dated differently - so
// they go to review rather than being guessed at in either direction.
export const REWATCH_REVIEW_WINDOW_DAYS = 31;

function dayGap(a, b) {
  const left = Date.parse(String(a || ""));
  const right = Date.parse(String(b || ""));
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Infinity;
  return Math.abs(left - right) / DAY_MS;
}

// identityMatches without the same-day gate: is this the same title/episode,
// whenever it was watched?
function identityMatchesIgnoringDate(record, existing) {
  if (!existing || existing.media_type !== record.media_type) return false;
  if (String(existing.sync_action || "watched").toLowerCase() !== "watched") return false;
  if (episodeCoordinatesDiffer(record, existing)) return false;
  const incomingIds = providerIds(record);
  const existingIds = providerIds(existing);
  if (incomingIds.some((id) => existingIds.includes(id))) return true;
  if (record.media_type === "episode") {
    return Number(existing.season) === Number(record.season)
      && Number(existing.episode) === Number(record.episode)
      && canonicalShowTitleKey(existing.show_title || existing.title) === canonicalShowTitleKey(record.show_title || record.title);
  }
  if (titleKey(existing.title) !== titleKey(record.title)) return false;
  const incomingYear = text(record._tautulli_year) || titleYear(record.title);
  const existingYear = titleYear(existing.title);
  return !incomingYear || !existingYear || incomingYear === existingYear;
}

// Same item as an existing history row, whatever its state or date. Episodes
// must also share season and episode, because Tautulli ids can be show-level.
function sameItemAnyState(record, existing) {
  if (!existing || existing.media_type !== record.media_type) return false;
  if (record.media_type === "episode") {
    if (Number(existing.season) !== Number(record.season) || Number(existing.episode) !== Number(record.episode)) return false;
    const incomingIds = providerIds(record);
    const existingIds = providerIds(existing);
    return incomingIds.some((id) => existingIds.includes(id))
      || canonicalShowTitleKey(existing.show_title || existing.title) === canonicalShowTitleKey(record.show_title || record.title);
  }
  const incomingIds = providerIds(record);
  const existingIds = providerIds(existing);
  if (incomingIds.some((id) => existingIds.includes(id))) return true;
  if (titleKey(existing.title) !== titleKey(record.title)) return false;
  const incomingYear = text(record._tautulli_year) || titleYear(record.title);
  const existingYear = titleYear(existing.title);
  return !incomingYear || !existingYear || incomingYear === existingYear;
}

// When the item was last unwatched, in epoch ms (0 if never). An unwatch row's
// created_at is when the user acted; its watched_at can be an older display
// date, so the later of the two is the unwatch time.
function newestUnwatchTime(index, record) {
  let newest = 0;
  for (const candidate of indexedCandidates(index, record)) {
    if (String(candidate.sync_action || "watched").toLowerCase() !== "unwatched") continue;
    if (!sameItemAnyState(record, candidate)) continue;
    const at = Math.max(Number(candidate.created_at) || 0, Date.parse(String(candidate.watched_at || "")) || 0);
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * The nearest already-watched record for this item that is NOT on the same
 * calendar day, within the rewatch window. Returns null when the play is
 * clearly standalone.
 */
function nearestOtherDayWatch(index, record) {
  let best = null;
  for (const candidate of indexedCandidates(index, record)) {
    if (!identityMatchesIgnoringDate(record, candidate)) continue;
    if (dayKey(candidate.watched_at) === dayKey(record.watched_at)) continue;
    const gap = dayGap(candidate.watched_at, record.watched_at);
    if (!Number.isFinite(gap) || gap > REWATCH_REVIEW_WINDOW_DAYS) continue;
    if (!best || gap < best.gap) best = { candidate, gap };
  }
  return best;
}

function addIndexValue(index, key, record) {
  if (!key) return;
  const bucket = index.get(key);
  if (bucket) bucket.push(record);
  else index.set(key, [record]);
}

function buildIdentityIndex(records = []) {
  const byProviderId = new Map();
  const byEpisode = new Map();
  const byMovieTitle = new Map();
  for (const record of records) {
    const mediaType = text(record.media_type).toLowerCase();
    for (const id of providerIds(record)) addIndexValue(byProviderId, `${mediaType}:${id}`, record);
    if (mediaType === "episode") {
      addIndexValue(
        byEpisode,
        `${canonicalShowTitleKey(record.show_title || record.title)}:${Number(record.season)}:${Number(record.episode)}`,
        record,
      );
    } else if (mediaType === "movie") {
      addIndexValue(byMovieTitle, titleKey(record.title), record);
    }
  }
  return { byProviderId, byEpisode, byMovieTitle };
}

function indexedCandidates(index, record) {
  const candidates = new Set();
  const mediaType = text(record.media_type).toLowerCase();
  for (const id of providerIds(record)) {
    for (const candidate of index.byProviderId.get(`${mediaType}:${id}`) || []) candidates.add(candidate);
  }
  if (mediaType === "episode") {
    const key = `${canonicalShowTitleKey(record.show_title || record.title)}:${Number(record.season)}:${Number(record.episode)}`;
    for (const candidate of index.byEpisode.get(key) || []) candidates.add(candidate);
  } else if (mediaType === "movie") {
    for (const candidate of index.byMovieTitle.get(titleKey(record.title)) || []) candidates.add(candidate);
  }
  return [...candidates];
}

/**
 * Two independent decisions, resolved in order, for each connected server:
 *
 *  1. did the user pick this target for *this* import? (operation-level)
 *  2. does the standing provider policy allow the write? (provider-level)
 *
 * Deselecting a target and having Plex's historical policy suppress it are
 * different answers and are reported as such. The policy can only ever remove
 * the historical Plex projection; Emby, Jellyfin, and Trakt keep receiving the
 * original Tautulli playback date either way.
 */
export function tautulliTargetPlan(selectedTargets = [], activeTargets = TARGETS) {
  const selected = new Set(selectedTargets.map((target) => text(target).toLowerCase()));
  return activeTargets.map((target) => {
    if (!selected.has(target)) {
      return { target, decision: "not_selected", detail: "Not selected for this Tautulli import" };
    }
    const policy = watchTargetPolicy({ target, intent: "import", state: "watched" });
    if (policy.decision !== TARGET_DECISIONS.SEND) {
      return { target, decision: policy.decision, detail: policy.detail };
    }
    return { target, decision: TARGET_DECISIONS.SEND, detail: "" };
  });
}

export function buildTautulliTelemetry(selectedTargets = [], activeTargets = TARGETS) {
  const plan = tautulliTargetPlan(selectedTargets, activeTargets);
  const eligible = plan.filter((entry) => entry.decision === TARGET_DECISIONS.SEND);
  const policySkipped = plan.filter((entry) => entry.decision === TARGET_DECISIONS.SKIPPED_BY_POLICY);
  const details = eligible.length
    ? `Historical Tautulli watch imported into Plekt;${eligible.map((entry) => entry.target).join(", ")} queued for outbound sync`
    : policySkipped.length
      ? "Historical Tautulli watch stored locally; every selected target was skipped by the historical sync policy"
      : "Historical Tautulli watch stored locally; no outbound targets were selected";
  const lines = [
    `Origin: ${TAUTULLI_SOURCE}`,
    "Loop-check: Pending",
    `Dispatch status: ${eligible.length ? "pending" : "skipped"}`,
    `Details: ${details}`,
    "Ingest path: historical_import",
    "Source event: history_import",
  ];
  for (const entry of plan) {
    lines.push(entry.decision === TARGET_DECISIONS.SEND
      ? `Target ${entry.target} status: pending`
      : `Target ${entry.target} status: skipped - ${entry.detail}`);
  }
  return lines.join("\n");
}

/**
 * Every connected server this import may project to. All of them are selected:
 * Plembfin is the source of truth, so its scheduled sync reconciles Emby and
 * Jellyfin with imported watches regardless, and they receive the original
 * playback date either way - offering a per-server opt-out would imply a choice
 * that does not exist.
 *
 * Plex is deliberately NOT turned off here just because Tautulli points at the
 * same Plex server. An already-watched Plex item is detected and reported as
 * `already_matching` instead (see markPlexPlayed), which is accurate rather than
 * a guess from the machine identifier, and the standing `Sync historical watched
 * items to Plex` setting is what actually decides whether Plex is written to.
 */
export function targetDefaults(config = {}) {
  const active = TARGETS.filter((target) => {
    const section = config[target] || {};
    return !section.disabled && Boolean(section.baseUrl && (target === "plex" ? section.token : section.apiKey) && (target === "plex" || section.userId));
  });
  return Object.fromEntries(active.map((target) => [target, true]));
}

/**
 * A content-derived key for one imported play, stable across preview and
 * commit. Review decisions are addressed by this rather than by array index:
 * the commit re-reads Tautulli, and a play added or pruned in between would
 * silently shift every index after it and apply a decision to the wrong record.
 */
export function tautulliReviewKey(record = {}) {
  return `${mediaKeyFor(record)}:${dayKey(record.watched_at)}`;
}

// Only the fields the review UI needs to tell two candidates apart. No raw
// history rows leave the server here.
function reviewCandidate(candidate = {}) {
  return {
    id: candidate.id || null,
    title: text(candidate.title),
    show_title: text(candidate.show_title) || undefined,
    media_type: text(candidate.media_type),
    season: candidate.season ?? null,
    episode: candidate.episode ?? null,
    watched_at: text(candidate.watched_at),
    source: text(candidate.source),
  };
}

const REVIEW_ACTIONS = new Set(["merge", "import", "skip"]);

// Incoming decisions are `{ [reviewKey]: { action, matchedId } }`. Anything
// unrecognized is dropped rather than guessed at, so a malformed payload leaves
// the record in review instead of importing or discarding it.
export function normalizeReviewDecisions(raw = {}) {
  const normalized = new Map();
  if (!raw || typeof raw !== "object") return normalized;
  for (const [key, value] of Object.entries(raw)) {
    const action = text(value?.action || value).toLowerCase();
    if (!REVIEW_ACTIONS.has(action)) continue;
    normalized.set(String(key), { action, matchedId: text(value?.matchedId) || null });
  }
  return normalized;
}

export async function prepareTautulliImport(rows = [], options = {}) {
  const history = options.history || await getCachedHistory();
  const activeTargets = options.activeTargets || TARGETS;
  const selectedTargets = Array.isArray(options.selectedTargets) ? options.selectedTargets : activeTargets;
  const reviewDecisions = options.reviewDecisions instanceof Map
    ? options.reviewDecisions
    : normalizeReviewDecisions(options.reviewDecisions);
  const mapped = [];
  const result = {
    total: rows.length,
    new: 0,
    merged: 0,
    skipped_incomplete: 0,
    unresolved: 0,
    rejected: 0,
    needs_review: 0,
    reviewed_merged: 0,
    reviewed_imported: 0,
    reviewed_skipped: 0,
    merged_approximate_date: 0,
    possible_rewatch: 0,
    skipped_newer_unwatch: 0,
    items: [],
    reviews: [],
  };
  const accepted = [];
  const identityIndex = buildIdentityIndex(history);
  const duplicateIndex = new Set();
  const reportProgress = async (completed) => {
    if (!options.onProgress || (completed % 25 !== 0 && completed !== rows.length)) return;
    options.onProgress({ phase: "preparing", completed, total: rows.length });
    await new Promise((resolve) => setImmediate(resolve));
  };
  for (const [index, row] of rows.entries()) {
    const mappedRow = mapTautulliHistoryRow(row, options);
    if (mappedRow.status === "skipped") {
      result.skipped_incomplete += 1;
      await reportProgress(index + 1);
      continue;
    }
    if (mappedRow.status !== "ready") {
      result.rejected += 1;
      if (["unresolved_identity", "missing_watch_date"].includes(mappedRow.reason)) result.unresolved += 1;
      result.items.push({ index, status: "rejected", reason: mappedRow.reason });
      await reportProgress(index + 1);
      continue;
    }
    const record = mappedRow.record;
    const candidates = indexedCandidates(identityIndex, record)
      .filter((candidate) => identityMatches(record, candidate));
    const uniqueCandidates = [...new Map(candidates.map((candidate) => [candidate.id || mediaKeyFor(candidate), candidate])).values()];
    const reviewKey = tautulliReviewKey(record);
    if (uniqueCandidates.length > 1) {
      const decision = reviewDecisions.get(reviewKey);
      // No decision yet: report the ambiguity with its candidates so an
      // administrator can resolve it, and import nothing.
      if (!decision) {
        result.needs_review += 1;
        result.items.push({ index, status: "needs_review", title: record.title, reason: "ambiguous_identity", reviewKey });
        result.reviews.push({
          reviewKey,
          index,
          title: record.title,
          show_title: record.show_title || undefined,
          media_type: record.media_type,
          season: record.season ?? null,
          episode: record.episode ?? null,
          watched_at: record.watched_at,
          candidates: uniqueCandidates.slice(0, 5).map(reviewCandidate),
          candidateCount: uniqueCandidates.length,
        });
        await reportProgress(index + 1);
        continue;
      }
      if (decision.action === "skip") {
        result.reviewed_skipped += 1;
        result.items.push({ index, status: "reviewed_skipped", title: record.title, reviewKey });
        await reportProgress(index + 1);
        continue;
      }
      if (decision.action === "merge") {
        result.reviewed_merged += 1;
        result.merged += 1;
        result.items.push({
          index,
          status: "reviewed_merged",
          title: record.title,
          reviewKey,
          matchedId: decision.matchedId
            || uniqueCandidates.find((candidate) => candidate.id === decision.matchedId)?.id
            || null,
        });
        await reportProgress(index + 1);
        continue;
      }
      // "import": the administrator says this is a genuinely separate play, so
      // fall through to the normal accept path below and count it as reviewed.
      result.reviewed_imported += 1;
    }
    if (uniqueCandidates.length === 1) {
      result.merged += 1;
      result.items.push({ index, status: "merged", title: record.title, matchedId: uniqueCandidates[0].id || null });
      await reportProgress(index + 1);
      continue;
    }
    // No same-day match. Before treating this as a brand-new play, check for a
    // nearby record of the same item: Plembfin holds a lot of approximated
    // dates, and a real Tautulli timestamp landing a day either side of one is
    // the same viewing rather than a rewatch.
    const near = nearestOtherDayWatch(identityIndex, record);
    if (near) {
      const approximated = isApproximatedWatchDate(near.candidate.watched_at);
      if (approximated && near.gap <= APPROXIMATED_MERGE_WINDOW_DAYS) {
        result.merged += 1;
        result.merged_approximate_date += 1;
        result.items.push({
          index,
          status: "merged_approximate_date",
          title: record.title,
          matchedId: near.candidate.id || null,
          matchedWatchedAt: near.candidate.watched_at,
        });
        await reportProgress(index + 1);
        continue;
      }

      // Genuinely ambiguous: the same item watched twice inside the rewatch
      // window. Neither answer is safe to guess, so it goes to review with the
      // same three resolutions an ambiguous identity gets.
      const decision = reviewDecisions.get(reviewKey);
      if (!decision) {
        result.needs_review += 1;
        result.possible_rewatch += 1;
        result.items.push({ index, status: "needs_review", title: record.title, reason: "possible_rewatch", reviewKey });
        result.reviews.push({
          reviewKey,
          index,
          reason: "possible_rewatch",
          title: record.title,
          show_title: record.show_title || undefined,
          media_type: record.media_type,
          season: record.season ?? null,
          episode: record.episode ?? null,
          watched_at: record.watched_at,
          gapDays: Math.round(near.gap * 10) / 10,
          candidates: [reviewCandidate(near.candidate)],
          candidateCount: 1,
        });
        await reportProgress(index + 1);
        continue;
      }
      if (decision.action === "skip") {
        result.reviewed_skipped += 1;
        result.items.push({ index, status: "reviewed_skipped", title: record.title, reviewKey });
        await reportProgress(index + 1);
        continue;
      }
      if (decision.action === "merge") {
        result.reviewed_merged += 1;
        result.merged += 1;
        result.items.push({
          index,
          status: "reviewed_merged",
          title: record.title,
          reviewKey,
          matchedId: decision.matchedId || near.candidate.id || null,
        });
        await reportProgress(index + 1);
        continue;
      }
      // "import": the administrator confirmed this is a separate rewatch.
      result.reviewed_imported += 1;
    }

    // The play's own timestamp decides: a play older than the item's newest
    // unwatch must not re-watch it. Importing it would write a watched
    // playstate newer than the unwatch and dispatch it to every server.
    const unwatchedAt = newestUnwatchTime(identityIndex, record);
    if (unwatchedAt && (Date.parse(record.watched_at) || 0) <= unwatchedAt) {
      result.skipped_newer_unwatch += 1;
      result.items.push({ index, status: "skipped_newer_unwatch", title: record.title, unwatchedAt: new Date(unwatchedAt).toISOString() });
      await reportProgress(index + 1);
      continue;
    }

    const duplicateKey = reviewKey;
    const duplicate = duplicateIndex.has(duplicateKey);
    if (duplicate) {
      result.merged += 1;
      result.items.push({ index, status: "merged", title: record.title, matchedId: null });
      await reportProgress(index + 1);
      continue;
    }
    accepted.push(record);
    duplicateIndex.add(duplicateKey);
    for (const id of providerIds(record)) addIndexValue(identityIndex.byProviderId, `${record.media_type}:${id}`, record);
    if (record.media_type === "episode") {
      addIndexValue(identityIndex.byEpisode, `${canonicalShowTitleKey(record.show_title || record.title)}:${Number(record.season)}:${Number(record.episode)}`, record);
    } else if (record.media_type === "movie") {
      addIndexValue(identityIndex.byMovieTitle, titleKey(record.title), record);
    }
    mapped.push(record);
    result.new += 1;
    result.items.push({ index, status: "new", title: record.title });
    await reportProgress(index + 1);
  }
  return {
    ...result,
    records: mapped,
    telemetry: buildTautulliTelemetry(selectedTargets, activeTargets),
    targetPlan: tautulliTargetPlan(selectedTargets, activeTargets),
  };
}

export async function commitTautulliImport(rows = [], options = {}) {
  const preview = await prepareTautulliImport(rows, options);
  const inserted = await batchInsertWatchRecords(preview.records, {
    source: TAUTULLI_SOURCE,
    prefetch: false,
    telemetryForRecord: () => preview.telemetry,
  });
  return { ...preview, inserted: inserted.inserted, skipped: inserted.skipped, rejectedRows: inserted.rejected };
}

export function filterTautulliRows(rows = [], { userId = "", fromDate = "" } = {}) {
  return rows.filter((row) => selectedUserValue(row) === text(userId) && dateWithinFromDate(timestamp(row.stopped) || timestamp(row.date) || releaseFallback(row), fromDate));
}
