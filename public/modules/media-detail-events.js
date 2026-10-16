import { HIDE_EPISODE_SPOILERS_KEY, state } from "./state.js?v=2.0.0.3.4";
import { escapeAttribute, formatDate, showTitleFrom, showName, slug, movieHref, movieTmdbHref, tvShowBaseHrefFromEpisode, tvShowTmdbHref, tvShowTvdbHref, normalizePlatformSource } from "./utils.js?v=2.0.0.3.4";
import { isCachedStorageImageUrl, proxiedArtworkUrl, rememberPosterLookup } from "./images.js?v=2.0.0.3.4";
import { triggerRetrySync, loadSyncJobs, loadSyncHistory, showAvailIssuePopup, isWatchedHistoryAction } from "./sync.js?v=2.0.0.3.4";
import { movieBySlugOrId } from "./media-routing.js?v=2.0.0.3.4";
import { ifLoaded, lazyExport, loadRouteModules, loadedRouteModule } from "./route-modules.js?v=2.0.0.3.4";

// This module wires document-wide handlers that the dashboard and library
// pages use too, so it loads with the shell. Its route modules are therefore
// not imported statically (that pulled the whole ~700 KB detail graph onto
// every page). Actions load their module on first use (lazyExport); renders
// and patches only run when that module is already on the page (ifLoaded).
const lazyEdit = (name) => lazyExport("edit-dialogs", name);
const openEditDateDialog = lazyEdit("openEditDateDialog"), openEditShowDateDialog = lazyEdit("openEditShowDateDialog"), openEditImageDialog = lazyEdit("openEditImageDialog"), openFixMatchDialog = lazyEdit("openFixMatchDialog"), openMergeShowDialog = lazyEdit("openMergeShowDialog"), openEditSeasonDateDialog = lazyEdit("openEditSeasonDateDialog");
const applyArtworkToLocalWatchRecords = ifLoaded("edit-dialogs", "applyArtworkToLocalWatchRecords"), applyWatchedAtToLocalWatchRecord = ifLoaded("edit-dialogs", "applyWatchedAtToLocalWatchRecord");
// Synchronous; the edit-date branches load edit-dialogs before calling it.
const editDateOptionsFromButton = ifLoaded("edit-dialogs", "editDateOptionsFromButton", {});
const explorerTmdbCache = () => loadedRouteModule("explorer")?.resolvedTmdbCache;
const lazyWatch = (name) => lazyExport("watch-action", name);
const openWatchDatePrompt = lazyWatch("openWatchDatePrompt"), runResyncWatchAction = lazyWatch("runResyncWatchAction"), submitSeerrRequest = lazyWatch("submitSeerrRequest"), openSeerrSeasonRequestDialog = lazyWatch("openSeerrSeasonRequestDialog"), markMovieWatched = lazyWatch("markMovieWatched"), refreshShowAfterManualWatch = lazyWatch("refreshShowAfterManualWatch"), applyWatchDateChoice = lazyWatch("applyWatchDateChoice"), confirmAndMarkUnwatched = lazyWatch("confirmAndMarkUnwatched"), confirmAndDeleteMedia = lazyWatch("confirmAndDeleteMedia");
// The prompt these act on only exists once watch-action has opened it.
const closeWatchDatePrompt = ifLoaded("watch-action", "closeWatchDatePrompt"), toggleWatchDateIncludeSpecials = ifLoaded("watch-action", "toggleWatchDateIncludeSpecials"), toggleWatchDateIncludeUnreleased = ifLoaded("watch-action", "toggleWatchDateIncludeUnreleased");
// Synchronous; the watch-button branch loads watch-action before calling it.
const watchActionFromButton = ifLoaded("watch-action", "watchActionFromButton", null);
const renderExplorer = ifLoaded("explorer", "renderExplorer"), renderHistoryView = ifLoaded("explorer", "renderHistoryView"), refreshMovieExplorerInPlace = ifLoaded("explorer", "refreshMovieExplorerInPlace"), refreshHistoryViewInPlace = ifLoaded("explorer", "refreshHistoryViewInPlace");
const openShowInlineDetail = lazyExport("media-detail", "openShowInlineDetail"), ensureAllShowEpisodeDetailsForWatch = lazyExport("media-detail", "ensureAllShowEpisodeDetailsForWatch"), openHistoryDebugModal = lazyExport("media-detail", "openHistoryDebugModal"), openMediaInfoModal = lazyExport("media-detail", "openMediaInfoModal");
const closeMediaDetail = ifLoaded("media-detail", "closeMediaDetail"), renderImmersiveShowModal = ifLoaded("media-detail", "renderImmersiveShowModal"), renderShowModalContent = ifLoaded("media-detail", "renderShowModalContent"), patchShowModalEpisodeFromLive = ifLoaded("media-detail", "patchShowModalEpisodeFromLive"), scrollSeasonAccordionIntoView = ifLoaded("media-detail", "scrollSeasonAccordionIntoView"), renderMovieImmersiveModalContent = ifLoaded("media-detail", "renderMovieImmersiveModalContent"), patchMovieWatchedState = ifLoaded("media-detail", "patchMovieWatchedState");
const fetchWatchedMovieByTmdb = lazyExport("media-detail-movie", "fetchWatchedMovieByTmdb"), syncRewatchHistoryToggle = ifLoaded("media-detail-movie", "syncRewatchHistoryToggle");
const lazyPersonal = (name) => lazyExport("personal-media", name);
const addToWatchlist = lazyPersonal("addToWatchlist"), removeFromWatchlist = lazyPersonal("removeFromWatchlist"), openAddToListDialog = lazyPersonal("openAddToListDialog"), loadPersonalMedia = lazyPersonal("loadPersonalMedia");
const personalItemFromDetailDataset = ifLoaded("personal-media", "personalItemFromDetailDataset", {}), refreshRenderedPersonalMediaControls = ifLoaded("personal-media", "refreshRenderedPersonalMediaControls");
const lazyUpNext = (name) => lazyExport("up-next", name, ["dashboard"]);
const addShowToUpNext = lazyUpNext("addShowToUpNext");
const removeShowFromUpNext = lazyUpNext("removeShowFromUpNext");
const upNextAttentionOptions = ifLoaded("up-next", "upNextAttentionOptions", () => ({}));

// Callbacks injected by app-events.js (forwarded from app.js) to avoid circular imports.
let _cb = {};
export function initMediaDetailEvents(callbacks = {}) {
  _cb = callbacks;
}

const navigateTo = (...args) => _cb.navigateTo?.(...args);
const setMessage = (...args) => _cb.setMessage?.(...args);
const authHeaders = (...args) => _cb.authHeaders?.(...args);
const clearDerivedUiCaches = (...args) => _cb.clearDerivedUiCaches?.(...args);
const loadHistory = (...args) => _cb.loadHistory?.(...args);
const selectSettingsTab = (...args) => _cb.selectSettingsTab?.(...args);
const copyToClipboard = (...args) => _cb.copyToClipboard?.(...args);
const toggleSet = (...args) => _cb.toggleSet?.(...args);
const openConfirmDialog = (...args) => _cb.openConfirmDialog?.(...args);

function activeShowRecord() {
  if (state.activeShowTmdbId) {
    const byTmdb = state.showsRaw.find((show) => String(show.tmdb_id || "") === String(state.activeShowTmdbId));
    if (byTmdb) return byTmdb;
  }
  if (state.activeShowTvdbId) {
    const byTvdb = state.showsRaw.find((show) => String(show.tvdb_id || "") === String(state.activeShowTvdbId));
    if (byTvdb) return byTvdb;
  }
  return state.activeShowModalKey
    ? state.showsRaw.find((show) => slug(show.title) === state.activeShowModalKey)
    : null;
}

async function refreshActiveMovieAfterDateEdit(entry = null) {
  if (!state.activeMovieModalId) return;
  if (entry?.media_type && entry.media_type !== "movie") return;
  const title = entry?.title || document.querySelector(".immersive-title")?.textContent || "";
  const movie = await fetchWatchedMovieByTmdb(state.activeMovieTmdbId || entry?.tmdb_id || "", title);
  if (movie && state.activeMovieModalId) await renderMovieImmersiveModalContent(movie);
}

async function refreshActiveShowAfterDateEdit(entry = null) {
  if (!state.activeShowModalKey) return;
  if (entry?.media_type && entry.media_type !== "episode") return;
  const activeShow = activeShowRecord();
  const showTitle = entry?.show_title || (entry?.title ? showTitleFrom(entry.title) : "") || activeShow?.title || "";
  if (!showTitle) return;
  await refreshShowAfterManualWatch(showTitle);
  if (state.activeShowModalKey) {
    await renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
  }
}

async function refreshAfterWatchDateDeletion() {
  if (state.activeView === "history") {
    await loadHistory({ force: true, silent: true }).catch(() => null);
    renderHistoryView();
    return;
  }
  await refreshActiveDetailView();
}

function liveChangeValue(change = {}, camelName, snakeName = camelName) {
  return change[camelName] ?? change[snakeName];
}

function liveChangeKey(change = {}) {
  return String(liveChangeValue(change, "mediaKey", "media_key") || "").trim();
}

