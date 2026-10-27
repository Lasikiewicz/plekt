import { buildAuthHeaders } from "./auth.js?v=2.2.0.0.1";
import { state, elements } from "./state.js?v=2.2.0.0.1";
import { escapeHtml, escapeAttribute, platformName, formatDate } from "./utils.js?v=2.2.0.0.1";
import { historyAction, syncStatus, telemetryLineValue } from "./sync.js?v=2.2.0.0.1";
import { syncInlineMediaDetailHeading } from "./explorer.js?v=2.2.0.0.1";
import { auditEventsForRecord, infoSyncSummary, infoSyncTargetStates, infoWatchDetails, mediaInfoGlanceEntries, renderInfoWatchSync } from "./media-info-summary.js?v=2.2.0.0.1";

let _cb = {};
let _mediaRenderToken = 0;

export function initMediaDetail(callbacks = {}) {
  _cb = callbacks;
}
export function authHeaders() {
  return buildAuthHeaders(state.token);
}
export function setMessage(text, tone = "muted") { _cb.setMessage?.(text, tone); }
export function navigateTo(url) { _cb.navigateTo?.(url); }
export function selectView(view) { _cb.selectView?.(view); }
export function syncPageTopbar() { _cb.syncPageTopbar?.(); }
export function renderExplorer() { _cb.renderExplorer?.(); }
export function renderSearchPage() { _cb.renderSearchPage?.(); }
export function loadExplorerMovies() { return _cb.loadExplorerMovies?.() ?? Promise.resolve(); }
export function loadExplorerShows() { return _cb.loadExplorerShows?.() ?? Promise.resolve(); }

// Monotonic token guarding async media-detail renders. Each render captures the
// current value; if navigation (a new render, or clearMediaDetailState) bumps it
// while a slow TMDB fetch is in flight, the stale render aborts before writing the
// DOM. Without this, an abandoned detail page would "appear" after you'd already
// navigated back and opened something else.
//
// This token is one half of a two-token handshake that guards against a movie
// render and a show render clobbering each other; the other half is
// `state.showModalRequestToken` (declared in state.js). Both tokens are bumped
// and checked from *both* media-detail-show.js and media-detail-movie.js:
//   - media-detail-show.js: renderImmersiveShowModal() bumps this token (to
//     cancel any in-flight movie render) and owns state.showModalRequestToken
//     (bumping/checking it to cancel stale show hydration).
//   - media-detail-movie.js: renderMovieImmersiveModalContent() bumps this
//     token (and checks it after every await) and also bumps
//     state.showModalRequestToken to cancel any in-flight show hydration.
// If you change one side of this handshake, check the other file too -
// grep both files for `bumpMediaRenderToken` and `showModalRequestToken`.
export function bumpMediaRenderToken() {
  return ++_mediaRenderToken;
}
export function currentMediaRenderToken() {
  return _mediaRenderToken;
}

function provenanceForEntry(entry = {}) {
  const raw = entry.watch_provenance || entry.watchProvenance;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Fall through to the explicit legacy state below.
    }
  }
  return {
    ingest_path: "unavailable",
    event: "",
    item_id: "",
    session_id: "",
    user: "",
    device: "",
    device_id: "",
    client: "",
    client_version: "",
    source_timestamp: "",
    captured_at: "",
    confidence: "source_only",
    note: "Exact ingest path was not stored for this legacy row; only the originating platform was retained.",
  };
}

function provenanceValue(value, fallback = "Not recorded") {
  return value == null || value === "" ? fallback : value;
}

let _mediaInfoOverlay = null;
let _mediaInfoPreviousOverflow = "";
let _mediaInfoKeydown = null;
let _mediaInfoBoundsHandler = null;
let _mediaInfoRequestToken = 0;

export function mediaInfoActionHtml() {
  return `
    <button class="action-pill media-info-btn" type="button" data-media-info title="Show watch and sync information">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5" />
        <path d="M8 7.1v4.15M8 4.75h.01" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <span>Info</span>
    </button>
  `;
}

export function mediaToolsActionHtml(content = "") {
  return `
    <details class="actions-tools-dropdown">
      <summary class="action-pill actions-tools-trigger" aria-label="Open media options" title="Options">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M4 6h5m4 0h7M4 12h9m4 0h3M4 18h2m4 0h10" />
          <circle cx="11" cy="6" r="2" fill="none" />
          <circle cx="15" cy="12" r="2" fill="none" />
          <circle cx="8" cy="18" r="2" fill="none" />
        </svg>
        <span>Options</span>
      </summary>
      <div class="actions-tools-panel" role="group" aria-label="Media options">
        ${content}
      </div>
    </details>
  `;
}

export function mediaForceSyncActionHtml({
  type = "movie",
  title = "",
  tmdbId = "",
  tvdbId = "",
  imdbId = "",
  disabled = false,
  seasons = [],
} = {}) {
  const seasonsAttr = seasons
    .filter((season) => Number.isFinite(Number(season.number)))
    .map((season) => `${Number(season.number)}:${Number(season.episodeCount) || 0}`)
    .join(",");
  return `
    <button class="action-pill action-pill-ghost media-force-sync-btn" type="button" ${disabled ? "disabled" : ""}
      data-media-force-sync
      data-force-sync-type="${escapeAttribute(type)}"
      data-force-sync-title="${escapeAttribute(title)}"
      data-force-sync-tmdb-id="${escapeAttribute(tmdbId)}"
      data-force-sync-tvdb-id="${escapeAttribute(tvdbId)}"
      data-force-sync-imdb-id="${escapeAttribute(imdbId)}"
      data-force-sync-seasons="${escapeAttribute(seasonsAttr)}"
      title="Import watched state from connected media servers">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M13.5 5.5A5.5 5.5 0 0 0 3.2 4L2 6" />
        <path d="M2 2.5V6h3.5" />
        <path d="M2.5 10.5A5.5 5.5 0 0 0 12.8 12l1.2-2" />
        <path d="M14 13.5V10h-3.5" />
      </svg>
      <span>Force Sync</span>
    </button>
  `;
}

export function setMediaInfoContext(context = null) {
  state.activeMediaInfo = context && typeof context === "object" ? context : null;
}

function hasWatchRecordData(record = {}) {
  return Boolean(
    record.watched_at
    || record.sync_action
    || record.sync_dispatch_telemetry
    || record.syncDispatchTelemetry
    || record.watch_provenance
    || record.watchProvenance
    || record.source
  );
}

