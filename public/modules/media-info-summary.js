import { escapeHtml, escapeAttribute, platformName, formatDate, formatSeasonTitle } from "./utils.js?v=2.1.1.0.5";
import { normalizeTargetStatus, syncStatus, telemetryTargetStates } from "./sync.js?v=2.1.1.0.5";

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

function infoRecordTitle(record = {}, context = {}) {
  const title = record.episode_title || record.title || context.media?.title || "Watch record";
  if (context.mediaType !== "tv" || record.season == null || record.episode == null) return title;
  return `${infoEpisodeCode(record)} - ${title}`;
}

function infoEpisodeCode(record = {}) {
  if (record.season == null || record.episode == null) return "";
  return `S${String(record.season).padStart(2, "0")}E${String(record.episode).padStart(2, "0")}`;
}

function infoPlatform(value) {
  if (value == null || String(value).trim() === "") return "Not recorded";
  const name = platformName(value);
  return name && name !== "Unknown" ? name : "Not recorded";
}

export function auditEventsForRecord(record = {}, events = [], context = {}) {
  const recordId = String(record.id ?? "").trim();
  const mediaKey = String(record.media_key ?? "").trim();
  const title = String(record.episode_title || record.title || "").trim().toLowerCase();
  const showTitle = String(record.show_title || context.media?.show_title || context.media?.showTitle || context.media?.title || "").trim().toLowerCase();
  const season = record.season == null ? null : Number(record.season);
  const episode = record.episode == null ? null : Number(record.episode);
  return events.filter((event) => {
    if (recordId && String(event.watchRecordId || "").trim() === recordId) return true;
    if (mediaKey && String(event.mediaKey || "").trim() === mediaKey) return true;
    if (context.mediaType === "tv") {
      return season != null && episode != null
        && Number(event.season) === season
        && Number(event.episode) === episode
        && (!showTitle || !event.showTitle || String(event.showTitle).trim().toLowerCase() === showTitle);
    }
    return Boolean(title && String(event.title || "").trim().toLowerCase() === title);
  });
}

export function infoWatchDetails(record = {}, events = [], getProvenance = () => ({})) {
  const provenance = getProvenance(record) || {};
  const sortedEvents = [...events].sort((a, b) => Number(b.timestamp || b.createdAt || 0) - Number(a.timestamp || a.createdAt || 0));
  const nonSyncEvents = sortedEvents.filter((event) => !String(event.eventType || "").toLowerCase().startsWith("sync_"));
  const sourceEvent = nonSyncEvents.find((event) => event.source || event.client || event.device || event.user) || nonSyncEvents[0] || sortedEvents[0] || {};
  const client = provenance.client || sourceEvent.client || "";
  const device = provenance.device || sourceEvent.device || "";
  const user = provenance.user || sourceEvent.user || "";
  const how = [client, device ? `on ${device}` : "", user ? `for ${user}` : ""].filter(Boolean).join(" ")
    || (provenance.ingest_path && provenance.ingest_path !== "unavailable" ? provenance.ingest_path : "Not recorded");
  return {
    watchedAt: record.watched_at || provenance.source_timestamp || sourceEvent.sourceTimestamp || sourceEvent.timestamp,
    source: infoPlatform(record.source || sourceEvent.source),
    how,
  };
}

function normalizeInfoSyncStatus(value = "") {
  const status = normalizeTargetStatus(value);
  if (["success", "ok", "complete", "completed"].includes(status)) return "success";
  if (["error", "failed", "failure", "timeout"].includes(status)) return "error";
  if (["pending", "queued", "in_progress", "in-progress"].includes(status)) return "pending";
  if (["skipped", "not_found", "not-found"].includes(status)) return "skipped";
  return status || "unknown";
}

export function infoSyncTargetStates(record = {}, events = []) {
  const states = new Map();
  const add = (target, status, detail = "") => {
    const key = String(target || "").trim().toLowerCase();
    if (!["plex", "emby", "jellyfin"].includes(key)) return;
    states.set(key, { target: key, status: normalizeInfoSyncStatus(status), detail: detail || "" });
  };
  const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
  telemetryTargetStates(telemetry).forEach((state) => add(state.target, state.status, state.detail));
  [...events]
    .filter((event) => event.target)
    .sort((a, b) => Number(a.timestamp || a.createdAt || 0) - Number(b.timestamp || b.createdAt || 0))
    .forEach((event) => add(event.target, event.status || event.payload?.status, event.details || event.payload?.detail || ""));
  return [...states.values()];
}