async function fetchLiveHistoryItemByRecordId(recordId) {
  const normalizedId = String(recordId || "").trim();
  if (!normalizedId) return null;
  try {
    const response = await fetch(`/api/history?id=${encodeURIComponent(normalizedId)}`, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return null;
    return { row: body.row || null, progress: body.progress || null };
  } catch {
    return null;
  }
}

function historyRowMatchesLiveChange(row = {}, change = {}) {
  const mediaKey = liveChangeKey(change);
  const recordId = String(liveChangeValue(change, "recordId", "record_id") || "");
  if (mediaKey && String(row.media_key || "") === mediaKey) return true;
  if (recordId && String(row.id || "") === recordId) return true;
  const season = liveChangeValue(change, "season");
  const episode = liveChangeValue(change, "episode");
  const mediaType = String(liveChangeValue(change, "mediaType", "media_type") || "").toLowerCase();
  return mediaType === "episode"
    && season != null
    && episode != null
    && Number(row.season) === Number(season)
    && Number(row.episode) === Number(episode)
    && slug(showTitleFrom(row.show_title || row.title || "")) === slug(showTitleFrom(liveChangeValue(change, "showTitle", "show_title") || ""));
}

function liveTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// A provider can acknowledge an old played bit after Plekt has already
// recorded a newer local unwatch. Keep that stale watched row out of both the
// dashboard history and the lightweight show summaries; patchShowModalEpisodeFromLive
// applies the same rule to the mounted detail card.
function liveWatchedRowBlockedByTombstone(row, change = {}) {
  if (!row || !isWatchedHistoryAction(row) || normalizePlatformSource(row.source) === "plembfin") return false;

  const mediaKey = liveChangeKey(change) || String(row.media_key || "");
  const season = liveChangeValue(change, "season") ?? row.season;
  const episode = liveChangeValue(change, "episode") ?? row.episode;
  const rowShowTitle = row.show_title
    || showTitleFrom(row.title || "")
    || liveChangeValue(change, "showTitle", "show_title")
    || "";
  const rowTime = liveTimestamp(row.watched_at);

  for (const show of state.showsRaw || []) {
    if (rowShowTitle && slug(showTitleFrom(show.title || "")) !== slug(showTitleFrom(rowShowTitle))) continue;
    const tombstone = (show.episodes || []).find((candidate) => {
      if (isWatchedHistoryAction(candidate)) return false;
      if (mediaKey && String(candidate.media_key || "") === mediaKey) return true;
      return Boolean(rowShowTitle)
        && season != null
        && episode != null
        && Number(candidate.season) === Number(season)
        && Number(candidate.episode) === Number(episode);
    });
    if (!tombstone) continue;

    const tombstoneTime = liveTimestamp(tombstone.watched_at);
    // Missing timestamps are not enough evidence to overrule a local unwatch.
    // A strictly later provider watch is a new decision and remains allowed.
    return rowTime == null || tombstoneTime == null || rowTime <= tombstoneTime;
  }
  return false;
}

function mergeLiveHistoryState({ change = {}, row = null, progress = null } = {}) {
  const sourceTable = String(liveChangeValue(change, "sourceTable", "source_table") || "");
  const mediaKey = liveChangeKey(change) || String(row?.media_key || progress?.media_key || "");
  const matches = (candidate) => (
    (mediaKey && String(candidate.media_key || "") === mediaKey)
      || historyRowMatchesLiveChange(candidate, change)
  );

  if (sourceTable !== "playback_progress") {
    const currentIndex = state.history.findIndex(matches);
    const blockedByLocalTombstone = row && isWatchedHistoryAction(row)
      ? liveWatchedRowBlockedByTombstone(row, change)
      : false;
    if (row && isWatchedHistoryAction(row) && !blockedByLocalTombstone) {
      const current = currentIndex >= 0 ? state.history[currentIndex] : {};
      const next = { ...current, ...row };
      if (currentIndex >= 0) state.history[currentIndex] = next;
      else state.history.unshift(next);
    } else if (blockedByLocalTombstone || currentIndex >= 0 || String(liveChangeValue(change, "changeKind", "change_kind") || "") === "delete") {
      state.history = state.history.filter((candidate) => !matches(candidate));
    }
    state.history.sort((left, right) => String(right.watched_at || "").localeCompare(String(left.watched_at || "")));
  }

  if (sourceTable === "playback_progress") {
    const progressKey = mediaKey;
    const progressMatches = (candidate) => (
      (progressKey && String(candidate.media_key || "") === progressKey)
        || (progress?.season != null && progress?.episode != null
          && Number(candidate.season) === Number(progress.season)
          && Number(candidate.episode) === Number(progress.episode)
          && slug(showTitleFrom(candidate.show_title || candidate.title || "")) === slug(showTitleFrom(progress.title || "")))
    );
    const progressIndex = state.partWatchedRaw.findIndex(progressMatches);
    if (progress && Number(progress.progress || 0) > 0) {
      const current = progressIndex >= 0 ? state.partWatchedRaw[progressIndex] : {};
      const next = { ...current, ...progress };
      if (progressIndex >= 0) state.partWatchedRaw[progressIndex] = next;
      else state.partWatchedRaw.unshift(next);
    } else if (progressIndex >= 0) {
      state.partWatchedRaw = state.partWatchedRaw.filter((candidate) => !progressMatches(candidate));
    }
  }

  if (row?.media_type !== "episode") return;
  const rowShowTitle = row.show_title || showTitleFrom(row.title || "");
  const blockedByLocalTombstone = isWatchedHistoryAction(row)
    ? liveWatchedRowBlockedByTombstone(row, change)
    : false;
  for (const show of state.showsRaw) {
    if (rowShowTitle && slug(showTitleFrom(show.title || "")) !== slug(showTitleFrom(rowShowTitle))) continue;
    if (!Array.isArray(show.episodes)) continue;
    const episodeIndex = show.episodes.findIndex((episode) => (
      (mediaKey && String(episode.media_key || "") === mediaKey)
        || (Number(episode.season) === Number(row.season) && Number(episode.episode) === Number(row.episode))
    ));
    if (isWatchedHistoryAction(row) && !blockedByLocalTombstone) {
      if (episodeIndex >= 0) show.episodes[episodeIndex] = { ...show.episodes[episodeIndex], ...row };
      else show.episodes.push(row);
    } else if (!isWatchedHistoryAction(row) && episodeIndex >= 0) {
      show.episodes.splice(episodeIndex, 1);
    }
  }
}

async function fetchLiveHistoryItems(changes = []) {
  const keyed = changes.filter((change) => liveChangeKey(change));
  const unkeyed = changes.filter((change) => !liveChangeKey(change) && liveChangeValue(change, "recordId", "record_id"));
  const items = [];
  const batchSize = 100;
  for (let offset = 0; offset < keyed.length; offset += batchSize) {
    const batch = keyed.slice(offset, offset + batchSize);
    const url = new URL("/api/history", window.location.origin);
    for (const change of batch) url.searchParams.append("mediaKey", liveChangeKey(change));
    try {
      const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) continue;
      const byKey = new Map((Array.isArray(body.items) ? body.items : []).map((item) => [String(item.mediaKey || ""), item]));
      await Promise.all(batch.map(async (change) => {
        const item = byKey.get(liveChangeKey(change));
        let row = item?.row || null;
        let progress = item?.progress || null;
        const recordId = liveChangeValue(change, "recordId", "record_id");
        // Identity repair can rewrite a provider episode key after the SSE
        // journal has recorded it. Resolve the canonical row by its durable
        // history id when the keyed lookup has already gone stale.
        if (!row && !progress && recordId) {
          const fallback = await fetchLiveHistoryItemByRecordId(recordId);
          row = fallback?.row || null;
          progress = fallback?.progress || null;
        }
        items.push({ change, row, progress });
      }));
    } catch {
      // A transient item request should not turn the live stream into a page
      // refresh. The next canonical mutation will carry the item again.
    }
  }
  await Promise.all(unkeyed.map(async (change) => {
    const recordId = String(liveChangeValue(change, "recordId", "record_id") || "");
    const item = await fetchLiveHistoryItemByRecordId(recordId);
    if (item) items.push({ change, ...item });
  }));
  return items;
}

// Reconcile only the media keys named by the SSE journal. This is deliberately
// separate from refreshActiveDetailView(), whose full show render is still
// useful after a manual date edit but is too broad for a background tick.
export async function applyLiveHistoryChanges(changes = []) {
  const normalized = Array.isArray(changes) ? changes.filter((change) => change && typeof change === "object") : [];
  if (!normalized.length) return 0;
  const items = await fetchLiveHistoryItems(normalized);
  for (const item of items) {
    mergeLiveHistoryState(item);
    patchShowModalEpisodeFromLive(item);
    if (item.row?.media_type === "movie" && isWatchedHistoryAction(item.row)) {
      patchMovieWatchedState(item.row);
    }
  }
  return items.length;
}

// An open movie/show detail page renders from its own fetched record, so a
// history-version bump on the live-updates stream leaves it showing rows that
// no longer exist - a watch date removed in this tab, in another tab, or by a
// sync. Reconcile it from the same refetch the date-edit dialog uses; both
// helpers no-op when their detail view is not the one on screen.
export async function refreshActiveDetailView() {
  await refreshActiveMovieAfterDateEdit().catch(() => null);
  await refreshActiveShowAfterDateEdit().catch(() => null);
}

function mediaForceSyncAvailableSeasons(button) {
  const raw = button.dataset.forceSyncSeasons || "";
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.split(":"))
    .map(([number, episodeCount]) => ({ number: Number(number), episodeCount: Number(episodeCount) || 0 }))
    .filter((season) => Number.isFinite(season.number) && season.number > 0);
}

function mediaForceSyncPayload(button) {
  const payload = {
    type: button.dataset.forceSyncType || "movie",
    title: button.dataset.forceSyncTitle || "",
    tmdb_id: button.dataset.forceSyncTmdbId || "",
    tvdb_id: button.dataset.forceSyncTvdbId || "",
    imdb_id: button.dataset.forceSyncImdbId || "",
  };
  const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== ""));
  clean.availableSeasons = mediaForceSyncAvailableSeasons(button);
  return clean;
}

let mediaForceSyncSession = null;