function infoValue(value, fallback = "Not recorded") {
  if (value == null || value === "") return fallback;
  if (Array.isArray(value)) return value.length ? value.join(", ") : fallback;
  return String(value);
}

function infoDate(value, fallback = "Not recorded") {
  if (!value) return fallback;
  const formatted = formatDate(value);
  return formatted === "Unknown" ? infoValue(value, fallback) : formatted;
}

function infoField(label, value, className = "") {
  return `
    <div class="media-info-field${className ? ` ${className}` : ""}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(infoValue(value))}</strong>
    </div>
  `;
}

function infoSection(title, body) {
  return `
    <section class="media-info-section">
      <div class="media-info-section-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
        </div>
      </div>
      ${body}
    </section>
  `;
}

function infoRecords(context = {}) {
  if (Array.isArray(context.records)) return context.records.filter(hasWatchRecordData);
  if (Array.isArray(context.media?.episodes)) return context.media.episodes.filter(hasWatchRecordData);
  return hasWatchRecordData(context.media) ? [context.media] : [];
}

function infoRecordTitle(record = {}, context = {}) {
  const title = record.episode_title || record.title || context.media?.title || "Watch record";
  if (context.mediaType !== "tv" || record.season == null || record.episode == null) return title;
  const season = String(record.season).padStart(2, "0");
  const episode = String(record.episode).padStart(2, "0");
  return `S${season}E${episode} · ${title}`;
}

function infoRecordPayload(record = {}) {
  const provenance = provenanceForEntry(record);
  return {
    id: record.id || null,
    title: record.title || null,
    media_type: record.media_type || null,
    watched_at: record.watched_at || null,
    source: record.source || null,
    imdb_id: record.imdb_id || null,
    tmdb_id: record.tmdb_id || null,
    tvdb_id: record.tvdb_id || null,
    season: record.season ?? null,
    episode: record.episode ?? null,
    show_title: record.show_title || null,
    episode_title: record.episode_title || null,
    media_key: record.media_key || null,
    sync_action: record.sync_action || null,
    sync_dispatch_telemetry: record.sync_dispatch_telemetry || record.syncDispatchTelemetry || null,
    watch_provenance: record.watch_provenance || record.watchProvenance || null,
    source_device: provenance.device || null,
    source_device_id: provenance.device_id || null,
    source_client: provenance.client || null,
    source_client_version: provenance.client_version || null,
    playHistory: Array.isArray(record.playHistory) ? record.playHistory : undefined,
  };
}

function renderInfoRecordSummary(record, context) {
  const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
  const hasRecord = hasWatchRecordData(record);
  const status = hasRecord && telemetry ? syncStatus(record) : { label: "Not recorded" };
  return `
    <div class="media-info-history-record">
      <div class="media-info-record-main">
        <strong class="media-info-record-title">${escapeHtml(infoRecordTitle(record, context))}</strong>
        <span class="media-info-record-meta">${escapeHtml(infoDate(record.watched_at))} · ${escapeHtml(infoValue(platformName(record.source), "Source unknown"))}</span>
      </div>
      <div class="media-info-record-state">
        <span>${escapeHtml(hasRecord ? historyAction(record) : "Not recorded")}</span>
        <span>${escapeHtml(status.label)}</span>
      </div>
    </div>
  `;
}

function renderInfoWatchRecord(record, context, index) {
  const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
  const provenance = provenanceForEntry(record);
  const hasRecord = hasWatchRecordData(record);
  const status = hasRecord && telemetry ? syncStatus(record) : { label: "Not recorded" };
  const playHistory = Array.isArray(record.playHistory) ? [...record.playHistory].sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at))) : [];
  const recordId = record.id || `record-${index}`;
  return `
    <details class="media-info-detail-record">
      <summary>
        <span class="media-info-record-title">${escapeHtml(infoRecordTitle(record, context))}</span>
        <span class="media-info-record-meta">Open details</span>
      </summary>
      <div class="media-info-history-body">
        <div class="media-info-fields">
          ${infoField("Record ID", recordId)}
          ${infoField("Source platform", platformName(record.source))}
          ${infoField("Action", hasRecord ? historyAction(record) : "Not recorded")}
          ${infoField("Sync state", status.label)}
          ${infoField("Telemetry origin", telemetryLineValue(telemetry, "Origin"))}
          ${infoField("Watched at", infoDate(record.watched_at))}
          ${infoField("Media key", record.media_key)}
          ${infoField("Season / episode", record.season != null && record.episode != null ? `S${String(record.season).padStart(2, "0")}E${String(record.episode).padStart(2, "0")}` : "Not applicable")}
        </div>
        <div class="media-info-provenance-block">
          <div class="media-info-subhead">
            <span>Ingest provenance</span>
            <b>${escapeHtml(infoValue(provenance.confidence, "Unknown"))}</b>
          </div>
          <div class="media-info-fields">
            ${infoField("Ingest path", provenance.ingest_path, provenance.ingest_path === "unavailable" ? "media-info-field--warning" : "")}
            ${infoField("Source event", provenance.event)}
            ${infoField("Source item ID", provenance.item_id)}
            ${infoField("Source session ID", provenance.session_id)}
            ${infoField("Source user", provenance.user)}
            ${infoField("Source device", provenance.device)}
            ${infoField("Source device ID", provenance.device_id)}
            ${infoField("Source client", provenance.client)}
            ${infoField("Source client version", provenance.client_version)}
            ${infoField("Source timestamp", infoDate(provenance.source_timestamp))}
            ${infoField("Captured at", infoDate(provenance.captured_at))}
            ${infoField("Confidence", provenance.confidence)}
            ${infoField("Note", provenance.note, "media-info-field--wide")}
          </div>
        </div>
        ${playHistory.length > 1 ? `
          <div class="media-info-subsection">
            <div class="media-info-subhead"><span>Recorded play history</span><b>${playHistory.length} plays</b></div>
            <ul class="media-info-play-history">
              ${playHistory.map((play) => `<li><span>${escapeHtml(infoDate(play.watched_at))}</span><b>${escapeHtml(platformName(play.source))}</b></li>`).join("")}
            </ul>
          </div>
        ` : ""}
        <details class="media-info-telemetry">
          <summary>Sync dispatch telemetry</summary>
          <pre>${escapeHtml(telemetry || "No sync telemetry recorded for this row.")}</pre>
        </details>
        <details class="media-info-telemetry">
          <summary>Stored record fields</summary>
          <pre>${escapeHtml(JSON.stringify(infoRecordPayload(record), null, 2))}</pre>
        </details>
      </div>
    </details>
  `;
}