function infoSyncStateLabel(status, detail = "") {
  if (status === "success") return "Synced";
  if (status === "error") return "Problem";
  if (status === "pending") return "Pending";
  if (status === "skipped" && /no matching|not found|unavailable|failed|error/i.test(detail)) return "Problem";
  if (status === "skipped") return "Skipped";
  return "Unknown";
}

function infoSyncProblemStates(states = []) {
  return states.filter((state) => state.status === "error"
    || (state.status === "skipped" && /no matching|not found|unavailable|failed|error/i.test(state.detail || "")));
}

export function infoSyncSummary(record = {}, states = []) {
  const telemetry = record.sync_dispatch_telemetry || record.syncDispatchTelemetry || "";
  const base = telemetry ? syncStatus(record) : null;
  const problems = infoSyncProblemStates(states);
  if (problems.some((state) => state.status === "error" || /no matching|not found|unavailable|failed|error/i.test(state.detail || ""))) {
    return { tone: "error", label: "Sync problem", detail: "One or more target apps did not confirm this watched-state change.", problems };
  }
  if (states.some((state) => state.status === "pending")) {
    return { tone: "pending", label: "Sync pending", detail: "A target app has not confirmed this watched-state change yet.", problems };
  }
  if (states.length && states.some((state) => state.status === "success")) {
    return { tone: "success", label: "Sync complete", detail: "The watched-state change was confirmed by the recorded target apps.", problems };
  }
  if (base?.tone === "error") return { tone: "error", label: "Sync problem", detail: base.detail, problems };
  if (base?.tone === "pending") return { tone: "pending", label: "Sync pending", detail: base.detail, problems };
  if (base?.tone === "success") {
    if (/complete/i.test(base.label || "")) return { tone: "success", label: "Sync complete", detail: base.detail, problems };
    return { tone: "skipped", label: "No outbound sync recorded", detail: base.detail, problems };
  }
  return { tone: "muted", label: "No sync result recorded", detail: "No outbound sync result is stored for this watch record.", problems };
}

function renderInfoWatchSyncCard(record, context, events, getProvenance, debugHtml = "", includeHeading = true) {
  const watch = infoWatchDetails(record, events, getProvenance);
  const states = infoSyncTargetStates(record, events);
  const summary = infoSyncSummary(record, states);
  const syncTargetHtml = states.length ? states.map((state) => `
    <span class="media-info-sync-target media-info-sync-target--${escapeAttribute(state.status)}" title="${escapeAttribute(state.detail || infoSyncStateLabel(state.status, state.detail))}">
      <b>${escapeHtml(infoPlatform(state.target))}</b>
      <span>${escapeHtml(infoSyncStateLabel(state.status, state.detail))}</span>
    </span>
  `).join("") : `<span class="media-info-sync-none media-info-sync-none--${escapeAttribute(summary.tone)}">${escapeHtml(summary.tone === "error" ? "Problem" : summary.tone === "pending" ? "Pending" : summary.tone === "success" ? "Sync complete" : "No outbound sync recorded")}</span>`;
  return `
    <article class="media-info-watch-card media-info-watch-card--${escapeAttribute(summary.tone)}" data-sync-status="${escapeAttribute(summary.tone)}">
      ${includeHeading ? `
        <header class="media-info-watch-card-head">
          <div>
            <strong>${escapeHtml(context.mediaType === "tv" ? infoRecordTitle(record, context) : "Watched")}</strong>
            <span>${escapeHtml(infoDate(watch.watchedAt))}</span>
          </div>
          <span class="media-info-watch-state">Watched</span>
        </header>
      ` : ""}
      <div class="media-info-watch-lines">
        <div class="media-info-watch-line">
          <strong>Watched at</strong><span aria-hidden="true">-</span><b>${escapeHtml(infoDate(watch.watchedAt))}</b>
        </div>
        <div class="media-info-watch-line">
          <strong>From</strong><span aria-hidden="true">-</span><b>${escapeHtml(watch.source)}</b>
        </div>
        <div class="media-info-watch-line">
          <strong>Played using</strong><span aria-hidden="true">-</span><b>${escapeHtml(watch.how)}</b>
        </div>
        <div class="media-info-watch-line media-info-watch-line--sync">
          <strong>Synced to</strong><span aria-hidden="true">-</span><div class="media-info-sync-targets">${syncTargetHtml}</div>
        </div>
      </div>
      ${debugHtml}
    </article>
  `;
}