function forceSyncElements(scope = "media") {
  const library = scope === "library";
  const prefix = library ? "settingsForceSync" : "mediaForceSync";
  const id = (suffix) => `#${prefix}${suffix}`;
  return {
    scope,
    container: document.querySelector(library ? "#settingsForceSyncPanel" : "#mediaForceSyncModal"),
    modal: library ? null : document.querySelector("#mediaForceSyncModal"),
    title: library ? null : document.querySelector("#mediaForceSyncModalTitle"),
    description: library ? null : document.querySelector("#mediaForceSyncModalDescription"),
    close: library ? null : document.querySelector("#closeMediaForceSyncModalButton"),
    activity: document.querySelector(id("Activity")),
    activityState: document.querySelector(id("ActivityState")),
    terminal: document.querySelector(id("Terminal")),
    progress: document.querySelector(id("Progress")),
    progressLabel: document.querySelector(id("ProgressLabel")),
    progressMeta: document.querySelector(id("ProgressMeta")),
    progressTrack: document.querySelector(id("ProgressTrack")),
    progressFill: document.querySelector(id("ProgressFill")),
    pushTarget: document.querySelector(id("PushTarget")),
    pullSource: document.querySelector(id("PullSource")),
    ratingTarget: library ? null : document.querySelector("#mediaForceSyncRatingTarget"),
    ratingButton: library ? null : document.querySelector("[data-media-rating-sync-run]"),
    seasons: document.querySelector(id("Seasons")),
    seasonsList: document.querySelector(id("SeasonsList")),
    cancel: document.querySelector(id("CancelButton")),
    runSelector: library ? "[data-library-force-sync-run]" : "[data-media-force-sync-run]",
  };
}

function mediaForceSyncElements() {
  return forceSyncElements("media");
}

function libraryForceSyncElements() {
  return forceSyncElements("library");
}

function mediaForceSyncModeLabel(mode = "push") {
  return mode === "pull" ? "Import Watched Status" : "Set Plekt as Source of Truth";
}

function mediaForceSyncServerLabel(server = "all") {
  if (server === "all" || !server) return "all connected servers";
  return server.charAt(0).toUpperCase() + server.slice(1);
}

function mediaForceSyncEndpoint(payload = {}, status = false) {
  const scope = payload.type === "library" ? "library" : "media";
  return status ? `/api/force-sync/${scope}/status` : `/api/force-sync/${scope}`;
}

function resetMediaForceSyncActivity(elements) {
  elements.activity?.classList.add("hidden");
  if (elements.terminal) elements.terminal.textContent = "";
  if (elements.activityState) elements.activityState.textContent = "Ready";
  elements.progress?.classList.add("hidden");
  if (elements.progressLabel) elements.progressLabel.textContent = "Preparing operation";
  if (elements.progressMeta) elements.progressMeta.textContent = "";
  if (elements.progressTrack) elements.progressTrack.setAttribute("aria-valuenow", "0");
  if (elements.progressFill) elements.progressFill.style.transform = "scaleX(0)";
  if (elements.cancel) {
    elements.cancel.classList.add("hidden");
    elements.cancel.disabled = false;
    elements.cancel.textContent = "Cancel operation";
    elements.cancel.removeAttribute("aria-busy");
  }
}

function setMediaForceSyncControlsBusy(elements, busy) {
  const root = elements.container || elements.modal;
  const runSelector = elements.runSelector || "[data-media-force-sync-run]";
  root?.querySelectorAll(`${runSelector}, select`).forEach((control) => {
    control.disabled = busy;
  });
  if (elements.close) {
    elements.close.textContent = busy ? "Running…" : "Close";
    elements.close.setAttribute("aria-disabled", String(busy));
  }
  if (elements.cancel) {
    elements.cancel.classList.toggle("hidden", !busy);
    elements.cancel.disabled = false;
    elements.cancel.textContent = "Cancel operation";
    elements.cancel.removeAttribute("aria-busy");
  }
}

function renderMediaForceSyncActivity(activity, targetElements = null) {
  const elements = targetElements || mediaForceSyncElements();
  if (!activity) return;
  elements.activity?.classList.remove("hidden");
  const lines = (activity.lines || []).map((line) => {
    const stamp = line.at ? new Date(line.at).toLocaleTimeString() : "--:--:--";
    const level = String(line.level || "info").toUpperCase().padEnd(7, " ");
    return `[${stamp}] ${level} ${line.text || ""}`;
  });
  if (elements.terminal) {
    elements.terminal.textContent = lines.join("\n");
    elements.terminal.scrollTop = elements.terminal.scrollHeight;
  }

  const status = activity.status || "running";
  const statusLabel = status === "completed" ? "Complete" : status === "cancelled" ? "Cancelled" : status === "error" ? "Failed" : "Live output";
  if (elements.activityState) elements.activityState.textContent = statusLabel;
  if (elements.progressLabel) {
    elements.progressLabel.textContent = status === "running"
      ? `${mediaForceSyncModeLabel(activity.meta?.mode)} in progress`
      : status === "completed" ? "Operation complete" : status === "cancelled" ? "Operation cancelled" : "Operation stopped with an error";
  }
  if (elements.progressMeta) elements.progressMeta.textContent = `${lines.length} log line${lines.length === 1 ? "" : "s"}`;
  elements.progress?.classList.remove("hidden");
  elements.progress?.setAttribute("data-status", status);
  const progressValue = ["completed", "cancelled", "error"].includes(status) ? 100 : 18;
  if (elements.progressTrack) elements.progressTrack.setAttribute("aria-valuenow", String(progressValue));
  if (elements.progressFill) elements.progressFill.style.transform = `scaleX(${progressValue / 100})`;
}

function waitForMediaForceSyncPoll() {
  return new Promise((resolve) => setTimeout(resolve, 650));
}

function closeMediaForceSyncDialog() {
  const elements = mediaForceSyncElements();
  if (mediaForceSyncSession?.running) return;
  elements.modal?.classList.add("hidden");
}

function renderMediaForceSyncSeasons(elements, availableSeasons = []) {
  if (!elements.seasons || !elements.seasonsList) return;
  if (!availableSeasons.length) {
    elements.seasons.classList.add("hidden");
    elements.seasonsList.innerHTML = "";
    return;
  }
  elements.seasons.classList.remove("hidden");
  elements.seasonsList.innerHTML = availableSeasons.map((season) => `
    <label class="media-force-sync-season-pill">
      <input type="checkbox" value="${season.number}" data-media-force-sync-season />
      <span>Season ${season.number}${season.episodeCount ? ` <small>(${season.episodeCount} eps)</small>` : ""}</span>
    </label>
  `).join("");
}

function selectedMediaForceSyncSeasons(elements) {
  if (!elements.seasonsList) return [];
  return [...elements.seasonsList.querySelectorAll("[data-media-force-sync-season]:checked")].map((input) => Number(input.value));
}

function openMediaForceSyncDialog(button) {
  if (mediaForceSyncSession?.running) return;
  const elements = mediaForceSyncElements();
  if (!elements.modal) {
    setMessage("Force Sync options are unavailable until the page finishes loading.", "error");
    return;
  }
  const payload = mediaForceSyncPayload(button);
  mediaForceSyncSession = { button, payload, elements, running: false, operationId: "", cancelRequested: false, cancelling: false };
  if (elements.title) elements.title.textContent = `Force Sync · ${payload.title}`;
  if (elements.pushTarget) elements.pushTarget.value = "all";
  if (elements.pullSource) elements.pullSource.value = "all";
  if (elements.ratingTarget) elements.ratingTarget.value = "all";
  renderMediaForceSyncSeasons(elements, payload.type === "show" ? payload.availableSeasons : []);
  resetMediaForceSyncActivity(elements);
  setMediaForceSyncControlsBusy(elements, false);
  elements.modal.classList.remove("hidden");
  elements.modal.querySelector("[data-media-force-sync-run=push]")?.focus();
}

function prepareLibraryForceSyncSession() {
  if (mediaForceSyncSession?.running) return mediaForceSyncSession;
  const elements = libraryForceSyncElements();
  if (!elements.container) {
    setMessage("Force Sync options are unavailable until the page finishes loading.", "error");
    return null;
  }
  if (mediaForceSyncSession?.payload?.type === "library" && mediaForceSyncSession.elements?.container === elements.container) {
    return mediaForceSyncSession;
  }
  const payload = { type: "library", title: "All media" };
  mediaForceSyncSession = { button: null, payload, elements, running: false, operationId: "", cancelRequested: false, cancelling: false };
  if (elements.pushTarget) elements.pushTarget.value = "all";
  if (elements.pullSource) elements.pullSource.value = "all";
  resetMediaForceSyncActivity(elements);
  setMediaForceSyncControlsBusy(elements, false);
  return mediaForceSyncSession;
}

export function initLibraryForceSyncPanel() {
  const elements = libraryForceSyncElements();
  if (!elements.container || elements.container.dataset.bound === "1") return;
  elements.container.dataset.bound = "1";
  prepareLibraryForceSyncSession();
  elements.container.addEventListener("click", (event) => {
    const button = event.target.closest(elements.runSelector);
    if (!button || mediaForceSyncSession?.running) return;
    event.preventDefault();
    prepareLibraryForceSyncSession();
    confirmAndRunMediaForceSync(button.dataset.libraryForceSyncRun).catch((error) => setMessage(error.message, "error"));
  });
}

function forceSyncConfirmation(mode, session, elements) {
  const title = session.payload.type === "library" ? "the full library" : `"${session.payload.title}"`;
  const selectedSeasons = selectedMediaForceSyncSeasons(elements);
  const seasonScope = selectedSeasons.length
    ? ` (season${selectedSeasons.length === 1 ? "" : "s"} ${selectedSeasons.join(", ")} only)`
    : "";
  if (mode === "push") {
    const progress = session.payload.type === "library" ? " and saved resume positions" : "";
    return `This will send Plekt's currently recorded watched state${progress} for ${title}${seasonScope} to ${mediaForceSyncServerLabel(elements.pushTarget?.value || "all")}, overwriting whatever it currently shows. Nothing is checked or pulled in first. If Plekt's own record is wrong, this sends that wrong state out too. Continue?`;
  }
  return `This will read watched status for ${title}${seasonScope} from ${mediaForceSyncServerLabel(elements.pullSource?.value || "all")} and add anything Plekt doesn't already have. Nothing is sent back out, and nothing is marked unwatched or removed. Continue?`;
}

function mediaRatingSyncLabel(target = "all") {
  if (target === "all" || !target) return "all enabled rating providers";
  return target.charAt(0).toUpperCase() + target.slice(1);
}

function mediaRatingSyncPayload(payload = {}) {
  const item = {
    media_type: payload.type === "show" ? "tv" : payload.type,
    title: payload.title || "",
    tmdb_id: payload.tmdb_id || "",
    tvdb_id: payload.tvdb_id || "",
    imdb_id: payload.imdb_id || "",
  };
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== ""));
}

