import { db, getDataVersion, bumpUpNextVersion, parseJson, toJson } from "../db.js";
import { normalizeUpNextCandidate } from "./upNextIdentity.js";
import { queueTmdbMetadataWarmup } from "./tmdbGateway.js";
import { resolveSeriesIds } from "./seriesIdentity.js";

const PROVIDERS = new Set(["plex", "emby", "jellyfin"]);
const FEED_KINDS = new Set(["resume", "next_up"]);
const UP_NEXT_PROVIDERS = new Set(["plex", "emby", "jellyfin"]);

function queueAutomaticUpNextSync(reason) {
  void import("./upNextAutoSync.js")
    .then(({ requestUpNextAutoSync }) => requestUpNextAutoSync(reason))
    .catch((error) => console.error(`[up-next] Automatic sync request failed: ${error?.message || error}`));
}

// Plembfin's unified queue deliberately uses the provider rail with the
// closest meaning on each server. Jellyfin's Continue Watching feed is still
// read separately as a safety boundary for real part-watches, but it is not
// the queue that Plembfin reconciles or projects.
export const PLEMBFIN_UP_NEXT_FEED_BY_PROVIDER = Object.freeze({
  plex: "resume",
  emby: "resume",
  jellyfin: "next_up",
});

export function isPlektPrimaryUpNextFeed(provider, feedKind) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedFeedKind = String(feedKind || "").trim().toLowerCase();
  return PLEMBFIN_UP_NEXT_FEED_BY_PROVIDER[normalizedProvider] === normalizedFeedKind;
}

