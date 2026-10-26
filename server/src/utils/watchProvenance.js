const MAX_TEXT_LENGTH = 240;

const LEGACY_NOTE = "Record predates detailed provenance capture; only the originating platform was retained.";

function text(value, maxLength = MAX_TEXT_LENGTH) {
  const valueText = String(value ?? "").trim();
  return valueText ? valueText.slice(0, maxLength) : "";
}

function timestamp(value) {
  const valueText = text(value, 80);
  if (!valueText) return "";
  const parsed = new Date(valueText);
  return Number.isNaN(parsed.getTime()) ? valueText : parsed.toISOString();
}

function objectFrom(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function inferredPath(source = "") {
  const normalized = text(source).toLowerCase();
  if (normalized === "manual") return "manual";
  if (normalized === "progress_resolve") return "manual_progress_resolve";
  if (normalized === "force_sync") return "force_sync";
  if (normalized.includes("import")) return "historical_import";
  if (normalized.endsWith("_initial_sync")) return normalized;
  return "unknown";
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

// Some providers split one catalogue series into another series and renumber
// its seasons. Keep that mapping on the watch row without changing the
// canonical TVDB identity or the local episode coordinates used by the rest
// of the application.
export function normalizeProviderOverrides(value) {
  const input = objectFrom(value);
  const rawTrakt = input.trakt || input.trakt_match || input.traktMatch;
  if (!rawTrakt || typeof rawTrakt !== "object" || Array.isArray(rawTrakt)) return null;
  const tmdbId = text(rawTrakt.tmdb_id || rawTrakt.tmdbId || rawTrakt.tmdb, 100);
  if (!tmdbId) return null;
  const season = integer(rawTrakt.season ?? rawTrakt.season_number ?? rawTrakt.seasonNumber);
  const episode = integer(rawTrakt.episode ?? rawTrakt.episode_number ?? rawTrakt.episodeNumber);
  return {
    trakt: {
      tmdb_id: tmdbId,
      ...(season != null ? { season } : {}),
      ...(episode != null ? { episode } : {}),
    },
  };
}

/**
 * Normalize the compact provenance object stored alongside a watch row. Raw
 * webhook payloads never belong in this object; the durable audit event keeps
 * the event payload separately, while credentials must never be captured.
 */
export function normalizeWatchProvenance(value, defaults = {}) {
  const input = objectFrom(value);
  const hasDefaults = Object.keys(defaults || {}).length > 0;
  if (!Object.keys(input).length && !hasDefaults) return null;

  const source = text(input.source || defaults.source);
  const ingestPath = text(input.ingest_path || input.ingestPath || defaults.ingestPath) || inferredPath(source);
  const confidence = text(input.confidence || defaults.confidence) || (ingestPath === "unknown" ? "source_only" : "exact");
  const sourceEvent = text(input.event || input.source_event || input.sourceEvent || defaults.event);
  const sourceTimestamp = timestamp(input.source_timestamp || input.sourceTimestamp || defaults.sourceTimestamp);
  const capturedAt = timestamp(input.captured_at || input.capturedAt || defaults.capturedAt) || new Date().toISOString();
  const percentComplete = Number(input.percent_complete ?? input.percentComplete ?? defaults.percentComplete);
  const providerOverrides = normalizeProviderOverrides(input.provider_overrides || input.providerOverrides || defaults.provider_overrides || defaults.providerOverrides);
  // Kept for one-time imports (Netflix CSV, etc.) so a later re-upload can skip
  // already-imported title+date rows before hitting metadata providers.
  const sourceTitle = text(input.source_title || input.sourceTitle || defaults.source_title || defaults.sourceTitle, 400);

  return {
    version: 1,
    source,
    ingest_path: ingestPath,
    event: sourceEvent,
    phase: text(input.phase || defaults.phase),
    item_id: text(input.item_id || input.itemId || defaults.itemId),
    session_id: text(input.session_id || input.sessionId || defaults.sessionId),
    user: text(input.user || defaults.user),
    device: text(input.device || input.deviceName || defaults.device || defaults.deviceName),
    device_id: text(input.device_id || input.deviceId || defaults.deviceId || defaults.device_id),
    client: text(input.client || defaults.client),
    client_version: text(input.client_version || input.clientVersion || defaults.clientVersion || defaults.client_version),
    source_timestamp: sourceTimestamp,
    captured_at: capturedAt,
    confidence,
    ...(sourceTitle ? { source_title: sourceTitle } : {}),
    ...(Number.isFinite(percentComplete) ? { percent_complete: Math.max(0, Math.min(100, percentComplete)) } : {}),
    ...(providerOverrides ? { provider_overrides: providerOverrides } : {}),
    note: text(input.note || defaults.note || (confidence === "source_only" ? LEGACY_NOTE : ""), 400),
  };
}

export function buildWatchProvenance(media = {}, {
  ingestPath = "",
  sourceTimestamp = "",
  capturedAt = "",
  confidence = "",
  note = "",
  device = "",
  deviceId = "",
  client = "",
    clientVersion = "",
  percentComplete = undefined,
} = {}) {
  const source = text(media.source || media.platform);
  const path = text(ingestPath || media.ingest_path || media.ingestPath) || inferredPath(source);
  return normalizeWatchProvenance({
    source,
    ingest_path: path,
    event: media.event,
    phase: media.phase,
    item_id: media.item_id || media.itemId,
    session_id: media.session_id || media.sessionId,
    user: media.user,
    device: device || media.device || media.deviceName,
    device_id: deviceId || media.deviceId || media.device_id,
    client: client || media.client,
    client_version: clientVersion || media.clientVersion || media.client_version,
    source_timestamp: sourceTimestamp || media.source_timestamp || media.sourceTimestamp || media.playedAt,
    captured_at: capturedAt,
    confidence: confidence || (path === "unknown" ? "source_only" : "exact"),
    percent_complete: percentComplete ?? media.percent_complete ?? media.percentComplete,
    note: note || (path === "unknown" ? LEGACY_NOTE : ""),
  });
}

export function provenanceTelemetryLines(value, defaults = {}) {
  const provenance = normalizeWatchProvenance(value, defaults);
  if (!provenance) {
    return [
      "Ingest path: unavailable",
      "Source event: unavailable",
      "Source item ID: unavailable",
      "Provenance confidence: source_only",
      `Provenance note: ${LEGACY_NOTE}`,
    ];
  }

  const lines = [
    `Ingest path: ${provenance.ingest_path || "unknown"}`,
    `Source event: ${provenance.event || "unavailable"}`,
    `Source item ID: ${provenance.item_id || "unavailable"}`,
  ];
  if (provenance.session_id) lines.push(`Source session ID: ${provenance.session_id}`);
  if (provenance.user) lines.push(`Source user: ${provenance.user}`);
  if (provenance.device) lines.push(`Source device: ${provenance.device}`);
  if (provenance.device_id) lines.push(`Source device ID: ${provenance.device_id}`);
  if (provenance.client) lines.push(`Source client: ${provenance.client}`);
  if (provenance.client_version) lines.push(`Source client version: ${provenance.client_version}`);
  if (provenance.source_timestamp) lines.push(`Source timestamp: ${provenance.source_timestamp}`);
  if (provenance.captured_at) lines.push(`Provenance captured: ${provenance.captured_at}`);
  lines.push(`Provenance confidence: ${provenance.confidence || "unknown"}`);
  if (provenance.note) lines.push(`Provenance note: ${provenance.note}`);
  return lines;
}

export const legacyProvenanceNote = LEGACY_NOTE;
