import { buildAuthHeaders } from "./auth.js?v=2.0.0.3.6";
import { state, elements } from "./state.js?v=2.0.0.3.6";
import { escapeHtml, escapeAttribute, formatDate, slug, movieHref, movieTmdbHref, tvShowTmdbHref, tvShowTvdbHref, showTitleFrom, platformName, platformIconMarkup } from "./utils.js?v=2.0.0.3.6";
import { syncHistoryTone, syncHistoryActionLabel } from "./sync.js?v=2.0.0.3.6";

const REFRESH_MS = 15000;
const SEARCH_DEBOUNCE_MS = 180;
const ACTIVITY_PAGE_SIZE = 25;
const DEFAULT_PAGINATION = {
  page: 1,
  limit: ACTIVITY_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  from: 0,
  to: 0,
  hasPrevious: false,
  hasNext: false,
};

let refreshTimer = null;
let searchTimer = null;
let activityChangeRefreshTimer = null;
let loadRequestToken = 0;
let attentionRequestToken = 0;
let syncAttentionLoadPromise = null;
const retryingActivityIds = new Set();
// "Retry all failed" runs one item at a time rather than in parallel, so it
// doesn't fire a burst of simultaneous requests at Plex/Emby/Jellyfin/Trakt -
// this tracks progress through that queue for the header button's label.
let bulkRetryProgress = null;
// The retry-all worker owns the actual queue, but the page already discovers
// the same latest retryable ids before starting it. Keep that snapshot locally
// so the visible current-result rows can show which issues are waiting while
// the worker advances in the background (including across an SSE refresh).
let bulkRetryQueueIds = new Set();
// Keep the discovered group keys as well as the queued ids so a collapsed
// movie/show row can reflect the same waiting state as its event rows.
let bulkRetryQueueGroupKeys = new Map();
// Retry feedback is shown inline on the row it came from, not as a toast -
// keyed by activity id (not stored on the entry objects themselves) because
// state.syncActivity is replaced wholesale on every periodic refresh, which
// would otherwise wipe out feedback the moment the list reloads.
const activityFeedback = new Map();
let syncActivityActionStatus = null;
let syncActivityActionStatusTimer = null;
// A durable record of what happened when a row's retry was attempted, folded
// into that row's own log text (buildSyncActivityLog) so it survives closing
// and reopening the row, and shows up in a downloaded log too.
const activityNotes = new Map();
// The page stores only one row per media group. Event pages are fetched when
// a group is opened, so a large audit trail does not become a large browser
// payload. The cache also lets a refresh reopen the group without losing the
// reader's place.
const groupEventCache = new Map();
const groupEventLoading = new Set();
// Each expanded group starts in the actionable view (one newest result per
// movie/episode). Failed audit history is still available on demand and the
// selected view survives the page's periodic refresh.
const groupEventView = new Map();
// A show-wide Fix Match action retries the group's current failed entries in
// one server request. Keep a small local marker so the expanded group can
// disable competing item actions while that request is in flight.
const groupRetryProgress = new Map();

// Periodic refreshes replace the API snapshot even when nothing changed. Keep
// render keys so a quiet refresh does not replace DOM nodes the reader may be
// looking at (or reset native focus/selection state).
let lastActivityRowsKey = "";
let lastActivitySummaryKey = "";
let lastActivityPaginationKey = "";
let lastAttentionKey = "";
let lastTraktProgressKey = "";
let pausedProgressSnapshot = null;

function renderSnapshot(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function groupEventCacheKey(groupKey, latestOnly = true) {
  return `${String(groupKey || "")}\u0000${latestOnly ? "latest" : "history"}`;
}

function isLatestOnlyValue(value, fallback = true) {
  if (value == null || value === "") return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return ["1", "true", "latest", "current"].includes(String(value).trim().toLowerCase());
}

function groupShowsLatestOnly(groupKey) {
  // Current results are the actionable view. The full audit stream is an
  // explicit secondary view so an old failure cannot displace the item that
  // currently needs attention.
  return groupEventView.get(String(groupKey || "")) !== "history";
}

function clearGroupEventCache(groupKey) {
  const prefix = `${String(groupKey || "")}\u0000`;
  for (const key of groupEventCache.keys()) {
    if (key.startsWith(prefix)) groupEventCache.delete(key);
  }
}

function setActivityFeedback(id, feedback) {
  const key = String(id || "");
  if (!key) return;
  if (feedback) activityFeedback.set(key, feedback);
  else activityFeedback.delete(key);
}

function appendActivityNote(id, text) {
  const key = String(id || "");
  if (!key || !text) return;
  const list = activityNotes.get(key) || [];
  list.push({ timestamp: Date.now(), text });
  // Caps memory for a row that gets retried many times in one session - the
  // log only needs recent context, not an unbounded history.
  activityNotes.set(key, list.slice(-10));
}

function clearSyncActivityActionStatusTimer() {
  if (syncActivityActionStatusTimer) window.clearTimeout(syncActivityActionStatusTimer);
  syncActivityActionStatusTimer = null;
}

export function setSyncActivityActionStatus(text, tone = "muted", { duration = 0 } = {}) {
  clearSyncActivityActionStatusTimer();
  const message = String(text || "").trim();
  syncActivityActionStatus = message
    ? { text: message, tone: String(tone || "muted").trim().toLowerCase() || "muted" }
    : null;
  renderSyncActivityStatus();
  if (syncActivityActionStatus && Number(duration) > 0) {
    syncActivityActionStatusTimer = window.setTimeout(() => {
      syncActivityActionStatus = null;
      syncActivityActionStatusTimer = null;
      renderSyncActivityStatus();
    }, Number(duration));
  }
}

function authHeaders() {
  return buildAuthHeaders(state.token);
}

function normalizeAttentionTone(value, fallback = "warning") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["error", "critical", "blocking", "red", "failed", "attention"].includes(normalized)) return "error";
  if (["warning", "warn", "degraded", "amber"].includes(normalized)) return "warning";
  return fallback;
}

function attentionToneForItem(item = {}) {
  return normalizeAttentionTone(item.severity || item.tone, "warning");
}

function serverAttentionItems() {
  return Array.isArray(state.syncAttention) ? state.syncAttention : [];
}

function clientAttentionItems() {
  return Array.isArray(state.clientAttention) ? state.clientAttention : [];
}

function unresolvedMatchSamples() {
  const platforms = state.syncActivityMatchReport?.platforms || {};
  return Object.entries(platforms).flatMap(([platform, stats]) => (
    (Array.isArray(stats?.samples) ? stats.samples : []).map((sample) => ({
      ...sample,
      platform,
      platformLabel: platformName(platform),
    }))
  ));
}

function unresolvedMatchIssueCount() {
  const keys = new Set();
  for (const sample of unresolvedMatchSamples()) {
    const key = sample.id || sample.media_key || `${sample.media_type || ""}|${sample.title || ""}`;
    keys.add(`${key}|${sample.media_type || ""}`);
  }
  return keys.size;
}

function matchAttentionItem() {
  const samples = unresolvedMatchSamples();
  const issueCount = unresolvedMatchIssueCount();
  if (!issueCount) return null;
  const issueItems = samples.map((sample, index) => ({
    key: `match:${sample.platform}:${sample.id || sample.media_key || index}`,
    sourceRowId: String(sample.id || ""),
    title: sample.title || "Unknown title",
    sourceTitle: sample.title || "Unknown title",
    type: sample.media_type || "movie",
    provider: sample.platform,
    target: sample.platform,
    mediaKey: sample.media_key || "",
    showTitle: sample.show_title || "",
    season: sample.season ?? null,
    episode: sample.episode ?? null,
    watchedAt: sample.watched_at || "",
    reason: `${sample.platformLabel} could not find this item during sync.`,
  }));
  const platforms = [...new Set(samples.map((sample) => sample.platformLabel).filter(Boolean))].join(", ");
  return {
    id: "sync-match-report",
    source: "match_report",
    kind: "cross_platform_match_issues",
    severity: "error",
    summary: `${issueCount} unresolved media match${issueCount === 1 ? "" : "es"} found${platforms ? ` on ${platforms}` : ""}.`,
    context: { issueCount, issueItems, issueItemsComplete: true },
  };
}

function attentionItems() {
  const match = matchAttentionItem();
  return [...serverAttentionItems(), ...(match ? [match] : []), ...clientAttentionItems()];
}

function serverAttentionCount() {
  const count = Number(state.syncAttentionCount);
  return Number.isFinite(count) && count > 0 ? count : serverAttentionItems().length;
}

function currentActivityIssueCount() {
  const activityCount = Number(state.syncActivityCurrentIssueCount);
  const matchCount = Number(state.syncActivityMatchIssueCount);
  return (Number.isFinite(activityCount) && activityCount > 0 ? activityCount : 0)
    + (Number.isFinite(matchCount) && matchCount > 0 ? matchCount : 0);
}

function attentionCount() {
  const count = attentionItems().length;
  const attentionCheckFailed = state.syncAttentionError && !count ? 1 : 0;
  return count + attentionCheckFailed;
}

function attentionTone() {
  const items = attentionItems();
  if (state.syncAttentionError) return "error";
  if (items.some((item) => attentionToneForItem(item) === "error")) return "error";
  if (currentActivityIssueCount() > 0) return "error";
  if (items.length) return "warning";
  return state.syncAttentionSeverity === "error" ? "error" : "clear";
}

function syncAttentionNeeded() {
  return serverAttentionCount() > 0 || currentActivityIssueCount() > 0 || Boolean(state.syncAttentionError);
}

function statusText() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  if (total > 0 && completed < total) return `Sync - ${completed} of ${total}`;
  if (state.syncActivityProgress?.active) return `Sync - ${state.syncActivityProgress.label || "Working"}`;
  if (syncActivityActionStatus?.text) return `Sync - ${syncActivityActionStatus.text}`;
  if (syncAttentionNeeded()) return "Sync - Attention Needed";
  return "Sync - Idle";
}

function isActive() {
  const total = Number(state.syncActivityProgress?.total) || 0;
  const completed = Number(state.syncActivityProgress?.completed) || 0;
  return Boolean(state.syncActivityProgress?.active) || (total > 0 && completed < total);
}

// The shared `normalizePlatformSource` helper only knows about the three media
// servers and folds everything else into Plex, which would label a Trakt
// dispatch as Plex here. Sync activity names trackers as well as servers, so it
// resolves platforms itself.
const PLATFORMS = {
  plex: { name: "Plex", icon: "/icons/plex.svg?v=2.0.0.3.6" },
  emby: { name: "Emby", icon: "/icons/emby.svg?v=2.0.0.3.6" },
  jellyfin: { name: "Jellyfin", icon: "/icons/jellyfin.svg?v=2.0.0.3.6" },
  trakt: { name: "Trakt", icon: "/icons/trakt.svg?v=2.0.0.3.6" },
  plembfin: { name: "Plekt", icon: "" },
};

export function activityPlatform(value) {
  const key = String(value || "").trim().toLowerCase();
  if (key.includes("trakt")) return { key: "trakt", ...PLATFORMS.trakt };
  if (key.startsWith("emby")) return { key: "emby", ...PLATFORMS.emby };
  if (key.startsWith("jellyfin")) return { key: "jellyfin", ...PLATFORMS.jellyfin };
  if (key.startsWith("plex")) return { key: "plex", ...PLATFORMS.plex };
  if (key.startsWith("manual") || key.startsWith("force_sync") || key.startsWith("plembfin")) {
    return { key: "plembfin", ...PLATFORMS.plembfin };
  }
  return { key: "unknown", name: key ? key.charAt(0).toUpperCase() + key.slice(1) : "Unknown", icon: "" };
}

function platformIcon(platform, className = "sync-activity-icon") {
  if (platform.key === "plembfin") return platformIconMarkup("plembfin", className, "sync-activity-icon-set");
  if (!platform.icon) return "";
  return `<img class="${className}" src="${escapeAttribute(platform.icon)}" alt="${escapeAttribute(platform.name)}" loading="eager" decoding="async" />`;
}

export function targetResults(entry = {}, { failedOnly = false, showDetails = false, showSkipReasons = false } = {}) {
  const allTargets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  const targets = failedOnly
    ? allTargets.filter((target) => ["error", "failed"].includes(String(target.status || "").toLowerCase()))
    : allTargets;
  if (!targets.length) {
    const status = String(entry.status || "").toLowerCase();
    if (failedOnly) return `<span class="sync-activity-target sync-activity-target--empty" data-status="pending">No failed target response on this result</span>`;
    const noTargets = status === "skipped" || /no enabled sync destinations/i.test(entry.details || "");
    const label = status === "pending" ? "Waiting for dispatch" : noTargets ? "No eligible destinations" : "No target response recorded";
    return `<span class="sync-activity-target sync-activity-target--empty" data-status="pending">${label}</span>`;
  }
  return targets
    .map((target) => {
      const status = String(target.status || "unknown").toLowerCase();
      const tone = status === "success" ? "success" : ["error", "failed"].includes(status) ? "error" : "pending";
      const platform = activityPlatform(target.target);
      const recordedDetail = target.detail ? String(target.detail) : "";
      const showTargetDetail = showDetails || (showSkipReasons && status === "skipped");
      const detail = showTargetDetail
        ? recordedDetail || (status === "skipped" ? "No reason was recorded." : "")
        : recordedDetail;
      const label = `${platform.name} ${status}${detail ? ` - ${detail}` : ""}`;
      if (showTargetDetail) {
        return `<span class="sync-activity-target sync-activity-target--detailed" data-status="${tone}" title="${escapeAttribute(label)}"><span class="sync-activity-target-name">${platformIcon(platform)}<span>${escapeHtml(platform.name)}:</span></span><span class="sync-activity-target-status">${escapeHtml(status)}</span>${detail ? `<span class="sync-activity-target-detail">- ${escapeHtml(detail)}</span>` : ""}</span>`;
      }
      return `<span class="sync-activity-target" data-status="${tone}" title="${escapeAttribute(label)}">${platformIcon(platform)}<span>${escapeHtml(status)}</span></span>`;
    })
    .join("");
}