const selectFeedStateStmt = db.prepare(
  "SELECT * FROM up_next_provider_feed_state WHERE provider = ? AND feed_kind = ?",
);
const selectFeedStatesStmt = db.prepare(
  "SELECT * FROM up_next_provider_feed_state ORDER BY provider ASC, feed_kind ASC",
);
const selectActiveItemsStmt = db.prepare(`
  SELECT items.*
    FROM up_next_provider_items items
    JOIN up_next_provider_feed_state feeds
      ON feeds.provider = items.provider
     AND feeds.feed_kind = items.feed_kind
     AND feeds.active_generation = items.feed_generation
   ORDER BY items.provider ASC, items.feed_kind ASC, items.provider_item_id ASC
`);
const selectActiveItemsForFeedStmt = db.prepare(`
  SELECT items.*
    FROM up_next_provider_items items
    JOIN up_next_provider_feed_state feeds
      ON feeds.provider = items.provider
     AND feeds.feed_kind = items.feed_kind
     AND feeds.active_generation = items.feed_generation
   WHERE items.provider = ? AND items.feed_kind = ?
   ORDER BY items.provider_item_id ASC
`);
const selectActiveItemByProviderIdStmt = db.prepare(`
  SELECT items.*
    FROM up_next_provider_items items
    JOIN up_next_provider_feed_state feeds
      ON feeds.provider = items.provider
     AND feeds.feed_kind = items.feed_kind
     AND feeds.active_generation = items.feed_generation
   WHERE items.provider = ? AND items.provider_item_id = ?
   LIMIT 1
`);
const insertFeedStateStmt = db.prepare(`
  INSERT INTO up_next_provider_feed_state
    (provider, feed_kind, current_generation, active_generation, status, started_at,
     completed_at, last_success_at, item_count, last_run_complete, cursor_json,
     last_error, retry_after, updated_at)
  VALUES (@provider, @feed_kind, @current_generation, @active_generation, @status, @started_at,
     @completed_at, @last_success_at, @item_count, @last_run_complete, @cursor_json,
     @last_error, @retry_after, @updated_at)
  ON CONFLICT(provider, feed_kind) DO UPDATE SET
    current_generation = excluded.current_generation,
    active_generation = excluded.active_generation,
    status = excluded.status,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    last_success_at = excluded.last_success_at,
    item_count = excluded.item_count,
    last_run_complete = excluded.last_run_complete,
    cursor_json = excluded.cursor_json,
    last_error = excluded.last_error,
    retry_after = excluded.retry_after,
    updated_at = excluded.updated_at
`);
const insertProviderItemStmt = db.prepare(`
  INSERT INTO up_next_provider_items
    (provider, feed_kind, provider_item_id, media_key, media_type, title, show_title,
     episode_title, season, episode, year, air_date, poster_url, show_poster_url, imdb_id, tmdb_id, tvdb_id, show_imdb_id,
     show_tmdb_id, show_tvdb_id, provider_ids_json, parent_provider_item_id,
     series_provider_item_id, position_ms, duration_ms, progress, source_updated_at,
     observed_at, feed_generation, last_seen_at, resolution_status, last_error)
  VALUES (@provider, @feed_kind, @provider_item_id, @media_key, @media_type, @title, @show_title,
     @episode_title, @season, @episode, @year, @air_date, @poster_url, @show_poster_url, @imdb_id, @tmdb_id, @tvdb_id, @show_imdb_id,
     @show_tmdb_id, @show_tvdb_id, @provider_ids_json, @parent_provider_item_id,
     @series_provider_item_id, @position_ms, @duration_ms, @progress, @source_updated_at,
     @observed_at, @feed_generation, @last_seen_at, @resolution_status, @last_error)
  ON CONFLICT(provider, feed_kind, provider_item_id) DO UPDATE SET
    media_key = excluded.media_key,
    media_type = excluded.media_type,
    title = excluded.title,
    show_title = excluded.show_title,
    episode_title = excluded.episode_title,
    season = excluded.season,
    episode = excluded.episode,
    year = excluded.year,
    air_date = excluded.air_date,
    poster_url = excluded.poster_url,
    show_poster_url = excluded.show_poster_url,
    imdb_id = excluded.imdb_id,
    tmdb_id = excluded.tmdb_id,
    tvdb_id = excluded.tvdb_id,
    show_imdb_id = excluded.show_imdb_id,
    show_tmdb_id = excluded.show_tmdb_id,
    show_tvdb_id = excluded.show_tvdb_id,
    provider_ids_json = excluded.provider_ids_json,
    parent_provider_item_id = excluded.parent_provider_item_id,
    series_provider_item_id = excluded.series_provider_item_id,
    position_ms = excluded.position_ms,
    duration_ms = excluded.duration_ms,
    progress = excluded.progress,
    source_updated_at = excluded.source_updated_at,
    observed_at = excluded.observed_at,
    feed_generation = excluded.feed_generation,
    last_seen_at = excluded.last_seen_at,
    resolution_status = excluded.resolution_status,
    last_error = excluded.last_error
`);
const deleteFeedItemsStmt = db.prepare(
  "DELETE FROM up_next_provider_items WHERE provider = ? AND feed_kind = ?",
);
const deleteInactiveFeedItemsStmt = db.prepare(
  "DELETE FROM up_next_provider_items WHERE provider = ? AND feed_kind = ? AND feed_generation <> ?",
);

function assertFeed(provider, feedKind) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedFeedKind = String(feedKind || "").trim().toLowerCase();
  if (!PROVIDERS.has(normalizedProvider)) throw new Error(`Unsupported Up Next provider: ${normalizedProvider}`);
  if (!FEED_KINDS.has(normalizedFeedKind)) throw new Error(`Unsupported Up Next feed: ${normalizedFeedKind}`);
  return { provider: normalizedProvider, feedKind: normalizedFeedKind };
}

function safeErrorCode(value) {
  let current = value;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const code = String(current?.code || "").trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_:-]{1,48}$/.test(code)) return code;
    current = current?.cause;
  }
  return "";
}