async function confirmAndRunMediaRatingSync() {
  const session = mediaForceSyncSession;
  if (!session || session.running || session.ratingRunning || session.confirmingRating) return;
  const elements = session.elements || mediaForceSyncElements();
  const target = elements.ratingTarget?.value || "all";
  session.confirmingRating = true;
  try {
    const confirmed = await openConfirmDialog({
      title: "Confirm Push Personal Rating",
      body: `This will send Plekt's personal rating for "${session.payload.title}" to ${mediaRatingSyncLabel(target)}. It will not change watched status, play history, resume positions, or lists. Continue?`,
      confirmLabel: "Push rating",
      cancelLabel: "Cancel",
    });
    if (confirmed && mediaForceSyncSession === session) await runMediaRatingSync();
  } finally {
    session.confirmingRating = false;
  }
}

async function runMediaRatingSync() {
  const session = mediaForceSyncSession;
  if (!session || session.running || session.ratingRunning) return;
  const elements = session.elements || mediaForceSyncElements();
  const target = elements.ratingTarget?.value || "all";
  const button = elements.ratingButton;
  const payload = mediaRatingSyncPayload(session.payload);
  if (!payload.title && !payload.tmdb_id && !payload.tvdb_id && !payload.imdb_id) {
    setMessage("This item does not have enough identity data to push a personal rating.", "error");
    return;
  }
  session.ratingRunning = true;
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  if (elements.ratingTarget) elements.ratingTarget.disabled = true;
  setMessage(`Pushing personal rating for ${session.payload.title} separately from watched-state Force Sync…`, "muted");
  try {
    const response = await fetch("/api/rating-sync/push", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ providers: target === "all" ? [] : [target], items: [payload] }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `Personal rating push failed with ${response.status}`);
    if (body.status === "disabled") {
      setMessage("Personal Rating Sync is disabled. Enable it in Settings → Sync Tools first.", "muted");
    } else if (Number(body.items || 0) === 0) {
      setMessage("No local Plekt personal rating exists for this title, so nothing was pushed.", "muted");
    } else if (Number(body.queued || 0) === 0) {
      setMessage(`No enabled send direction is configured for ${mediaRatingSyncLabel(target)}.`, "muted");
    } else {
      setMessage(`Personal rating push completed for ${session.payload.title} via ${mediaRatingSyncLabel(target)}. Watched state was not changed.`, "success");
      await loadPersonalMedia({ force: true }).catch(() => null);
    }
  } catch (error) {
    setMessage(error.message || "Personal rating push failed", "error");
  } finally {
    session.ratingRunning = false;
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
    if (elements.ratingTarget) elements.ratingTarget.disabled = false;
  }
}

async function confirmAndRunMediaForceSync(mode) {
  const session = mediaForceSyncSession;
  if (!session || session.running || session.confirming) return;
  const elements = session.elements || mediaForceSyncElements();
  session.confirming = true;
  try {
    const confirmed = await openConfirmDialog({
      title: `Confirm ${mediaForceSyncModeLabel(mode)}`,
      body: forceSyncConfirmation(mode, session, elements),
      confirmLabel: "Start",
      cancelLabel: "Cancel",
    });
    if (!confirmed || mediaForceSyncSession !== session) return;
    await runMediaForceSync(mode);
  } finally {
    session.confirming = false;
  }
}

async function sendMediaForceSyncCancellation(session) {
  const response = await fetch(`${mediaForceSyncEndpoint(session.payload)}/cancel`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ id: session.operationId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || `Cancellation failed with ${response.status}`);
  return body;
}

async function cancelMediaForceSync() {
  const session = mediaForceSyncSession;
  if (!session?.running || session.cancelling) return;
  const elements = session.elements || mediaForceSyncElements();
  session.cancelRequested = true;
  session.cancelling = true;
  if (elements.cancel) {
    elements.cancel.disabled = true;
    elements.cancel.textContent = "Cancelling...";
    elements.cancel.setAttribute("aria-busy", "true");
  }
  if (!session.operationId) {
    setMessage("Cancellation requested; waiting for the operation to start...", "muted");
    return;
  }
  try {
    await sendMediaForceSyncCancellation(session);
    setMessage("Cancellation requested...", "muted");
  } catch (error) {
    session.cancelRequested = false;
    session.cancelling = false;
    if (elements.cancel) {
      elements.cancel.disabled = false;
      elements.cancel.textContent = "Cancel operation";
      elements.cancel.removeAttribute("aria-busy");
    }
    setMessage(`Unable to cancel Force Sync: ${error.message || String(error)}`, "error");
  }
}

async function finishMediaForceSyncOperation(payload, activity, error = "") {
  const session = mediaForceSyncSession;
  if (!session) return;
  session.running = false;
  session.cancelling = false;
  session.cancelRequested = false;
  const elements = session.elements || mediaForceSyncElements();
  renderMediaForceSyncActivity(activity, elements);
  setMediaForceSyncControlsBusy(elements, false);
  if (session.button?.isConnected) {
    session.button.disabled = false;
    session.button.removeAttribute("aria-busy");
  }
  if (error || activity?.status === "error") {
    setMessage(`Force Sync failed: ${error || activity?.error || "operation failed"}`, "error");
    return;
  }

  const result = activity?.result || {};
  clearDerivedUiCaches({ resetExplorer: false });
  await loadHistory({ force: true }).catch(() => null);
  mergeForceSyncRecords(result.records);
  await refreshMediaAfterForceSync(payload, result);

  if (activity?.status === "cancelled" || result.cancelled) {
    setMessage(`${mediaForceSyncModeLabel(payload.mode)} cancelled after ${Number(result.results?.length || 0)} item${Number(result.results?.length || 0) === 1 ? "" : "s"}.`, "muted");
    return;
  }

  if (payload.mode === "pull") {
    setMessage(`Import completed: found ${Number(result.found || 0)} watched item${Number(result.found || 0) === 1 ? "" : "s"}; added ${Number(result.imported || 0)} to Plekt.`, "success");
  } else {
    const progressMessage = payload.type === "library" && Number(result.progressSynced || 0) > 0
      ? ` ${Number(result.progressSynced)} resume position${Number(result.progressSynced) === 1 ? "" : "s"} also sent.`
      : "";
    setMessage(`Push completed to ${mediaForceSyncServerLabel(payload.push_to || "all")}: ${Number(result.synced || 0)} item${Number(result.synced || 0) === 1 ? "" : "s"} processed.${progressMessage}`, "success");
  }
}