export function renderInfoWatchSync(records, context, auditEvents, getProvenance, renderDebug = () => "") {
  if (!records.length) {
    return `
      <div class="media-info-empty">
        <strong>${context.mediaType === "tv" ? "No watched episodes are recorded." : "This item is not marked watched."}</strong>
        <span>Any watch and sync details recorded later will appear here.</span>
      </div>
    `;
  }
  if (context.mediaType !== "tv") {
    return `<div class="media-info-watch-list">${records.map((record) => {
      const recordEvents = auditEventsForRecord(record, auditEvents, context);
      return renderInfoWatchSyncCard(record, context, recordEvents, getProvenance, renderDebug(record, recordEvents));
    }).join("")}</div>`;
  }

  const seasons = new Map();
  records.forEach((record) => {
    const key = record.season == null ? "unknown" : String(record.season);
    if (!seasons.has(key)) seasons.set(key, []);
    seasons.get(key).push(record);
  });
  const sortedSeasons = [...seasons.entries()].sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return Number(a) - Number(b);
  });
  return `<div class="media-info-season-list">${sortedSeasons.map(([season, seasonRecords]) => {
    const seasonName = context.tmdbData?.seasons?.find((s) => Number(s.season_number) === Number(season))?.name || "";
    const seasonLabel = season === "unknown" ? "Season not recorded" : formatSeasonTitle(season, seasonName);
    const sortedEpisodes = [...seasonRecords].sort((a, b) => Number(a.episode ?? 0) - Number(b.episode ?? 0));
    return `
      <details class="media-info-season-group">
        <summary>
          <span class="media-info-disclosure-title">${escapeHtml(seasonLabel)}</span>
          <span class="media-info-disclosure-meta">${sortedEpisodes.length} watched episode${sortedEpisodes.length === 1 ? "" : "s"}</span>
        </summary>
        <div class="media-info-episode-list">
          ${sortedEpisodes.map((record) => {
            const recordEvents = auditEventsForRecord(record, auditEvents, context);
            const watch = infoWatchDetails(record, recordEvents, getProvenance);
            const summary = infoSyncSummary(record, infoSyncTargetStates(record, recordEvents));
            const episodeTitle = record.episode_title || record.title || "Episode";
            const title = `${infoEpisodeCode(record) || "Episode"} - ${episodeTitle}`;
            return `
              <details class="media-info-episode-group media-info-episode-group--${escapeAttribute(summary.tone)}" data-sync-status="${escapeAttribute(summary.tone)}">
                <summary>
                  <span class="media-info-disclosure-title">${escapeHtml(title)}</span>
                  <span class="media-info-disclosure-meta">${escapeHtml(infoDate(watch.watchedAt))}</span>
                </summary>
                <div class="media-info-episode-body">
                  ${renderInfoWatchSyncCard(record, context, recordEvents, getProvenance, renderDebug(record, recordEvents), false)}
                </div>
              </details>
            `;
          }).join("")}
        </div>
      </details>
    `;
  }).join("")}</div>`;
}

export function mediaInfoGlanceEntries({ isTv, records, watchedCount, totalCount, targets, watchDates, syncProblemCount }) {
  return [
    [isTv ? "Watched episodes" : "Watch status", isTv ? `${watchedCount} of ${infoValue(totalCount, "?")}` : records.length ? "Watched" : "Not watched"],
    ["Latest watched", infoDate(watchDates.at(-1))],
    ["Sync results", targets.length ? `${targets.length} target${targets.length === 1 ? "" : "s"} recorded` : "No outbound sync recorded"],
    ["Sync problems", syncProblemCount ? `${syncProblemCount} found` : "None recorded"],
  ];
}