function safeError(value) {
  const rawMessage = String(value?.message || value || "Provider feed failed");
  const causeCode = safeErrorCode(value);
  const annotatedMessage = causeCode
    && /\bfetch failed\b/i.test(rawMessage)
    && !rawMessage.toUpperCase().includes(causeCode)
    ? `${rawMessage} (${causeCode})`
    : rawMessage;
  const message = annotatedMessage
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/((?:token|api[_-]?key|password|secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
  return message || "Provider feed failed";
}

function normalizedFeedItems(provider, feedKind, items = [], now = Date.now()) {
  const byId = new Map();
  for (const raw of Array.isArray(items) ? items : []) {
    const candidate = normalizeUpNextCandidate({ provider, feed_kind: feedKind, item: raw });
    if (!candidate.provider_item_id) continue;
    candidate.observed_at = now;
    candidate.last_seen_at = now;
    byId.set(candidate.provider_item_id, candidate);
  }
  return [...byId.values()];
}

function providerItemPayload(candidate) {
  return {
    ids: {
      imdb: candidate.imdb_id || null,
      tmdb: candidate.tmdb_id || null,
      tvdb: candidate.tvdb_id || null,
    },
    show_ids: {
      imdb: candidate.show_imdb_id || null,
      tmdb: candidate.show_tmdb_id || null,
      tvdb: candidate.show_tvdb_id || null,
    },
    episode_ids: {
      imdb: candidate.episode_imdb_id || null,
      tmdb: candidate.episode_tmdb_id || null,
      tvdb: candidate.episode_tvdb_id || null,
    },
    provider_items: candidate.provider_items || {},
  };
}

function rowToCandidate(row) {
  const payload = parseJson(row.provider_ids_json, {}) || {};
  return normalizeUpNextCandidate({
    provider: row.provider,
    feed_kind: row.feed_kind,
    provider_item_id: row.provider_item_id,
    media_key: row.media_key || "",
    media_type: row.media_type,
    title: row.title,
    show_title: row.show_title,
    episode_title: row.episode_title,
    season: row.season,
    episode: row.episode,
    year: row.year,
    air_date: row.air_date,
    poster_url: row.poster_url,
    show_poster_url: row.show_poster_url,
    ids: payload.ids || { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id },
    show_ids: payload.show_ids || { imdb: row.show_imdb_id, tmdb: row.show_tmdb_id, tvdb: row.show_tvdb_id },
    provider_items: payload.provider_items || { [row.provider]: [row.provider_item_id] },
    parent_provider_item_id: row.parent_provider_item_id,
    series_provider_item_id: row.series_provider_item_id,
    position_ms: row.position_ms,
    duration_ms: row.duration_ms,
    progress: row.progress,
    source_updated_at: row.source_updated_at,
    updated_at: row.source_updated_at,
  });
}

// The stored snapshot reads back ordered by id while providers send recency
// order, and feed order is never stored, so compare in id order.
function contentSignature(items = []) {
  const ordered = [...items].sort((a, b) => (
    String(a.provider_item_id) < String(b.provider_item_id) ? -1 : String(a.provider_item_id) > String(b.provider_item_id) ? 1 : 0
  ));
  return JSON.stringify(ordered.map((item) => ({
    provider: item.source,
    provider_item_id: item.provider_item_id,
    media_key: item.media_key,
    media_type: item.media_type,
    title: item.title,
    show_title: item.show_title,
    episode_title: item.episode_title,
    season: item.season,
    episode: item.episode,
    ids: [item.imdb_id, item.tmdb_id, item.tvdb_id, item.show_imdb_id, item.show_tmdb_id, item.show_tvdb_id],
    position_ms: item.position_ms,
    duration_ms: item.duration_ms,
    progress: item.progress,
    source_updated_at: item.source_updated_at,
    air_date: item.air_date,
    year: item.year,
    poster_url: item.poster_url,
    show_poster_url: item.show_poster_url,
    provider_items: item.provider_items,
  })));
}

function metadataWarmupItems(candidates = []) {
  return candidates.map((candidate) => {
    const isMovie = candidate.media_type === "movie";
    return {
      mediaType: isMovie ? "movie" : "tv",
      // A TV feed item can carry the episode's TMDB id in tmdb_id. Only pass
      // an explicit show id to the warm-up path; the gateway can safely
      // resolve a TVDB episode id, while a TMDB episode id must not become a
      // series cache key.
      tmdbId: isMovie ? candidate.tmdb_id || "" : candidate.show_tmdb_id || "",
      title: isMovie ? candidate.title || "" : candidate.show_title || candidate.title || "",
      ids: isMovie
        ? { imdbId: candidate.imdb_id || "", tvdbId: candidate.tvdb_id || "" }
        : { imdbId: candidate.show_imdb_id || "", tvdbId: candidate.show_tvdb_id || "" },
      verifyTvdbTitle: !isMovie,
    };
  });
}

export function startUpNextProviderFeed(provider, feedKind, { now = Date.now(), cursor = null } = {}) {
  const normalized = assertFeed(provider, feedKind);
  const current = selectFeedStateStmt.get(normalized.provider, normalized.feedKind);
  const generation = Math.max(Number(current?.current_generation || 0), Number(current?.active_generation || 0)) + 1;
  insertFeedStateStmt.run({
    provider: normalized.provider,
    feed_kind: normalized.feedKind,
    current_generation: generation,
    active_generation: Number(current?.active_generation || 0),
    status: "running",
    started_at: now,
    completed_at: current?.completed_at || null,
    last_success_at: current?.last_success_at || null,
    item_count: Number(current?.item_count || 0),
    last_run_complete: 0,
    cursor_json: cursor == null ? current?.cursor_json || null : toJson(cursor),
    // Kept until this run ends: complete clears it and fail replaces it, so a
    // completing run can tell that the previous one failed.
    last_error: current?.last_error || null,
    retry_after: 0,
    updated_at: now,
  });
  return generation;
}

export function completeUpNextProviderFeed(provider, feedKind, generation, items = [], {
  now = Date.now(),
  cursor = null,
  triggerAutoSync = true,
  // A read outside a push that finds a provider back still needs the push the
  // outage skipped, even when feed changes must not queue one.
  triggerOnRecovery = triggerAutoSync,
} = {}) {
  const normalized = assertFeed(provider, feedKind);
  const state = selectFeedStateStmt.get(normalized.provider, normalized.feedKind);
  if (!state || Number(state.current_generation) !== Number(generation)) {
    return { changed: false, ignored: true, generation };
  }
  const candidates = normalizedFeedItems(normalized.provider, normalized.feedKind, items, now);
  const before = selectActiveItemsForFeedStmt.all(normalized.provider, normalized.feedKind).map(rowToCandidate);
  const changed = contentSignature(before) !== contentSignature(candidates);
  // A provider coming back with the same items is not a content change, but
  // the automatic push skipped it while it was down and must now reach it.
  const recovered = Boolean(state.last_error);

  db.transaction(() => {
    deleteFeedItemsStmt.run(normalized.provider, normalized.feedKind);
    for (const candidate of candidates) {
      insertProviderItemStmt.run({
        provider: normalized.provider,
        feed_kind: normalized.feedKind,
        provider_item_id: candidate.provider_item_id,
        media_key: candidate.media_key || candidate.canonical_key,
        media_type: candidate.media_type,
        title: candidate.title || null,
        show_title: candidate.show_title || null,
        episode_title: candidate.episode_title || null,
        season: candidate.season,
        episode: candidate.episode,
        year: candidate.year,
        imdb_id: candidate.imdb_id,
        tmdb_id: candidate.tmdb_id,
        tvdb_id: candidate.tvdb_id,
        show_imdb_id: candidate.show_imdb_id,
        show_tmdb_id: candidate.show_tmdb_id,
        show_tvdb_id: candidate.show_tvdb_id,
        air_date: candidate.air_date || null,
        poster_url: candidate.poster_url || null,
        show_poster_url: candidate.show_poster_url || null,
        provider_ids_json: toJson(providerItemPayload(candidate)),
        parent_provider_item_id: candidate.parent_provider_item_id,
        series_provider_item_id: candidate.series_provider_item_id,
        position_ms: candidate.position_ms,
        duration_ms: candidate.duration_ms,
        progress: candidate.progress,
        source_updated_at: candidate.source_updated_at || null,
        observed_at: now,
        feed_generation: generation,
        last_seen_at: now,
        resolution_status: candidate.resolution_status || "resolved",
        last_error: candidate.last_error || null,
      });
    }
    deleteInactiveFeedItemsStmt.run(normalized.provider, normalized.feedKind, generation);
    insertFeedStateStmt.run({
      provider: normalized.provider,
      feed_kind: normalized.feedKind,
      current_generation: generation,
      active_generation: generation,
      status: "succeeded",
      started_at: state.started_at || now,
      completed_at: now,
      last_success_at: now,
      item_count: candidates.length,
      last_run_complete: 1,
      cursor_json: cursor == null ? state.cursor_json || null : toJson(cursor),
      last_error: null,
      retry_after: 0,
      updated_at: now,
    });
  }).immediate();

  // Metadata enrichment belongs to the background discovery path, never to
  // the dashboard projection. Keep it outside the SQLite transaction so a
  // provider outage cannot hold the feed tables open.
  if (candidates.length) {
    try {
      queueTmdbMetadataWarmup(metadataWarmupItems(candidates), { reason: "up-next-provider-discovery" });
    } catch (error) {
      // A cache enqueue failure must not turn an already-committed provider
      // snapshot into a failed feed run. The scheduler backstop will retry the
      // metadata discovery later.
      console.warn(`Up Next metadata warm-up queue failed: ${error?.message || error}`);
    }
  }
  if (changed) {
    bumpUpNextVersion();
    if (triggerAutoSync) queueAutomaticUpNextSync(`provider ${normalized.provider} ${normalized.feedKind} feed changed`);
  }
  if (recovered && triggerOnRecovery && !(changed && triggerAutoSync)) {
    queueAutomaticUpNextSync(`provider ${normalized.provider} ${normalized.feedKind} feed recovered`);
  }
  return { changed, ignored: false, generation, itemCount: candidates.length };
}

export function failUpNextProviderFeed(provider, feedKind, generation, error, { now = Date.now(), retryAfter = 0, partial = false, cursor = null } = {}) {
  const normalized = assertFeed(provider, feedKind);
  const state = selectFeedStateStmt.get(normalized.provider, normalized.feedKind);
  if (!state || Number(state.current_generation) !== Number(generation)) return { ignored: true, generation };
  insertFeedStateStmt.run({
    provider: normalized.provider,
    feed_kind: normalized.feedKind,
    current_generation: generation,
    active_generation: Number(state.active_generation || 0),
    status: partial ? "partial" : "failed",
    started_at: state.started_at || now,
    completed_at: state.completed_at || null,
    last_success_at: state.last_success_at || null,
    item_count: Number(state.item_count || 0),
    last_run_complete: 0,
    cursor_json: cursor == null ? state.cursor_json || null : toJson(cursor),
    last_error: safeError(error),
    retry_after: Math.max(0, Number(retryAfter) || 0),
    updated_at: now,
  });
  return { ignored: false, generation, status: partial ? "partial" : "failed" };
}

// Feed episodes often carry only their own ids plus the native series handle
// (Plex's modern agent sends no grandparent guids). Without series ids the
// projection falls back to the title index, which gives a same-title show's
// ids (Scrubs 2001 vs the 2026 reboot). Resolve the handle before storing so
// the observation keeps the identity the media server itself gave it.
export async function withUpNextFeedSeriesIdentity(provider, items = [], providerConfig = null, {
  resolve = resolveSeriesIds,
} = {}) {
  if (!Array.isArray(items) || !providerConfig) return items;
  return Promise.all(items.map(async (raw) => {
    const candidate = normalizeUpNextCandidate({ provider, item: raw });
    if (candidate.media_type !== "episode" || !candidate.series_provider_item_id) return raw;
    if (candidate.show_imdb_id || candidate.show_tmdb_id || candidate.show_tvdb_id) return raw;
    const seriesIds = await resolve(provider, candidate.series_provider_item_id, providerConfig);
    return seriesIds ? { ...raw, show_ids: seriesIds } : raw;
  }));
}

export function recordUpNextProviderFeed(provider, feedKind, items = [], options = {}) {
  const generation = startUpNextProviderFeed(provider, feedKind, options);
  try {
    return completeUpNextProviderFeed(provider, feedKind, generation, items, options);
  } catch (error) {
    failUpNextProviderFeed(provider, feedKind, generation, error, options);
    throw error;
  }
}

export function listActiveUpNextProviderItems() {
  return selectActiveItemsStmt.all().map(rowToCandidate);
}

// Poster requests use the native provider id in their proxy URL. Resolve it
// against the active snapshot so artwork can be fetched with the server-side
// Emby/Jellyfin/Plex credentials without exposing those credentials to the
// browser.
export function getActiveUpNextProviderItemById(provider, providerItemId) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedId = String(providerItemId || "").trim();
  if (!normalizedProvider || !normalizedId) return null;
  const row = selectActiveItemByProviderIdStmt.get(normalizedProvider, normalizedId);
  return row ? rowToCandidate(row) : null;
}

export function listUpNextProviderFeedStates() {
  return selectFeedStatesStmt.all().map((row) => ({
    provider: row.provider,
    feed_kind: row.feed_kind,
    status: row.status,
    current_generation: Number(row.current_generation || 0),
    active_generation: Number(row.active_generation || 0),
    started_at: Number(row.started_at || 0),
    completed_at: Number(row.completed_at || 0),
    last_success_at: Number(row.last_success_at || 0),
    item_count: Number(row.item_count || 0),
    complete: Boolean(row.last_run_complete),
    cursor: parseJson(row.cursor_json, null),
    last_error: row.last_error || null,
    retry_after: Number(row.retry_after || 0),
    updated_at: Number(row.updated_at || 0),
  }));
}

export function getUpNextFeedSourceVersion() {
  const feeds = listUpNextProviderFeedStates()
    .filter((feed) => UP_NEXT_PROVIDERS.has(String(feed?.provider || "").toLowerCase()))
    .map((feed) => ({
      provider: feed.provider,
      feed_kind: feed.feed_kind,
      status: feed.status,
      item_count: feed.item_count,
      complete: feed.complete,
      last_error: feed.last_error,
    }));
  const items = listActiveUpNextProviderItems()
    .filter((item) => UP_NEXT_PROVIDERS.has(String(item?.source || "").toLowerCase()))
    .map((item) => ({
      provider: item.source,
      feed_kind: item.queue_kind,
      provider_item_id: item.provider_item_id,
      canonical_key: item.canonical_key,
      title: item.title,
      show_title: item.show_title,
      episode_title: item.episode_title,
      season: item.season,
      episode: item.episode,
      year: item.year,
      air_date: item.air_date,
      poster_url: item.poster_url,
      show_poster_url: item.show_poster_url,
      ids: [item.imdb_id, item.tmdb_id, item.tvdb_id, item.show_imdb_id, item.show_tmdb_id, item.show_tvdb_id],
      position_ms: item.position_ms,
      duration_ms: item.duration_ms,
      progress: item.progress,
      source_updated_at: item.source_updated_at,
      provider_items: item.provider_items,
    }));
  return `${getDataVersion()}:${JSON.stringify({ feeds, items })}`;
}

// Remove rows for providers that are no longer supported. The feed mapping is
// intentionally separate: all supported providers may expose both Resume and
// Next Up observations even though only one feed per provider is Plembfin's
// target queue.
export function purgeUnsupportedUpNextProviders() {
  const supported = [...UP_NEXT_PROVIDERS];
  const placeholders = supported.map(() => "?").join(", ");
  const items = db.prepare(
    `DELETE FROM up_next_provider_items WHERE LOWER(provider) NOT IN (${placeholders})`,
  ).run(...supported);
  const feeds = db.prepare(
    `DELETE FROM up_next_provider_feed_state WHERE LOWER(provider) NOT IN (${placeholders})`,
  ).run(...supported);
  const removed = Number(items.changes || 0) + Number(feeds.changes || 0);
  if (removed) {
    bumpUpNextVersion();
    queueAutomaticUpNextSync("unsupported Up Next provider data purged");
    console.log(`Removed ${items.changes} stale Up Next provider item(s) and ${feeds.changes} feed state(s) for unsupported providers.`);
  }
  return { items: Number(items.changes || 0), feeds: Number(feeds.changes || 0) };
}

export { safeError as redactUpNextProviderError };