function renderInfoRecordDebug(record, context, index, events = []) {
  const exactEventCount = events.filter((event) => event.eventType !== "legacy_record").length;
  const legacyEventCount = events.length - exactEventCount;
  const timeline = events.length
    ? renderInfoAuditTimeline(events, { eventCount: events.length, exactEventCount, legacyEventCount })
    : "";
  return `
    <details class="media-info-record-debug">
      <summary>
        <span>Debug details</span>
        <span>${events.length} audit event${events.length === 1 ? "" : "s"}</span>
      </summary>
      <div class="media-info-record-debug-body">
        ${timeline}
        ${renderInfoWatchRecord(record, context, index)}
      </div>
    </details>
  `;
}

function mediaInfoAuditQuery(context = {}) {
  const params = new URLSearchParams();
  const media = context.media || {};
  const metadata = context.tmdbData || {};
  const records = infoRecords(context);
  const add = (key, value) => {
    if (value != null && value !== "") params.append(key, String(value));
  };
  const addUnique = (key, values) => {
    [...new Set(values.filter((value) => value != null && value !== ""))].forEach((value) => add(key, value));
  };

  params.set("mediaType", context.mediaType === "tv" ? "tv" : "movie");
  addUnique("recordId", records.map((record) => record.id));
  addUnique("mediaKey", records.map((record) => record.media_key));
  addUnique("mediaKey", [media.media_key]);
  add("title", media.title || metadata.title || metadata.name);
  if (context.mediaType === "tv") add("showTitle", media.show_title || media.showTitle || media.title || metadata.name);

  const externalIds = metadata.external_ids || {};
  add("imdbId", media.imdb_id || metadata.imdb_id || externalIds.imdb_id);
  add("tmdbId", media.tmdb_id || metadata.id);
  add("tvdbId", media.tvdb_id || externalIds.tvdb_id);
  return params.toString();
}

async function fetchMediaInfoAudit(context = {}) {
  const query = mediaInfoAuditQuery(context);
  const response = await fetch(`/api/history-audit?${query}`, { headers: authHeaders() });
  if (!response.ok) throw new Error(`Audit request failed (${response.status})`);
  return response.json();
}

function auditEventLabel(event = {}) {
  const type = String(event.eventType || "").toLowerCase();
  const phase = String(event.phase || "").toLowerCase();
  if (type === "source_event") {
    if (phase === "active") return "Playback detected";
    if (phase === "ended") return "Playback ended";
    if (phase === "completed") return "Watch completion received";
    if (phase === "unplayed" || phase === "unwatched") return "Unwatched event received";
    if (phase === "added") return "Library item detected";
    if (phase === "ignored") return "Source event ignored";
    return "Source event received";
  }
  if (type === "playback_detected") return "Playback detected";
  if (type === "playback_ended") return "Playback ended";
  if (type === "history_added") return "Added to Plekt watch history";
  if (type === "history_state_recorded") return "Watch state recorded in Plekt";
  if (type === "history_deleted") return "Removed from Plekt watch history";
  if (type === "history_record_updated") return "Plekt history record updated";
  if (type === "sync_queued") return "Outbound sync queued";
  if (type === "playstate_updated") return "Plekt playstate updated";
  if (type === "resume_progress_stored") return "Resume progress stored";
  if (type === "resume_progress_cleared") return "Resume progress cleared";
  if (type === "sync_dispatch") return "Outbound sync dispatched";
  if (type === "sync_target") return event.target ? `Pushed to ${platformName(event.target)}` : "Outbound target processed";
  if (type === "legacy_record") return "Historical record — exact timeline unavailable";
  return event.eventType || "Recorded event";
}

function auditEventTime(event = {}) {
  const timestamp = Number(event.timestamp || 0);
  return timestamp > 0 ? infoDate(new Date(timestamp).toISOString(), "Time not recorded") : "Time not recorded";
}

function auditEventDate(value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp > 0) return infoDate(new Date(timestamp).toISOString());
  }
  return infoDate(value, "");
}

function auditEventPayloadText(event = {}) {
  if (event.payload == null || event.payload === "") return "No additional payload was stored.";
  if (typeof event.payload === "string") return event.payload;
  try {
    return JSON.stringify(event.payload, null, 2);
  } catch {
    return String(event.payload);
  }
}

function auditEventCounts(events = [], coverage = {}) {
  const exactValue = Number(coverage.exactEventCount);
  const legacyValue = Number(coverage.legacyEventCount);
  const exact = Number.isFinite(exactValue)
    ? Math.max(0, exactValue)
    : events.filter((event) => event.eventType !== "legacy_record").length;
  const legacy = Number.isFinite(legacyValue)
    ? Math.max(0, legacyValue)
    : events.filter((event) => event.eventType === "legacy_record").length;
  return { exact, legacy };
}

function auditEventCountText(events = [], coverage = {}) {
  const { exact, legacy } = auditEventCounts(events, coverage);
  if (exact && legacy) return `${exact} captured · ${legacy} legacy placeholders`;
  if (exact) return `${exact} captured event${exact === 1 ? "" : "s"}`;
  if (legacy) return `${legacy} legacy placeholder${legacy === 1 ? "" : "s"}`;
  return `${events.length} event${events.length === 1 ? "" : "s"}`;
}

function auditEventCoverageNote(events = [], coverage = {}) {
  const { exact, legacy } = auditEventCounts(events, coverage);
  if (!legacy) return "";
  const legacyLabel = `${legacy} historical record${legacy === 1 ? "" : "s"}`;
  const exactNote = exact
    ? `${exact} captured event${exact === 1 ? "" : "s"} are also shown below.`
    : "No individual playback, history, or dispatch steps were captured for these records.";
  return `
    <div class="media-info-audit-coverage-note">
      <strong>Historical coverage</strong>
      <span>${escapeHtml(`${legacyLabel} only contain compact history data. The exact source event, device, and dispatch sequence were not stored and cannot be reconstructed exactly. ${exactNote}`)}</span>
    </div>
  `;
}

function auditEventProviderIds(event = {}) {
  const labels = { imdb: "IMDb", tmdb: "TMDB", tvdb: "TVDB" };
  return Object.entries(event.ids || {})
    .filter(([, value]) => value != null && value !== "")
    .map(([key, value]) => `${labels[key] || key.toUpperCase()}: ${value}`)
    .join(", ");
}