function routeTargetNames(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  const names = [];
  for (const target of targets) {
    const name = activityPlatform(target.target).name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// Where the title links to. A record that matches something already in the
// library resolves to its local page; otherwise the provider ids the dispatch
// carried address it directly, and a record with neither falls back to a search
// rather than a route that would resolve to nothing.
export function mediaHrefFor(entry = {}) {
  const isMovie = String(entry.mediaType || "").toLowerCase() === "movie";
  const ids = entry.rawPayloadDebug?.ids || {};
  const tmdbId = ids.tmdb ? String(ids.tmdb) : "";
  const tvdbId = ids.tvdb ? String(ids.tvdb) : "";
  const rawTitle = entry.title || "";

  if (isMovie) {
    const known = (state.history || []).find(
      (record) => String(record.media_type || record.type || "").toLowerCase() === "movie" && slug(record.title) === slug(rawTitle),
    ) || (state.moviesRaw || []).find((movie) => slug(movie.title) === slug(rawTitle));
    if (known) return movieHref(known);
    if (tmdbId) return movieTmdbHref(tmdbId, rawTitle);
    return `/search?q=${encodeURIComponent(rawTitle)}`;
  }

  const showTitle = showTitleFrom(rawTitle);
  const knownShow = (state.showsRaw || []).find((show) => (
    (tmdbId && String(show.tmdb_id || "") === tmdbId)
    || (tvdbId && String(show.tvdb_id || "") === tvdbId)
  )) || ((!tmdbId && !tvdbId) ? (state.showsRaw || []).find((show) => slug(show.title) === slug(showTitle)) : null);
  if (knownShow?.tmdb_id) return tvShowTmdbHref(knownShow.tmdb_id, knownShow.title);
  if (knownShow?.tvdb_id) return tvShowTvdbHref(knownShow.tvdb_id, knownShow.title);
  if (knownShow) return `/tvshow/${slug(knownShow.title)}`;
  if (tmdbId) return tvShowTmdbHref(tmdbId, showTitle);
  if (tvdbId) return tvShowTvdbHref(tvdbId, showTitle);
  return `/search?q=${encodeURIComponent(showTitle)}`;
}

// "Where the request came from and where it went": the source is the app that
// reported the play, the targets are the apps Plekt dispatched it to.
function routeLine(entry = {}) {
  const source = activityPlatform(entry.source).name;
  const targets = routeTargetNames(entry);
  const pending = String(entry.status || "").toLowerCase() === "pending";
  const to = targets.length ? targets.map((name) => escapeHtml(name)).join(", ") : pending ? "Awaiting dispatch" : "None recorded";
  return `
    <div class="sync-activity-row-route">
      <span class="sync-activity-route-leg"><span>Source</span><b>${escapeHtml(source)}</b></span>
      <span class="sync-activity-route-arrow" aria-hidden="true">-&gt;</span>
      <span class="sync-activity-route-leg"><span>Destinations</span><b>${to}</b></span>
    </div>
  `;
}

function traktMatchIssueMessage(entry = {}) {
  return isTraktNotFoundMatchIssue(entry)
    ? "Trakt could not find this show. Fix the show match and Plekt will retry this Trakt update automatically."
    : "";
}

export function hasRetryableActivityTarget(entry = {}) {
  return (entry.targetStates || []).some((target) => ["error", "failed"].includes(String(target.status || "").toLowerCase()));
}

export function isFailedSyncActivityEntry(entry = {}) {
  const status = String(entry.status || "").toLowerCase();
  return ["error", "failed"].includes(status)
    || (status === "partial" && hasRetryableActivityTarget(entry));
}

export function isRetryableActivity(entry = {}) {
  return entry.isLatestForItem !== false
    && isFailedSyncActivityEntry(entry)
    && hasRetryableActivityTarget(entry);
}

function activityTvdbId(entry = {}) {
  const ids = entry?.rawPayloadDebug?.ids || entry?.rawPayloadDebug?.media?.ids || {};
  return String(ids.tvdb || ids.tvdb_id || "").trim();
}

function activityCoordinate(entry = {}, field = "season") {
  const debug = entry?.rawPayloadDebug || {};
  const value = debug[field] ?? debug.media?.[field] ?? entry[field];
  const number = Number(value);
  return Number.isInteger(number) && number >= (field === "episode" ? 1 : 0) ? String(number) : "";
}

// Trakt's not_found response for an episode means the stored show identity
// did not resolve to a real Trakt series. That is a match problem, not a
// transient retry problem: offer the normal Fix Match flow only for the
// newest actionable episode result, where correcting the show can repair all
// of its stored episode identities in one operation.
export function isTraktNotFoundMatchIssue(entry = {}) {
  if (entry.isLatestForItem === false) return false;
  if (String(entry.mediaType || "").trim().toLowerCase() !== "episode") return false;
  return (entry.targetStates || []).some((target) => {
    const targetName = String(target?.target || "").trim().toLowerCase();
    const status = String(target?.status || "").trim().toLowerCase();
    const detail = `${target?.detail || ""} ${entry.details || ""}`;
    return targetName === "trakt"
      && ["error", "failed"].includes(status)
      && /not[_ -]?found/i.test(detail);
  });
}

function isAwaitingBulkRetryId(id) {
  const key = id != null ? String(id) : "";
  if (!bulkRetryProgress?.total || !key || !bulkRetryQueueIds.size || !bulkRetryQueueIds.has(key)) return false;
  if (bulkRetryProgress.completedIds?.has(key)) return false;
  // Older in-flight jobs may not have the structured activity id suffix in
  // their log lines. Fall back to the discovery order for those jobs so a
  // refreshed page still stops animating rows already past the checkpoint.
  if (!bulkRetryProgress.completedIds?.size && bulkRetryProgress.index > 0) {
    const position = [...bulkRetryQueueIds].indexOf(key);
    if (position >= 0 && position < bulkRetryProgress.index) return false;
  }
  return true;
}

function isAwaitingBulkRetry(entry = {}) {
  if (!isRetryableActivity(entry)) return false;
  return isAwaitingBulkRetryId(entry.id);
}

function feedbackHtml(id) {
  const feedback = activityFeedback.get(String(id || ""));
  if (!feedback) return "";
  return `<div class="sync-activity-row-feedback sync-activity-row-feedback--${escapeAttribute(feedback.tone || "muted")}" role="status">${escapeHtml(feedback.text)}</div>`;
}

function groupLatestEntry(group = {}) {
  return group?.latest && typeof group.latest === "object" ? group.latest : {};
}

function groupTone(group = {}) {
  const latest = groupLatestEntry(group);
  if (Number(group.problemCount || 0) > 0) return "error";
  if (Number(group.pendingCount || 0) > 0) return "pending";
  return syncHistoryTone(latest);
}

function isAwaitingBulkRetryGroup(group = {}) {
  if (!bulkRetryProgress?.total || Number(group.problemCount || 0) <= 0 || !bulkRetryQueueGroupKeys.size) return false;
  const groupKey = String(group.groupKey || groupLatestEntry(group).activityGroupKey || "");
  if (!groupKey) return false;
  for (const [id, candidateGroupKey] of bulkRetryQueueGroupKeys.entries()) {
    if (candidateGroupKey === groupKey && isAwaitingBulkRetryId(id)) return true;
  }
  return false;
}

function statusClassForTone(tone) {
  return tone === "error" ? "status-error" : tone === "pending" ? "status-warning" : "status-ready";
}

function pluralLabel(count, singular, plural = `${singular}s`) {
  const value = Number(count) || 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

function groupCurrentItemCount(group = {}) {
  const value = Number(group.currentItemCount);
  return Number.isFinite(value) ? Math.max(value, 0) : (Number(group.eventCount) || 0);
}

function groupSummaryLine(group = {}) {
  const latest = groupLatestEntry(group);
  const source = activityPlatform(latest.source);
  const auditCount = Number(group.eventCount) || groupCurrentItemCount(group);
  const pieces = [
    pluralLabel(auditCount, "audit record"),
    `latest ${formatDate(group.timestamp || latest.timestamp)}`,
    `${source.name} · ${syncHistoryActionLabel(latest)}`,
  ];
  if (Number(group.problemCount || 0) > 0) pieces.push(pluralLabel(group.problemCount, "issue"));
  return pieces.join(" · ");
}

function activityGroupTimestamp(group = {}) {
  const values = [group.timestamp, group.latest?.timestamp, group.latest?.createdAt]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : 0;
}

function activityGroupLatestId(group = {}) {
  const value = Number(group.latest?.id || group.latestId || group.latest_id || 0);
  return Number.isFinite(value) ? value : 0;
}

// The API already returns groups newest-first. Keep that contract explicit at
// the rendering boundary as well: a fresh result must become the first row,
// even if a proxy/cache or a future endpoint implementation returns groups in
// insertion order. The id tie-breaker is important when several sync writes
// share the same millisecond timestamp.
export function compareSyncActivityGroups(left = {}, right = {}) {
  const timestampDelta = activityGroupTimestamp(right) - activityGroupTimestamp(left);
  if (timestampDelta) return timestampDelta;
  const idDelta = activityGroupLatestId(right) - activityGroupLatestId(left);
  if (idDelta) return idDelta;
  return String(left.groupKey || "").localeCompare(String(right.groupKey || ""));
}

function currentActivityEntry(entry = {}) {
  return entry.isLatestForItem !== false;
}

function activityFailureTargets(entry = {}) {
  return (Array.isArray(entry.targetStates) ? entry.targetStates : [])
    .filter((target) => ["error", "failed"].includes(String(target?.status || "").trim().toLowerCase()));
}

function syncActivityEntryActionMarkup(entry = {}, groupKey = "") {
  const awaitingRetry = isAwaitingBulkRetry(entry);
  const id = entry.id != null ? String(entry.id) : "";
  const isEpisode = String(entry.mediaType || "").toLowerCase() === "episode";
  const showTitle = isEpisode ? showTitleFrom(entry.title || "") : "";
  const groupRetrying = groupRetryProgress.has(String(groupKey || entry.activityGroupKey || ""));
  const matchIssue = isTraktNotFoundMatchIssue(entry);
  const canFixMatch = Boolean(id && showTitle && !awaitingRetry && !groupRetrying && matchIssue);
  const canDismiss = Boolean(id && showTitle && !awaitingRetry && !groupRetrying && matchIssue);
  const retryable = !awaitingRetry && isRetryableActivity(entry);
  const canRetry = retryable && !matchIssue && !groupRetrying;
  return `
    ${canFixMatch ? `<button class="button-ghost sync-activity-fix-match" type="button" data-sync-activity-fix-match="${escapeAttribute(id)}" data-sync-activity-fix-match-title="${escapeAttribute(showTitle)}" data-sync-activity-fix-match-current-tvdb="${escapeAttribute(activityTvdbId(entry))}" data-sync-activity-fix-match-source-season="${escapeAttribute(activityCoordinate(entry, "season"))}" data-sync-activity-fix-match-source-episode="${escapeAttribute(activityCoordinate(entry, "episode"))}" title="Choose the Trakt show/season mapping, then retry the episode">Fix show match</button>` : ""}
    ${canDismiss ? `<button class="button-ghost sync-activity-dismiss" type="button" data-sync-activity-dismiss="${escapeAttribute(id)}" data-sync-activity-dismiss-title="${escapeAttribute(showTitle)}" title="Mark the Trakt not-found error as intentionally skipped">Dismiss Trakt error</button>` : ""}
    ${canRetry ? `<button class="button-ghost sync-activity-retry" type="button" data-sync-activity-retry="${escapeAttribute(id)}" ${retryingActivityIds.has(id) ? "disabled" : ""} title="Retry only the failed destinations">${retryingActivityIds.has(id) ? "Retrying..." : "Retry failed"}</button>` : ""}
  `;
}

function syncActivityCurrentResultRow(entry = {}) {
  const tone = isFailedSyncActivityEntry(entry) ? "error" : syncHistoryTone(entry);
  const statusClass = statusClassForTone(tone);
  const mediaType = String(entry.mediaType || "").toLowerCase();
  const eventLabel = mediaType === "episode" && entry.title
    ? `${syncHistoryActionLabel(entry)} · ${entry.title}`
    : syncHistoryActionLabel(entry);
  const status = isFailedSyncActivityEntry(entry) ? "Failed" : (entry.status || "unknown");
  return `
    <div class="sync-activity-current-result" data-status="${tone}">
      <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
      <strong>${escapeHtml(eventLabel)}</strong>
      <span class="sync-activity-inline-targets">${targetResults(entry, { showSkipReasons: true })}</span>
      <time class="sync-activity-current-result-time">${escapeHtml(formatDate(entry.timestamp))}</time>
      <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
    </div>
  `;
}

// Current issue cards deliberately use a different visual treatment from the
// audit rows below. A user should be able to see the item, every destination's
// response, and the matching action without opening a historical log.
export function syncActivityIssueMarkup(entry = {}, groupKey = "") {
  const title = entry.title || "Unknown media";
  const action = syncHistoryActionLabel(entry);
  const failureTargets = activityFailureTargets(entry);
  const primaryFailure = failureTargets[0];
  const primaryFailureDetail = String(primaryFailure?.detail || "").trim();
  const failureSummary = failureTargets.length === 1 && primaryFailureDetail
    ? `${activityPlatform(primaryFailure.target).name}: ${primaryFailureDetail}`
    : failureTargets.length
      ? `${failureTargets.map((target) => activityPlatform(target.target).name).join(", ")} reported a failure.`
      : "The sync failed before a destination response was recorded.";
  const matchIssue = isTraktNotFoundMatchIssue(entry);
  const explanation = matchIssue
    ? traktMatchIssueMessage(entry)
    : entry.details || "Review the destination responses below.";
  const actionMarkup = syncActivityEntryActionMarkup(entry, groupKey).trim();
  const mediaLink = `<button class="sync-activity-row-title sync-activity-current-issue-title" type="button" data-media-href="${escapeAttribute(mediaHrefFor(entry))}" title="Open ${escapeAttribute(title)}">${escapeHtml(title)}</button>`;
  return `
    <article class="sync-activity-current-issue${actionMarkup ? "" : " sync-activity-current-issue--no-actions"}" data-status="error" data-sync-activity-current-issue="${escapeAttribute(entry.id != null ? String(entry.id) : "")}">
      <div class="sync-activity-current-issue-header">
        <div class="sync-activity-current-issue-heading">
          <span class="sync-status-dot sync-status-dot--error" aria-hidden="true"></span>
          <strong>${escapeHtml(action)} Failed</strong>
          <span aria-hidden="true">·</span>
          ${mediaLink}
          <span aria-hidden="true">·</span>
          <time>${escapeHtml(formatDate(entry.timestamp))}</time>
        </div>
        <span class="status-pill status-error">Failed</span>
      </div>
      <div class="sync-activity-current-issue-body">
        <div class="sync-activity-current-issue-cause">
          <span>Issue</span>
          <span>${escapeHtml(failureSummary)}</span>
        </div>
        <div class="sync-activity-current-issue-results">
          <span class="sync-activity-current-issue-label">Destination responses</span>
          <div class="sync-activity-target-results--detailed">${targetResults(entry, { showDetails: true })}</div>
        </div>
        <p class="sync-activity-current-issue-explanation${matchIssue ? " sync-activity-row-detail--warning" : ""}">${escapeHtml(explanation)}</p>
      </div>
      ${actionMarkup ? `<div class="sync-activity-current-issue-actions" aria-label="Issue actions">
        <span class="sync-activity-current-issue-actions-label">Actions</span>
        <div class="sync-activity-current-issue-action-buttons">${actionMarkup}</div>
      </div>` : ""}
    </article>
  `;
}

function activityGroupRow(group = {}) {
  const latest = groupLatestEntry(group);
  const failedOnly = Boolean(state.syncActivityFailedOnly);
  const awaitingRetry = isAwaitingBulkRetryGroup(group);
  const tone = awaitingRetry ? "pending" : groupTone(group);
  const mediaType = String(group.mediaType || latest.mediaType || "").toLowerCase() === "movie" ? "Movie" : "Show";
  const statusClass = statusClassForTone(tone);
  const groupKey = String(group.groupKey || latest.activityGroupKey || "");
  const title = group.title || latest.title || "Unknown media";
  const awaitingClass = awaitingRetry ? " sync-activity-group-row--awaiting-retry" : "";
  const awaitingAttributes = awaitingRetry ? ' aria-busy="true"' : "";
  const currentCount = groupCurrentItemCount(group);
  const auditCount = Number(group.eventCount) || 0;
  const issueCount = Math.max(Number(group.problemCount) || 0, 0);
  const statusLabel = awaitingRetry ? "Awaiting retry" : issueCount > 0 ? "Failed" : (latest.status || "unknown");
  const latestIsIssue = isFailedSyncActivityEntry(latest);
  const showGroup = String(group.mediaType || latest.mediaType || "").trim().toLowerCase() === "show"
    || String(latest.mediaType || "").trim().toLowerCase() === "episode";
  const hasTraktMatchIssue = showGroup && issueCount > 0 && isTraktNotFoundMatchIssue(latest);
  const hasGroupTraktMatchAction = hasTraktMatchIssue && issueCount > 1;
  const groupRetry = groupRetryProgress.get(groupKey);
  const groupActionCount = Math.max(issueCount, 1);
  const actionLabel = showGroup ? "Show actions" : "Activity actions";
  const failedGroupHint = issueCount > 0 && !latestIsIssue
    ? `<span class="sync-activity-target sync-activity-target--empty sync-activity-group-failed-hint" data-status="error">Expand to review ${escapeHtml(pluralLabel(issueCount, "current item"))} with an issue.</span>`
    : "";
  const latestDetail = issueCount > 0 && !latestIsIssue
    ? `Current issues are shown above the failed audit history when this group is expanded.`
    : hasTraktMatchIssue
      ? traktMatchIssueMessage(latest)
      : latest.details || "";
  const groupActions = `
    <div class="sync-activity-group-actions" aria-label="${actionLabel}">
      <span class="sync-activity-group-actions-label">${actionLabel}</span>
      <div class="sync-activity-group-action-buttons">
        ${hasGroupTraktMatchAction ? `
          <button class="button-ghost sync-activity-fix-show" type="button"
            data-sync-activity-fix-show="${escapeAttribute(groupKey)}"
            data-sync-activity-fix-show-title="${escapeAttribute(title)}"
            data-sync-activity-fix-show-current-tvdb="${escapeAttribute(activityTvdbId(latest))}"
            data-sync-activity-fix-show-source-season="${escapeAttribute(activityCoordinate(latest, "season"))}"
            ${groupRetry ? "disabled" : ""}
            title="Fix the show match, then retry every current failed entry in this show">
            ${groupRetry ? `Retrying ${escapeHtml(pluralLabel(groupActionCount, "entry"))}...` : "Fix show match &amp; retry all"}
          </button>
          <button class="button-ghost sync-activity-dismiss-show" type="button"
            data-sync-activity-dismiss-show="${escapeAttribute(groupKey)}"
            data-sync-activity-dismiss-show-title="${escapeAttribute(title)}"
            data-sync-activity-dismiss-show-count="${groupActionCount}"
            ${groupRetry ? "disabled" : ""}
            title="Dismiss every Trakt not-found error in this show">
            Dismiss Trakt errors (${groupActionCount})
          </button>
        ` : ""}
        <button class="button-ghost sync-activity-download" type="button" data-sync-activity-download="${escapeAttribute(groupKey)}" title="Download every event for this media">Download all logs</button>
      </div>
    </div>
  `;
  return `
    <article class="sync-activity-row sync-activity-group-row${awaitingClass}" data-tone="${tone}" data-activity-group-key="${escapeAttribute(groupKey)}" role="button" tabindex="0" aria-expanded="false" title="Open current results and failed audit history for ${escapeAttribute(title)}"${awaitingAttributes}>
      <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
      <div class="sync-activity-group-main">
        <div class="sync-activity-group-heading">
          <button class="sync-activity-row-title sync-activity-group-title" type="button" data-media-href="${escapeAttribute(mediaHrefFor(latest))}" title="Open ${escapeAttribute(title)}">${escapeHtml(title)}</button>
          <span class="sync-activity-inline-targets">${failedGroupHint || targetResults(latest, { failedOnly })}</span>
          <span class="sync-activity-type">${escapeHtml(mediaType)}</span>
        </div>
        <div class="sync-activity-group-summary">${escapeHtml(groupSummaryLine(group))}</div>
        ${routeLine(latest)}
        ${latestDetail ? `<div class="sync-activity-row-detail sync-activity-group-latest-detail${issueCount > 0 ? " sync-activity-row-detail--warning" : ""}">${escapeHtml(latestDetail)}</div>` : ""}
      </div>
      ${groupActions}
      <div class="sync-activity-group-outcome">
        <div class="sync-activity-outcome-heading">
          <span>${awaitingRetry ? "Retry status" : issueCount > 0 ? "Current issue status" : "Latest result"}</span>
          <span class="status-pill ${statusClass} sync-activity-row-status">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="sync-activity-group-counts">
          <div class="sync-activity-group-count-labels">
            <span>${escapeHtml(pluralLabel(auditCount || currentCount, "audit record"))}</span>
            ${Number(group.problemCount || 0) > 0 ? `<span class="sync-activity-group-issue-count">${escapeHtml(pluralLabel(group.problemCount, "issue"))}</span>` : ""}
          </div>
        </div>
      </div>
      <div class="sync-activity-group-detail hidden" data-sync-activity-group-detail></div>
    </article>
  `;
}

function syncActivityEventRow(entry = {}, index = 0, groupKey = "", { open = index === 0 } = {}) {
  const awaitingRetry = isAwaitingBulkRetry(entry);
  const historicalIssue = entry.isLatestForItem === false && isFailedSyncActivityEntry(entry);
  const tone = awaitingRetry ? "pending" : historicalIssue ? "ready" : isFailedSyncActivityEntry(entry) ? "error" : syncHistoryTone(entry);
  const source = activityPlatform(entry.source);
  const statusClass = statusClassForTone(tone);
  const id = entry.id != null ? String(entry.id) : "";
  const isEpisode = String(entry.mediaType || "").toLowerCase() === "episode";
  const eventLabel = isEpisode && entry.title ? `${syncHistoryActionLabel(entry)} · ${entry.title}` : syncHistoryActionLabel(entry);
  const displayStatus = awaitingRetry ? "Awaiting retry" : historicalIssue ? "historical" : (entry.status || "unknown");
  return `
    <details class="sync-activity-event${awaitingRetry ? " sync-activity-event--awaiting-retry" : ""}" ${open ? "open" : ""}>
      <summary>
        <span class="sync-status-dot sync-status-dot--${tone}" aria-hidden="true"></span>
        <strong>${escapeHtml(eventLabel)}</strong>
        <span class="sync-activity-inline-targets">${targetResults(entry, { failedOnly: Boolean(state.syncActivityFailedOnly) })}</span>
        <span class="sync-activity-event-source">${platformIcon(source)}${escapeHtml(source.name)}</span>
        <span class="sync-activity-event-time">${escapeHtml(formatDate(entry.timestamp))}</span>
        <span class="status-pill ${statusClass}">${escapeHtml(displayStatus)}</span>
      </summary>
      <div class="sync-activity-event-body">
        ${routeLine(entry)}
        ${traktMatchIssueMessage(entry)
          ? `<div class="sync-activity-row-detail sync-activity-row-detail--warning">${escapeHtml(traktMatchIssueMessage(entry))}</div>`
          : entry.details ? `<div class="sync-activity-row-detail">${escapeHtml(entry.details)}</div>` : ""}
        ${historicalIssue ? `<div class="sync-activity-row-detail sync-activity-row-detail--muted">Older result for this item; only the newest result is actionable.</div>` : ""}
        ${awaitingRetry ? `<div class="sync-activity-row-detail sync-activity-row-detail--awaiting-retry" role="status">Awaiting retry — Retry all failed is working through the queue.</div>` : ""}
        <div class="sync-activity-row-actions">
          ${syncActivityEntryActionMarkup(entry, groupKey)}
        </div>
        ${feedbackHtml(id)}
        <pre class="sync-activity-log">${escapeHtml(buildSyncActivityLog(entry))}</pre>
      </div>
    </details>
  `;
}

function renderGroupEvents(groupKey, payload, container) {
  if (!container) return;
  const loadedEvents = Array.isArray(payload?.events) ? payload.events : [];
  const failedOnly = Boolean(state.syncActivityFailedOnly);
  const group = payload?.group || {};
  const pagination = payload?.pagination || {};
  const latestOnly = isLatestOnlyValue(payload?.latestOnly, true);
  const currentEvents = loadedEvents.filter(currentActivityEntry);
  const currentIssueEvents = currentEvents.filter(isFailedSyncActivityEntry);
  const currentCleanEvents = currentEvents.filter((entry) => !isFailedSyncActivityEntry(entry));
  const historicalFailureEvents = latestOnly
    ? []
    : loadedEvents.filter((entry) => !currentActivityEntry(entry) && isFailedSyncActivityEntry(entry));
  const issueCount = Math.max(Number(group.problemCount) || 0, currentIssueEvents.length);
  const currentResultCount = currentEvents.length || Math.max(Number(group.currentItemCount) || 0, 0);
  const skippedDestinationCount = currentEvents.reduce((count, entry) => count + (Array.isArray(entry.targetStates)
    ? entry.targetStates.filter((target) => String(target?.status || "").toLowerCase() === "skipped").length
    : 0), 0);
  const olderButton = pagination.hasNext
    ? `<button class="button-ghost sync-activity-group-more" type="button" data-sync-activity-group-more="${escapeAttribute(groupKey)}" data-sync-activity-group-page="${Number(pagination.page || 1) + 1}" data-sync-activity-group-latest-only="0">Load older failed audit records</button>`
    : "";
  const currentMarkup = currentIssueEvents.length
    ? `
      <section class="sync-activity-current-issues" aria-label="Current sync issues">
        <div class="sync-activity-current-section-heading">
          <b>Current issues</b>
          <span>${escapeHtml(pluralLabel(issueCount, "item"))} need attention</span>
        </div>
        <div class="sync-activity-current-issue-list">
          ${currentIssueEvents.map((entry) => syncActivityIssueMarkup(entry, groupKey)).join("")}
        </div>
        ${!failedOnly && currentCleanEvents.length ? `
          <details class="sync-activity-current-other-results">
            <summary><b>Other current results</b><span>${escapeHtml(pluralLabel(currentCleanEvents.length, "successful or pending item"))}</span></summary>
            <div class="sync-activity-current-result-list">${currentCleanEvents.map(syncActivityCurrentResultRow).join("")}</div>
          </details>
        ` : ""}
      </section>
    `
    : `
      <section class="sync-activity-current-results" aria-label="Current sync results">
        <div class="sync-activity-current-section-heading">
          <b>Current results</b>
          <span>${escapeHtml(pluralLabel(currentResultCount, "item"))} · ${skippedDestinationCount
            ? escapeHtml(pluralLabel(skippedDestinationCount, "skipped destination"))
            : "no current issues"}</span>
        </div>
        <div class="sync-activity-current-result-list">
          ${currentEvents.length ? currentEvents.map(syncActivityCurrentResultRow).join("") : `<div class="empty-log"><b>No current results</b><span>Refresh the page and try again.</span></div>`}
        </div>
      </section>
    `;
  const historySummary = latestOnly
    ? "Older failures are hidden until opened"
    : `${pluralLabel(historicalFailureEvents.length, "failed audit record")} shown${pagination.hasNext ? " · more records available" : ""}`;
  const historyMarkup = `
    <details class="sync-activity-history-disclosure"${latestOnly ? "" : " open"}>
      <summary data-sync-activity-group-key="${escapeAttribute(groupKey)}" data-sync-activity-group-view="${latestOnly ? "history" : "latest"}">
        <b>${latestOnly ? "Failed audit history" : "Hide failed audit history"}</b>
        <span>${escapeHtml(historySummary)}</span>
      </summary>
      <div class="sync-activity-history-body">
        ${latestOnly
          ? `<div class="sync-activity-history-placeholder"><b>Failed audit history</b><span>Open this section to inspect older failed sync attempts. Current issues stay listed above.</span></div>`
          : historicalFailureEvents.length
            ? `<div class="sync-activity-event-list">${historicalFailureEvents.map((entry, index) => syncActivityEventRow(entry, index, groupKey, { open: false })).join("")}</div>${olderButton}`
            : `<div class="empty-log"><b>No failed audit history</b><span>The issue above is the only failed result recorded for this item.</span></div>${olderButton}`}
      </div>
    </details>
  `;
  container.innerHTML = `
    ${currentMarkup}
    ${historyMarkup}
  `;
}

// The actual retry call plus outcome-recording, shared by the single-row
// button and the bulk retry loop below. Never throws - every outcome,
// including a network failure, is recorded via feedback/notes and returned
// instead. Deliberately does not touch retryingActivityIds or reload the
// list - callers own that, since the bulk path needs different bookkeeping
// (no per-item full-list reload) than a single click does.
async function dispatchRetry(key, identity = {}) {
  try {
    const payload = { id: key };
    const tvdbId = String(identity?.tvdbId || identity?.tvdb_id || "").trim();
    const showTitle = String(identity?.showTitle || identity?.show_title || "").trim();
    if (tvdbId) payload.tvdbId = tvdbId;
    if (showTitle) payload.showTitle = showTitle;
    const traktTmdbId = String(identity?.traktTmdbId || identity?.trakt_tmdb_id || "").trim();
    if (traktTmdbId) {
      payload.traktTmdbId = traktTmdbId;
      payload.traktSourceSeason = Number(identity.traktSourceSeason ?? identity.trakt_source_season);
      payload.traktTargetSeason = Number(identity.traktTargetSeason ?? identity.trakt_target_season ?? 1);
    }
    const response = await fetch("/api/sync-history/retry", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok && response.status === 409 && body.code === "SYNC_ACTIVITY_SUPERSEDED") {
      const text = body.error || "A newer sync result already exists for this item. The activity list was refreshed.";
      setActivityFeedback(key, { text, tone: "muted" });
      appendActivityNote(key, text);
      return { status: "skipped", details: text };
    }
    if (!response.ok) throw new Error(body.error || `Retry failed with ${response.status}`);
    const text = body.status === "success"
      ? "Retry completed."
      : body.status === "skipped"
        ? (body.details || "Nothing to retry - no destination is currently configured for this item.")
        : `Retry finished: ${body.status}.`;
    setActivityFeedback(key, { text, tone: body.status === "success" ? "success" : "warning" });
    appendActivityNote(key, text);
    return body;
  } catch (error) {
    const text = error.message || "Sync retry failed.";
    setActivityFeedback(key, { text, tone: "error" });
    appendActivityNote(key, text);
    return { status: "error", details: text };
  }
}

// Feedback is shown inline on the row (feedbackHtml) and folded into that
// row's own log (buildSyncActivityLog) rather than as a toast, so it stays
// attached to the item it's about instead of a corner notification the user
// has to catch before it disappears.
export async function retrySyncActivity(id, identity = {}) {
  const key = String(id || "");
  if (!key || retryingActivityIds.has(key)) return null;

  retryingActivityIds.add(key);
  const retryLabel = identity?.traktTmdbId || identity?.trakt_tmdb_id ? "Trakt update" : "Sync retry";
  setSyncActivityActionStatus(`Retrying ${retryLabel.toLowerCase()}…`, "pending");
  setActivityFeedback(key, null);
  renderSyncActivity();
  try {
    const result = await dispatchRetry(key, identity);
    for (const [cacheKey, cached] of groupEventCache.entries()) {
      if ((cached.events || []).some((entry) => String(entry.id) === key)) groupEventCache.delete(cacheKey);
    }
    await loadSyncActivity({ force: true, page: 1 });
    if (result?.status === "success") {
      setSyncActivityActionStatus(`${retryLabel} complete · no current failures`, "success", { duration: 8000 });
    } else if (result?.status === "skipped") {
      setSyncActivityActionStatus(`${retryLabel} skipped · ${result.details || "no destination is configured"}`, "warning", { duration: 10000 });
    } else {
      setSyncActivityActionStatus(`${retryLabel} needs attention · ${result?.details || "the failure remains"}`, "warning", { duration: 10000 });
    }
    return result;
  } catch (error) {
    setSyncActivityActionStatus(`${retryLabel} failed · ${error.message || String(error)}`, "error", { duration: 10000 });
    throw error;
  } finally {
    retryingActivityIds.delete(key);
    renderSyncActivity();
  }
}

export async function dismissSyncActivity(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const response = await fetch("/api/sync-history/dismiss", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: key }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Dismiss failed with ${response.status}`);

  setActivityFeedback(key, { text: body.details || "Trakt error dismissed.", tone: "muted" });
  appendActivityNote(key, body.details || "Trakt error dismissed.");
  for (const [cacheKey, cached] of groupEventCache.entries()) {
    if ((cached.events || []).some((entry) => String(entry.id) === key)) groupEventCache.delete(cacheKey);
  }
  await loadSyncActivity({ force: true, page: 1 });
  return body;
}

export async function dismissSyncActivityGroup(groupKey) {
  const key = String(groupKey || "").trim();
  if (!key) return null;
  let cached = groupEventCache.get(groupEventCacheKey(key, true));
  if (!cached) {
    cached = await loadActivityGroupPage(key, { force: true, latestOnly: true });
  }
  const ids = (cached?.events || [])
    .filter(isTraktNotFoundMatchIssue)
    .map((entry) => String(entry.id || "").trim())
    .filter(Boolean);
  if (!ids.length) return { ok: true, dismissed: 0, failed: 0, results: [] };

  const response = await fetch("/api/sync-history/dismiss", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ids, scope: "show" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Dismiss failed with ${response.status}`);
  clearGroupEventCache(key);
  await loadSyncActivity({ force: true, page: 1 });
  return body;
}

export async function retrySyncActivityGroup(groupKey, identity = {}) {
  const key = String(groupKey || "").trim();
  if (!key || groupRetryProgress.has(key)) return null;
  setSyncActivityActionStatus("Retrying the show update…", "pending");
  const payload = { groupKey: key };
  const tvdbId = String(identity?.tvdbId || identity?.tvdb_id || "").trim();
  const showTitle = String(identity?.showTitle || identity?.show_title || "").trim();
  if (tvdbId) payload.tvdbId = tvdbId;
  if (showTitle) payload.showTitle = showTitle;
  const traktTmdbId = String(identity?.traktTmdbId || identity?.trakt_tmdb_id || "").trim();
  if (traktTmdbId) {
    payload.traktTmdbId = traktTmdbId;
    payload.traktSourceSeason = Number(identity.traktSourceSeason ?? identity.trakt_source_season);
    payload.traktTargetSeason = Number(identity.traktTargetSeason ?? identity.trakt_target_season ?? 1);
  }
  const cached = groupEventCache.get(groupEventCacheKey(key, true));
  const retryableCount = (cached?.events || []).filter(isRetryableActivity).length
    || Math.max(Number(cached?.group?.problemCount) || 0, 0);
  groupRetryProgress.set(key, { total: retryableCount });
  renderSyncActivity();
  try {
    const response = await fetch("/api/sync-history/retry-group", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Show retry failed with ${response.status}`);
    clearGroupEventCache(key);
    await loadSyncActivity({ force: true, page: 1 });
    const remaining = Number(body.stillFailed || 0) + Number(body.errored || 0);
    setSyncActivityActionStatus(
      remaining > 0
        ? `Show retry needs attention · ${remaining} current issue${remaining === 1 ? "" : "s"} remain`
        : "Show retry complete · no current failures",
      remaining > 0 ? "warning" : "success",
      { duration: remaining > 0 ? 10000 : 8000 },
    );
    return body;
  } catch (error) {
    setSyncActivityActionStatus(`Show retry failed · ${error.message || String(error)}`, "error", { duration: 10000 });
    throw error;
  } finally {
    groupRetryProgress.delete(key);
    renderSyncActivity();
  }
}

// Walks every page of /api/sync-history (not just what's currently loaded/
// displayed) collecting every retryable entry's id, so "retry all failed"
// covers the whole library rather than only the ~25 rows on screen. Uses the
// server's own 200-row page cap to keep this to a handful of requests even
// for a few thousand entries.
export async function fetchAllRetryableSyncActivityIds() {
  const latestByItem = new Map();
  bulkRetryQueueGroupKeys = new Map();
  const search = (state.syncActivitySearch || "").trim();
  const limit = 200;
  let page = 1;
  for (;;) {
    const url = new URL("/api/sync-history", window.location.origin);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    if (!response.ok) break;
    const body = await response.json().catch(() => null);
    const history = Array.isArray(body?.history) ? body.history : [];
    for (const entry of history) {
      const itemKey = String(entry.activityItemKey || "").trim()
        || `${String(entry.mediaType || "unknown").toLowerCase()}|${String(entry.title || "").trim().toLowerCase()}|${String(entry.rawPayloadDebug?.season ?? "")}|${String(entry.rawPayloadDebug?.episode ?? "")}`;
      const current = latestByItem.get(itemKey);
      const entryTime = Number(entry.timestamp || entry.createdAt || 0) || 0;
      const currentTime = Number(current?.timestamp || current?.createdAt || 0) || 0;
      const entryId = Number(entry.id);
      const currentId = Number(current?.id);
      if (!current || entryTime > currentTime || (entryTime === currentTime && Number.isFinite(entryId) && entryId > currentId)) {
        latestByItem.set(itemKey, entry);
      }
    }
    const totalPages = Math.max(Number(body?.pagination?.totalPages) || 1, 1);
    if (!history.length || page >= totalPages) break;
    page += 1;
  }
  const loweredSearch = search.toLowerCase();
  const retryableEntries = [...latestByItem.values()]
    .filter((entry) => {
      if (!isRetryableActivity(entry)) return false;
      if (!loweredSearch) return true;
      const source = activityPlatform(entry.source);
      const haystack = [
        entry.mediaType,
        entry.title,
        entry.source,
        source.name,
        entry.status,
        entry.details,
        entry.action,
        JSON.stringify(entry.targetStates || []),
        JSON.stringify(entry.rawPayloadDebug || {}),
      ].join(" ").toLowerCase();
      return haystack.includes(loweredSearch);
    });
  bulkRetryQueueGroupKeys = new Map(
    retryableEntries
      .map((entry) => [
        entry.id != null ? String(entry.id) : "",
        String(entry.activityGroupKey || ""),
      ])
      .filter(([id, groupKey]) => id && groupKey),
  );
  return retryableEntries.map((entry) => String(entry.id));
}

// "Retry all failed" runs as a server-side background job (see
// runRetryAllSyncActivityJob in server/src/routes/sync.js) rather than a
// client-driven loop, so it keeps running - and survives - a closed tab,
// a page reload, or navigating away, the same way Force Sync does. This
// module only starts the job and polls its status/log; the actual retries
// happen entirely on the server.
let bulkRetryPollTimer = null;

function stopBulkRetryPoll() {
  if (bulkRetryPollTimer) window.clearTimeout(bulkRetryPollTimer);
  bulkRetryPollTimer = null;
}

// The job's log lines are "[i/total] <title>: <status> [activityId=<id>]" once discovery has
// run, plus a leading "Found N failed item(s) to retry." line
// before the first one. The id suffix lets a refreshed page distinguish an
// item that is still awaiting its turn from one that has already been tried.
function parseBulkRetryProgress(log) {
  let index = 0;
  let total = 0;
  const completedIds = new Set();
  for (const line of log) {
    const item = /^\[(\d+)\/(\d+)\]/.exec(line);
    if (item) {
      index = Math.max(index, Number(item[1]) || 0);
      total = Number(item[2]) || total;
      const activityId = /\[activityId=([^\]\s]+)\]/.exec(line);
      if (activityId) completedIds.add(activityId[1]);
    }
    const found = /^Found (\d+) failed(?: or skipped)?/.exec(line);
    if (found) total = Number(found[1]);
  }
  return { index, total, completedIds };
}

function setBulkRetryProgressFromLog(log) {
  const parsed = parseBulkRetryProgress(log);
  if (!parsed.total && bulkRetryQueueIds.size) parsed.total = bulkRetryQueueIds.size;
  bulkRetryProgress = parsed;
}

async function pollRetryAllSyncActivity(onDone) {
  stopBulkRetryPoll();
  let body;
  try {
    const response = await fetch("/api/sync-history/retry-all", { headers: authHeaders(), cache: "no-store" });
    body = await response.json();
  } catch (error) {
    bulkRetryPollTimer = window.setTimeout(() => pollRetryAllSyncActivity(onDone), 3000);
    return;
  }

  const log = Array.isArray(body.log) ? body.log : [];
  if (body.active) {
    setBulkRetryProgressFromLog(log);
    renderSyncActivity();
    bulkRetryPollTimer = window.setTimeout(() => pollRetryAllSyncActivity(onDone), 2000);
    return;
  }

  bulkRetryProgress = null;
  bulkRetryQueueIds = new Set();
  bulkRetryQueueGroupKeys = new Map();
  await loadSyncActivity({ force: true, page: 1 }).catch(() => {});
  renderSyncActivity();
  if (typeof onDone === "function") onDone(body.result || null);
}

// Starts the background job and begins polling it. `onDone(result)` is
// called once the job finishes (or is found to have already finished),
// so the caller can surface a completion message.
export async function startRetryAllSyncActivity(onDone, queueIds = []) {
  const response = await fetch("/api/sync-history/retry-all", {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok && !(response.status === 409 && body.jobId)) {
    throw new Error(body.error || `Retry all failed to start with HTTP ${response.status}`);
  }
  bulkRetryQueueIds = new Set((Array.isArray(queueIds) ? queueIds : []).map((id) => String(id)));
  bulkRetryProgress = { index: 0, total: bulkRetryQueueIds.size, completedIds: new Set() };
  renderSyncActivity();
  pollRetryAllSyncActivity(onDone);
}

// Called whenever the Sync Activity page becomes visible, so a run started
// from another tab (or before a reload) picks its polling back up instead of
// the button silently sitting idle while the job keeps working server-side.
export async function resumeRetryAllSyncActivityIfRunning() {
  if (bulkRetryPollTimer) return;
  try {
    const response = await fetch("/api/sync-history/retry-all", { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!body?.active) {
      bulkRetryProgress = null;
      bulkRetryQueueIds = new Set();
      bulkRetryQueueGroupKeys = new Map();
      return;
    }
    setBulkRetryProgressFromLog(Array.isArray(body.log) ? body.log : []);
    renderSyncActivity();
    // Reconstruct the visible queue after a page reload. The worker remains
    // authoritative; this is only a UI snapshot used to label current rows.
    fetchAllRetryableSyncActivityIds()
      .then((ids) => {
        bulkRetryQueueIds = new Set(ids.map((id) => String(id)));
        renderSyncActivity();
      })
      .catch(() => { });
    pollRetryAllSyncActivity();
  } catch {
    // No connectivity yet - the next periodic sync activity refresh will retry.
  }
}

function logTimestamp(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return "Unknown";
  return `${formatDate(time)} (${new Date(time).toISOString()})`;
}

// One media item's sync record as plain text: what was synced, where the
// request came from, where it was dispatched to, and what each target replied.
export function buildSyncActivityLog(entry = {}) {
  const targets = Array.isArray(entry.targetStates) ? entry.targetStates : [];
  const lines = [
    "Plekt sync log",
    `Exported: ${new Date().toISOString()}`,
    "",
    `Title: ${entry.title || "Unknown media"}`,
    `Media type: ${entry.mediaType || "unknown"}`,
    `Action: ${syncHistoryActionLabel(entry)}`,
    `Status: ${entry.status || "unknown"}`,
    `Logged at: ${logTimestamp(entry.timestamp)}`,
    `Record id: ${entry.id != null ? entry.id : "unknown"}`,
    "",
    `Request came from: ${activityPlatform(entry.source).name}`,
    `Dispatched to: ${routeTargetNames(entry).join(", ") || "No targets recorded"}`,
    "",
    `Details: ${entry.details || "No details"}`,
    "",
    "Target results:",
  ];

  if (!targets.length) {
    lines.push("  No target detail recorded.");
  } else {
    for (const target of targets) {
      const detail = target.detail ? ` - ${target.detail}` : "";
      lines.push(`  ${activityPlatform(target.target).name}: ${String(target.status || "unknown").toLowerCase()}${detail}`);
    }
  }

  const debug = entry.rawPayloadDebug && Object.keys(entry.rawPayloadDebug).length ? entry.rawPayloadDebug : null;
  if (debug) {
    lines.push("", "Raw payload debug:", JSON.stringify(debug, null, 2));
  }

  const notes = activityNotes.get(entry.id != null ? String(entry.id) : "") || [];
  if (notes.length) {
    lines.push("", "Retry attempts (this browser session):");
    for (const note of notes) lines.push(`  ${logTimestamp(note.timestamp)}: ${note.text}`);
  }

  return `${lines.join("\n")}\n`;
}

function syncActivityLogFilename(entry = {}) {
  const safeTitle = String(entry.title || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "media";
  const stamp = Number(entry.timestamp) > 0 ? new Date(Number(entry.timestamp)).toISOString().replace(/[:.]/g, "-") : "unknown-time";
  return `${safeTitle}-sync-${stamp}.log`;
}

function currentActivityGroup(groupKey) {
  const key = String(groupKey || "");
  const live = state.syncActivity.find((group) => String(group.groupKey || "") === key);
  if (live) return live;
  for (const cached of groupEventCache.values()) {
    if (String(cached?.group?.groupKey || "") === key) return cached.group;
  }
  return null;
}

function groupEventPageUrl(groupKey, page = 1, limit = 200, latestOnly = true) {
  const url = new URL("/api/sync-activity/group", window.location.origin);
  url.searchParams.set("key", String(groupKey || ""));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("page", String(Math.max(Number(page) || 1, 1)));
  if (latestOnly) url.searchParams.set("latest", "1");
  return url;
}

async function requestActivityGroupPage(groupKey, page = 1, limit = 200, latestOnly = true) {
  const response = await fetch(groupEventPageUrl(groupKey, page, limit, latestOnly), { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Sync activity details failed with ${response.status}`);
  return body;
}

function cacheActivityGroupPage(groupKey, body, append = false, latestOnly = isLatestOnlyValue(body?.latestOnly, true)) {
  const key = String(groupKey || "");
  const cacheKey = groupEventCacheKey(key, latestOnly);
  const previous = groupEventCache.get(cacheKey);
  const incoming = Array.isArray(body?.events) ? body.events : [];
  const events = append
    ? [...(previous?.events || []), ...incoming.filter((event) => !(previous?.events || []).some((item) => String(item.id) === String(event.id)))]
    : incoming;
  const cached = {
    group: body?.group || previous?.group || currentActivityGroup(key),
    events,
    pagination: body?.pagination || previous?.pagination || { page: 1, total: events.length, totalPages: 1, hasNext: false },
    latestOnly: Boolean(latestOnly),
  };
  groupEventCache.set(cacheKey, cached);
  return cached;
}

async function loadActivityGroupPage(groupKey, { page = 1, force = false, latestOnly = true } = {}) {
  const key = String(groupKey || "");
  if (!key) throw new Error("Sync activity group is missing");
  const cacheKey = groupEventCacheKey(key, latestOnly);
  const cached = groupEventCache.get(cacheKey);
  if (!force && Number(page) === 1 && cached) return cached;
  const body = await requestActivityGroupPage(key, page, 200, latestOnly);
  return cacheActivityGroupPage(key, body, Number(page) > 1 && !force, latestOnly);
}

async function fetchAllActivityGroupEvents(groupKey) {
  const key = String(groupKey || "");
  const first = await requestActivityGroupPage(key, 1, 500, false);
  const all = [...(Array.isArray(first.events) ? first.events : [])];
  const totalPages = Math.max(Number(first.pagination?.totalPages) || 1, 1);
  for (let page = 2; page <= totalPages; page += 1) {
    const body = await requestActivityGroupPage(key, page, 500, false);
    for (const event of Array.isArray(body.events) ? body.events : []) {
      if (!all.some((item) => String(item.id) === String(event.id))) all.push(event);
    }
  }
  cacheActivityGroupPage(key, { ...first, events: all }, false, false);
  return { group: first.group || currentActivityGroup(key), events: all };
}

function buildSyncActivityGroupLog(group = {}, events = []) {
  const latest = groupLatestEntry(group);
  const lines = [
    "Plekt grouped sync log",
    `Exported: ${new Date().toISOString()}`,
    "",
    `Title: ${group.title || latest.title || "Unknown media"}`,
    `Media type: ${group.mediaType || latest.mediaType || "unknown"}`,
    `Recorded events: ${events.length || Number(group.eventCount) || 0}`,
    `Latest activity: ${logTimestamp(group.timestamp || latest.timestamp)}`,
    "",
  ];
  for (const [index, event] of events.entries()) {
    lines.push(`===== Event ${index + 1} of ${events.length} =====`, buildSyncActivityLog(event).trim(), "");
  }
  return `${lines.join("\n")}\n`;
}

export async function downloadSyncActivityLog(groupKey) {
  const group = currentActivityGroup(groupKey);
  if (!group) return false;
  const detail = await fetchAllActivityGroupEvents(groupKey);
  const latest = detail.group || group;
  const blob = new Blob([buildSyncActivityGroupLog(latest, detail.events)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = syncActivityLogFilename({ title: latest.title || group.title, timestamp: latest.timestamp || group.timestamp });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

// Clicking anywhere on a group row that is not the title or the download
// button expands it and fetches one current result per movie/episode. The
// expanded view can opt into the complete audit stream explicitly.
export function toggleSyncActivityRowLog(row) {
  if (!row) return false;
  const detail = row.querySelector("[data-sync-activity-group-detail]");
  const groupKey = String(row.dataset.activityGroupKey || "");
  if (!detail || !groupKey) return false;
  const expanded = row.getAttribute("aria-expanded") === "true";
  if (expanded) {
    detail.classList.add("hidden");
    row.setAttribute("aria-expanded", "false");
    return true;
  }
  row.setAttribute("aria-expanded", "true");
  detail.classList.remove("hidden");
  const latestOnly = groupShowsLatestOnly(groupKey);
  const cached = groupEventCache.get(groupEventCacheKey(groupKey, latestOnly));
  const current = currentActivityGroup(groupKey);
  const cachedTimestamp = Number(cached?.group?.timestamp || cached?.group?.latest?.timestamp || 0);
  const currentTimestamp = Number(current?.timestamp || current?.latest?.timestamp || 0);
  const cachedId = Number(cached?.group?.latest?.id || 0);
  const currentId = Number(current?.latest?.id || 0);
  const cacheIsCurrent = cached && (!current
    || (cachedTimestamp > currentTimestamp || (cachedTimestamp === currentTimestamp && cachedId >= currentId)));
  if (cacheIsCurrent) {
    renderGroupEvents(groupKey, cached, detail);
    return true;
  }
  detail.innerHTML = `<div class="empty-log"><b>Loading activity</b><span>${latestOnly ? "Fetching the newest result for each movie/episode." : "Fetching the full audit history."}</span></div>`;
  if (!groupEventLoading.has(groupKey)) {
    groupEventLoading.add(groupKey);
    loadActivityGroupPage(groupKey, { force: Boolean(cached), latestOnly })
      .then((payload) => {
        if (row.getAttribute("aria-expanded") === "true") renderGroupEvents(groupKey, payload, detail);
      })
      .catch((error) => {
        if (row.getAttribute("aria-expanded") === "true") {
          detail.innerHTML = `<div class="empty-log"><b>Could not load activity details</b><span>${escapeHtml(error.message || "Refresh the page and try again.")}</span></div>`;
        }
      })
      .finally(() => groupEventLoading.delete(groupKey));
  }
  return true;
}

export async function setSyncActivityGroupView(groupKey, latestOnly = true) {
  const key = String(groupKey || "");
  if (!key) return false;
  const currentLatestOnly = isLatestOnlyValue(latestOnly, true);
  groupEventView.set(key, currentLatestOnly ? "latest" : "history");
  const row = [...(elements.syncActivityRows?.querySelectorAll(".sync-activity-group-row") || [])]
    .find((candidate) => candidate.dataset.activityGroupKey === key);
  const detail = row?.querySelector("[data-sync-activity-group-detail]");
  if (!row || !detail || row.getAttribute("aria-expanded") !== "true") return true;
  detail.innerHTML = `<div class="empty-log"><b>Loading activity</b><span>${currentLatestOnly ? "Fetching the newest result for each movie/episode." : "Fetching the full audit history."}</span></div>`;
  try {
    const payload = await loadActivityGroupPage(key, { force: true, latestOnly: currentLatestOnly });
    if (row.getAttribute("aria-expanded") === "true") renderGroupEvents(key, payload, detail);
  } catch (error) {
    if (row.getAttribute("aria-expanded") === "true") {
      detail.innerHTML = `<div class="empty-log"><b>Could not load activity details</b><span>${escapeHtml(error.message || "Refresh the page and try again.")}</span></div>`;
    }
  }
  return true;
}

export async function loadOlderSyncActivityGroup(groupKey, page, latestOnly = true) {
  const key = String(groupKey || "");
  const currentLatestOnly = isLatestOnlyValue(latestOnly, groupShowsLatestOnly(key));
  groupEventView.set(key, currentLatestOnly ? "latest" : "history");
  const payload = await loadActivityGroupPage(key, { page: Math.max(Number(page) || 1, 1), latestOnly: currentLatestOnly });
  const row = [...(elements.syncActivityRows?.querySelectorAll(".sync-activity-group-row") || [])]
    .find((candidate) => candidate.dataset.activityGroupKey === key);
  if (row?.getAttribute("aria-expanded") === "true") {
    renderGroupEvents(key, payload, row.querySelector("[data-sync-activity-group-detail]"));
  }
  return payload;
}

export function renderSyncActivityStatus() {
  const text = statusText();
  const sidebarText = isActive()
    ? (state.syncActivityProgress?.label ? `Sync - ${state.syncActivityProgress.label}` : "Sync - Working")
    : syncAttentionNeeded()
      ? "Sync - Attention Needed"
      : "Sync - Idle";
  const hasAttention = syncAttentionNeeded();
  const actionTone = syncActivityActionStatus?.tone || "";
  const stateName = isActive() ? "active" : hasAttention ? "attention" : "idle";
  const attentionToneName = hasAttention
    ? (state.syncAttentionError || state.syncAttentionSeverity === "error" || currentActivityIssueCount() > 0 ? "error" : "warning")
    : actionTone === "error" ? "error" : "clear";
  if (elements.syncProgressIndicator && elements.syncProgressText) {
    elements.syncProgressText.textContent = sidebarText;
    elements.syncProgressIndicator.dataset.syncState = stateName;
    elements.syncProgressIndicator.dataset.attentionTone = hasAttention ? attentionToneName : "clear";
    delete elements.syncProgressIndicator.dataset.actionTone;
    elements.syncProgressIndicator.title = hasAttention
      ? "Open sync activity - attention needed"
      : "Open sync activity";
  }
  if (elements.syncActivityStatus && elements.syncActivityStatusText) {
    elements.syncActivityStatusText.textContent = text;
    elements.syncActivityStatus.dataset.syncState = stateName;
    elements.syncActivityStatus.dataset.attentionTone = attentionToneName;
    if (actionTone) elements.syncActivityStatus.dataset.actionTone = actionTone;
    else delete elements.syncActivityStatus.dataset.actionTone;
  }
  if (elements.startupScanNotice) {
    elements.startupScanNotice.classList.toggle("hidden", !state.syncActivityProgress?.startupScanActive);
  }
  renderCurrentSyncProgress();
  renderSidebarSyncAttention();
}

function renderCurrentSyncProgress() {
  const container = elements.syncActivityCurrentProgress;
  if (!container) return;
  const progress = pausedProgressSnapshot || state.syncActivityProgress || {};
  const total = Math.max(Number(progress.total) || 0, 0);
  const completed = Math.min(Math.max(Number(progress.completed) || 0, 0), total || Number.MAX_SAFE_INTEGER);
  const active = Boolean(progress.active) || (total > 0 && completed < total);
  const determinate = total > 0;
  const percent = determinate ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const currentItemLabel = String(progress.currentItemLabel || "").trim();
  const countLabel = determinate ? `${completed} of ${total} items` : "";
  const label = active
    ? (currentItemLabel ? `${countLabel || "Syncing"} - ${currentItemLabel}` : String(progress.label || "Working"))
    : "No sync running";

  container.dataset.syncState = active ? "active" : "idle";
  container.dataset.indeterminate = active && !determinate ? "true" : "false";
  container.dataset.paused = state.syncActivityPaused ? "true" : "false";
  if (elements.syncActivityCurrentProgressLabel) elements.syncActivityCurrentProgressLabel.textContent = label;
  if (elements.syncActivityCurrentProgressMeta) {
    elements.syncActivityCurrentProgressMeta.textContent = active
      ? (currentItemLabel ? "Sending this item to connected media apps." : determinate ? `${completed} of ${total} items` : "Working through the current sync")
      : (determinate && completed >= total ? `${completed} of ${total} items complete` : "Waiting for a sync to start.");
  }
  if (elements.syncActivityCurrentProgressTrack) {
    elements.syncActivityCurrentProgressTrack.setAttribute("aria-valuenow", String(percent));
    elements.syncActivityCurrentProgressTrack.setAttribute("aria-valuetext", active ? label : "No sync running");
  }
  if (elements.syncActivityCurrentProgressFill) {
    elements.syncActivityCurrentProgressFill.style.width = `${percent}%`;
  }
  if (elements.syncActivityPause) {
    elements.syncActivityPause.textContent = state.syncActivityPaused ? "Resume page updates" : "Pause page updates";
    elements.syncActivityPause.setAttribute("aria-pressed", state.syncActivityPaused ? "true" : "false");
    elements.syncActivityPause.setAttribute("aria-label", state.syncActivityPaused
      ? "Resume page updates"
      : "Pause page updates; the sync will continue in the background");
    elements.syncActivityPause.title = state.syncActivityPaused
      ? "Resume page updates; the sync has continued in the background"
      : "Pause page updates; the sync will continue in the background";
  }
  if (elements.syncActivityPauseStatus) elements.syncActivityPauseStatus.classList.toggle("hidden", !state.syncActivityPaused);
}

function renderSidebarSyncAttention() {
  const container = elements.sidebarSyncAttention;
  const button = elements.sidebarSyncAttentionButton;
  if (!container || !button) return;
  const items = clientAttentionItems();
  const count = items.length;
  const tone = items.some((item) => attentionToneForItem(item) === "error") ? "error" : "warning";
  const visible = count > 0;
  container.classList.toggle("hidden", !visible);
  if (!visible) {
    container.removeAttribute("data-attention-tone");
    button.removeAttribute("data-attention-tone");
    return;
  }

  const title = "Attention";
  const detail = tone === "error"
    ? `${count} issue${count === 1 ? "" : "s"}`
    : `${count} warning${count === 1 ? "" : "s"}`;
  container.dataset.attentionTone = tone;
  button.dataset.attentionTone = tone;
  if (elements.sidebarSyncAttentionTitle) elements.sidebarSyncAttentionTitle.textContent = title;
  if (elements.sidebarSyncAttentionText) elements.sidebarSyncAttentionText.textContent = detail;
  button.title = "Open Sync Activity to review this issue";
  button.setAttribute("aria-label", `${title}: ${detail}. Open Sync Activity for details.`);
}

export function setSyncAttentionSummary({ count = 0, status = "", severity = "" } = {}) {
  const normalizedCount = Math.max(Number(count) || 0, 0);
  state.syncAttentionCount = normalizedCount;
  state.syncAttentionStatus = normalizedCount > 0 || String(status || "").toLowerCase() === "attention" ? "attention" : "clear";
  state.syncAttentionSeverity = normalizedCount > 0
    ? normalizeAttentionTone(severity || status, "error")
    : "clear";
  if (normalizedCount === 0) {
    state.syncAttention = [];
    if (String(status || "").toLowerCase() !== "attention") state.syncAttentionError = "";
  }
  renderSyncActivityStatus();
  if (!state.syncActivityPaused) renderSyncAttention();
}

function clientAttentionSignature(message, route) {
  return `${route}\n${String(message || "").replace(/\s+/g, " ").trim()}`.slice(0, 600);
}

function clientAttentionId(signature) {
  let hash = 0;
  for (let index = 0; index < signature.length; index += 1) {
    hash = ((hash << 5) - hash) + signature.charCodeAt(index);
    hash |= 0;
  }
  return `client:${Math.abs(hash).toString(36)}`;
}

function clientAttentionRoute() {
  if (typeof window === "undefined") return "";
  return `${window.location.pathname || "/"}${window.location.search || ""}${window.location.hash || ""}`;
}

function clientAttentionTitle(message, explicitTitle = "") {
  if (explicitTitle) return explicitTitle;
  const text = String(message || "");
  const lower = text.toLowerCase();
  if (/unwatched correction|review remains pending/.test(lower)) return "Unwatch correction failed";
  if (/manual watch|watch update|provider records updated/.test(lower)) return "Watch update failed";
  const match = text.match(/^([^:]{2,48}):\s*/);
  const source = match?.[1]?.trim();
  return source ? `${source} needs attention` : "Request needs attention";
}

function clientAttentionRecommendations(message) {
  const lower = String(message || "").toLowerCase();
  if (/unauthorized|forbidden|401|403|token|credential|api key/.test(lower)) {
    return [
      "Open Settings → Connections and verify the affected service URL and credentials.",
      "Test the connection after saving any correction.",
      "Review Settings → Logs if the connection still fails.",
    ];
  }
  if (/manual watch|unwatched correction|review remains pending|provider records updated/.test(lower)) {
    return [
      "Open Manual Watch review and confirm the affected item is still pending.",
      "Check the connected media app named in the failure, then retry the correction.",
      "Review Settings → Logs if the same app rejects the retry.",
    ];
  }
  if (/timeout|timed out|network|refused|connect|fetch failed|econn|socket/.test(lower)) {
    return [
      "Confirm the affected service is running and reachable from the Plekt server.",
      "Check firewall, proxy, DNS, and TLS settings for the connection.",
      "Review Settings → Logs for the full request failure.",
    ];
  }
  if (/not found|404|older build|route missing/.test(lower)) {
    return [
      "Confirm the requested item or local API route exists in this Plekt build.",
      "Restart Plekt if the message says the server is running an older build.",
      "Review Settings → Logs for the full failure context.",
    ];
  }
  return [
    "Review Settings → Logs for the full failure details.",
    "Check the affected connection or configuration before trying the action again.",
  ];
}

export function recordClientAttention(message, tone = "error", options = {}) {
  const text = String(message || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const route = String(options.route || clientAttentionRoute());
  const signature = clientAttentionSignature(text, route);
  const id = clientAttentionId(signature);
  const existing = clientAttentionItems().find((item) => item.id === id);
  const item = {
    ...(existing || {}),
    id,
    source: "client",
    kind: "client_request_failure",
    severity: normalizeAttentionTone(tone, "error"),
    title: clientAttentionTitle(text, String(options.title || "").trim()),
    summary: String(options.summary || text),
    explanation: String(options.explanation || "Plekt could not complete this request. The failure is kept here so it is not lost when the page changes."),
    recommendations: Array.isArray(options.recommendations) && options.recommendations.length
      ? options.recommendations.filter(Boolean)
      : clientAttentionRecommendations(text),
    canSkip: false,
    createdAt: Number(existing?.createdAt || Date.now()),
    context: {
      ...(existing?.context || {}),
      ...(options.context && typeof options.context === "object" ? options.context : {}),
      route,
      signature,
      ...(options.retry && typeof options.retry === "object" ? { retry: options.retry } : {}),
    },
  };
  state.clientAttention = [item, ...clientAttentionItems().filter((candidate) => candidate.id !== id)].slice(0, 8);
  renderSyncActivityStatus();
  renderSyncAttention();
  return item;
}

export function clearClientAttention() {
  if (!clientAttentionItems().length) return;
  state.clientAttention = [];
  renderSyncActivityStatus();
  renderSyncAttention();
}

export function clearClientAttentionForRoute(route = clientAttentionRoute()) {
  const targetRoute = String(route || "");
  const remaining = clientAttentionItems().filter((item) => String(item.context?.route || "") !== targetRoute);
  if (remaining.length === clientAttentionItems().length) return;
  state.clientAttention = remaining;
  renderSyncActivityStatus();
  renderSyncAttention();
}

function clientAttentionById(id) {
  const key = String(id || "").trim();
  return clientAttentionItems().find((item) => String(item.id || "") === key) || null;
}

export async function retryClientAttention(id) {
  const key = String(id || "").trim();
  const item = clientAttentionById(key);
  const retry = item?.context?.retry;
  if (!key || !retry?.endpoint || state.clientAttentionRetrying) return null;

  state.clientAttentionRetrying = key;
  renderSyncAttention();
  try {
    const response = await fetch(String(retry.endpoint), {
      method: String(retry.method || "POST").toUpperCase(),
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: retry.body == null ? undefined : JSON.stringify(retry.body),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `Retry failed with ${response.status}`);
      error.status = response.status;
      error.response = body;
      if (Array.isArray(body.failureTargets)) error.failureTargets = body.failureTargets;
      if (Array.isArray(body.targetStates)) error.targetStates = body.targetStates;
      throw error;
    }
    state.clientAttention = clientAttentionItems().filter((candidate) => String(candidate.id || "") !== key);
    return body;
  } catch (error) {
    const current = clientAttentionById(key);
    if (current) {
      const failureReason = String(error?.message || "Retry failed.").replace(/\s+/g, " ").trim();
      const failedTargets = Array.isArray(error?.failureTargets) ? error.failureTargets : [];
      const providers = [...new Set(failedTargets.map((target) => String(target?.provider || target?.target || "").trim()).filter(Boolean))];
      state.clientAttention = clientAttentionItems().map((candidate) => candidate.id === key
        ? {
          ...candidate,
          summary: `Retry failed. ${candidate.summary || "The request did not complete."}`,
          explanation: `The retry also failed. ${failureReason} Fix the reported connection or provider issue, then retry again.`,
          context: {
            ...(candidate.context || {}),
            ...(providers.length ? { provider: providers.join(", ") } : {}),
            failureReason,
            ...(failedTargets.length ? { failureTargets: failedTargets } : {}),
          },
        }
        : candidate);
    }
    throw error;
  } finally {
    if (state.clientAttentionRetrying === key) state.clientAttentionRetrying = "";
    renderSyncActivityStatus();
    renderSyncAttention();
  }
}

function attentionCreatedAt(item = {}) {
  const value = Number(item.createdAt || 0);
  return Number.isFinite(value) && value > 0 ? formatDate(value) : "during the current sync run";
}

function attentionExamples(item = {}) {
  const examples = Array.isArray(item.context?.examples) ? item.context.examples.filter(Boolean) : [];
  if (!examples.length) return "";
  return `
    <div class="sync-attention-examples">
      <h4>Examples</h4>
      <ul>${examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul>
    </div>`;
}

function attentionIssueCode(issue = {}) {
  const season = Number(issue.sourceSeason ?? issue.season);
  const episode = Number(issue.sourceEpisode ?? issue.episode);
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return "";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function attentionIssueDate(issue = {}) {
  const watchedAt = String(issue.watchedAt || "").trim();
  return watchedAt ? formatDate(watchedAt) : "Date unavailable";
}

function attentionIssueProvider(issue = {}) {
  const provider = String(issue.provider || issue.target || "").trim().toLowerCase();
  if (provider === "plex") return "Plex";
  if (provider === "emby") return "Emby";
  if (provider === "jellyfin") return "Jellyfin";
  if (provider === "trakt") return "Trakt";
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "";
}

function attentionIssueFromState(parentId, issueKey) {
  const parent = (state.syncAttention || []).find((item) => String(item.id || "") === String(parentId || ""));
  return (Array.isArray(parent?.context?.issueItems) ? parent.context.issueItems : [])
    .find((issue) => String(issue.key || issue.sourceRowId || "") === String(issueKey || ""));
}

function attentionIssueCanFixMatch(issue = {}) {
  const provider = String(issue.provider || issue.target || "").trim().toLowerCase();
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  return ["plex", "emby", "jellyfin"].includes(provider)
    && ["episode", "movie"].includes(type)
    && issue.candidate !== true;
}

function attentionIssueNeedsMatch(issue = {}, actionKey = "") {
  const terminal = state.syncAttentionIssueRetryTerminal?.actionKey === actionKey
    ? state.syncAttentionIssueRetryTerminal
    : null;
  return terminal?.requiresMatch === true || /not enough row data|fix match/i.test([
    issue.reason,
    issue.lastError,
    issue.detail,
  ].map((value) => String(value || "")).join(" "));
}

function attentionIssueTerminalTime(value = Date.now()) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function attentionIssueRetryTerminalMarkup(parentId, issueKey) {
  const terminal = state.syncAttentionIssueRetryTerminal;
  const actionKey = `${parentId}:${issueKey}`;
  if (!terminal || terminal.actionKey !== actionKey) return "";
  const status = ["running", "success", "error"].includes(terminal.status) ? terminal.status : "running";
  const statusLabel = status === "success" ? "Complete" : status === "error" ? "Failed" : "Running";
  const lines = Array.isArray(terminal.lines) ? terminal.lines : [];
  return `
        <div class="sync-attention-issue-terminal" data-sync-attention-terminal="${escapeAttribute(actionKey)}" role="status" aria-live="polite" aria-busy="${status === "running" ? "true" : "false"}">
          <div class="sync-attention-issue-terminal-header">
            <span class="sync-attention-issue-terminal-prompt" aria-hidden="true">›</span>
            <span class="sync-attention-issue-terminal-title">Retry terminal</span>
            <span class="sync-attention-issue-terminal-target">${escapeHtml(terminal.provider || "Target")}</span>
            <span class="sync-attention-issue-terminal-state sync-attention-issue-terminal-state--${status}">${statusLabel}</span>
          </div>
          <pre class="sync-attention-issue-terminal-output">${escapeHtml(lines.join("\n"))}</pre>
        </div>`;
}

function attentionIssueCanRepair(issue = {}) {
  const provider = String(issue.provider || issue.target || "").trim().toLowerCase();
  if (!["trakt", "plex", "emby", "jellyfin"].includes(provider) || issue.candidate === true) return false;
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  if (!["episode", "movie"].includes(type)) return false;
  const sourceRowId = String(issue.sourceRowId || "").trim();
  const sourcePlaystateKey = String(issue.sourcePlaystateKey || issue.mediaKey || "").trim();
  const sourceMediaKey = String(issue.sourceMediaKey || "").trim();
  const hasSource = provider === "trakt"
    ? Boolean(sourceRowId)
    : Boolean(sourceRowId || sourcePlaystateKey || sourceMediaKey);
  return hasSource;
}

export function attentionIssueMarkup(parentId, issue = {}) {
  const issueKey = String(issue.key || issue.sourceRowId || "").trim();
  if (!issueKey) return "";
  const actionKey = `${parentId}:${issueKey}`;
  const skipping = state.syncAttentionIssueSkipping === actionKey;
  const retrying = state.syncAttentionIssueRetrying === actionKey;
  const actionBusy = Boolean(state.syncAttentionSkipping) || skipping || retrying;
  const canRepair = attentionIssueCanRepair(issue);
  const canFixMatch = attentionIssueCanFixMatch(issue);
  const needsMatch = attentionIssueNeedsMatch(issue, actionKey);
  const code = attentionIssueCode(issue);
  const provider = attentionIssueProvider(issue);
  const metadata = [code, issue.watchedAt ? `Watched ${attentionIssueDate(issue)}` : "Date unavailable"]
    .concat(provider ? [`Target ${provider}`] : [])
    .filter(Boolean)
    .join(" · ");
  const href = String(issue.localHref || "").trim();
  const linkLabel = String(issue.localLinkLabel || "Open in Plekt");
  const reason = String(issue.reason || (provider && provider !== "Trakt"
    ? `${provider} did not confirm the restored state.`
    : "Trakt could not match this restored play."));
  const retryButton = canRepair
    ? `<button class="button-primary sync-attention-issue-retry" type="button" data-sync-attention-retry-item="${escapeAttribute(parentId)}" data-sync-attention-item-key="${escapeAttribute(issueKey)}" ${actionBusy ? "disabled" : ""} ${retrying ? 'aria-busy="true"' : ""} title="Retry this restored item on ${escapeAttribute(provider || "the affected target")}">${escapeHtml(retrying ? "Retrying..." : String(issue.repairLabel || "Retry this issue"))}</button>`
    : "";
  const fixMatchButton = canFixMatch
    ? `<button class="button-ghost sync-attention-issue-fix-match" type="button" data-sync-attention-fix-match="${escapeAttribute(parentId)}" data-sync-attention-item-key="${escapeAttribute(issueKey)}" ${actionBusy ? "disabled" : ""} title="Correct the local title or provider IDs before retrying">Fix match</button>`
    : "";
  const skipButton = `<button class="button-ghost sync-attention-issue-skip" type="button" data-sync-attention-skip-item="${escapeAttribute(parentId)}" data-sync-attention-item-key="${escapeAttribute(issueKey)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipping ? "Skipping..." : "Skip this issue")}</button>`;
  const matchGuidance = needsMatch
    ? `<p class="sync-attention-issue-match-guidance"><strong>Fix match required.</strong> This failed item no longer has enough saved row data for a direct retry. Correct the local match, then retry this item with the corrected identity.</p>`
    : "";
  return `
    <article class="sync-attention-issue" data-sync-attention-issue="${escapeAttribute(issueKey)}">
      <div class="sync-attention-issue-copy">
        <div class="sync-attention-issue-title-row">
          <h4>${escapeHtml(issue.title || "Unknown media")}</h4>
          ${issue.candidate ? '<span class="sync-attention-issue-badge">Candidate</span>' : ""}
        </div>
        <span class="sync-attention-issue-meta">${escapeHtml(metadata)}</span>
        <span class="sync-attention-issue-reason">${escapeHtml(reason)}</span>
      </div>
      <div class="sync-attention-issue-actions">
        ${href ? `<a class="button-ghost sync-attention-issue-link" href="${escapeAttribute(href)}">${escapeHtml(linkLabel)}</a>` : '<span class="sync-attention-issue-unavailable">No local link available</span>'}
        ${fixMatchButton}
        ${canRepair ? `${retryButton}${skipButton}` : ""}
      </div>
      ${matchGuidance}
      ${attentionIssueRetryTerminalMarkup(parentId, issueKey)}
    </article>`;
}

function attentionRestoreIssueKey(issue = {}) {
  return String(issue.key || issue.sourceRowId || "").trim();
}

export function issueShowTitle(issue = {}) {
  const explicit = String(issue.showTitle || issue.show_title || "").trim();
  if (explicit) return explicit;
  const title = String(issue.title || "").trim();
  const type = String(issue.type || issue.mediaType || "").trim().toLowerCase();
  if (type === "episode" || /\bS\d{1,3}E\d{1,3}\b/i.test(title)) {
    const stripped = title.replace(/\s*-?\s*S\d{1,3}E\d{1,3}\b.*$/i, "").trim();
    if (stripped) return stripped;
  }
  return "";
}

export function canonicalShowKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function groupAttentionIssues(issues = []) {
  const groups = [];
  const groupsByKey = new Map();

  for (const issue of issues) {
    const showTitle = issueShowTitle(issue);
    if (showTitle) {
      const key = canonicalShowKey(showTitle) || "unknown-show";
      if (!groupsByKey.has(key)) {
        const group = {
          key,
          kind: "show",
          title: showTitle,
          issues: [],
        };
        groupsByKey.set(key, group);
        groups.push(group);
      }
      groupsByKey.get(key).issues.push(issue);
    } else {
      const issueKey = String(issue.key || issue.sourceRowId || Math.random());
      const key = `movie:${issueKey}`;
      const group = {
        key,
        kind: "movie",
        title: String(issue.title || "Movie").trim(),
        issues: [issue],
      };
      groups.push(group);
    }
  }

  return groups;
}

function attentionShowRetryTerminalMarkup(parentId, showKey) {
  const terminal = state.syncAttentionShowRetryTerminal;
  const actionKey = `${parentId}:${showKey}`;
  if (!terminal || terminal.actionKey !== actionKey) return "";
  const status = ["running", "success", "error", "partial"].includes(terminal.status) ? terminal.status : "running";
  const statusLabel = status === "success" ? "Complete" : status === "error" ? "Failed" : status === "partial" ? "Partial" : "Running";
  const lines = Array.isArray(terminal.lines) ? terminal.lines : [];
  return `
        <div class="sync-attention-issue-terminal sync-attention-show-terminal" data-sync-attention-terminal="${escapeAttribute(actionKey)}" role="status" aria-live="polite" aria-busy="${status === "running" ? "true" : "false"}">
          <div class="sync-attention-issue-terminal-header">
            <span class="sync-attention-issue-terminal-prompt" aria-hidden="true">›</span>
            <span class="sync-attention-issue-terminal-title">Show retry terminal</span>
            <span class="sync-attention-issue-terminal-target">${escapeHtml(terminal.provider || "Target")}</span>
            <span class="sync-attention-issue-terminal-state sync-attention-issue-terminal-state--${status}">${statusLabel}</span>
          </div>
          <pre class="sync-attention-issue-terminal-output">${escapeHtml(lines.join("\n"))}</pre>
        </div>`;
}

function attentionShowGroupMarkup(parentId, group) {
  const showKey = group.key;
  const actionKey = `${parentId}:${showKey}`;
  const isExpanded = state.syncAttentionExpandedShows instanceof Set
    ? state.syncAttentionExpandedShows.has(actionKey)
    : false;
  const skipping = state.syncAttentionShowSkipping === actionKey;
  const retrying = state.syncAttentionShowRetrying === actionKey;
  const actionBusy = Boolean(state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying || state.syncAttentionShowSkipping || state.syncAttentionShowRetrying);

  const issueCount = group.issues.length;
  const seasons = [...new Set(group.issues.map((i) => i.season).filter((s) => s != null))].sort((a, b) => a - b);
  const seasonsText = seasons.length === 1 ? `Season ${seasons[0]}` : seasons.length > 1 ? `Seasons ${seasons.join(", ")}` : "";
  const provider = attentionIssueProvider(group.issues[0]) || "Trakt";
  const metaParts = [
    `${issueCount} affected ${issueCount === 1 ? "play" : "plays"}`,
    seasonsText,
    provider ? `Target ${provider}` : "",
  ].filter(Boolean);
  const meta = metaParts.join(" · ");

  const canRepair = group.issues.some((issue) => attentionIssueCanRepair(issue));
  const retryButton = canRepair
    ? `<button class="button-primary sync-attention-show-retry" type="button" data-sync-attention-retry-show="${escapeAttribute(parentId)}" data-sync-attention-show-key="${escapeAttribute(showKey)}" ${actionBusy ? "disabled" : ""} ${retrying ? 'aria-busy="true"' : ""} title="Retry all ${issueCount} plays for ${escapeAttribute(group.title)}">${escapeHtml(retrying ? "Retrying show..." : "Retry this show")}</button>`
    : "";
  const skipButton = `<button class="button-ghost sync-attention-show-skip" type="button" data-sync-attention-skip-show="${escapeAttribute(parentId)}" data-sync-attention-show-key="${escapeAttribute(showKey)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""} title="Skip all ${issueCount} plays for ${escapeAttribute(group.title)}">${escapeHtml(skipping ? "Skipping show..." : "Skip this show")}</button>`;

  const terminalMarkup = attentionShowRetryTerminalMarkup(parentId, showKey);

  return `
    <div class="sync-attention-show-group ${isExpanded ? "is-expanded" : ""}" data-sync-attention-show="${escapeAttribute(showKey)}">
      <div class="sync-attention-show-header" role="button" tabindex="0" aria-expanded="${isExpanded ? "true" : "false"}" data-sync-attention-toggle-show="${escapeAttribute(parentId)}" data-sync-attention-show-key="${escapeAttribute(showKey)}">
        <div class="sync-attention-show-header-left">
          <span class="sync-attention-show-chevron ${isExpanded ? "is-expanded" : ""}" aria-hidden="true">›</span>
          <div class="sync-attention-show-title-copy">
            <h4 class="sync-attention-show-title">${escapeHtml(group.title)}</h4>
            <span class="sync-attention-show-meta">${escapeHtml(meta)}</span>
          </div>
        </div>
        <div class="sync-attention-show-actions">
          ${retryButton}
          ${skipButton}
        </div>
      </div>
      ${terminalMarkup}
      ${isExpanded ? `
        <div class="sync-attention-show-episodes">
          ${group.issues.map((issue) => attentionIssueMarkup(parentId, issue)).join("")}
        </div>
      ` : ""}
    </div>`;
}

function attentionIssueList(item = {}) {
  const context = item.context || {};
  const issues = Array.isArray(context.issueItems) ? context.issueItems : [];
  const issueCount = Math.max(Number(context.issueCount) || issues.length, issues.length);
  const itemWord = issues.some((issue) => {
    const provider = String(issue.provider || issue.target || "").toLowerCase();
    return provider && provider !== "trakt";
  }) ? "item" : "play";
  if (!issueCount && !issues.length) return attentionExamples(item);
  const listed = issues.length;
  const complete = context.issueItemsComplete === true && listed >= issueCount;
  const groups = groupAttentionIssues(issues);
  const showCount = groups.filter((g) => g.kind === "show").length;
  const description = complete
    ? `All ${issueCount} affected ${itemWord}${issueCount === 1 ? " is" : "s are"} grouped by show below. Click a show to view its episodes and fix options.`
    : listed
      ? `${listed} of ${issueCount} affected ${itemWord}s are listed below. The failed run retained only these examples; run a new restore to capture any missing item-level details.`
      : `${issueCount} affected ${itemWord}s were reported, but the failed run did not retain item-level details. Run a new restore to capture them.`;
  const countLabel = showCount > 0
    ? `${showCount} ${showCount === 1 ? "show" : "shows"} · ${listed} listed · ${issueCount} total`
    : `${listed} listed · ${issueCount} total`;
  return `
    <div class="sync-attention-issues">
      <div class="sync-attention-issues-heading">
        <h4>Affected plays</h4>
        <span>${escapeHtml(countLabel)}</span>
      </div>
      <p class="sync-attention-issues-note">${escapeHtml(description)}</p>
      ${listed ? `
        <div class="sync-attention-issue-list">
          ${groups.map((group) => (
            group.kind === "show"
              ? attentionShowGroupMarkup(item.id, group)
              : attentionIssueMarkup(item.id, group.issues[0])
          )).join("")}
        </div>
      ` : ""}
    </div>`;
}

export function syncAttentionItemMarkup(item = {}) {
  const recommendations = Array.isArray(item.recommendations) ? item.recommendations.filter(Boolean) : [];
  const skipping = state.syncAttentionSkipping === String(item.id || "");
  const actionBusy = Boolean(state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying);
  const skipLabel = skipping ? "Skipping..." : String(item.skipLabel || "Skip this issue");
  const tone = attentionToneForItem(item);
  const isBlocking = tone === "error";
  return `
    <article class="sync-attention-item" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <span class="sync-attention-kicker">${isBlocking ? "Blocking issue" : "Warning"}</span>
          <h3>${escapeHtml(item.title || "Sync issue")}</h3>
        </div>
        <span class="status-pill status-${isBlocking ? "error" : "warning"}">${isBlocking ? "Needs attention" : "Review warning"}</span>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || "This operation did not complete.")}</p>
      <div class="sync-attention-detail-grid">
        <div>
          <h4>Why this blocks completion</h4>
          <p>${escapeHtml(item.explanation || "The sync cannot be considered complete until this issue is resolved or skipped.")}</p>
        </div>
        <div>
          <h4>Recommended next steps</h4>
          ${recommendations.length
            ? `<ol>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ol>`
            : `<p>Review Settings → Logs, correct the affected connection, and retry the operation.</p>`}
        </div>
      </div>
      ${attentionIssueList(item)}
      <div class="sync-attention-item-footer">
        <span class="sync-attention-detected">Detected ${escapeHtml(attentionCreatedAt(item))}</span>
        <div class="sync-attention-actions">
          <p>Skipping accepts this incomplete projection and lets normal sync resume; it does not create the missing remote records.</p>
          <button class="button-ghost sync-attention-skip" type="button" data-sync-attention-skip="${escapeAttribute(item.id)}" ${actionBusy ? "disabled" : ""} ${skipping ? 'aria-busy="true"' : ""}>${escapeHtml(skipLabel)}</button>
        </div>
      </div>
    </article>`;
}

export function clientAttentionItemMarkup(item = {}) {
  const recommendations = Array.isArray(item.recommendations) ? item.recommendations.filter(Boolean) : [];
  const tone = attentionToneForItem(item);
  const route = String(item.context?.route || "").trim();
  const internalRoute = route.startsWith("/") && !route.startsWith("//") ? route : "";
  const affectedMedia = String(item.context?.affectedMedia || "").trim();
  const actionLabel = String(item.context?.actionLabel || "").trim();
  const sourceApps = String(item.context?.sourceApps || "").trim();
  const provider = String(item.context?.provider || "").trim();
  const failureReason = String(item.context?.failureReason || "").trim();
  const routeLabel = String(item.context?.routeLabel || "Open affected page").trim();
  const retry = item.context?.retry && typeof item.context.retry === "object" ? item.context.retry : null;
  const retrying = state.clientAttentionRetrying === String(item.id || "");
  const retryButton = retry?.endpoint
    ? `<button class="button-primary sync-attention-client-retry" type="button" data-sync-client-retry="${escapeAttribute(item.id)}" ${retrying ? "disabled" : ""} ${retrying ? 'aria-busy="true"' : ""}>${escapeHtml(retrying ? "Retrying..." : String(retry.label || "Retry request"))}</button>`
    : "";
  const contextFields = [
    actionLabel ? `<div><span>Action</span><strong>${escapeHtml(actionLabel)}</strong></div>` : "",
    affectedMedia ? `<div><span>Affected media</span><strong>${escapeHtml(affectedMedia)}</strong></div>` : "",
    sourceApps ? `<div><span>Reported by</span><strong>${escapeHtml(sourceApps)}</strong></div>` : "",
    provider ? `<div><span>Failed at</span><strong>${escapeHtml(provider)}</strong></div>` : "",
  ].filter(Boolean);
  const contextMarkup = contextFields.length
    ? `<div class="sync-attention-client-context">${contextFields.join("")}</div>`
    : "";
  const causeMarkup = failureReason
    ? `<div class="sync-attention-client-cause"><span>Failure reason</span><code>${escapeHtml(failureReason)}</code></div>`
    : "";
  const logsLink = `<a class="button-ghost sync-attention-logs-link" href="/settings/logs">Open logs</a>`;
  const routeLink = internalRoute
    ? `<a class="button-ghost sync-attention-issue-link" href="${escapeAttribute(internalRoute)}">${escapeHtml(routeLabel)}</a>`
    : "";
  const actions = [retryButton, routeLink, logsLink].filter(Boolean).join("");
  return `
    <article class="sync-attention-item sync-attention-item--client" data-sync-client-attention="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <span class="sync-attention-kicker">${tone === "error" ? "Request failed" : "Warning"}</span>
          <h3>${escapeHtml(item.title || "Request needs attention")}</h3>
        </div>
        <span class="status-pill status-${tone === "error" ? "error" : "warning"}">${tone === "error" ? "Needs attention" : "Review warning"}</span>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || "The request did not complete.")}</p>
      ${contextMarkup}
      ${causeMarkup}
      <div class="sync-attention-detail-grid">
        <div>
          <h4>What happened</h4>
          <p>${escapeHtml(item.explanation || "Plekt could not complete this request.")}</p>
        </div>
        <div>
          <h4>What to do</h4>
          ${recommendations.length
            ? `<ol>${recommendations.map((recommendation) => `<li>${escapeHtml(recommendation)}</li>`).join("")}</ol>`
            : `<p>Review Settings → Logs for the full failure details.</p>`}
        </div>
      </div>
      <div class="sync-attention-item-footer">
        <span class="sync-attention-detected">Detected ${escapeHtml(attentionCreatedAt(item))}</span>
        ${actions ? `<div class="sync-attention-actions">${actions}</div>` : ""}
      </div>
    </article>`;
}

function matchAttentionItemMarkup(item = {}) {
  const issues = Array.isArray(item.context?.issueItems) ? item.context.issueItems : [];
  const issueCount = Number(item.context?.issueCount) || issues.length;
  return `
    <article class="sync-attention-item sync-attention-item--match" data-sync-attention-item="${escapeAttribute(item.id)}">
      <div class="sync-attention-item-header">
        <div class="sync-attention-item-title">
          <h3>Cross-Platform Match Issues</h3>
        </div>
      </div>
      <p class="sync-attention-summary">${escapeHtml(item.summary || `${issueCount} unresolved media matches found.`)} Choose the correct match to clear each issue.</p>
      <div class="sync-attention-issues">
        <div class="sync-attention-issues-heading">
          <h4>Items</h4>
        </div>
        <div class="sync-attention-issue-list sync-attention-match-list">
          ${issues.map((issue) => `
            <div class="sync-attention-match-row">
              <div>
                <strong>${escapeHtml(issue.title || "Unknown title")}</strong>
                <span>${escapeHtml(`${platformName(issue.provider)} · ${issue.type === "episode" ? "TV" : "Movie"}${issue.season != null && issue.episode != null ? ` · S${String(issue.season).padStart(2, "0")}E${String(issue.episode).padStart(2, "0")}` : ""}`)}</span>
              </div>
              ${issue.sourceRowId ? `<div class="sync-attention-match-actions"><button class="button-ghost sync-attention-match-fix" type="button" data-sync-attention-match-fix-id="${escapeAttribute(issue.sourceRowId)}" data-sync-attention-match-fix-title="${escapeAttribute(issue.type === "episode" ? issue.showTitle || issue.title : issue.title)}" data-sync-attention-match-fix-type="${escapeAttribute(issue.type || "movie")}">Fix match</button><button class="button-ghost sync-attention-match-dismiss" type="button" data-sync-attention-match-dismiss-id="${escapeAttribute(issue.sourceRowId)}" data-sync-attention-match-dismiss-title="${escapeAttribute(issue.type === "episode" ? issue.showTitle || issue.title : issue.title)}" title="Keep local watch history and stop reporting this issue">Remove</button></div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    </article>`;
}

export function renderSyncAttention() {
  const container = elements.syncActivityAttention;
  if (!container) return;
  // Once attention has loaded, keep the last good panel in place while a
  // background refresh is in flight. Showing an empty loading card here makes
  // the content above the activity list grow and shrink on every poll.
  if (state.syncAttentionLoading === true && state.syncAttentionLoaded === true) return;
  const items = attentionItems();
  const serverItems = serverAttentionItems();
  const count = attentionCount();
  const loading = state.syncAttentionLoading === true;
  const error = String(state.syncAttentionError || "").trim();
  const attentionKey = renderSnapshot({
    items,
    serverItems,
    count,
    loading,
    loaded: state.syncAttentionLoaded === true,
    error,
    tone: attentionTone(),
    skipping: state.syncAttentionSkipping || "",
    issueSkipping: state.syncAttentionIssueSkipping || "",
    issueRetrying: state.syncAttentionIssueRetrying || "",
    issueRetryTerminal: state.syncAttentionIssueRetryTerminal || null,
    showSkipping: state.syncAttentionShowSkipping || "",
    showRetrying: state.syncAttentionShowRetrying || "",
    showRetryTerminal: state.syncAttentionShowRetryTerminal || null,
    clientRetrying: state.clientAttentionRetrying || "",
    expandedShows: state.syncAttentionExpandedShows instanceof Set
      ? [...state.syncAttentionExpandedShows].sort()
      : [],
  });
  if (attentionKey === lastAttentionKey) return;
  lastAttentionKey = attentionKey;

  if (!count && !loading && !error) {
    container.classList.add("hidden");
    container.removeAttribute("data-attention-tone");
    container.innerHTML = "";
    return;
  }

  container.classList.remove("hidden");
  container.dataset.attentionTone = attentionTone() === "error" ? "error" : "warning";
  if (loading && !state.syncAttentionLoaded && !clientAttentionItems().length && !matchAttentionItem()) {
    container.innerHTML = `<div class="sync-attention-loading"><b>Checking sync blockers</b><span>Reading the latest restore and initial-sync status.</span></div>`;
    return;
  }
  if (error && !items.length) {
    container.innerHTML = `<div class="sync-attention-error"><div><b>Could not load sync attention details</b><span>${escapeHtml(error)} Review Settings → Logs for the full server-side failure. Details will refresh automatically when Sync Activity is opened again.</span></div></div>`;
    return;
  }
  if (!items.length) {
    container.innerHTML = `<div class="sync-attention-loading"><b>Sync needs attention</b><span>Loading the issue details. No automatic retry is offered from this alert.</span></div>`;
    return;
  }

  const affectedCount = serverItems.reduce((total, item) => total + (Number(item.context?.issueCount) || 0), 0);
  const blockingCount = items.filter((item) => attentionToneForItem(item) === "error").length;
  const matchOnly = items.length > 0 && items.every((item) => item.source === "match_report");
  if (matchOnly) {
    container.innerHTML = `<div class="sync-attention-list sync-attention-list--match-only">${items.map((item) => matchAttentionItemMarkup(item)).join("")}</div>`;
    return;
  }
  const clientItems = items.filter((item) => item.source === "client");
  const clientOnly = clientItems.length > 0 && clientItems.length === items.length;
  const heading = affectedCount
    ? `${count} issue${count === 1 ? "" : "s"} · ${affectedCount} affected play${affectedCount === 1 ? "" : "s"}`
    : clientOnly
      ? `${clientItems.length} failed request${clientItems.length === 1 ? "" : "s"} need${clientItems.length === 1 ? "s" : ""} action`
      : `${count} issue${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} review`;
  const badge = blockingCount ? `${blockingCount} attention` : `${count} to review`;
  const hasMatchIssues = items.some((item) => item.source === "match_report");
  const description = serverItems.length
    ? "The restore or initial sync is paused to protect your canonical watch history. Review the explanation and recommended fixes below."
    : hasMatchIssues
      ? "Choose the correct title to resolve these matches."
      : clientOnly
        ? "Sync is idle. These requests failed outside the sync run and are waiting for action; the affected item, target app, cause, and retry are shown below."
        : "These failed requests are kept here so an important problem is not lost when a temporary message disappears.";
  container.innerHTML = `
    <div class="sync-attention-heading">
      <div>
        <span class="sync-attention-kicker">Sync - Attention Needed</span>
        <h2 id="syncAttentionHeading">${escapeHtml(heading)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      <span class="status-pill status-${blockingCount ? "error" : "warning"}">${escapeHtml(badge)}</span>
    </div>
    <div class="sync-attention-list">${items.map((item) => item.source === "client"
      ? clientAttentionItemMarkup(item)
      : item.source === "match_report"
        ? matchAttentionItemMarkup(item)
        : syncAttentionItemMarkup(item)).join("")}</div>`;
}

export async function loadSyncAttention({ force = false } = {}) {
  if (!state.token || (state.syncAttentionLoading && !force)) return state.syncAttention;
  if (syncAttentionLoadPromise) return syncAttentionLoadPromise;
  const requestToken = ++attentionRequestToken;
  syncAttentionLoadPromise = (async () => {
    state.syncAttentionLoading = true;
    state.syncAttentionError = "";
    renderSyncAttention();
    try {
      const response = await fetch("/api/sync-attention", { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Sync attention load failed with ${response.status}`);
      if (requestToken !== attentionRequestToken) return state.syncAttention;
      state.syncAttention = Array.isArray(body.attention) ? body.attention : [];
      state.syncAttentionCount = Math.max(Number(body.count) || state.syncAttention.length, 0);
      state.syncAttentionStatus = state.syncAttentionCount ? "attention" : "clear";
      state.syncAttentionSeverity = state.syncAttentionCount
        ? (state.syncAttention.some((item) => attentionToneForItem(item) === "error") ? "error" : "warning")
        : "clear";
      state.syncAttentionLoaded = true;
      return state.syncAttention;
    } catch (error) {
      if (requestToken === attentionRequestToken) {
        state.syncAttentionError = error.message || "Could not load sync attention details.";
        state.syncAttentionStatus = "attention";
        state.syncAttentionSeverity = "error";
      }
      throw error;
    } finally {
      if (requestToken === attentionRequestToken) {
        state.syncAttentionLoading = false;
        renderSyncActivityStatus();
        renderSyncAttention();
      }
    }
  })();
  try {
    return await syncAttentionLoadPromise;
  } finally {
    syncAttentionLoadPromise = null;
  }
}

export async function skipSyncAttention(id) {
  const key = String(id || "").trim();
  if (!key || state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying) return null;
  state.syncAttentionSkipping = key;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: key }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not skip sync issue (${response.status})`);
    await loadSyncAttention({ force: true });
    return body;
  } catch (error) {
    state.syncAttentionError = error.message || "Could not skip sync issue.";
    throw error;
  } finally {
    state.syncAttentionSkipping = "";
    renderSyncAttention();
  }
}

export async function skipSyncAttentionItem(id, itemKey) {
  const parentId = String(id || "").trim();
  const issueKey = String(itemKey || "").trim();
  if (!parentId || !issueKey || state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying) return null;
  const actionKey = `${parentId}:${issueKey}`;
  state.syncAttentionIssueSkipping = actionKey;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: parentId, itemKey: issueKey, action: "skip-item" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not acknowledge restore issue (${response.status})`);
    await loadSyncAttention({ force: true });
    return body;
  } catch (error) {
    state.syncAttentionError = error.message || "Could not acknowledge restore issue.";
    throw error;
  } finally {
    if (state.syncAttentionIssueSkipping === actionKey) state.syncAttentionIssueSkipping = "";
    renderSyncAttention();
  }
}

export async function retrySyncAttentionItem(id, itemKey) {
  const parentId = String(id || "").trim();
  const issueKey = String(itemKey || "").trim();
  if (!parentId || !issueKey || state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying) return null;
  const actionKey = `${parentId}:${issueKey}`;
  const issue = attentionIssueFromState(parentId, issueKey) || {};
  const provider = attentionIssueProvider(issue) || "Target";
  const title = String(issue.title || "the restored item").trim();
  state.syncAttentionIssueRetrying = actionKey;
  state.syncAttentionIssueRetryTerminal = {
    actionKey,
    provider,
    title,
    status: "running",
    requiresMatch: false,
    lines: [
      `[${attentionIssueTerminalTime()}] plekt › retry restored item`,
      `[${attentionIssueTerminalTime()}] target: ${provider}`,
      `[${attentionIssueTerminalTime()}] Retrying "${title}"...`,
    ],
  };
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    const response = await fetch("/api/sync-attention", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: parentId, itemKey: issueKey, action: "repair" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body.error || `Could not retry restore issue (${response.status})`;
      state.syncAttentionIssueRetryTerminal = {
        ...state.syncAttentionIssueRetryTerminal,
        status: "error",
        requiresMatch: body.requiresMatch === true || /not enough row data|fix match/i.test(message),
        lines: [
          ...(state.syncAttentionIssueRetryTerminal?.lines || []),
          `[${attentionIssueTerminalTime()}] Retry failed: ${message}`,
        ],
      };
      throw new Error(message);
    }
    state.syncAttentionIssueRetryTerminal = {
      ...state.syncAttentionIssueRetryTerminal,
      status: "success",
      lines: [
        ...(state.syncAttentionIssueRetryTerminal?.lines || []),
        `[${attentionIssueTerminalTime()}] ${body.message || `Retry confirmed by ${provider}.`}`,
      ],
    };
    await loadSyncAttention({ force: true });
    return body;
  } catch (error) {
    if (state.syncAttentionIssueRetryTerminal?.actionKey === actionKey && state.syncAttentionIssueRetryTerminal.status === "running") {
      state.syncAttentionIssueRetryTerminal = {
        ...state.syncAttentionIssueRetryTerminal,
        status: "error",
        lines: [
          ...(state.syncAttentionIssueRetryTerminal.lines || []),
          `[${attentionIssueTerminalTime()}] Retry failed: ${error.message || "The request could not be completed."}`,
        ],
      };
    }
    state.syncAttentionError = error.message || "Could not retry restore issue.";
    throw error;
  } finally {
    if (state.syncAttentionIssueRetrying === actionKey) state.syncAttentionIssueRetrying = "";
    renderSyncAttention();
  }
}

export async function skipSyncAttentionShow(id, showKey) {
  const parentId = String(id || "").trim();
  const key = String(showKey || "").trim();
  if (!parentId || !key || state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying || state.syncAttentionShowSkipping || state.syncAttentionShowRetrying) return null;
  const parent = (state.syncAttention || []).find((c) => String(c.id) === parentId);
  const allIssues = Array.isArray(parent?.context?.issueItems) ? parent.context.issueItems : [];
  const showIssues = allIssues.filter((issue) => canonicalShowKey(issueShowTitle(issue)) === key);
  if (!showIssues.length) return null;
  const itemKeys = showIssues.map((i) => attentionRestoreIssueKey(i)).filter(Boolean);
  if (!itemKeys.length) return null;

  const actionKey = `${parentId}:${key}`;
  state.syncAttentionShowSkipping = actionKey;
  state.syncAttentionError = "";
  renderSyncAttention();
  try {
    let result = null;
    if (itemKeys.length === 1) {
      const response = await fetch("/api/sync-attention", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: parentId, itemKey: itemKeys[0], action: "skip-item" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not skip issue (${response.status})`);
      result = body;
    } else {
      const response = await fetch("/api/sync-attention", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: parentId, itemKeys, action: "skip-items" }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) {
        result = body;
      } else if (response.status === 400 && /unsupported/i.test(body.error || "")) {
        for (const singleKey of itemKeys) {
          const fallbackRes = await fetch("/api/sync-attention", {
            method: "POST",
            headers: { ...authHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify({ id: parentId, itemKey: singleKey, action: "skip-item" }),
          });
          const fallbackBody = await fallbackRes.json().catch(() => ({}));
          if (!fallbackRes.ok) throw new Error(fallbackBody.error || `Could not skip issue (${fallbackRes.status})`);
          result = fallbackBody;
        }
      } else {
        throw new Error(body.error || `Could not skip show issues (${response.status})`);
      }
    }
    await loadSyncAttention({ force: true });
    return result;
  } catch (error) {
    state.syncAttentionError = error.message || "Could not skip show issues.";
    throw error;
  } finally {
    if (state.syncAttentionShowSkipping === actionKey) state.syncAttentionShowSkipping = "";
    renderSyncAttention();
  }
}

export async function retrySyncAttentionShow(id, showKey) {
  const parentId = String(id || "").trim();
  const key = String(showKey || "").trim();
  if (!parentId || !key || state.syncAttentionSkipping || state.syncAttentionIssueSkipping || state.syncAttentionIssueRetrying || state.syncAttentionShowSkipping || state.syncAttentionShowRetrying) return null;
  const parent = (state.syncAttention || []).find((c) => String(c.id) === parentId);
  const allIssues = Array.isArray(parent?.context?.issueItems) ? parent.context.issueItems : [];
  const showIssues = allIssues.filter((issue) => canonicalShowKey(issueShowTitle(issue)) === key);
  if (!showIssues.length) return null;
  const showTitle = issueShowTitle(showIssues[0]) || "Show";
  const repairable = showIssues.filter((issue) => attentionIssueCanRepair(issue));
  if (!repairable.length) return null;

  const actionKey = `${parentId}:${key}`;
  if (!state.syncAttentionExpandedShows) state.syncAttentionExpandedShows = new Set();
  state.syncAttentionExpandedShows.add(actionKey);
  state.syncAttentionShowRetrying = actionKey;
  state.syncAttentionError = "";

  const provider = attentionIssueProvider(repairable[0]) || "Target";
  state.syncAttentionShowRetryTerminal = {
    actionKey,
    showTitle,
    provider,
    status: "running",
    lines: [
      `[${attentionIssueTerminalTime()}] plekt › retry show "${showTitle}"`,
      `[${attentionIssueTerminalTime()}] target: ${provider}`,
      `[${attentionIssueTerminalTime()}] Retrying ${repairable.length} plays...`,
    ],
  };
  renderSyncAttention();

  let succeeded = 0;
  let failed = 0;

  for (let index = 0; index < repairable.length; index++) {
    const issue = repairable[index];
    const issueTitle = String(issue.title || `Play ${index + 1}`).trim();
    const issueKey = attentionRestoreIssueKey(issue);
    try {
      const response = await fetch("/api/sync-attention", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ id: parentId, itemKey: issueKey, action: "repair" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        failed += 1;
        const msg = body.error || `Failed (${response.status})`;
        state.syncAttentionShowRetryTerminal.lines.push(`[${attentionIssueTerminalTime()}] [${index + 1}/${repairable.length}] ${issueTitle}: Failed - ${msg}`);
      } else {
        succeeded += 1;
        state.syncAttentionShowRetryTerminal.lines.push(`[${attentionIssueTerminalTime()}] [${index + 1}/${repairable.length}] ${issueTitle}: Repaired.`);
      }
    } catch (err) {
      failed += 1;
      state.syncAttentionShowRetryTerminal.lines.push(`[${attentionIssueTerminalTime()}] [${index + 1}/${repairable.length}] ${issueTitle}: Error - ${err.message || String(err)}`);
    }
    renderSyncAttention();
  }

  state.syncAttentionShowRetryTerminal.lines.push(
    `[${attentionIssueTerminalTime()}] Completed: ${succeeded} repaired, ${failed} failed.`
  );
  state.syncAttentionShowRetryTerminal.status = failed > 0 ? (succeeded > 0 ? "partial" : "error") : "success";

  try {
    await loadSyncAttention({ force: true });
  } finally {
    if (state.syncAttentionShowRetrying === actionKey) state.syncAttentionShowRetrying = "";
    renderSyncAttention();
  }

  return {
    succeeded,
    failed,
    total: repairable.length,
    message: failed > 0 ? `Completed with ${failed} ${failed === 1 ? "failure" : "failures"}.` : `All ${succeeded} ${succeeded === 1 ? "play was" : "plays were"} repaired.`,
  };
}

export function setSyncActivityProgress({ total = 0, completed = 0, active = false, label = "", currentItemLabel = "", startupScanActive = false } = {}) {
  const normalizedTotal = Math.max(Number(total) || 0, 0);
  const normalizedCompleted = Math.max(Number(completed) || 0, 0);
  state.syncActivityProgress = {
    total: normalizedTotal,
    completed: normalizedCompleted,
    active: Boolean(active) || (normalizedTotal > 0 && normalizedCompleted < normalizedTotal),
    label: String(label || ""),
    currentItemLabel: String(currentItemLabel || ""),
    startupScanActive: Boolean(startupScanActive),
  };
  renderSyncActivityStatus();
}

function renderSyncActivityPagination() {
  const container = elements.syncActivityPagination;
  if (!container) return;
  const pagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const total = Math.max(Number(pagination.total) || 0, 0);
  const totalPages = Math.max(Number(pagination.totalPages) || 1, 1);
  const page = Math.min(Math.max(Number(pagination.page) || 1, 1), totalPages);
  const from = total ? Math.max(Number(pagination.from) || ((page - 1) * pagination.limit + 1), 1) : 0;
  const to = total ? Math.max(Number(pagination.to) || Math.min(page * pagination.limit, total), from) : 0;
  const paginationKey = renderSnapshot({
    total,
    totalPages,
    page,
    from,
    to,
    hasPrevious: Boolean(pagination.hasPrevious),
    hasNext: Boolean(pagination.hasNext),
    loading: Boolean(state.syncActivityLoading),
    items: paginationItems(page, totalPages),
  });
  if (paginationKey === lastActivityPaginationKey) return;
  lastActivityPaginationKey = paginationKey;

  container.classList.toggle("hidden", totalPages <= 1 || !total);
  if (elements.syncActivityPageRange) {
    elements.syncActivityPageRange.textContent = total ? `Showing ${from}-${to} of ${total}` : "Showing 0-0 of 0";
  }
  if (elements.syncActivityPageLabel) {
    elements.syncActivityPageLabel.textContent = `Page ${page} of ${totalPages}`;
  }
  if (elements.syncActivityPageNumbers) {
    elements.syncActivityPageNumbers.innerHTML = paginationItems(page, totalPages).map((item) => {
      if (item === "ellipsis") return `<span class="sync-activity-page-ellipsis" aria-hidden="true">&hellip;</span>`;
      const current = item === page;
      return `<button class="button-ghost sync-activity-page-number ${current ? "is-current" : ""}" type="button" data-sync-activity-page="${item}" ${current ? 'aria-current="page" disabled' : `aria-label="Go to page ${item}"`}>${item}</button>`;
    }).join("");
  }
  if (elements.syncActivityPrevious) {
    elements.syncActivityPrevious.disabled = Boolean(state.syncActivityLoading) || !pagination.hasPrevious;
  }
  if (elements.syncActivityNext) {
    elements.syncActivityNext.disabled = Boolean(state.syncActivityLoading) || !pagination.hasNext;
  }
}

export function paginationItems(page, totalPages, maxVisible = 5) {
  const total = Math.max(Math.floor(Number(totalPages) || 1), 1);
  const current = Math.min(Math.max(Math.floor(Number(page) || 1), 1), total);
  const visible = Math.max(Math.floor(Number(maxVisible) || 5), 3);
  if (total <= visible) return Array.from({ length: total }, (_, index) => index + 1);

  const innerSlots = visible - 2;
  let start = Math.max(2, current - Math.floor(innerSlots / 2));
  let end = Math.min(total - 1, start + innerSlots - 1);
  start = Math.max(2, end - innerSlots + 1);
  const items = [1];
  if (start > 2) items.push("ellipsis");
  for (let number = start; number <= end; number += 1) items.push(number);
  if (end < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

export function setSyncActivitySearch(value) {
  state.syncActivitySearch = String(value || "").slice(0, 120);
  state.syncActivityPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}), page: 1 };
  renderSyncActivity();
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    loadSyncActivity({ force: true, page: 1 }).catch(() => null);
  }, SEARCH_DEBOUNCE_MS);
}

export function resetSyncActivity() {
  loadRequestToken += 1;
  clearSyncActivityActionStatusTimer();
  syncActivityActionStatus = null;
  if (searchTimer) window.clearTimeout(searchTimer);
  searchTimer = null;
  if (activityChangeRefreshTimer) window.clearTimeout(activityChangeRefreshTimer);
  activityChangeRefreshTimer = null;
  state.syncAttentionIssueRetrying = "";
  state.syncAttentionIssueRetryTerminal = null;
  state.syncActivity = [];
  state.syncActivityLoaded = false;
  state.syncActivityLoading = false;
  state.syncActivitySearch = "";
  state.syncActivityFailedOnly = false;
  state.syncActivityCurrentIssueGroupCount = 0;
  state.syncActivityCurrentIssueCount = 0;
  state.syncActivityRetryableCount = 0;
  state.syncActivityMatchReport = null;
  state.syncActivityMatchIssueCount = 0;
  state.syncActivityPaused = false;
  pausedProgressSnapshot = null;
  state.syncActivityPagination = { ...DEFAULT_PAGINATION };
  groupEventCache.clear();
  groupEventLoading.clear();
  groupEventView.clear();
  groupRetryProgress.clear();
  lastActivityRowsKey = "";
  lastActivitySummaryKey = "";
  lastActivityPaginationKey = "";
  lastAttentionKey = "";
  lastTraktProgressKey = "";
}

export function toggleSyncActivityPaused() {
  state.syncActivityPaused = !state.syncActivityPaused;
  pausedProgressSnapshot = state.syncActivityPaused
    ? { ...(state.syncActivityProgress || {}) }
    : null;
  renderSyncActivityStatus();
  return state.syncActivityPaused;
}

// A live sync-progress heartbeat is not itself an activity change. Queue one
// bounded refresh only when a completed item or the finished run can have
// written a new sync-history row. Keeping this separate from the 15-second
// background refresh prevents the activity list from repainting on every
// progress tick while still moving the newest result to the top promptly.
export function queueSyncActivityRefresh({ immediate = false } = {}) {
  if (!state.token || state.activeView !== "syncActivity" || state.syncActivityPaused) return;
  if (activityChangeRefreshTimer) {
    if (!immediate) return;
    window.clearTimeout(activityChangeRefreshTimer);
  }
  activityChangeRefreshTimer = window.setTimeout(() => {
    activityChangeRefreshTimer = null;
    if (state.activeView === "syncActivity" && !state.syncActivityPaused) {
      loadSyncActivity({ force: true }).catch(() => null);
    }
  }, immediate ? 40 : 140);
}

// The failed-only view is server-filtered so issues do not disappear just
// because they are on a later activity page. The server uses the same current
// item/target-level classification as the row issue counts.
export function toggleSyncActivityFailedOnly() {
  state.syncActivityFailedOnly = !state.syncActivityFailedOnly;
  state.syncActivityPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}), page: 1 };
  state.syncActivity = [];
  renderSyncActivity();
  loadSyncActivity({ force: true, page: 1 }).catch(() => null);
}

function syncActivitySummaryMarkup(text, { failedOnly = false, showToggle = false, hasIssues = false } = {}) {
  const toggle = showToggle
    ? `<button class="button-ghost sync-activity-failed-toggle" type="button" data-sync-activity-failed-toggle="1" aria-pressed="${failedOnly ? "true" : "false"}">${failedOnly ? "Show all activity" : "Issues only"}</button>`
    : "";
  const issueClass = hasIssues ? " sync-activity-summary-text--issues" : "";
  return `<span class="sync-activity-summary-text${issueClass}">${escapeHtml(text)}</span>${toggle}`;
}

function renderTraktDispatchProgress() {
  const el = elements.syncActivityTraktProgress;
  if (!el) return;
  const progress = state.traktDispatchProgress;
  const progressKey = renderSnapshot(progress || null);
  if (progressKey === lastTraktProgressKey) return;
  lastTraktProgressKey = progressKey;
  if (!progress || !progress.pending) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  // A stable, whole-backlog figure - separate from the "Sync - X of Y"
  // indicator above, whose Y is only the current small dispatch burst and
  // resets between bursts (see countTraktImportPendingDispatch in
  // dataRepo.js). This number only ever counts down.
  const processed = Math.max(0, progress.total - progress.pending);
  el.classList.remove("hidden");
  el.textContent = `Propagating your imported Trakt history to your media servers: ${processed} of ${progress.total} processed so far.`;
}

export function renderSyncActivity() {
  renderSyncActivityStatus();
  renderSyncAttention();
  renderTraktDispatchProgress();
  if (!elements.syncActivityRows) return;
  renderSyncActivityPagination();

  if (state.syncActivityLoading && !state.syncActivity.length) {
    const loadingRowsKey = "loading";
    if (loadingRowsKey !== lastActivityRowsKey) {
      lastActivityRowsKey = loadingRowsKey;
      elements.syncActivityRows.innerHTML = `<div class="empty-log"><b>Loading sync activity</b><span>Fetching what has been synced recently.</span></div>`;
    }
    if (elements.syncActivitySummary) {
      const loadingSummaryKey = "Loading";
      if (loadingSummaryKey !== lastActivitySummaryKey) {
        lastActivitySummaryKey = loadingSummaryKey;
        elements.syncActivitySummary.className = "sync-activity-summary";
        elements.syncActivitySummary.innerHTML = syncActivitySummaryMarkup("Loading");
      }
    }
    renderSyncActivityPagination();
    return;
  }

  const query = state.syncActivitySearch || "";
  const pageRows = [...state.syncActivity];
  const failedGroups = pageRows.filter((group) => groupTone(group) === "error").length;
  const currentIssueGroupCount = Math.max(Number(state.syncActivityCurrentIssueGroupCount) || 0, 0);
  const activityIssueCount = Math.max(Number(state.syncActivityCurrentIssueCount) || 0, 0);
  const matchIssueCount = Math.max(Number(state.syncActivityMatchIssueCount) || 0, 0);
  const currentIssueCount = activityIssueCount + matchIssueCount;
  const failedOnly = Boolean(state.syncActivityFailedOnly);
  const rows = failedOnly ? pageRows.filter((group) => groupTone(group) === "error") : pageRows;
  const pagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const total = Math.max(Number(pagination.total) || 0, pageRows.length);
  const from = total ? Math.max(Number(pagination.from) || 1, 1) : 0;
  const to = total ? Math.max(Number(pagination.to) || pageRows.length, from) : 0;

  const currentIssueSummary = [
    activityIssueCount > 0
      ? (currentIssueGroupCount > 0
        ? `${pluralLabel(currentIssueGroupCount, "media group")} with ${pluralLabel(activityIssueCount, "current issue")}`
        : `${pluralLabel(activityIssueCount, "current issue")} need review`)
      : "",
    matchIssueCount > 0 ? `${pluralLabel(matchIssueCount, "cross-platform match issue")} need review` : "",
  ].filter(Boolean).join(" / ") || "no current issues";
  const summaryText = !pageRows.length
    ? (failedOnly
      ? (query
        ? `Issues only: no matching media groups${matchIssueCount ? ` / ${pluralLabel(matchIssueCount, "cross-platform match issue")} need review` : ""}`
        : matchIssueCount
          ? `Issues only: ${pluralLabel(matchIssueCount, "cross-platform match issue")} need review`
          : "Issues only: no media groups")
      : (query ? "No matches" : matchIssueCount ? `${pluralLabel(matchIssueCount, "cross-platform match issue")} need review` : "No activity"))
    : (failedOnly
      ? `Showing issues only: ${from}-${to} of ${total} media groups / ${currentIssueSummary}`
      : `Showing ${from}-${to} of ${total} media groups / ${currentIssueSummary}`);
  const summaryOptions = {
    failedOnly,
    showToggle: pageRows.length
      ? currentIssueGroupCount > 0 || matchIssueCount > 0 || failedOnly || failedGroups > 0
      : failedOnly || matchIssueCount > 0,
    hasIssues: currentIssueCount > 0,
  };
  const summaryKey = renderSnapshot({ text: summaryText, ...summaryOptions });
  if (elements.syncActivitySummary && summaryKey !== lastActivitySummaryKey) {
    lastActivitySummaryKey = summaryKey;
    elements.syncActivitySummary.className = "sync-activity-summary";
    elements.syncActivitySummary.innerHTML = syncActivitySummaryMarkup(summaryText, summaryOptions);
  }

  if (elements.syncActivityRetryAllFailed) {
    const button = elements.syncActivityRetryAllFailed;
    const retryableCount = Math.max(Number(state.syncActivityRetryableCount) || 0, 0);
    const retryAllActive = Boolean(bulkRetryProgress);
    // The count is calculated across the full activity store, not just the
    // current page, so the control never disappears merely because a failure
    // is on another page. Keep it visible while an already-started job is
    // reporting progress, even after the latest page snapshot reaches zero.
    button.hidden = !retryAllActive && retryableCount === 0;
    button.disabled = retryAllActive || retryableCount === 0;
    button.textContent = bulkRetryProgress
      ? (bulkRetryProgress.total ? `Retrying ${bulkRetryProgress.index} of ${bulkRetryProgress.total}...` : "Retrying...")
      : "Retry all failed";
  }

  if (!rows.length) {
    const failedOnlyEmptyHint = matchIssueCount
      ? "Cross-platform match issues are shown above; successful media groups are hidden while Issues only is active."
      : "Successful media groups are hidden while Issues only is active.";
    const emptyMarkup = failedOnly
      ? `<div class="empty-log"><b>${query ? "No failed sync activity groups match this search" : "No failed sync activity groups on this page"}</b><span>${failedOnlyEmptyHint}</span></div>`
      : query
        ? `<div class="empty-log"><b>No matching sync activity</b><span>Try another title, platform, action, or status.</span></div>`
        : `<div class="empty-log"><b>Nothing synced yet</b><span>Watches propagated to your media servers and trackers appear here, newest first.</span></div>`;
    const emptyRowsKey = renderSnapshot({ mode: "empty", emptyMarkup, query, failedOnly, pageRows, pagination, retryableCount: state.syncActivityRetryableCount });
    if (emptyRowsKey !== lastActivityRowsKey) {
      lastActivityRowsKey = emptyRowsKey;
      elements.syncActivityRows.innerHTML = emptyMarkup;
    }
    renderSyncActivityPagination();
    return;
  }

  const rowsKey = renderSnapshot({
    mode: "rows",
    rows,
    query,
    failedOnly,
    pagination,
    feedback: [...activityFeedback.entries()],
    notes: [...activityNotes.entries()],
    retrying: [...retryingActivityIds].sort(),
    bulkRetryProgress: bulkRetryProgress ? {
      index: bulkRetryProgress.index,
      total: bulkRetryProgress.total,
      completedIds: [...(bulkRetryProgress.completedIds || [])].sort(),
    } : null,
    bulkRetryQueueIds: [...bulkRetryQueueIds].sort(),
    bulkRetryQueueGroupKeys: [...bulkRetryQueueGroupKeys.entries()],
    groupRetryProgress: [...groupRetryProgress.entries()],
  });
  if (rowsKey === lastActivityRowsKey) return;
  lastActivityRowsKey = rowsKey;

  // A changed snapshot replaces the markup, so rows the reader has opened are
  // reopened afterwards rather than snapping shut under them.
  const expandedKeys = new Set(
    [...elements.syncActivityRows.querySelectorAll('.sync-activity-row[aria-expanded="true"]')].map((row) => row.dataset.activityGroupKey),
  );
  patchActivityRows(rows, expandedKeys);
  renderSyncActivityPagination();
}

function activityGroupRowKey(group) {
  return renderSnapshot({
    group,
    failedOnly: Boolean(state.syncActivityFailedOnly),
    bulkRetryQueueIds: [...bulkRetryQueueIds].sort(),
    bulkRetryQueueGroupKeys: [...bulkRetryQueueGroupKeys.entries()],
    groupRetryProgress: [...groupRetryProgress.entries()],
  });
}

function activityRowFromMarkup(markup) {
  const template = document.createElement("template");
  template.innerHTML = String(markup || "").trim();
  return template.content.firstElementChild;
}

function animateActivityRow(row, { entering = false } = {}) {
  if (!row || state.syncActivityPaused || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
  if (entering) {
    row.classList.add("sync-activity-row--entering");
    window.setTimeout(() => row.classList.remove("sync-activity-row--entering"), 260);
  }
}

// Patch rows by media-group key instead of replacing the whole list. This
// preserves focus, open logs, and scroll anchoring while the sync writes new
// results. Existing rows are FLIP-animated when the server moves them, and
// only new/changed rows get an entrance animation.
function patchActivityRows(rows, expandedKeys = new Set()) {
  const container = elements.syncActivityRows;
  if (!container) return;
  for (const child of [...container.children]) {
    if (!child.classList.contains("sync-activity-group-row")) child.remove();
  }
  const existing = new Map(
    [...container.querySelectorAll(".sync-activity-group-row")]
      .map((row) => [row.dataset.activityGroupKey, row]),
  );
  const firstRects = new Map([...existing.values()].map((row) => [row.dataset.activityGroupKey, row.getBoundingClientRect()]));
  const nextKeys = new Set();
  const nextRows = [];

  for (const group of rows) {
    const latest = groupLatestEntry(group);
    const key = String(group.groupKey || latest.activityGroupKey || "");
    if (!key) continue;
    nextKeys.add(key);
    const previous = existing.get(key);
    const rowKey = activityGroupRowKey(group);
    let row = previous;
    if (!row || row.dataset.syncActivityRowKey !== rowKey) {
      row = activityRowFromMarkup(activityGroupRow(group));
      if (!row) continue;
      row.dataset.syncActivityRowKey = rowKey;
      const wasExpanded = expandedKeys.has(key) || previous?.getAttribute("aria-expanded") === "true";
      if (wasExpanded) {
        row.setAttribute("aria-expanded", "true");
        const previousDetail = previous?.querySelector("[data-sync-activity-group-detail]");
        const nextDetail = row.querySelector("[data-sync-activity-group-detail]");
        if (previousDetail && nextDetail) {
          nextDetail.innerHTML = previousDetail.innerHTML;
          nextDetail.classList.toggle("hidden", previousDetail.classList.contains("hidden"));
        }
      }
      if (previous) previous.replaceWith(row);
      animateActivityRow(row, { entering: !previous });
    }
    nextRows.push(row);
  }

  for (const [key, row] of existing) {
    if (!nextKeys.has(key)) row.remove();
  }
  // Keep rows that are already in the right position where they are. Moving
  // every row through appendChild, even when its order is unchanged, can
  // disturb the browser's scroll anchor after a changed activity snapshot.
  let nextPosition = container.firstElementChild;
  for (const row of nextRows) {
    if (row === nextPosition) {
      nextPosition = nextPosition.nextElementSibling;
      continue;
    }
    container.insertBefore(row, nextPosition);
  }

  for (const row of nextRows) {
    const first = firstRects.get(row.dataset.activityGroupKey);
    if (!first || state.syncActivityPaused || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) continue;
    const last = row.getBoundingClientRect();
    const deltaY = first.top - last.top;
    if (Math.abs(deltaY) > 1 && typeof row.animate === "function") {
      row.animate(
        [{ transform: `translateY(${deltaY}px)` }, { transform: "translateY(0)" }],
        { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    }
  }
}

export async function loadSyncActivity({ force = false, page } = {}) {
  if (!state.token || (state.syncActivityLoading && !force)) return state.syncActivity;
  const currentPage = Number(state.syncActivityPagination?.page) || 1;
  const requestedPage = page == null ? currentPage : Math.max(Math.floor(Number(page) || 1), 1);
  const previousPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}) };
  const requestToken = ++loadRequestToken;
  const requestedSearch = state.syncActivitySearch || "";
  state.syncActivityPagination = { ...DEFAULT_PAGINATION, ...(state.syncActivityPagination || {}), page: requestedPage };
  state.syncActivityLoading = true;
  renderSyncActivity();
  try {
    const url = new URL("/api/sync-activity", window.location.origin);
    url.searchParams.set("limit", String(ACTIVITY_PAGE_SIZE));
    url.searchParams.set("page", String(requestedPage));
    if (requestedSearch.trim()) url.searchParams.set("search", requestedSearch.trim());
    if (state.syncActivityFailedOnly) url.searchParams.set("failedOnly", "1");
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sync activity load failed with ${response.status}`);
    if (requestToken !== loadRequestToken || requestedSearch !== state.syncActivitySearch) return state.syncActivity;
    state.syncActivity = (Array.isArray(body.groups) ? body.groups : [])
      .slice()
      .sort(compareSyncActivityGroups);
    state.syncActivityMatchReport = body.matchReport && typeof body.matchReport === "object" ? body.matchReport : null;
    state.syncActivityMatchIssueCount = unresolvedMatchIssueCount();
    const pageIssueGroupCount = state.syncActivity.filter((group) => groupTone(group) === "error").length;
    const pageIssueCount = state.syncActivity.reduce((totalIssues, group) => totalIssues + Math.max(Number(group.problemCount) || 0, 0), 0);
    state.syncActivityCurrentIssueGroupCount = Object.prototype.hasOwnProperty.call(body, "currentIssueGroupCount")
      ? Math.max(Number(body.currentIssueGroupCount) || 0, 0)
      : pageIssueGroupCount;
    state.syncActivityCurrentIssueCount = Object.prototype.hasOwnProperty.call(body, "currentIssueCount")
      ? Math.max(Number(body.currentIssueCount) || 0, 0)
      : pageIssueCount;
    // Keep the activity API's sync-history count separate from the match
    // report count; currentActivityIssueCount() combines them for the global
    // attention state and the summary below adds the visible match issues.
    const pageRetryableCount = pageIssueCount;
    state.syncActivityRetryableCount = Object.prototype.hasOwnProperty.call(body, "retryableCount")
      ? Math.max(Number(body.retryableCount) || 0, 0)
      : pageRetryableCount;
    state.traktDispatchProgress = body.traktDispatchProgress || null;
    const rawPagination = body.pagination && typeof body.pagination === "object" ? body.pagination : {};
    const limit = Math.min(Math.max(Number(rawPagination.limit) || ACTIVITY_PAGE_SIZE, 1), 200);
    const total = Math.max(Number(rawPagination.total) || state.syncActivity.length, 0);
    const totalPages = Math.max(Number(rawPagination.totalPages) || Math.ceil(total / limit) || 1, 1);
    const resolvedPage = Math.min(Math.max(Number(rawPagination.page) || requestedPage, 1), totalPages);
    state.syncActivityPagination = {
      ...DEFAULT_PAGINATION,
      ...rawPagination,
      page: resolvedPage,
      limit,
      total,
      totalPages,
      from: Number(rawPagination.from) || (total ? ((resolvedPage - 1) * limit + 1) : 0),
      to: Number(rawPagination.to) || (total ? Math.min(resolvedPage * limit, total) : 0),
      hasPrevious: rawPagination.hasPrevious === true || resolvedPage > 1,
      hasNext: rawPagination.hasNext === true || resolvedPage < totalPages,
    };
    state.syncActivityLoaded = true;
    return state.syncActivity;
  } catch (error) {
    if (requestToken !== loadRequestToken) return state.syncActivity;
    state.syncActivityPagination = previousPagination;
    throw error;
  } finally {
    if (requestToken === loadRequestToken) {
      state.syncActivityLoading = false;
      renderSyncActivity();
    }
  }
}

// The page keeps itself current while it is the visible view. The live update
// stream refreshes promptly when a history item completes; this interval is a
// quiet fallback for changes that do not emit a progress event.
export function startSyncActivityRefresh() {
  stopSyncActivityRefresh();
  refreshTimer = window.setInterval(() => {
    if (state.activeView !== "syncActivity") return;
    if (state.syncActivityPaused) return;
    loadSyncActivity({ force: true }).catch(() => null);
    loadSyncAttention({ force: true }).catch(() => null);
  }, REFRESH_MS);
}

export function stopSyncActivityRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  refreshTimer = null;
  if (activityChangeRefreshTimer) window.clearTimeout(activityChangeRefreshTimer);
  activityChangeRefreshTimer = null;
}

let syncActivityEventsInitialized = false;

// The activity page owns its search, pagination, row actions, and retry/fix
// controls. Keeping these listeners with the route module means the shell does
// not parse a large status-page event graph on About, Settings, or Dashboard.
export function initSyncActivityEvents(callbacks = {}) {
  if (syncActivityEventsInitialized) return;
  syncActivityEventsInitialized = true;
  const setMessage = (...args) => callbacks.setMessage?.(...args);
  const navigateTo = (...args) => callbacks.navigateTo?.(...args);
  const openConfirmDialog = (...args) => callbacks.openConfirmDialog
    ? callbacks.openConfirmDialog(...args)
    : Promise.resolve(true);

  // These controls only exist on the Sync Activity route. Keep their wiring
  // with the route module so the global event graph only owns shell status
  // indicators and navigation into this page.
  elements.syncActivityPause?.addEventListener("click", () => {
    callbacks.toggleSyncActivityPaused?.();
  });

  elements.syncActivityRefresh?.addEventListener("click", () => {
    callbacks.loadSyncActivity?.({ force: true })?.catch?.(() => { });
  });

  elements.syncActivityRetryAllFailed?.addEventListener("click", async () => {
    const button = elements.syncActivityRetryAllFailed;
    if (!button || button.disabled) return;
    const idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = "Checking...";
    let started = false;
    try {
      const ids = await callbacks.fetchAllRetryableSyncActivityIds?.() || [];
      if (!ids.length) {
        setMessage("No failed sync items to retry.", "muted");
        return;
      }
      const confirmed = await openConfirmDialog({
        title: "Retry all failed sync items?",
        body: `This retries the latest failed result for ${ids.length} movie/episode item${ids.length === 1 ? "" : "s"} across your entire sync history, not just this page. Missing media on a connected app is treated as skipped and is not retried. Older duplicate results and issues already resolved by a newer result are left alone. The retry runs one at a time in the background, even if you close this tab.`,
        confirmLabel: "Retry all",
      });
      if (!confirmed) return;
      started = true;
      await callbacks.startRetryAllSyncActivity?.((result) => {
        if (!result) return;
        if (result.cancelled) {
          setMessage("Retry all was cancelled.", "muted");
        } else if (result.success) {
          setMessage(`Retry all complete: ${result.succeeded || 0} succeeded, ${result.stillFailed || 0} still failed, ${result.skipped || 0} skipped, out of ${result.total || 0}.`, (result.stillFailed || result.errored) ? "warning" : "success");
        } else {
          setMessage(result.error || "Retry all finished with an error.", "error");
        }
      }, ids);
    } catch (error) {
      setMessage(error.message || "Could not start retry all.", "error");
    } finally {
      if (!started) {
        button.textContent = idleLabel;
        button.disabled = false;
      }
    }
  });

  elements.syncActivitySummary?.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-sync-activity-failed-toggle]");
    if (!toggle || !elements.syncActivitySummary.contains(toggle)) return;
    callbacks.toggleSyncActivityFailedOnly?.();
  });

  elements.syncActivitySearch?.addEventListener("input", (event) => {
    callbacks.setSyncActivitySearch?.(event.target.value);
  });

  const changeSyncActivityPage = (delta) => {
    const pagination = state.syncActivityPagination || {};
    const page = Math.max(Number(pagination.page) || 1, 1) + delta;
    if (page < 1 || (pagination.totalPages && page > Number(pagination.totalPages))) return;
    callbacks.loadSyncActivity?.({ page })?.catch?.(() => { });
  };

  elements.syncActivityPrevious?.addEventListener("click", () => changeSyncActivityPage(-1));
  elements.syncActivityNext?.addEventListener("click", () => changeSyncActivityPage(1));

  elements.syncActivityPagination?.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-sync-activity-page]");
    if (!pageButton) return;
    const page = Number(pageButton.dataset.syncActivityPage);
    if (!Number.isFinite(page) || page < 1 || page === Number(state.syncActivityPagination?.page)) return;
    callbacks.loadSyncActivity?.({ page })?.catch?.(() => { });
  });

  elements.syncActivityRows?.addEventListener("click", (event) => {
    const fixShow = event.target.closest("[data-sync-activity-fix-show]");
    if (fixShow) {
      const groupKey = String(fixShow.dataset.syncActivityFixShow || "").trim();
      const showTitle = String(fixShow.dataset.syncActivityFixShowTitle || "").trim();
      if (!groupKey || !showTitle) {
        setMessage("This show activity group does not contain enough information to fix the show match.", "error");
        return;
      }
      fixShow.disabled = true;
      callbacks.openFixMatchDialog?.(null, "", showTitle, "episode", async (saved = {}) => {
        setMessage(`Show match updated for ${showTitle}. Retrying all current failed entries...`, "success");
        try {
          const result = await callbacks.retrySyncActivityGroup?.(groupKey, {
            tvdbId: saved.tvdb_id || saved.tvdbId || "",
            showTitle: saved.show_title || saved.showTitle || saved.title || showTitle,
            traktTmdbId: saved.trakt_tmdb_id || saved.traktTmdbId || "",
            traktSourceSeason: saved.trakt_source_season || saved.traktSourceSeason || "",
            traktTargetSeason: saved.trakt_target_season || saved.traktTargetSeason || "",
          });
          const processed = Number(result?.processed || result?.total || 0);
          const failed = Number(result?.stillFailed || 0) + Number(result?.errored || 0);
          setMessage(
            `Show match updated. Retried ${processed} entr${processed === 1 ? "y" : "ies"}: ${result?.succeeded || 0} succeeded, ${result?.stillFailed || 0} still failed, ${result?.skipped || 0} skipped.`,
            failed ? "warning" : "success",
          );
        } catch (error) {
          setMessage(`Show match updated, but retrying the ${showTitle} entries failed: ${error.message || String(error)}`, "error");
        }
      }, {
        headerTitle: `Fix show match · ${showTitle}`,
        currentTvdbId: fixShow.dataset.syncActivityFixShowCurrentTvdb || "",
        traktSourceSeason: fixShow.dataset.syncActivityFixShowSourceSeason || "",
        traktTargetSeason: "1",
        onSkipLabel: "Skip Trakt for now",
        onSkip: async () => {
          try {
            const result = await callbacks.dismissSyncActivityGroup?.(groupKey);
            setMessage(`Skipped ${Number(result?.dismissed || 0) || "the"} Trakt error${Number(result?.dismissed || 0) === 1 ? "" : "s"} for ${showTitle} for now.`, "muted");
          } catch (error) {
            setMessage(`Could not skip the Trakt errors for ${showTitle}: ${error.message || String(error)}`, "error");
          }
        },
        onCancel: () => {
          if (fixShow.isConnected) fixShow.disabled = false;
        },
      });
      return;
    }

    const dismissShow = event.target.closest("[data-sync-activity-dismiss-show]");
    if (dismissShow && !dismissShow.disabled) {
      const groupKey = String(dismissShow.dataset.syncActivityDismissShow || "").trim();
      const showTitle = String(dismissShow.dataset.syncActivityDismissShowTitle || "").trim() || "this show";
      const count = Math.max(Number(dismissShow.dataset.syncActivityDismissShowCount) || 0, 1);
      const confirmed = openConfirmDialog({
        title: `Dismiss Trakt errors for ${showTitle}?`,
        body: `${count} ${count === 1 ? "episode" : "episodes"} will be marked as intentionally skipped because Trakt does not have this show. Plekt will keep the local watched state and remember this choice if a later retry still gets the same Trakt not-found result.`,
        confirmLabel: `Dismiss ${count} error${count === 1 ? "" : "s"}`,
      });
      dismissShow.disabled = true;
      Promise.resolve(confirmed).then(async (accepted) => {
        if (!accepted) {
          if (dismissShow.isConnected) dismissShow.disabled = false;
          return;
        }
        try {
          const result = await callbacks.dismissSyncActivityGroup?.(groupKey);
          const dismissed = Number(result?.dismissed || 0);
          const failed = Number(result?.failed || 0);
          setMessage(
            failed ? `Dismissed ${dismissed} Trakt error${dismissed === 1 ? "" : "s"}; ${failed} could not be dismissed.` : `Dismissed ${dismissed} Trakt error${dismissed === 1 ? "" : "s"} for ${showTitle}.`,
            failed ? "warning" : "muted",
          );
        } catch (error) {
          setMessage(error.message || `Could not dismiss the Trakt errors for ${showTitle}.`, "error");
          if (dismissShow.isConnected) dismissShow.disabled = false;
        }
      }).catch((error) => {
        setMessage(error.message || `Could not dismiss the Trakt errors for ${showTitle}.`, "error");
        if (dismissShow.isConnected) dismissShow.disabled = false;
      });
      return;
    }

    const dismiss = event.target.closest("[data-sync-activity-dismiss]");
    if (dismiss && !dismiss.disabled) {
      const activityId = String(dismiss.dataset.syncActivityDismiss || "").trim();
      const showTitle = String(dismiss.dataset.syncActivityDismissTitle || "").trim() || "this show";
      const confirmed = openConfirmDialog({
        title: "Dismiss this Trakt error?",
        body: `Trakt does not have ${showTitle}. The local watched state will stay unchanged and this Trakt update will be marked as intentionally skipped.`,
        confirmLabel: "Dismiss error",
      });
      dismiss.disabled = true;
      Promise.resolve(confirmed).then(async (accepted) => {
        if (!accepted) {
          if (dismiss.isConnected) dismiss.disabled = false;
          return;
        }
        try {
          await callbacks.dismissSyncActivity?.(activityId);
          setMessage(`Dismissed the Trakt error for ${showTitle}.`, "muted");
        } catch (error) {
          setMessage(error.message || `Could not dismiss the Trakt error for ${showTitle}.`, "error");
          if (dismiss.isConnected) dismiss.disabled = false;
        }
      }).catch((error) => {
        setMessage(error.message || `Could not dismiss the Trakt error for ${showTitle}.`, "error");
        if (dismiss.isConnected) dismiss.disabled = false;
      });
      return;
    }

    const fixMatch = event.target.closest("[data-sync-activity-fix-match]");
    if (fixMatch) {
      const activityId = String(fixMatch.dataset.syncActivityFixMatch || "").trim();
      const showTitle = String(fixMatch.dataset.syncActivityFixMatchTitle || "").trim();
      if (!activityId || !showTitle) {
        setMessage("This Trakt issue does not contain enough information to fix the show match.", "error");
        return;
      }
      fixMatch.disabled = true;
      callbacks.openFixMatchDialog?.(null, "", showTitle, "episode", async (saved = {}) => {
        setMessage(`Show match updated for ${showTitle}. Retrying the Trakt update...`, "success");
        try {
          const result = await callbacks.retrySyncActivity?.(activityId, {
            tvdbId: saved.tvdb_id || saved.tvdbId || "",
            showTitle: saved.show_title || saved.showTitle || saved.title || showTitle,
            traktTmdbId: saved.trakt_tmdb_id || saved.traktTmdbId || "",
            traktSourceSeason: saved.trakt_source_season || saved.traktSourceSeason || "",
            traktTargetSeason: saved.trakt_target_season || saved.traktTargetSeason || "",
          });
          if (result?.status === "success") {
            setMessage(`Show match updated and the Trakt issue for ${showTitle} was resolved.`, "success");
          } else if (result?.status === "skipped") {
            setMessage(`Show match updated, but Trakt skipped the ${showTitle} update: ${result.details || "no Trakt destination is configured"}.`, "warning");
          } else if (result?.details) {
            setMessage(`Show match updated, but Trakt still needs attention for ${showTitle}: ${result.details}`, "warning");
          }
        } catch (error) {
          setMessage(`Show match updated, but the Trakt retry failed: ${error.message || String(error)}`, "error");
        }
      }, {
        headerTitle: `Fix show match · ${showTitle}`,
        currentTvdbId: fixMatch.dataset.syncActivityFixMatchCurrentTvdb || "",
        traktSourceSeason: fixMatch.dataset.syncActivityFixMatchSourceSeason || "",
        traktSourceEpisode: fixMatch.dataset.syncActivityFixMatchSourceEpisode || "",
        traktTargetSeason: "1",
        onSkipLabel: "Skip Trakt for now",
        onSkip: async () => {
          try {
            await callbacks.dismissSyncActivity?.(activityId);
            setMessage(`Skipped the Trakt error for ${showTitle} for now.`, "muted");
          } catch (error) {
            setMessage(`Could not skip the Trakt error for ${showTitle}: ${error.message || String(error)}`, "error");
          }
        },
      });
      return;
    }

    const retry = event.target.closest("[data-sync-activity-retry]");
    if (retry) {
      callbacks.retrySyncActivity?.(retry.dataset.syncActivityRetry)?.catch?.(() => { });
      return;
    }

    const older = event.target.closest("[data-sync-activity-group-more]");
    if (older) {
      older.disabled = true;
      older.textContent = "Loading older events...";
      callbacks.loadOlderSyncActivityGroup?.(older.dataset.syncActivityGroupMore, older.dataset.syncActivityGroupPage, older.dataset.syncActivityGroupLatestOnly)
        ?.catch?.((error) => setMessage(error.message || "Could not load older activity.", "error"));
      return;
    }

    const groupView = event.target.closest("[data-sync-activity-group-view]");
    if (groupView) {
      const key = groupView.dataset.syncActivityGroupKey;
      const latestOnly = groupView.dataset.syncActivityGroupView !== "history";
      callbacks.setSyncActivityGroupView?.(key, latestOnly)?.catch?.((error) => setMessage(error.message || "Could not change the activity view.", "error"));
      return;
    }

    const download = event.target.closest("[data-sync-activity-download]");
    if (download) {
      Promise.resolve(callbacks.downloadSyncActivityLog?.(download.dataset.syncActivityDownload))
        .then((downloaded) => {
          if (!downloaded) setMessage("That sync log is no longer available - refresh the page.", "error");
        })
        .catch((error) => setMessage(error.message || "Could not download the sync log.", "error"));
      return;
    }

    const titleLink = event.target.closest("[data-media-href]");
    if (titleLink?.dataset.mediaHref) {
      navigateTo(titleLink.dataset.mediaHref);
      return;
    }

    if (event.target.closest(".sync-activity-group-detail")) return;

    const row = event.target.closest(".sync-activity-row");
    if (row) callbacks.toggleSyncActivityRowLog?.(row);
  });

  elements.syncActivityRows?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest(".sync-activity-group-detail") || event.target.closest("button,[data-media-href]")) return;
    const row = event.target.closest(".sync-activity-group-row");
    if (!row) return;
    event.preventDefault();
    callbacks.toggleSyncActivityRowLog?.(row);
  });
}