async function pollMediaForceSync(operationId, payload) {
  let missingAttempts = 0;
  while (mediaForceSyncSession?.operationId === operationId) {
    const response = await fetch(`${mediaForceSyncEndpoint(payload, true)}?id=${encodeURIComponent(operationId)}`, { headers: authHeaders(), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (response.status === 404 && missingAttempts < 5) {
      missingAttempts += 1;
      await waitForMediaForceSyncPoll();
      continue;
    }
    if (!response.ok || body.ok === false) throw new Error(body.error || `Force Sync status failed with ${response.status}`);
    missingAttempts = 0;
    renderMediaForceSyncActivity(body, mediaForceSyncSession?.elements);
    if (["completed", "cancelled", "error"].includes(body.status)) {
      await finishMediaForceSyncOperation(payload, body, body.error || "");
      return;
    }
    await waitForMediaForceSyncPoll();
  }
}

async function runMediaForceSync(mode) {
  const session = mediaForceSyncSession;
  if (!session || session.running) return;
  const elements = session.elements || mediaForceSyncElements();
  const payload = { ...session.payload, mode };
  delete payload.availableSeasons;
  const pushTarget = elements.pushTarget?.value || "all";
  const pullSource = elements.pullSource?.value || "all";
  if (mode === "push" && pushTarget !== "all") payload.push_to = pushTarget;
  if (mode === "pull" && pullSource !== "all") payload.pull_from = pullSource;
  const selectedSeasons = selectedMediaForceSyncSeasons(elements);
  if (selectedSeasons.length) payload.seasons = selectedSeasons;
  session.running = true;
  setMediaForceSyncControlsBusy(elements, true);
  if (session.button) {
    session.button.disabled = true;
    session.button.setAttribute("aria-busy", "true");
  }
  elements.activity?.classList.remove("hidden");
  if (elements.terminal) elements.terminal.textContent = `[client] Starting ${mediaForceSyncModeLabel(mode)} for ${payload.title}…`;
  if (elements.activityState) elements.activityState.textContent = "Starting";
  setMessage(`${mediaForceSyncModeLabel(mode)} ${payload.title}…`, "muted");

  try {
    const response = await fetch(mediaForceSyncEndpoint(payload), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `Force Sync failed with ${response.status}`);
    session.operationId = body.operationId;
    if (session.cancelRequested) {
      try {
        await sendMediaForceSyncCancellation(session);
      } catch (error) {
        session.cancelRequested = false;
        session.cancelling = false;
        if (elements.cancel) {
          elements.cancel.disabled = false;
          elements.cancel.textContent = "Cancel operation";
          elements.cancel.removeAttribute("aria-busy");
        }
        setMessage(`Unable to cancel Force Sync: ${error.message || String(error)}`, "error");
      }
    }
    await pollMediaForceSync(body.operationId, payload);
  } catch (error) {
    const message = error.message || String(error);
    await finishMediaForceSyncOperation(payload, {
      status: "error",
      error: message,
      lines: [{ at: Date.now(), level: "error", text: message }],
    }, message);
  }
}

function mergeForceSyncRecords(records = []) {
  if (!Array.isArray(records) || !records.length) return;
  const historyById = new Map((state.history || []).filter((row) => row?.id).map((row) => [String(row.id), row]));
  for (const record of records) {
    if (record?.id) historyById.set(String(record.id), record);
  }
  state.history = [...historyById.values()];
}

async function refreshMediaAfterForceSync(payload, body) {
  if (payload.type === "library") return;
  const records = Array.isArray(body.records) ? body.records : [];
  if (payload.type === "show") {
    if (state.activeShowModalKey) {
      await renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode);
    } else if (state.activeShowRenderContext?.show) {
      renderShowModalContent(state.activeShowRenderContext.show, {
        ...state.activeShowRenderContext,
        activeSeasonNum: state.activeShowModalSeason,
      });
    }
    return;
  }

  const movieRecord = records.find((record) => record?.media_type === "movie")
    || state.history.find((record) => record?.media_type === "movie" && (
      (payload.tmdb_id && String(record.tmdb_id || "") === String(payload.tmdb_id))
      || (payload.title && String(record.title || "").trim().toLowerCase() === String(payload.title).trim().toLowerCase())
    ));
  const tmdbId = movieRecord?.tmdb_id || payload.tmdb_id || state.activeMovieTmdbId || "";
  if (!movieRecord && !tmdbId) return;
  if (state.activeMovieTmdbId && tmdbId && String(state.activeMovieTmdbId) !== String(tmdbId)) return;
  const movie = await fetchWatchedMovieByTmdb(tmdbId, movieRecord?.title || payload.title);
  if (movie) {
    await renderMovieImmersiveModalContent(movie);
  } else if (movieRecord) {
    await renderMovieImmersiveModalContent(movieRecord);
  }
}

// Click delegation for the media-detail modal / immersive views: cast,
// trailers, poster/date/match editing, watch actions, and card navigation.
// Extracted verbatim from app-events.js's attachEvents() (was a single
// ~520-line addEventListener callback) to keep app-events.js under the
// module size limit; behavior is unchanged.
export function attachMediaDetailEvents() {
  document.addEventListener("change", (event) => {
    const includeSpecialsToggle = event.target.closest("[data-watch-date-include-specials]");
    if (includeSpecialsToggle) {
      toggleWatchDateIncludeSpecials(includeSpecialsToggle.checked);
      return;
    }

    const includeUnreleasedToggle = event.target.closest("[data-watch-date-include-unreleased]");
    if (includeUnreleasedToggle) {
      toggleWatchDateIncludeUnreleased(includeUnreleasedToggle.checked);
      return;
    }

    const spoilerToggle = event.target.closest("[data-hide-episode-spoilers]");
    if (!spoilerToggle) return;
    state.hideEpisodeSpoilers = spoilerToggle.checked;
    localStorage.setItem(HIDE_EPISODE_SPOILERS_KEY, String(spoilerToggle.checked));
    const ctx = state.activeShowRenderContext;
    if (ctx?.show) {
      renderShowModalContent(ctx.show, {
        ...ctx,
        activeSeasonNum: state.activeShowModalSeason,
        activeEpisodeNum: state.activeShowModalEpisode,
      });
    }
  });

  document.addEventListener("click", async (event) => {
    // The poster overflow button (poster-menu.js) sits inside card anchors
    // like [data-history-id]/.movie-card so it can be positioned over the
    // poster. Bail out before the card-navigation logic below fires, or
    // clicking the three dots would navigate to the media page instead of
    // opening the menu.
    if (event.target.closest(".poster-overflow-btn")) return;

    const upNextShowButton = event.target.closest("[data-up-next-show-add]");
    if (upNextShowButton) {
      event.preventDefault();
      event.stopPropagation();
      const remove = upNextShowButton.dataset.upNextShowAction === "remove";
      const request = remove
        ? openConfirmDialog({
            title: "Remove from Up Next",
            body: `Remove "${upNextShowButton.dataset.upNextShowTitle || "this show"}" from Up Next?`,
            confirmLabel: "Remove from Up Next",
            danger: true,
          }).then((confirmed) => confirmed ? removeShowFromUpNext(upNextShowButton) : null)
        : addShowToUpNext(upNextShowButton);
      request.catch((error) => setMessage(error.message, "error", upNextAttentionOptions(error, remove ? "remove" : "add")));
      return;
    }

    // Options is always a popup menu, so close it when a click lands outside it.
    const openDropdowns = document.querySelectorAll("#mediaDetailActions .actions-tools-dropdown[open]");
    for (const dropdown of openDropdowns) {
      if (!dropdown.contains(event.target)) {
        dropdown.removeAttribute("open");
      }
    }

    const posterLightbox = event.target.closest(".immersive-poster-img[data-lightbox-src]");
    if (posterLightbox) {
      window.openPhotoLightbox([posterLightbox.dataset.lightboxSrc], 0);
      return;
    }

    const mediaImageCard = event.target.closest(".media-image-card[data-lightbox-src]");
    if (mediaImageCard) {
      const row = mediaImageCard.closest(".media-images-scroll-row");
      const cards = row ? [...row.querySelectorAll(".media-image-card[data-lightbox-src]")] : [mediaImageCard];
      const srcs = cards.map((c) => c.dataset.lightboxSrc);
      const index = parseInt(mediaImageCard.dataset.lightboxIndex, 10) || 0;
      window.openPhotoLightbox(srcs, index);
      return;
    }

    const retryBtn = event.target.closest("[data-retry-sync-id]");
    if (retryBtn) {
      triggerRetrySync(retryBtn.dataset.retrySyncId, retryBtn).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const forceSyncCancelButton = event.target.closest("[data-force-sync-cancel]");
    if (forceSyncCancelButton) {
      event.preventDefault();
      cancelMediaForceSync().catch((error) => setMessage(error.message, "error"));
      return;
    }

    const ratingSyncRunButton = event.target.closest("[data-media-rating-sync-run]");
    if (ratingSyncRunButton) {
      event.preventDefault();
      confirmAndRunMediaRatingSync().catch((error) => setMessage(error.message, "error"));
      return;
    }

    const forceSyncRunButton = event.target.closest("[data-media-force-sync-run]");
    if (forceSyncRunButton) {
      event.preventDefault();
      confirmAndRunMediaForceSync(forceSyncRunButton.dataset.mediaForceSyncRun).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const forceSyncCloseButton = event.target.closest("#closeMediaForceSyncModalButton");
    if (forceSyncCloseButton) {
      event.preventDefault();
      closeMediaForceSyncDialog();
      return;
    }

    if (event.target === document.querySelector("#mediaForceSyncModal")) {
      closeMediaForceSyncDialog();
      return;
    }

    const personalAction = event.target.closest("#mediaDetailActions [data-media-personal-action]");
    if (personalAction) {
      event.preventDefault();
      event.stopPropagation();
      const item = personalItemFromDetailDataset(personalAction.dataset);
      if (personalAction.dataset.mediaPersonalAction === "custom-list") {
        if (!state.personalMediaLoadedAt) await loadPersonalMedia();
        openAddToListDialog(item);
        return;
      }
      if (personalAction.dataset.mediaPersonalAction === "watchlist") {
        personalAction.disabled = true;
        const request = personalAction.dataset.mediaPersonalMode === "remove"
          ? removeFromWatchlist(item)
          : addToWatchlist(item);
        request
          .catch((error) => setMessage(error.message, "error"))
          .finally(() => {
            personalAction.disabled = false;
            refreshRenderedPersonalMediaControls();
          });
      }
      return;
    }

    const forceSyncButton = event.target.closest("[data-media-force-sync]");
    if (forceSyncButton) {
      event.preventDefault();
      openMediaForceSyncDialog(forceSyncButton);
      return;
    }

    const mediaInfoTrigger = event.target.closest("[data-media-info]");
    if (mediaInfoTrigger) {
      event.preventDefault();
      openMediaInfoModal();
      return;
    }

    const watchHistoryToggle = event.target.closest("[data-watch-history-toggle]");
    if (watchHistoryToggle) {
      const history = watchHistoryToggle.closest(".movie-rewatch-history");
      if (history) {
        const expanded = history.classList.toggle("is-expanded");
        watchHistoryToggle.setAttribute("aria-expanded", String(expanded));
        watchHistoryToggle.querySelector(".watch-history-toggle-icon").textContent = expanded ? "▲" : "▼";
        watchHistoryToggle.querySelector(".watch-history-toggle-label").textContent = expanded ? "Show less" : "Show more";
        const toggleItem = watchHistoryToggle.closest(".watch-history-toggle-item");
        if (toggleItem) toggleItem.hidden = false;
        if (!expanded) syncRewatchHistoryToggle(history);
      }
      return;
    }

    const editDateBtn = event.target.closest(".media-edit-date-btn");
    if (editDateBtn) {
      // editDateOptionsFromButton() and the TMDB cache are read synchronously below.
      await loadRouteModules(["edit-dialogs"]);
      const container = editDateBtn.closest(".immersive-container, .modal-body") || document.body;
      const currentEntry = state.history.find((h) => h.id === editDateBtn.dataset.editId);
      openEditDateDialog(container, editDateBtn.dataset.editId, editDateBtn.dataset.watchedAt, async ({ watched_at = "", deleted = false } = {}) => {
        if (deleted) {
          await refreshAfterWatchDateDeletion();
          return;
        }
        editDateBtn.dataset.watchedAt = watched_at;
        const span = container.querySelector(".progress-label-row span");
        if (span) span.textContent = `Watched on ${formatDate(watched_at)}`;
        applyWatchedAtToLocalWatchRecord(editDateBtn.dataset.editId, watched_at);
        // The update-watch request emits a keyed history-version SSE event.
        // Keep the current detail mounted; applyLiveHistoryChanges() will
        // reconcile the authoritative row and patch only its tile.
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, { ...editDateOptionsFromButton(editDateBtn, currentEntry, explorerTmdbCache()), liveOnly: true });
      return;
    }

    const editImageBtn = event.target.closest(".media-edit-image-btn");
    if (editImageBtn) {
      const container = editImageBtn.closest(".immersive-container, .modal-body") || document.body;
      const id = editImageBtn.dataset.editId;
      // Resolve tmdbData - check both movie and TV caches
      let tmdbData = null;
      const entry = state.history.find((h) => h.id === id) || state.moviesRaw.find((m) => m.id === id);
      // ID-based show routes do not set activeShowModalKey, but the show edit
      // button still carries the canonical show ids. Treat either source as a
      // show-artwork context so the PATCH writes media_artwork rather than the
      // representative episode's poster_url.
      const artworkScope = editImageBtn.dataset.artworkScope || "";
      const hasShowArtworkIdentity = artworkScope === "show"
        || (artworkScope !== "movie" && Boolean(
          editImageBtn.dataset.showTmdbId
          || editImageBtn.dataset.showTvdbId
          || editImageBtn.dataset.showImdbId
          || state.activeShowModalKey
          || state.activeShowTmdbId
          || state.activeShowTvdbId,
        ));
      const showForArtwork = hasShowArtworkIdentity
        ? activeShowRecord() || state.activeShowRenderContext?.show
        : null;
      if (entry) {
        const movieKey = `movie|${entry.tmdb_id || ""}|${String(entry.title || "").toLowerCase()}`;
        const cached = state.tmdbDetailsCache.get(movieKey);
        if (cached && !(cached instanceof Promise)) tmdbData = cached;
      }
      if (!tmdbData && state.activeMovieModalId && String(state.activeMovieModalId) === String(id)) {
        const tmdbId = state.activeMovieTmdbId;
        if (tmdbId) {
          const prefix = `movie|${tmdbId}|`;
          for (const [key, cached] of state.tmdbDetailsCache.entries()) {
            if (key.startsWith(prefix) && cached && !(cached instanceof Promise)) {
              tmdbData = cached;
              break;
            }
          }
          if (!tmdbData) {
            tmdbData = {
              id: Number(tmdbId),
              title: entry?.title || "",
              media_type: "movie"
            };
          }
        }
      }
      if (!tmdbData && hasShowArtworkIdentity) {
        const show = showForArtwork;
        if (show) {
          const tvKey = `tv|${show.tmdb_id || ""}|${String(show.title || "").toLowerCase()}`;
          const cached = state.tmdbDetailsCache.get(tvKey);
          if (cached && !(cached instanceof Promise)) tmdbData = cached;
          if (!tmdbData && show.tmdb_id) {
            tmdbData = {
              id: show.tmdb_id,
              name: show.title,
              media_type: "tv",
              tvdb_id: show.tvdb_id || show.representative_episode?.tvdb_id || "",
            };
          } else if (tmdbData) {
            tmdbData = {
              ...tmdbData,
              media_type: "tv",
              tvdb_id: tmdbData.tvdb_id || tmdbData.external_ids?.tvdb_id || show.tvdb_id || show.representative_episode?.tvdb_id || "",
            };
          }
        }
        if (!tmdbData) {
          const showTmdbId = editImageBtn.dataset.showTmdbId || state.activeShowTmdbId || "";
          const showTvdbId = editImageBtn.dataset.showTvdbId || state.activeShowTvdbId || "";
          if (showTmdbId) {
            tmdbData = {
              id: showTmdbId,
              name: showForArtwork?.title || editImageBtn.dataset.title || "",
              media_type: "tv",
              tvdb_id: showTvdbId,
            };
          } else if (showTvdbId) {
            tmdbData = {
              name: showForArtwork?.title || editImageBtn.dataset.title || "",
              media_type: "tv",
              tvdb_id: showTvdbId,
            };
          }
        }
      }
      if (!tmdbData && entry?.tmdb_id && entry.media_type === "movie") {
        tmdbData = { id: entry.tmdb_id, title: entry.title, media_type: "movie" };
      }
      const imageDialogTitle = editImageBtn.dataset.title || tmdbData?.title || tmdbData?.name || entry?.title || "";
      const showIdentity = hasShowArtworkIdentity
        ? {
          media_type: "tv",
          title: showForArtwork?.title || imageDialogTitle,
          tmdb_id: editImageBtn.dataset.showTmdbId || tmdbData?.id || showForArtwork?.tmdb_id || "",
          tvdb_id: editImageBtn.dataset.showTvdbId || tmdbData?.external_ids?.tvdb_id || tmdbData?.tvdb_id || showForArtwork?.tvdb_id || "",
          imdb_id: editImageBtn.dataset.showImdbId || tmdbData?.external_ids?.imdb_id || showForArtwork?.imdb_id || "",
        }
        : null;
      const previousPosterUrl = editImageBtn.dataset.posterUrl || "";
      openEditImageDialog(container, id, editImageBtn.dataset.posterUrl, tmdbData, ({ poster_url, logo_url, backdrop_url, youtube_url, storage_url, updated_ids }) => {
        if (poster_url) {
          applyArtworkToLocalWatchRecords({
            id,
            mediaType: showIdentity ? "tv" : "movie",
            posterUrl: poster_url,
            updatedIds: updated_ids,
            showIdentity: showIdentity || {},
            previousPosterUrl,
          });
          editImageBtn.dataset.posterUrl = poster_url;
          const posterImg = container.querySelector(".immersive-poster-img");
          if (posterImg) posterImg.src = poster_url;
          const backdrop = container.querySelector(".modal-backdrop-image");
          if (backdrop) backdrop.style.backgroundImage = `url('${poster_url}')`;
          if (showIdentity) {
            // Show artwork is shared through the canonical show record. Do not
            // seed the episode id cache here: that would make this show poster
            // override the independent artwork of every episode card.
            const activeShows = new Set([
              showForArtwork,
              activeShowRecord(),
              state.activeShowRenderContext?.show,
            ].filter(Boolean));
            for (const activeShow of activeShows) {
              activeShow.poster_url = poster_url;
              activeShow.show_poster_url = poster_url;
              activeShow.canonical_poster_url = poster_url;
            }
          }
          // Drop cached explorer pages for both scopes, but retain and repaint
          // the loaded arrays that applyArtworkToLocalWatchRecords just fixed.
          clearDerivedUiCaches({ resetExplorer: false });
          if (!showIdentity && storage_url && isCachedStorageImageUrl(storage_url)) {
            const posterLookupIds = Array.isArray(updated_ids) && updated_ids.length ? updated_ids : [id];
            for (const updatedId of posterLookupIds) {
              rememberPosterLookup(String(updatedId), poster_url || storage_url);
            }
          }
          loadHistory({ force: true }).catch(() => { });
          if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
          else if (state.activeView === "history" && !state.mediaDetailInline) renderHistoryView();
        }
        if (logo_url !== undefined) {
          editImageBtn.dataset.logoUrl = logo_url;
          const meta = container.querySelector(".immersive-meta");
          if (meta) {
            let logoEl = meta.querySelector(".immersive-logo");
            const titleEl = meta.querySelector(".immersive-title");
            // An empty proxy URL means the artwork is known to be unfetchable,
            // so treat it the same as having no logo at all.
            const logoSrc = logo_url ? proxiedArtworkUrl(logo_url, "logo") : "";
            if (logoSrc) {
              if (logoEl) {
                logoEl.src = logoSrc;
              } else {
                logoEl = document.createElement("img");
                logoEl.className = "immersive-logo";
                logoEl.alt = titleEl?.textContent || "";
                logoEl.src = logoSrc;
                meta.insertBefore(logoEl, titleEl);
              }
              titleEl?.classList.add("sr-only");
            } else {
              logoEl?.remove();
              titleEl?.classList.remove("sr-only");
            }
          }
        }
        if (backdrop_url !== undefined) {
          editImageBtn.dataset.backdropUrl = backdrop_url;
          const backdrop = container.querySelector(".modal-backdrop-image");
          if (backdrop) backdrop.style.backgroundImage = `url('${backdrop_url}')`;
        }
        if (youtube_url !== undefined) {
          editImageBtn.dataset.youtubeUrl = youtube_url;
        }
      }, {
        title: imageDialogTitle,
        ...(showIdentity ? { artworkScope: "show", artworkIdentity: showIdentity } : {}),
      });
      return;
    }

    const editShowDateBtn = event.target.closest(".media-edit-show-date-btn");
    if (editShowDateBtn) {
      const fallbackRows = state.showModalEpisodes.map((episode) => episode.watched).filter(Boolean);
      openEditShowDateDialog(editShowDateBtn.dataset.showTitle || "", fallbackRows);
      return;
    }

    const fixMatchBtn = event.target.closest(".media-fix-match-btn");
    if (fixMatchBtn) {
      const container = fixMatchBtn.closest(".immersive-container, .modal-body") || document.body;
      const mediaType = fixMatchBtn.dataset.mediaType;
      // Set on every poster-grid overflow menu's fix-match item (posterOverflowMenu
      // in images.js) - no detail modal is open there, so the movie/show render
      // branches below must not open one; the grid card just needs its cached
      // identity patched before the in-place refresh at the end picks up the
      // new poster/metadata.
      const gridOrigin = fixMatchBtn.dataset.gridOrigin === "1";
      openFixMatchDialog(container, fixMatchBtn.dataset.editId, fixMatchBtn.dataset.title, mediaType, async ({ tmdb_id, tvdb_id, title }) => {
        state.tmdbDetailsCache.clear();
        state.tmdbSeasonCache.clear();
        const syncJobCard = fixMatchBtn.closest(".sync-job-card");
        const inSyncIssues = fixMatchBtn.closest("#syncIssuesContainer, #syncMatchReportContainer");
        if (syncJobCard || inSyncIssues) {
          setMessage("Match updated. Retrying sync...", "info");
          triggerRetrySync(fixMatchBtn.dataset.editId, fixMatchBtn).catch(() => {
            loadSyncJobs({ force: true }).catch(() => null);
            loadSyncHistory({ force: true }).catch(() => null);
          }).then(() => {
            if (inSyncIssues) window.dispatchEvent(new Event("sync-match-report-refresh"));
          });
        } else if (gridOrigin) {
          if (mediaType === "movie") {
            const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
            if (movie) {
              movie.tmdb_id = tmdb_id;
              movie.poster_url = "";
              movie.logo_url = "";
              movie.backdrop_url = "";
            }
          } else {
            const showTitle = fixMatchBtn.dataset.title || title || "";
            if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
          }
        } else if (mediaType === "movie") {
          const movie = state.history.find((h) => h.id === fixMatchBtn.dataset.editId);
          if (movie) {
            movie.tmdb_id = tmdb_id;
            movie.poster_url = "";
            movie.logo_url = "";
            movie.backdrop_url = "";
          }
          try {
            const res = await fetch(`/api/history?id=${encodeURIComponent(fixMatchBtn.dataset.editId)}`, { headers: authHeaders(), cache: "no-store" });
            const body = await res.json().catch(() => ({}));
            const freshMovie = body.row || movie;
            if (freshMovie) {
              freshMovie.tmdb_id = tmdb_id;
              await renderMovieImmersiveModalContent(freshMovie);
            }
          } catch {
            if (movie) await renderMovieImmersiveModalContent(movie);
          }
        } else if (state.activeShowModalKey) {
          const showTitle = fixMatchBtn.dataset.title || title || "";
          const show = activeShowRecord();
          if (show) {
            show.tmdb_id = tmdb_id;
            show.tvdb_id = tvdb_id || show.tvdb_id;
            show.poster_url = "";
            show.logo_url = "";
            show.backdrop_url = "";
          }
          if (showTitle) await refreshShowAfterManualWatch(showTitle).catch(() => null);
          await openShowInlineDetail(state.activeShowModalKey, state.activeShowModalSeason, state.activeShowModalEpisode).catch(() => { });
        }

        if (gridOrigin) {
          // Same reasoning as removeGridCards()/refreshMovieExplorerInPlace()
          // for unwatch: refresh the data in place instead of the destructive
          // resetExplorer()+renderExplorer() below, which empties the grid
          // before repopulating and resets scroll to the top.
          clearDerivedUiCaches({ resetExplorer: false });
          if (state.activeView === "explorer" && !state.mediaDetailInline) {
            if (state.explorerMode === "shows") renderExplorer();
            else await refreshMovieExplorerInPlace();
          } else if (state.activeView === "history") {
            await refreshHistoryViewInPlace();
          } else if (state.activeView === "dashboard") {
            loadHistory({ force: true }).catch(() => null);
          }
          return;
        }

        // The match response updates the detail view, but the explorer and
        // dashboard may already contain rendered cards backed by old rows.
        // Drop those snapshots and immediately repopulate the visible view so
        // the new poster and metadata are visible without navigation/reload.
        clearDerivedUiCaches({ resetExplorer: true });
        if (state.activeView === "explorer" && !state.mediaDetailInline) {
          renderExplorer();
        } else if (state.activeView === "dashboard") {
          loadHistory({ force: true }).catch(() => null);
        }
      });
      return;
    }

    const removeHistoryBtn = event.target.closest(".media-remove-history-btn");
    if (removeHistoryBtn) {
      const id = removeHistoryBtn.dataset.deleteHistoryId;
      if (!id) return;
      const confirmed = await openConfirmDialog({
        title: "Remove unmatched entry?",
        body: "This removes the local Plekt watch record only. It will not affect Plex, Emby or Jellyfin.",
        confirmLabel: "Continue",
        cancelLabel: "Keep entry",
        danger: true,
      });
      if (!confirmed) return;
      const finalConfirmed = await openConfirmDialog({
        title: "This cannot be undone",
        body: "The episode, watch date and local history for this unmatched entry will be permanently deleted. Continue?",
        confirmLabel: "Remove permanently",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!finalConfirmed) return;
      removeHistoryBtn.disabled = true;
      try {
        const response = await fetch("/api/delete-history-record", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ id, confirm: "DELETE" }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `Remove failed (${response.status})`);
        state.history = state.history.filter((row) => String(row.id || "") !== String(id));
        state.showsRaw = state.showsRaw.filter((show) => String(show.unmatched_history_id || "") !== String(id));
        clearDerivedUiCaches({ resetExplorer: true });
        setMessage("Unmatched watch entry removed.", "success");
        closeMediaDetail();
        if (state.activeView === "explorer" && !state.mediaDetailInline) renderExplorer();
        else if (state.activeView === "history") renderHistoryView();
      } catch (error) {
        removeHistoryBtn.disabled = false;
        setMessage(`Remove failed: ${error.message}`, "error");
      }
      return;
    }

    const mergeShowBtn = event.target.closest(".media-merge-show-btn");
    if (mergeShowBtn) {
      openMergeShowDialog(mergeShowBtn.dataset.showTitle);
      return;
    }

    const editDateIconBtn = event.target.closest(".edit-date-icon-btn");
    if (editDateIconBtn) {
      const id = editDateIconBtn.dataset.editId;
      // editDateOptionsFromButton() and the TMDB cache are read synchronously below.
      await loadRouteModules(["edit-dialogs"]);
      const currentEntry = state.history.find((h) => h.id === id);
      openEditDateDialog(null, id, editDateIconBtn.dataset.watchedAt, async ({ watched_at = "", deleted = false } = {}) => {
        if (deleted) {
          await refreshAfterWatchDateDeletion();
          return;
        }
        editDateIconBtn.dataset.watchedAt = watched_at;
        // Update the time element this icon is inside
        const timeEl = editDateIconBtn.closest("time");
        if (timeEl) timeEl.innerHTML = `Watched ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        // Also update movie watch status row if present
        const span = editDateIconBtn.closest(".progress-label-row")?.querySelector("span");
        if (span) span.innerHTML = `Watched on ${formatDate(watched_at)} <button class="edit-date-icon-btn" type="button" title="Edit watch date" data-edit-id="${escapeAttribute(id)}" data-watched-at="${escapeAttribute(watched_at)}">✎</button>`;
        applyWatchedAtToLocalWatchRecord(id, watched_at);
        // Do not refetch or re-render the show/movie here. The server emits a
        // keyed SSE change and the live patch updates only the affected row.
        if (state.activeView === "history") {
          renderHistoryView();
        }
      }, { ...editDateOptionsFromButton(editDateIconBtn, currentEntry, explorerTmdbCache()), liveOnly: true });
      return;
    }

    const availIssueEl = event.target.closest("[data-avail-issue]");
    if (availIssueEl) {
      showAvailIssuePopup(availIssueEl);
      return;
    }


    const settingsLink = event.target.closest("[data-settings-link]");
    if (settingsLink) {
      event.preventDefault();
      selectSettingsTab(settingsLink.dataset.settingsLink);
      return;
    }

    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      copyToClipboard(copyButton.dataset.copy, copyButton);
      return;
    }

    const watchDateCancel = event.target.closest("[data-watch-date-cancel]");
    if (watchDateCancel) {
      event.preventDefault();
      closeWatchDatePrompt();
      return;
    }

    const watchDateChoice = event.target.closest("[data-watch-date-choice]");
    if (watchDateChoice) {
      event.preventDefault();
      applyWatchDateChoice(watchDateChoice.dataset.watchDateChoice).catch((error) => {
        if (!error?.clientAttentionReported) setMessage(error.message, "error");
      });
      return;
    }

    const editSeasonDateBtn = event.target.closest("[data-edit-season-date]");
    if (editSeasonDateBtn) {
      const seasonNum = Number(editSeasonDateBtn.dataset.editSeasonDate);
      const seasonEpisodes = state.showModalEpisodes.filter((ep) => ep.seasonNumber === seasonNum);
      const watchedEpisodes = seasonEpisodes
        .filter((ep) => ep.watched)
        .map((ep) => ({ ...ep.watched, release_date: ep.airDate || "" }));
      if (!watchedEpisodes.length) {
        setMessage("No watched episodes in this season to update.", "error");
        return;
      }
      const showTitle = seasonEpisodes[0]?.showTitle || "";
      openEditSeasonDateDialog(showTitle, seasonNum, watchedEpisodes);
      return;
    }

    const movieWatchButton = event.target.closest("[data-movie-mark-watched]");
    if (movieWatchButton) {
      markMovieWatched({
        tmdbId: movieWatchButton.dataset.movieMarkWatched,
        title: movieWatchButton.dataset.movieTitle,
        posterUrl: movieWatchButton.dataset.moviePoster,
        releaseDate: movieWatchButton.dataset.movieRelease,
      });
      return;
    }

    const seerrBtn = event.target.closest("[data-seerr-media-type]");
    if (seerrBtn) {
      const mediaType = seerrBtn.dataset.seerrMediaType;
      const mediaId = Number(seerrBtn.dataset.seerrMediaId);
      if (mediaType === "tv" && !seerrBtn.hasAttribute("data-seerr-season")) {
        openSeerrSeasonRequestDialog(mediaType, mediaId, { is4k: seerrBtn.getAttribute("data-seerr-request-4k") === "true" });
      } else {
        submitSeerrRequest(mediaType, mediaId, seerrBtn);
      }
      return;
    }

    const unwatchButton = event.target.closest("[data-unwatch-id], [data-unwatch-ids]");
    if (unwatchButton) {
      confirmAndMarkUnwatched(unwatchButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const deleteMediaButton = event.target.closest("[data-delete-media-id]");
    if (deleteMediaButton) {
      confirmAndDeleteMedia(deleteMediaButton).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const backBtn = event.target.closest(".immersive-back-button");
    if (backBtn) {
      if (state.internalHistoryCount > 0) {
        window.history.back();
      } else {
        closeMediaDetail();
      }
      return;
    }

    const toggleEpisodes = event.target.closest("[data-immersive-toggle-episodes]");
    if (toggleEpisodes) {
      const list = document.querySelector("#immersiveEpisodeList");
      if (list) list.classList.toggle("hidden");
      return;
    }

    const seasonAccordion = event.target.closest("[data-season-accordion]");
    if (seasonAccordion) {
      event.preventDefault();
      const seasonNum = Number(seasonAccordion.dataset.seasonAccordion);
      const wasAllExpanded = state.showModalAllSeasonsExpanded;
      const currentSeason = state.activeShowModalSeason == null ? null : Number(state.activeShowModalSeason);
      // Clicking an individual season while "expand all" is active means the
      // user wants to focus on just this one - drop out of "all" mode instead
      // of leaving every season open underneath it.
      const shouldClose = !wasAllExpanded && currentSeason === seasonNum;
      const nextSeason = shouldClose ? null : seasonNum;
      // The app shell keeps window/document fixed and scrolls .page-shell
      // internally instead - see scrollSeasonAccordionIntoView's doc comment.
      const scrollContainer = document.querySelector(".page-shell");
      const scrollTop = scrollContainer?.scrollTop ?? 0;
      state.showModalAllSeasonsExpanded = false;
      state.activeShowModalSeason = nextSeason;
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: nextSeason,
          activeEpisodeNum: null,
        });
        requestAnimationFrame(() => {
          // Expanding scrolls the clicked season's header into view so the
          // newly-revealed episode list doesn't open off-screen below the
          // click; collapsing just restores the prior scroll position so the
          // page doesn't jump now that the content above has shrunk.
          if (nextSeason != null) {
            scrollSeasonAccordionIntoView(nextSeason);
          } else if (scrollContainer) {
            scrollContainer.scrollTop = scrollTop;
          }
        });
      }
      const nextUrlBase = state.activeShowModalKey
        ? `/tvshow/${state.activeShowModalKey}`
        : state.activeShowTmdbId
          ? tvShowTmdbHref(state.activeShowTmdbId, state.activeShowModalTitle)
          : state.activeShowTvdbId
            ? tvShowTvdbHref(state.activeShowTvdbId, state.activeShowModalTitle)
            : "";
      const nextUrl = nextUrlBase ? (nextSeason != null ? `${nextUrlBase}#season${nextSeason}` : nextUrlBase) : "";
      if (nextUrl) {
        window.history.replaceState({}, "", nextUrl);
      }
      return;
    }

    const toggleAllSeasons = event.target.closest("[data-toggle-all-seasons]");
    if (toggleAllSeasons) {
      event.preventDefault();
      state.showModalAllSeasonsExpanded = !state.showModalAllSeasonsExpanded;
      if (!state.showModalAllSeasonsExpanded) {
        state.activeShowModalSeason = null;
      }
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: state.activeShowModalSeason,
          activeEpisodeNum: null,
        });
      }
      return;
    }

    const watchButton = event.target.closest("[data-watch-scope]");
    if (watchButton) {
      event.preventDefault();
      const isShowWatchButton = watchButton.dataset.watchScope === "show";
      // watchActionFromButton() below reads watch-action synchronously.
      const prepareShowAction = loadRouteModules(["watch-action"])
        .then(() => (isShowWatchButton ? ensureAllShowEpisodeDetailsForWatch() : null));
      if (isShowWatchButton) watchButton.disabled = true;
      prepareShowAction
        .then(() => {
          const watchAction = watchActionFromButton(watchButton);
          if (watchAction && !watchAction.episodes.length && watchAction.resyncEpisodes.length) {
            runResyncWatchAction(watchAction);
          } else {
            openWatchDatePrompt(watchAction);
          }
        })
        .catch((error) => setMessage(error?.message || "Could not load all show episodes", "error"));
      return;
    }

    const episodeRow = event.target.closest("[data-immersive-episode-num]");
    if (episodeRow) {
      if (event.target.closest("button") || event.target.closest("a") || event.target.closest("details") || event.target.closest(".avail-pill")) {
        return;
      }
      event.preventDefault();
      const episodeNum = Number(episodeRow.dataset.immersiveEpisodeNum);
      const seasonNum = Number(episodeRow.dataset.immersiveSeasonNum);
      const shouldClear = Number(state.activeShowModalEpisode) === episodeNum && Number(state.activeShowModalSeason) === seasonNum;
      state.activeShowModalSeason = seasonNum;
      state.activeShowModalEpisode = shouldClear ? null : episodeNum;
      const ctx = state.activeShowRenderContext;
      if (ctx?.show) {
        renderShowModalContent(ctx.show, {
          ...ctx,
          activeSeasonNum: seasonNum,
          activeEpisodeNum: state.activeShowModalEpisode,
        });
      }
      const baseUrl = state.activeShowModalKey
        ? `/tvshow/${state.activeShowModalKey}`
        : state.activeShowTmdbId
          ? tvShowTmdbHref(state.activeShowTmdbId, state.activeShowModalTitle)
          : state.activeShowTvdbId
            ? tvShowTvdbHref(state.activeShowTvdbId, state.activeShowModalTitle)
            : "";
      if (baseUrl) {
        const hash = state.activeShowModalEpisode == null ? `#season${seasonNum}` : `#season${seasonNum}ep${episodeNum}`;
        window.history.replaceState({}, "", `${baseUrl}${hash}`);
      }
      return;
    }

    const recMovieCard = event.target.closest("[data-immersive-movie-id]");
    if (recMovieCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(recMovieCard.getAttribute("href") || movieTmdbHref(recMovieCard.dataset.immersiveMovieId));
      return;
    }

    const relatedShowCard = event.target.closest("[data-immersive-related-tmdb]");
    if (relatedShowCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      navigateTo(relatedShowCard.getAttribute("href") || tvShowTmdbHref(relatedShowCard.dataset.immersiveRelatedTmdb));
      return;
    }

    const libraryItemCard = event.target.closest("a[data-library-item-type]");
    if (libraryItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(libraryItemCard.dataset.libraryItemType, libraryItemCard.dataset.libraryItemId, libraryItemCard.dataset.libraryItemTitle, true, null);
      return;
    }

    const tmdbItemCard = event.target.closest("a[data-tmdb-id]");
    if (tmdbItemCard && event.button === 0 && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      window.openLibraryItem(tmdbItemCard.dataset.tmdbMediaType, null, tmdbItemCard.dataset.tmdbTitle, false, tmdbItemCard.dataset.tmdbId);
      return;
    }

    const provenanceTrigger = event.target.closest("[data-history-debug-id]");
    if (provenanceTrigger) {
      event.preventDefault();
      openHistoryDebugModal(provenanceTrigger.dataset.historyDebugId).catch((error) => setMessage(error.message, "error"));
      return;
    }

    const historyRow = event.target.closest("[data-history-id]");
    if (historyRow) {
      if (event.target.closest("[data-sync-status-dot]")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
        return;
      }
      if (historyRow.classList.contains("history-mini-card") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        const href = historyRow.getAttribute("href");
        if (href) {
          event.preventDefault();
          navigateTo(href);
          return;
        }
      }
      if (event.target.closest("#historyPanel") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        const href = historyRow.getAttribute("href");
        if (href) {
          event.preventDefault();
          navigateTo(href);
          return;
        }
      }
      const isTvRow = event.target.closest("#tvHistoryRow");
      if (isTvRow && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const href = historyRow.getAttribute("href");
        if (href) {
          // Dashboard episode cards already carry the exact show/season/
          // episode destination. Rebuilding the URL from the show record
          // here would silently discard the episode coordinates.
          navigateTo(href);
          return;
        }
        const entry = state.history.find(e => e.id === historyRow.dataset.historyId);
        if (entry) {
          const canonicalShowName = entry.show_title || showName(entry.title);
          const showKeySlug = slug(canonicalShowName);
          let showObj = state.showsRaw.find(s => (
            (entry.show_tmdb_id && String(s.tmdb_id || "") === String(entry.show_tmdb_id))
            || (entry.show_tvdb_id && String(s.tvdb_id || "") === String(entry.show_tvdb_id))
            || (!entry.show_tmdb_id && !entry.show_tvdb_id && slug(s.title) === showKeySlug)
          ));
          if (!showObj) {
            showObj = { title: canonicalShowName, tmdb_id: entry.show_tmdb_id || "", tvdb_id: entry.show_tvdb_id || "" };
            state.showsRaw.push(showObj);
          }

          const showHref = tvShowBaseHrefFromEpisode({
            ...entry,
            show_title: canonicalShowName,
            show_tmdb_id: entry.show_tmdb_id || showObj.tmdb_id || "",
            show_tvdb_id: entry.show_tvdb_id || showObj.tvdb_id || "",
          }, canonicalShowName);
          const season = Number(entry.season);
          navigateTo(Number.isInteger(season) && season >= 0
            ? `${showHref}#season${season}`
            : showHref);
        }
      } else if (event.target.closest(".movie-card") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        navigateTo(movieHref(movieBySlugOrId(historyRow.dataset.historyId) || { id: historyRow.dataset.historyId }));
      } else if (historyRow.tagName === "A" && historyRow.getAttribute("href") && event.button === 0 && !event.ctrlKey && !event.metaKey) {
        // Any other anchor-based history card (e.g. the dashboard's
        // page-style watch-history cards) - navigate via the SPA router
        // instead of falling through to the debug modal below, which left
        // preventDefault() uncalled and let the browser's native link
        // navigation fire a full page reload.
        event.preventDefault();
        navigateTo(historyRow.getAttribute("href"));
      } else if (!event.target.closest(".movie-card")) {
        openHistoryDebugModal(historyRow.dataset.historyId).catch((error) => setMessage(error.message, "error"));
      }
      return;
    }

    const showTrigger = event.target.closest("[data-show-key]");
    if (showTrigger) {
      // The poster grid renders this trigger as a real <a> so the card keeps a
      // copyable URL and can be middle-clicked or opened in a new tab. Leave
      // those gestures to the browser and take over only the plain left-click,
      // which otherwise followed the href and reloaded the whole document.
      if (showTrigger.tagName === "A") {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
      }
      const recordId = showTrigger.dataset.showRecordId;
      if (recordId) {
        state.pendingShowHistoryId = recordId;
        state.activeShowHistoryId = recordId;
      }
      const explicitShowHref = showTrigger.dataset.showHref || (showTrigger.tagName === "A" ? showTrigger.getAttribute("href") : "");
      const fallbackShowHref = `/tvshow/${showTrigger.dataset.showKey}${recordId ? `?historyId=${encodeURIComponent(recordId)}` : ""}`;
      navigateTo(explicitShowHref || fallbackShowHref);
      return;
    }

    const seasonTrigger = event.target.closest("[data-season-key]");
    if (seasonTrigger) {
      toggleSet(state.expandedSeasons, seasonTrigger.dataset.seasonKey);
      if (state.activeShowModalKey) {
        if (state.mediaDetailInline) {
          let url = `/tvshow/${state.activeShowModalKey}`;
          if (state.activeShowModalSeason !== null) {
            url += `#season${state.activeShowModalSeason}`;
          }
          navigateTo(url);
        } else {
          renderImmersiveShowModal(state.activeShowModalKey, state.activeShowModalSeason);
        }
      } else {
        renderExplorer();
      }
      return;
    }
  });
}