function auditEventFieldEntries(event = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const itemIds = [...new Set([
    event.itemId,
    ...(Array.isArray(payload.itemIds) ? payload.itemIds : []),
  ].filter(Boolean))];
  return [
    ["Event ID", event.id],
    ["Event type", event.eventType],
    ["Action", event.action],
    ["Media type", event.mediaType],
    ["Title", event.title],
    ["Show title", event.showTitle],
    ["Occurred at", auditEventTime(event)],
    ["Source platform", event.source ? platformName(event.source) : ""],
    ["Source event", event.sourceEvent],
    ["Phase", event.phase],
    ["Push destination", event.target ? platformName(event.target) : ""],
    ["Status", event.status],
    ["HTTP status", payload.httpStatus ?? payload.statusCode],
    ["Playback device", event.device],
    ["Device ID", event.deviceId],
    ["Client", event.client],
    ["Client version", event.clientVersion],
    ["Source user", event.user],
    ["Session ID", event.sessionId],
    ["Source item ID", event.itemId],
    ["Related item IDs", itemIds],
    ["Provider IDs", auditEventProviderIds(event)],
    ["Season / episode", event.season != null && event.episode != null
      ? `S${String(event.season).padStart(2, "0")}E${String(event.episode).padStart(2, "0")}`
      : "Not applicable"],
    ["Source timestamp", auditEventDate(event.sourceTimestamp)],
    ["Captured at", auditEventDate(event.capturedAt)],
    ["Watch record ID", event.watchRecordId],
    ["Media key", event.mediaKey],
    ["Audit row created at", auditEventDate(event.createdAt)],
  ];
}

function renderLegacyInfoAuditTimeline(events = [], coverage = {}) {
  const sourceValues = [...new Set(events.map((event) => platformName(event.source)).filter((value) => value && value !== "Unknown"))];
  const targetValues = [...new Set(events.map((event) => platformName(event.target)).filter((value) => value && value !== "Unknown"))];
  const deviceValues = [...new Set(events.map((event) => event.device).filter(Boolean))];
  const userValues = [...new Set(events.map((event) => event.user).filter(Boolean))];
  const sessionValues = [...new Set(events.map((event) => event.sessionId).filter(Boolean))];
  const contextEntries = [
    ["Recorded source", sourceValues.length ? sourceValues : "Not recorded"],
    ["Push destinations", targetValues.length ? targetValues : "Not recorded"],
    ["Playback device", deviceValues.length ? deviceValues : "Not recorded by source"],
    ["Source user", userValues.length ? userValues : "Not recorded"],
    ["Sessions", sessionValues.length || coverage.eventCount ? (sessionValues.length || "Not recorded") : "Not recorded"],
  ];
  const sortedEvents = [...events].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.id || 0) - Number(b.id || 0));

  return `
    <section class="media-info-timeline-block">
      <div class="media-info-subhead media-info-timeline-head">
        <div>
          <h3>Timeline</h3>
        </div>
        <b>${events.length} event${events.length === 1 ? "" : "s"}</b>
      </div>
      <div class="media-info-fields media-info-timeline-context">
        ${contextEntries.map(([label, value]) => infoField(label, value)).join("")}
      </div>
      ${sortedEvents.length ? `
        <ol class="media-info-timeline" aria-label="Media history timeline">
          ${sortedEvents.map((event, index) => {
            const targetItemIds = [event.itemId, ...(Array.isArray(event.payload?.itemIds) ? event.payload.itemIds : [])].filter(Boolean);
            const metadata = [
              event.source ? `From ${platformName(event.source)}` : "",
              event.target ? `Target ${platformName(event.target)}` : "",
              event.status ? `Status ${event.status}` : "",
              event.device ? `Device ${event.device}` : "",
              event.user ? `User ${event.user}` : "",
              targetItemIds.length ? `Item${targetItemIds.length === 1 ? "" : "s"} ${targetItemIds.join(", ")}` : "",
              event.sessionId ? `Session ${event.sessionId}` : "",
              event.sourceTimestamp ? `Source time ${infoDate(event.sourceTimestamp)}` : "",
              event.payload?.httpStatus ? `HTTP ${event.payload.httpStatus}` : "",
            ].filter(Boolean);
            const payloadText = auditEventPayloadText(event);
            return `
              <li class="media-info-timeline-event media-info-timeline-event--${escapeAttribute(String(event.status || "recorded").toLowerCase().replace(/[^a-z0-9_-]/g, "-"))}">
                <span class="media-info-timeline-marker" aria-hidden="true">${index + 1}</span>
                <div class="media-info-timeline-event-body">
                  <div class="media-info-timeline-event-head">
                    <div>
                      <strong>${escapeHtml(auditEventLabel(event))}</strong>
                      <span>${escapeHtml(auditEventTime(event))}</span>
                    </div>
                    ${event.phase || event.sourceEvent ? `<span class="media-info-timeline-kind">${escapeHtml([event.phase, event.sourceEvent].filter(Boolean).join(" · "))}</span>` : ""}
                  </div>
                  ${event.details ? `<p>${escapeHtml(event.details)}</p>` : ""}
                  ${metadata.length ? `<div class="media-info-timeline-meta">${metadata.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
                  ${payloadText !== "No additional payload was stored." ? `
                    <details class="media-info-telemetry media-info-timeline-payload">
                      <summary>Recorded event payload</summary>
                      <pre>${escapeHtml(payloadText)}</pre>
                    </details>
                  ` : ""}
                </div>
              </li>
            `;
          }).join("")}
        </ol>
      ` : `
        <div class="media-info-audit-empty">
          <strong>No durable timeline events are recorded yet.</strong>
          <span>New playback, history writes, and outbound syncs will appear here.</span>
        </div>
      `}
    </section>
  `;
}

function renderInfoAuditTimeline(events = [], coverage = {}) {
  const sourceValues = [...new Set(events.map((event) => platformName(event.source)).filter((value) => value && value !== "Unknown"))];
  const targetValues = [...new Set(events.map((event) => platformName(event.target)).filter((value) => value && value !== "Unknown"))];
  const deviceValues = [...new Set(events.map((event) => event.device).filter(Boolean))];
  const userValues = [...new Set(events.map((event) => event.user).filter(Boolean))];
  const sessionValues = [...new Set(events.map((event) => event.sessionId).filter(Boolean))];
  const contextEntries = [
    ["Recorded source", sourceValues.length ? sourceValues : "Not recorded"],
    ["Push destinations", targetValues.length ? targetValues : "Not recorded"],
    ["Playback device", deviceValues.length ? deviceValues : "Not recorded by source"],
    ["Source user", userValues.length ? userValues : "Not recorded"],
    ["Sessions", sessionValues.length || coverage.eventCount ? (sessionValues.length || "Not recorded") : "Not recorded"],
  ];
  const sortedEvents = [...events].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.id || 0) - Number(b.id || 0));

  return `
    <section class="media-info-timeline-block">
      <div class="media-info-subhead media-info-timeline-head">
        <div>
          <h3>Event timeline</h3>
          <p>One card represents one stored audit event.</p>
        </div>
        <b>${escapeHtml(auditEventCountText(events, coverage))}</b>
      </div>
      ${auditEventCoverageNote(events, coverage)}
      <div class="media-info-fields media-info-timeline-context">
        ${contextEntries.map(([label, value]) => infoField(label, value)).join("")}
      </div>
      ${sortedEvents.length ? `
        <ol class="media-info-audit-records" aria-label="Media history audit records">
          ${sortedEvents.map((event, index) => {
            const payloadText = auditEventPayloadText(event);
            return `
              <li class="media-info-audit-record media-info-audit-record--${escapeAttribute(String(event.status || "recorded").toLowerCase().replace(/[^a-z0-9_-]/g, "-"))}">
                <article class="media-info-audit-record-card">
                  <header class="media-info-audit-record-head">
                    <div>
                      <span class="media-info-audit-record-number">Event ${index + 1}</span>
                      <strong>${escapeHtml(auditEventLabel(event))}</strong>
                      <span class="media-info-audit-record-time">${escapeHtml(auditEventTime(event))}</span>
                    </div>
                    <span class="media-info-audit-record-status">${escapeHtml(infoValue(event.status, "Recorded"))}</span>
                  </header>
                  ${event.details ? `
                    <div class="media-info-audit-record-details">
                      <span>Details</span>
                      <p>${escapeHtml(event.details)}</p>
                    </div>
                  ` : ""}
                  <div class="media-info-fields media-info-audit-event-fields">
                    ${auditEventFieldEntries(event).map(([label, value]) => infoField(label, value)).join("")}
                  </div>
                  ${payloadText !== "No additional payload was stored." ? `
                    <details class="media-info-telemetry media-info-audit-payload">
                      <summary>Recorded event payload</summary>
                      <pre>${escapeHtml(payloadText)}</pre>
                    </details>
                  ` : ""}
                </article>
              </li>
            `;
          }).join("")}
        </ol>
      ` : `
        <div class="media-info-audit-empty">
          <strong>No durable timeline events are recorded yet.</strong>
          <span>New playback, history writes, and outbound syncs will appear here.</span>
        </div>
      `}
    </section>
  `;
}

function exportFieldLines(entries, indent = "") {
  return entries.map(([label, value]) => `${indent}${label}: ${infoValue(value)}`);
}

function mediaInfoExportText({ context, title, summaryText, isTv, records, glanceEntries, auditEvents = [], auditCoverage = {} }) {
  const lines = [
    "PLEKT MEDIA INFORMATION",
    "===========================",
    `Title: ${title}`,
    `Media type: ${isTv ? "TV show" : "Movie"}`,
    `Summary: ${summaryText}`,
    "",
    "AUDIT SUMMARY",
    "------------",
    ...exportFieldLines(glanceEntries),
    `Audit coverage: ${auditEventCountText(auditEvents, auditCoverage)}`,
    "",
    "TIMELINE",
    "--------",
  ];

  if (!auditEvents.length) {
    lines.push("No durable timeline events are recorded yet.");
  } else {
    [...auditEvents]
      .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0) || Number(a.id || 0) - Number(b.id || 0))
      .forEach((event, index) => {
        lines.push(
          "",
          `Event ${index + 1}: ${auditEventLabel(event)}`,
          ...exportFieldLines(auditEventFieldEntries(event), "  "),
        );
        if (event.payload != null) lines.push("", "  Recorded event payload", auditEventPayloadText(event));
      });
  }

  lines.push("", "DETAILED AUDIT", "--------------");

  if (!records.length) {
    lines.push("No local watch records.");
  } else {
    records.forEach((record, index) => {
      const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
      const provenance = provenanceForEntry(record);
      const hasRecord = hasWatchRecordData(record);
      const status = hasRecord && telemetry ? syncStatus(record) : { label: "Not recorded" };
      const playHistory = Array.isArray(record.playHistory)
        ? [...record.playHistory].sort((a, b) => String(b.watched_at).localeCompare(String(a.watched_at)))
        : [];
      const recordId = record.id || `record-${index}`;
      const episode = record.season != null && record.episode != null
        ? `S${String(record.season).padStart(2, "0")}E${String(record.episode).padStart(2, "0")}`
        : "Not applicable";

      lines.push(
        "",
        `Record ${index + 1}: ${infoRecordTitle(record, context)}`,
        ...exportFieldLines([
          ["Record ID", recordId],
          ["Source platform", platformName(record.source)],
          ["Action", hasRecord ? historyAction(record) : "Not recorded"],
          ["Sync state", status.label],
          ["Telemetry origin", telemetryLineValue(telemetry, "Origin")],
          ["Watched at", infoDate(record.watched_at)],
          ["Media key", record.media_key],
          ["Season / episode", episode],
        ], "  "),
        "",
        "  Ingest provenance",
        ...exportFieldLines([
          ["Ingest path", provenance.ingest_path],
          ["Source event", provenance.event],
          ["Source item ID", provenance.item_id],
          ["Source session ID", provenance.session_id],
          ["Source user", provenance.user],
          ["Source device", provenance.device],
          ["Source device ID", provenance.device_id],
          ["Source client", provenance.client],
          ["Source client version", provenance.client_version],
          ["Source timestamp", infoDate(provenance.source_timestamp)],
          ["Captured at", infoDate(provenance.captured_at)],
          ["Confidence", provenance.confidence],
          ["Note", provenance.note],
        ], "    "),
      );

      if (playHistory.length) {
        lines.push("", "  Recorded play history", ...playHistory.map((play) => `    ${infoDate(play.watched_at)} · ${platformName(play.source)}`));
      }

      lines.push(
        "",
        "  Sync dispatch telemetry",
        `    ${telemetry || "No sync telemetry recorded for this row."}`,
        "",
        "  Stored record fields",
        JSON.stringify(infoRecordPayload(record), null, 2),
      );
    });
  }

  return lines.join("\n");
}

function mediaInfoExportFilename(title) {
  const safeTitle = String(title || "media")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80) || "media";
  return `${safeTitle}-plekt-info.txt`;
}

function downloadMediaInfoText(title, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = mediaInfoExportFilename(title);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function closeMediaInfoModal() {
  _mediaInfoRequestToken += 1;
  if (!_mediaInfoOverlay) return;
  if (_mediaInfoKeydown) document.removeEventListener("keydown", _mediaInfoKeydown);
  if (_mediaInfoBoundsHandler) window.removeEventListener("resize", _mediaInfoBoundsHandler);
  _mediaInfoOverlay.remove();
  _mediaInfoOverlay = null;
  document.body.style.overflow = _mediaInfoPreviousOverflow;
  _mediaInfoPreviousOverflow = "";
  _mediaInfoKeydown = null;
  _mediaInfoBoundsHandler = null;
}

function syncMediaInfoOverlayBounds() {
  if (!_mediaInfoOverlay) return;
  const detailPage = document.querySelector(".immersive-container.media-detail-page");
  if (!detailPage) return;
  const rect = detailPage.getBoundingClientRect();
  if (!rect.width) return;
  _mediaInfoOverlay.classList.add("media-info-overlay--detail-page");
  _mediaInfoOverlay.style.setProperty("--media-info-page-left", `${rect.left}px`);
  _mediaInfoOverlay.style.setProperty("--media-info-page-top", `${Math.max(rect.top, 0)}px`);
  _mediaInfoOverlay.style.setProperty("--media-info-page-width", `${rect.width}px`);
  _mediaInfoOverlay.style.setProperty("--media-info-page-right", `${Math.max(window.innerWidth - rect.right, 0)}px`);
}

export async function openMediaInfoModal() {
  const context = state.activeMediaInfo;
  if (!context) return;
  closeMediaInfoModal();
  const requestToken = ++_mediaInfoRequestToken;
  let activeContext = context;
  let auditEvents = Array.isArray(context.auditEvents) ? context.auditEvents : [];
  let auditCoverage = context.auditCoverage || {};
  let auditError = "";
  try {
    const audit = await fetchMediaInfoAudit(context);
    auditEvents = Array.isArray(audit.events) ? audit.events : [];
    auditCoverage = audit.coverage || {};
  } catch (error) {
    auditError = error?.message || "The durable audit could not be loaded.";
  }
  if (requestToken !== _mediaInfoRequestToken || state.activeMediaInfo !== context) return;
  activeContext = { ...context, auditEvents, auditCoverage, auditError };
  state.activeMediaInfo = activeContext;
  const media = activeContext.media || {};
  const metadata = activeContext.tmdbData || {};
  const isTv = activeContext.mediaType === "tv";
  const title = metadata.name || metadata.title || media.title || "Media information";
  const records = infoRecords(activeContext);
  const recordAuditEvents = records.map((record) => auditEventsForRecord(record, auditEvents, activeContext));
  const watchDates = records.map((record, index) => infoWatchDetails(record, recordAuditEvents[index], provenanceForEntry).watchedAt).filter(Boolean).sort();
  const targetStates = records.flatMap((record, index) => infoSyncTargetStates(record, recordAuditEvents[index]));
  const targets = [...new Set([
    ...targetStates.map((state) => platformName(state.target)),
    ...auditEvents.filter((event) => event.target).map((event) => platformName(event.target)),
  ].filter((target) => target && target !== "Unknown"))];
  const syncProblemCount = records.reduce((count, record, index) => {
    const summary = infoSyncSummary(record, infoSyncTargetStates(record, recordAuditEvents[index]));
    return count + (summary.tone === "error" ? Math.max(summary.problems.length, 1) : 0);
  }, 0);
  const watchedCount = isTv
    ? (activeContext.summary?.watchedCount ?? records.length)
    : (records.length ? 1 : 0);
  const totalCount = isTv ? (activeContext.summary?.totalCount ?? metadata.number_of_episodes ?? media.episode_count) : 1;
  const progress = isTv ? (activeContext.summary?.progressPercent ?? (totalCount ? Math.round((watchedCount / totalCount) * 100) : 0)) : records.length ? 100 : 0;
  const poster = activeContext.posterUrl || media.poster_url || metadata.cached_poster_url || "";
  const infoId = `mediaInfoTitle-${Date.now()}`;
  const glanceEntries = mediaInfoGlanceEntries({ isTv, records, watchedCount, totalCount, targets, watchDates, syncProblemCount });
  const renderDebug = (record, events) => renderInfoRecordDebug(record, activeContext, records.indexOf(record), events);
  const watchAndSyncBody = renderInfoWatchSync(records, activeContext, auditEvents, provenanceForEntry, renderDebug);
  const matchedAuditEvents = new Set(recordAuditEvents.flat());
  const debugEvents = records.length ? auditEvents.filter((event) => !matchedAuditEvents.has(event)) : auditEvents;
  const debugCoverage = {
    eventCount: debugEvents.length,
    exactEventCount: debugEvents.filter((event) => event.eventType !== "legacy_record").length,
    legacyEventCount: debugEvents.filter((event) => event.eventType === "legacy_record").length,
  };
  const summaryText = isTv
    ? `${watchedCount} of ${infoValue(totalCount, "?")} episodes watched · ${progress}% complete`
    : (records.length ? `Watched · ${infoDate(watchDates.at(-1))}` : "Not watched in Plekt");
  const exportText = mediaInfoExportText({ context: activeContext, title, summaryText, isTv, records, glanceEntries, auditEvents, auditCoverage });
  const auditTimeline = debugEvents.length ? renderInfoAuditTimeline(debugEvents, debugCoverage) : "";
  const auditErrorHtml = auditError ? `<div class="media-info-audit-error"><strong>Audit timeline unavailable</strong><span>${escapeHtml(auditError)}</span></div>` : "";
  const hasGlobalDebug = Boolean(auditError || debugEvents.length);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay media-info-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", infoId);
  overlay.innerHTML = `
    <article class="media-info-panel glass-panel">
      <header class="media-info-head">
        <div class="media-info-title-block">
          ${poster ? `<img class="media-info-poster" src="${escapeAttribute(poster)}" alt="" data-err="hide" />` : ""}
          <div>
            <h2 id="${infoId}">${escapeHtml(title)}</h2>
            <p>${escapeHtml(summaryText)}</p>
          </div>
        </div>
        <div class="media-info-head-actions">
          <button class="button-ghost media-info-export" type="button" data-media-info-export>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
              <path d="M8 1.5v8m0 0 3-3m-3 3-3-3M2.5 10.5v3h11v-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span>Export</span>
          </button>
          <button class="button-ghost media-info-close" type="button" data-media-info-close>Close</button>
        </div>
      </header>
      <div class="media-info-content">
        <div class="media-info-glance">
          ${infoSection("Watch and sync", `
            <div class="media-info-fields">
              ${glanceEntries.map(([label, value]) => infoField(label, value)).join("")}
            </div>
            ${watchAndSyncBody}
          `)}
        </div>
        ${hasGlobalDebug ? `
          <details class="media-info-debug-section">
            <summary>
              <div class="media-info-debug-summary">
                <strong>Other debug details</strong>
                <span>Audit data not tied to an episode</span>
              </div>
              <span class="media-info-detail-count">${escapeHtml(auditEventCountText(debugEvents, debugCoverage))}</span>
            </summary>
            <div class="media-info-debug-body">
              ${auditErrorHtml}
              ${auditTimeline}
            </div>
          </details>
        ` : ""}
      </div>
    </article>
  `;
  _mediaInfoPreviousOverflow = document.body.style.overflow;
  _mediaInfoOverlay = overlay;
  document.body.appendChild(overlay);
  _mediaInfoBoundsHandler = () => syncMediaInfoOverlayBounds();
  window.addEventListener("resize", _mediaInfoBoundsHandler);
  syncMediaInfoOverlayBounds();
  document.body.style.overflow = "hidden";
  const close = () => closeMediaInfoModal();
  overlay.querySelector("[data-media-info-close]")?.addEventListener("click", close);
  overlay.querySelector("[data-media-info-export]")?.addEventListener("click", () => downloadMediaInfoText(title, exportText));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  _mediaInfoKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  document.addEventListener("keydown", _mediaInfoKeydown);
  overlay.querySelector("[data-media-info-close]")?.focus();
}

export function openDebugModal(entry) {
  if (!entry) return;
  const status = syncStatus(entry);
  const provenance = provenanceForEntry(entry);
  elements.debugModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  document.querySelector("#debugModalTitle").textContent = entry.title || "History row";
  elements.modalBody.innerHTML = `
    <section class="diagnostic-grid">
      <div><span>Title</span><b>${escapeHtml(entry.title || "Unknown")}</b></div>
      <div><span>Media type</span><b>${escapeHtml(entry.media_type || "unknown")}</b></div>
      <div><span>IMDb</span><b>${escapeHtml(entry.imdb_id || "None")}</b></div>
      <div><span>TMDB</span><b>${escapeHtml(entry.tmdb_id || "None")}</b></div>
      <div><span>TVDB</span><b>${escapeHtml(entry.tvdb_id || "None")}</b></div>
      <div><span>Source</span><b>${escapeHtml(platformName(entry.source))}</b></div>
      <div><span>Action</span><b>${escapeHtml(historyAction(entry))}</b></div>
      <div><span>Sync state</span><b>${escapeHtml(status.label)}</b></div>
      <div><span>Season</span><b>${escapeHtml(entry.season ?? "None")}</b></div>
      <div><span>Episode</span><b>${escapeHtml(entry.episode ?? "None")}</b></div>
      <div><span>Watched at (oldest)</span><b>${escapeHtml(formatDate(entry.watched_at))}</b></div>
      ${entry.playHistory && entry.playHistory.length > 1 ? `<div><span>Play history</span><b>${entry.playHistory.map(p => escapeHtml(`${formatDate(p.watched_at)} (${platformName(p.source)})`)).join("<br>")}</b></div>` : ""}
    </section>
    <section class="diagnostic-grid">
      <div><span>Ingest path</span><b>${escapeHtml(provenanceValue(provenance.ingest_path, "Unavailable"))}</b></div>
      <div><span>Source event</span><b>${escapeHtml(provenanceValue(provenance.event))}</b></div>
      <div><span>Source item ID</span><b>${escapeHtml(provenanceValue(provenance.item_id))}</b></div>
      <div><span>Source session ID</span><b>${escapeHtml(provenanceValue(provenance.session_id))}</b></div>
      <div><span>Source user</span><b>${escapeHtml(provenanceValue(provenance.user))}</b></div>
      <div><span>Source timestamp</span><b>${escapeHtml(provenanceValue(provenance.source_timestamp))}</b></div>
      <div><span>Provenance captured</span><b>${escapeHtml(provenanceValue(provenance.captured_at))}</b></div>
      <div><span>Confidence</span><b>${escapeHtml(provenanceValue(provenance.confidence))}</b></div>
      <div style="grid-column: 1 / -1;"><span>Provenance note</span><b>${escapeHtml(provenanceValue(provenance.note))}</b></div>
    </section>
    <section class="telemetry-block">
      <p>Sync dispatch telemetry</p>
      <pre>${escapeHtml(entry.sync_dispatch_telemetry || "No sync telemetry recorded for this row.")}</pre>
    </section>
  `;
}
export function closeDebugModal() {
  closeMediaInfoModal();
  elements.debugModal.classList.add("hidden");
  document.body.style.overflow = "";
  const modalPanel = elements.debugModal.querySelector(".modal-panel");
  if (modalPanel) {
    modalPanel.classList.remove("modal-panel--immersive");
  }
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowTvdbId = null;
  state.activeShowModalTitle = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.pendingShowHistoryId = "";
  state.activeShowHistoryId = "";
  state.showModalAllSeasonsExpanded = false;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMediaInfo = null;
  const eyebrowEl = elements.debugModal.querySelector(".eyebrow");
  if (eyebrowEl) {
    eyebrowEl.textContent = "Sync diagnostic audit";
  }
}
export function mediaDetailRoot() {
  if (state.mediaDetailInline) return elements.explorerPanel;
  // The watch-date prompt is opened from the dashboard Part Watched row while the
  // diagnostic modal is closed (and #modalBody therefore display:none, which would
  // suppress the fixed overlay). Anchor to <body> so the overlay always renders.
  if (state.activeView === "dashboard") return document.body;
  return elements.modalBody;
}
export function mediaDetailLoaderHtml(label = "Loading details") {
  const safeLabel = escapeHtml(label);
  return `
    <div class="media-detail-loader" role="status" aria-live="polite" aria-label="${safeLabel}">
      <span class="media-detail-loader-spinner" aria-hidden="true"></span>
      <span class="media-detail-loader-label">${safeLabel}&hellip;</span>
    </div>
  `;
}
export function prepareInlineMediaDetail(mode = state.explorerMode || "movies") {
  setMediaDetailActions("");
  const enteringInlineDetail = !state.mediaDetailInline;
  if (enteringInlineDetail) {
    state.mediaDetailReturnView = state.activeView || "explorer";
    state.mediaDetailReturnExplorerMode = state.explorerMode || "movies";
  }
  state.mediaDetailInline = true;
  state.explorerMode = mode;
  // Route handlers set mediaDetailInline before opening the detail renderer.
  // Re-selecting the already active view here re-enters the same URL route,
  // which starts another detail load and can exhaust the browser's resources.
  if (enteringInlineDetail) selectView("explorer");
  syncInlineMediaDetailHeading(mode);
  elements.explorerPanel.innerHTML = "";
  elements.explorerPanel.scrollIntoView({ block: "start" });
  document.querySelector("#explorerBackButton")?.classList.remove("hidden");
  elements.explorerTopbarControls?.classList.add("hidden");
  // Hide the alphabet picker - it should only appear on the bare movie/show explorer.
  elements.alphaFilterNav?.classList.add("hidden");
  syncPageTopbar();
}
const mobileMediaActionPlaceholders = new WeakMap();
const mobileMediaActionsContainerPlaceholders = new WeakMap();

function moveMediaActionsIntoOptions(el, dropdown, panel) {
  const actionNodes = [...el.children].filter((child) => child !== dropdown);
  for (const action of actionNodes) {
    if (action.parentElement === panel) continue;
    const placeholder = document.createComment("media-detail-action");
    el.insertBefore(placeholder, action);
    mobileMediaActionPlaceholders.set(action, placeholder);
  }
  for (const action of actionNodes.reverse()) {
    if (mobileMediaActionPlaceholders.has(action)) panel.insertBefore(action, panel.firstChild);
  }
}

function restoreMediaActionsToToolbar(el, panel) {
  if (!panel) return;
  for (const action of [...panel.children]) {
    const placeholder = mobileMediaActionPlaceholders.get(action);
    if (!placeholder || placeholder.parentNode !== el) continue;
    placeholder.replaceWith(action);
    mobileMediaActionPlaceholders.delete(action);
  }
}

function moveMediaActionsContainerInline(el) {
  const title = document.querySelector(".page-topbar-title");
  const source = el.parentElement;
  if (!title || !source || title.contains(el)) return;
  const placeholder = document.createComment("media-detail-actions-container");
  source.insertBefore(placeholder, el);
  mobileMediaActionsContainerPlaceholders.set(el, placeholder);
  source.classList.add("media-actions-inline-source");
  title.appendChild(el);
}

function restoreMediaActionsContainer(el) {
  const placeholder = mobileMediaActionsContainerPlaceholders.get(el);
  const source = placeholder?.parentNode || document.getElementById("pageTopbarActions");
  if (!source) return;
  if (placeholder?.parentNode === source) {
    source.insertBefore(el, placeholder);
    placeholder.remove();
  } else if (el.parentElement !== source) {
    source.appendChild(el);
  }
  source.classList.remove("media-actions-inline-source");
  mobileMediaActionsContainerPlaceholders.delete(el);
}

export function setMediaDetailActions(html) {
  const el = document.getElementById("mediaDetailActions");
  if (el) el.innerHTML = html || "";
  el?.querySelector("[data-media-info]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    el.querySelectorAll(".actions-tools-dropdown[open]").forEach((dropdown) => dropdown.removeAttribute("open")); openMediaInfoModal();
  });
  normalizeMediaDetailActions(el);
  syncMediaActionsMenuState();
  syncPageTopbar();
}
export function normalizeMediaDetailActions(el) {
  // No-op: Actions are rendered directly as flat buttons now.
}
export function syncMediaActionsMenuState() {
  const el = document.getElementById("mediaDetailActions");
  if (!el) return;
  const dropdown = el.querySelector(".actions-tools-dropdown");
  if (!dropdown) {
    restoreMediaActionsToToolbar(el, null);
    restoreMediaActionsContainer(el);
    el.classList.remove("actions-collapsed");
    return;
  }
  // Tools is a permanent grouped action. Keep the class that applies the
  // popup treatment at every viewport width instead of flattening the tool
  // actions into the main control bar when there is spare room.
  el.classList.add("actions-collapsed");
  const mobile = window.innerWidth <= 640;
  const panel = dropdown.querySelector(".actions-tools-panel");
  if (mobile && panel) {
    moveMediaActionsIntoOptions(el, dropdown, panel);
    moveMediaActionsContainerInline(el);
  } else {
    restoreMediaActionsToToolbar(el, panel);
    restoreMediaActionsContainer(el);
  }
}
export function syncTopbarControlsMenuState() {
  const menu = elements.topbarControlsMenu;
  if (!menu || menu.classList.contains("hidden")) {
    menu?.removeAttribute("open");
    return;
  }
  const isMobileControls = window.matchMedia("(max-width: 760px)").matches;
  if (!isMobileControls || !document.body.classList.contains("page-controls-options-active")) {
    menu.removeAttribute("open");
  }
}
export function clearMediaDetailState() {
  bumpMediaRenderToken();
  closeMediaInfoModal();
  state.activeShowModalKey = null;
  state.activeShowTmdbId = null;
  state.activeShowTvdbId = null;
  state.activeShowModalTitle = null;
  state.activeShowModalSeason = null;
  state.activeShowModalEpisode = null;
  state.showModalAllSeasonsExpanded = false;
  state.showModalRequestToken += 1;
  state.showModalEpisodes = [];
  state.showModalEpisodeIndex = new Map();
  state.activeShowRenderContext = null;
  state.pendingWatchAction = null;
  state.activeMovieModalId = null;
  state.activeMovieTmdbId = null;
  state.activeMediaInfo = null;
  setMediaDetailActions("");
}
export function closeMediaDetail() {
  if (window.location.pathname.startsWith("/person/")) {
    const returnUrl = state.personReturnUrl;
    state.personReturnUrl = null;
    navigateTo(returnUrl || "/");
    return;
  }
  if (!state.mediaDetailInline) {
    closeDebugModal();
    return;
  }
  state.mediaDetailInline = false;
  clearMediaDetailState();
  document.querySelector("#explorerBackButton")?.classList.add("hidden");
  elements.explorerTopbarControls?.classList.remove("hidden");
  state.explorerMode = state.mediaDetailReturnExplorerMode || state.explorerMode || "movies";
  if (state.mediaDetailReturnView && state.mediaDetailReturnView !== "explorer") {
    selectView(state.mediaDetailReturnView);
    return;
  }
  // A detail page owns a real URL, so closing one has to restore the library URL
  // as well. Rendering the grid without navigating left /tvshow/<key> in the
  // address bar, and the topbar (which derives its title and inline-detail state
  // from location.pathname) stayed in detail mode with the library controls hidden.
  navigateTo(state.explorerMode === "shows" ? "/tvshows" : "/movies");
}
