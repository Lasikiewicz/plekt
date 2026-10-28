import { loadLiveTrackingCache as loadLiveTrackingCacheFromDb } from "./dataRepo.js";
import { fetchWithTimeout } from "./outbound.js";
import { jellyfinAuthHeaders, jellyfinCredential } from "./jellyfinAuth.js";
import { fetchPlexWithRefresh } from "./plexFetch.js";
import { resolvePlexAccountId } from "./plexClient.js";
import { isUpNextSeedDeviceId } from "./embyClient.js";
import { decodeHtmlEntities } from "./parsers.js";
import { watchedThresholdPercent } from "./tuning.js";
import { resolveSeriesIds } from "./seriesIdentity.js";

function trimTrailingSlash(value = "") {
  return String(value).trim().replace(/\/+$/, "");
}

function imagePath(path, params = {}) {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) return "";

  try {
    const url = new URL(cleanPath, "https://media.local");
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return `${url.pathname}${url.search}`;
  } catch (error) {
    return "";
  }
}

function plexPosterUrl(attributes = {}, mediaType = "unknown") {
  const path =
    mediaType === "episode"
      ? attributes.grandparentThumb || attributes.parentThumb || attributes.thumb
      : attributes.thumb || attributes.grandparentThumb || attributes.parentThumb;

  return imagePath(path);
}

function embyLikePosterUrl(item = {}, mediaType = "unknown") {
  const imageTags = item.ImageTags || {};
  const itemId = mediaType === "episode" ? item.SeriesId || item.ParentId || item.Id : item.Id;
  const tag =
    mediaType === "episode"
      ? item.SeriesPrimaryImageTag || item.ParentPrimaryImageTag || imageTags.Primary
      : imageTags.Primary || item.PrimaryImageTag;

  if (!itemId) return "";
  return imagePath(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, {
    tag,
  });
}

// Plex can leave a completed item in /status/sessions for a short time while
// the client tears down playback. It is no longer useful in the dashboard's
// Now Playing rail once only a few seconds remain.
export const NOW_PLAYING_TERMINAL_GRACE_MS = 10_000;

// A live-tracking row can survive a process restart or a long poller outage.
// Once its last provider snapshot is this old, it is historical cache data,
// not trustworthy evidence that playback just completed. Prefer missing a
// watch over manufacturing a phantom watch from a stale high-progress row.
export const LIVE_SESSION_COMPLETION_MAX_AGE_MS = 5 * 60 * 1000;

export function isStaleLiveSessionRow(row = {}, now = Date.now()) {
  const updatedAt = Number(row.updated_at || 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  return Number(now) - updatedAt > LIVE_SESSION_COMPLETION_MAX_AGE_MS;
}

// Playback states that still count as a live session.
//
// "paused" belongs here. A paused session is open, not finished: the media
// server still reports it, the client is still holding it, and playback is
// expected to resume. Excluding it made the session vanish from the poll
// result, which refreshLiveSessions() (scheduled.js) can only read as "the
// session ended" - so pausing for ~20s recorded a stopped play and pushed
// resume progress outbound to every configured server. Only a session the
// media server no longer reports at all is a real stop.
export const LIVE_SESSION_PLAYBACK_STATES = ["playing", "buffering", "paused"];
const LIVE_SESSION_PLAYBACK_STATE_SET = new Set(
  LIVE_SESSION_PLAYBACK_STATES.map((value) => normalizePlaybackState(value)),
);
const TERMINAL_LIVE_SESSION_STATE_SET = new Set([
  "stopped",
  "stop",
  "idle",
  "completed",
  "complete",
  "ended",
  "end",
  "finished",
  "finish",
  "terminated",
  "mediaended",
  "playbackended",
  "playbackstopped",
  "notplaying",
  "closed",
  "disconnected",
]);

export function isTerminalLiveSession(session = {}) {
  const durationMs = Number(session.durationMs ?? session.duration_ms ?? 0);
  const offsetMs = Number(session.offsetMs ?? session.offset_ms ?? 0);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return false;
  return durationMs - offsetMs <= NOW_PLAYING_TERMINAL_GRACE_MS;
}

export function normalizeStoredConfig(stored = {}) {
  return {
    plex: {
      baseUrl: trimTrailingSlash(stored.plex?.baseUrl || stored.plex?.url || ""),
      token: String(stored.plex?.token || stored.plex?.apiKey || "").trim(),
      username: String(stored.plex?.username || "").trim(),
    },
    emby: {
      baseUrl: trimTrailingSlash(stored.emby?.baseUrl || stored.emby?.url || ""),
      apiKey: String(stored.emby?.apiKey || stored.emby?.api_key || "").trim(),
      userId: String(stored.emby?.userId || "").trim(),
    },
    jellyfin: {
      baseUrl: trimTrailingSlash(stored.jellyfin?.baseUrl || stored.jellyfin?.url || ""),
      apiKey: String(stored.jellyfin?.apiKey || stored.jellyfin?.api_key || stored.jellyfin?.token || "").trim(),
      userId: String(stored.jellyfin?.userId || "").trim(),
    },
  };
}

function parseAttributes(chunk = "") {
  const attributes = {};
  const matcher = /([A-Za-z_:][A-Za-z0-9_:\-.]*)="([^"]*)"/g;
  let match;
  while ((match = matcher.exec(chunk))) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function childAttributes(body = "", tagName = "") {
  const matcher = new RegExp(`<${tagName}\\b([^>]*)\\/?\\s*>`, "i");
  const match = body.match(matcher);
  return parseAttributes(match?.[1] || "");
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  if (!Number.isFinite(ticks) || ticks <= 0) return 0;
  return Math.round(ticks / 10000);
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

// Floored, not rounded: the poller compares this with the watched threshold,
// and rounding let 89.5% count as a completed 90%. Display code rounds itself.
function progressPercent(offsetMs, durationMs) {
  if (!durationMs || durationMs <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((offsetMs / durationMs) * 10_000) / 100));
}

function indexNumberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatEpisodeTitle(title, season, episode) {
  const base = String(title || "Unknown Show").trim() || "Unknown Show";
  const seasonText = Number.isFinite(Number(season)) ? String(Number(season)).padStart(2, "0") : "??";
  const episodeText = Number.isFinite(Number(episode)) ? String(Number(episode)).padStart(2, "0") : "??";
  return `${base} - S${seasonText}E${episodeText}`;
}

// Identity of one playback session in live_tracking_cache.
//
// `sessionId` is deliberately the client, not the playback: Plex reports
// machineIdentifier, which survives a transcode or quality switch that would
// otherwise assign the still-playing item a brand new id. But the client alone
// is not enough. Season and episode used to be the only media component, so two
// movies played back to back on one client produced the *same* key: the second
// overwrote the first, reconciliation saw the id still present, and the first
// movie's completion was never processed - the watch was silently lost.
//
// `mediaId` (Plex ratingKey, Emby/Jellyfin item id) closes that. It is stable
// for a given item, so it discriminates between items without reintroducing the
// churn that using Plex's own per-session key would.
function sessionKey(session = {}) {
  return [
    session.source,
    session.sessionId || session.title || "unknown",
    session.mediaId || "none",
    session.season ?? "none",
    session.episode ?? "none",
  ].join(":");
}

function plexGuidIds(attributes = {}, body = "") {
  const guidValues = [attributes.guid, attributes.Guid, attributes.GUID]
    .filter(Boolean)
    .map((value) => String(value));

  const ids = {
    imdb: guidValues.find((value) => value.includes("imdb"))?.split(/:\/\/|\//).pop(),
    tmdb: guidValues.find((value) => value.includes("tmdb"))?.split(/:\/\/|\//).pop(),
    tvdb: guidValues.find((value) => value.includes("tvdb"))?.split(/:\/\/|\//).pop(),
  };

  // Plex's new metadata agent stores external IDs as child <Guid id="tmdb://..."/> elements
  // rather than in the parent tag's guid attribute - parse those too.
  if (body) {
    const matcher = /<Guid\s+id="([^"]+)"/gi;
    let match;
    while ((match = matcher.exec(body))) {
      const guid = match[1];
      if (!ids.imdb && guid.includes("imdb")) ids.imdb = guid.split(/:\/\/|\//).pop();
      if (!ids.tmdb && guid.includes("tmdb")) ids.tmdb = guid.split(/:\/\/|\//).pop();
      if (!ids.tvdb && guid.includes("tvdb")) ids.tvdb = guid.split(/:\/\/|\//).pop();
    }
  }

  return ids;
}

function plexTitle(attributes = {}, mediaType = "unknown") {
  if (mediaType === "episode") {
    return formatEpisodeTitle(decodeHtmlEntities(attributes.grandparentTitle || attributes.title), attributes.parentIndex, attributes.index);
  }

  if (mediaType === "track") {
    const artist = decodeHtmlEntities(attributes.grandparentTitle || attributes.originalTitle || "");
    const title = decodeHtmlEntities(attributes.title || "Unknown Track");
    return artist ? `${artist} - ${title}` : title;
  }

  return decodeHtmlEntities(attributes.title) || "Unknown Movie";
}

export function parsePlexSessions(xmlText = "", config = {}) {
  const sessions = [];
  const tagMatcher = /<(Video|Track)\b([^>]*)>([\s\S]*?)<\/\1>|<(Video|Track)\b([^>]*)\/>/gi;
  let match;

  while ((match = tagMatcher.exec(xmlText))) {
    const nodeName = String(match[1] || match[4] || "").toLowerCase();
    const attributes = parseAttributes(match[2] || match[5] || "");
    const body = match[3] || "";
    const player = childAttributes(body, "Player");
    const user = childAttributes(body, "User");
    const mediaType = String(attributes.type || nodeName || "").toLowerCase();
    const state = String(player.state || attributes.state || "").toLowerCase();

    if (!["movie", "episode", "track"].includes(mediaType)) continue;
    // Paused is a live session, not a finished one. Dropping it here used to make
    // the reconciliation in scheduled.js see the session disappear, which recorded
    // a stopped play and propagated resume progress outbound - on a pause.
    // See LIVE_SESSION_PLAYBACK_STATES.
    if (!LIVE_SESSION_PLAYBACK_STATES.includes(state)) continue;

    const offsetMs = millisecondsFrom(attributes.viewOffset);
    const durationMs = millisecondsFrom(attributes.duration);

    sessions.push({
      source: "plex",
      sessionId: player.machineIdentifier || attributes.sessionKey || attributes.ratingKey || attributes.key || "",
      // Stable per item, and the piece that keeps two movies on one client from
      // sharing a session key - see sessionKey().
      mediaId: attributes.ratingKey || attributes.key || "",
      title: plexTitle(attributes, mediaType),
      mediaType,
      offsetMs,
      durationMs,
      progress: progressPercent(offsetMs, durationMs),
      playbackState: state === "paused" ? "paused" : "playing",
      paused: state === "paused",
      season: indexNumberOrNull(attributes.parentIndex),
      episode: indexNumberOrNull(attributes.index),
      episodeTitle: mediaType === "episode" ? decodeHtmlEntities(attributes.title || "") : "",
      // The show's own handle, so the stop/complete paths can resolve series ids
      // instead of reaching identity canonicalization with episode-only or no ids.
      seriesItemId: mediaType === "episode" ? String(attributes.grandparentRatingKey || "") : "",
      posterUrl: plexPosterUrl(attributes, mediaType),
      client: {
        deviceName: player.title || player.product || player.platform || "",
        userName: user.title || attributes.user || "",
        // Plex leaves <User> empty on some sessions (observed on an owner's own
        // stream: `<User />` with every attribute absent) while still reporting
        // the account on <Player userID>. Carrying it lets the session still be
        // attributed instead of failing the username check by default.
        userId: user.id || player.userID || "",
        userIdSource: user.id ? "user" : "player",
      },
      ids: plexGuidIds(attributes, body),
      raw: { attributes, player, user },
    });
  }

  return sessions;
}

function mediaTypeFrom(item = {}, session = {}) {
  const raw = String(item.Type || item.MediaType || session.MediaType || "").toLowerCase();
  if (raw === "audio") return "track";
  return raw;
}

function playStateFrom(session = {}) {
  return session.PlayState || session.PlaybackState || session.PlayerState || {};
}

function normalizePlaybackState(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function playbackStateCandidates(session = {}, playState = {}) {
  return [
    session.State,
    session.Status,
    typeof session.PlaybackState === "string" ? session.PlaybackState : "",
    typeof session.PlayerState === "string" ? session.PlayerState : "",
    playState?.State,
    playState?.Status,
    playState?.PlaybackState,
  ]
    .map(normalizePlaybackState)
    .filter(Boolean);
}

function flagIsTrue(value) {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function flagIsFalse(value) {
  return value === false || value === 0 || value === "0" || String(value).toLowerCase() === "false";
}

function isSessionPaused(session = {}) {
  const playState = playStateFrom(session);
  const playStateObject = playState && typeof playState === "object" ? playState : {};
  return Boolean(
    flagIsTrue(session.IsPaused) ||
      flagIsTrue(playStateObject.IsPaused) ||
      playbackStateCandidates(session, playStateObject).includes("paused"),
  );
}

// Whether the media server is still reporting an open playback session, whether
// or not it is currently advancing. A paused session stays active on purpose -
// see LIVE_SESSION_PLAYBACK_STATES for why treating pause as a stop was wrong.
export function isSessionActive(session = {}) {
  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem;
  if (!item) return false;

  const playState = playStateFrom(session);
  const playStateObject = playState && typeof playState === "object" ? playState : {};
  const stateCandidates = playbackStateCandidates(session, playStateObject);
  const positionValues = [
    playStateObject.PositionTicks,
    session.PositionTicks,
    session.PlaybackPositionTicks,
  ];
  const hasPosition = positionValues.some(
    (value) => value !== undefined && value !== null && value !== "" && Number.isFinite(Number(value)),
  );
  const playingFlags = [session.IsPlaying, session.Playing, playStateObject.IsPlaying]
    .filter((value) => value !== undefined && value !== null)
    .map(flagIsTrue);
  const hasPlaybackData = Boolean(Object.keys(playStateObject).length || hasPosition || stateCandidates.length || playingFlags.length);
  const explicitlyPaused = isSessionPaused(session);
  const explicitlyPlaying = Boolean(
    playingFlags.some(Boolean) ||
      playStateObject.PlayMethod ||
      stateCandidates.some((value) => LIVE_SESSION_PLAYBACK_STATE_SET.has(value)),
  );
  const explicitlyStopped = Boolean(
    stateCandidates.some((value) => TERMINAL_LIVE_SESSION_STATE_SET.has(value)) ||
      (!explicitlyPaused && (
        (playingFlags.length > 0 && playingFlags.every((value) => !value)) ||
        flagIsFalse(session.IsPlaying) ||
        flagIsFalse(session.Playing) ||
        flagIsFalse(playStateObject.IsPlaying)
      )),
  );

  return hasPlaybackData && !explicitlyStopped && (explicitlyPlaying || explicitlyPaused || item);
}

function normalizeSessionItem(session = {}, source = "unknown", config = {}) {
  const item = session.NowPlayingItem || session.NowPlayingItemInfo || session.Item || session.MediaItem || {};
  const playState = playStateFrom(session);
  const mediaType = mediaTypeFrom(item, session);

  if (!["movie", "episode", "track"].includes(mediaType)) return null;
  if (!isSessionActive(session)) return null;

  const offsetMs = ticksToMilliseconds(
    playState.PositionTicks ||
      session.PositionTicks ||
      session.PlaybackPositionTicks ||
      item.PositionTicks ||
      item.PlaybackPositionTicks,
  );
  const durationMs = ticksToMilliseconds(item.RunTimeTicks || item.DurationTicks || session.RunTimeTicks || session.DurationTicks);

  return {
    source,
    sessionId: session.Id || session.SessionId || item.Id || "",
    mediaId: item.Id || "",
    title:
      mediaType === "episode"
        ? formatEpisodeTitle(decodeHtmlEntities(item.SeriesName || item.ParentName || item.Name || session.SeriesName), item.ParentIndexNumber, item.IndexNumber)
        : mediaType === "track"
          ? [decodeHtmlEntities(item.Artists?.[0] || item.AlbumArtist || item.SeriesName || ""), decodeHtmlEntities(item.Name || item.Title || session.Name || "Unknown Track")].filter(Boolean).join(" - ")
        : decodeHtmlEntities(item.Name || item.Title || session.Name || "Unknown Movie"),
    mediaType,
    offsetMs,
    durationMs,
    progress: progressPercent(offsetMs, durationMs),
    playbackState: isSessionPaused(session) ? "paused" : "playing",
    paused: isSessionPaused(session),
    season: indexNumberOrNull(item.ParentIndexNumber),
    episode: indexNumberOrNull(item.IndexNumber),
    episodeTitle: mediaType === "episode" ? decodeHtmlEntities(item.Name || "") : "",
    seriesItemId: mediaType === "episode" ? String(item.SeriesId || "") : "",
    posterUrl: embyLikePosterUrl(item, mediaType),
    ids: {
      imdb: item.ProviderIds?.Imdb || item.ProviderIds?.IMDb || undefined,
      tmdb: item.ProviderIds?.Tmdb || undefined,
      tvdb: item.ProviderIds?.Tvdb || undefined,
    },
    client: {
      deviceName: session.DeviceName || session.Client || session.ApplicationVersion || "",
      userName: session.UserName || session.UserId || "",
    },
    raw: session,
  };
}

async function fetchJson(url, headers) {
  try {
    const response = await fetchWithTimeout(url, { headers });
    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }
    return response.json();
  } catch (error) {
    let safeUrl = String(url);
    try { const parsed = new URL(safeUrl); parsed.search = ""; safeUrl = parsed.toString(); } catch { /* keep non-URL diagnostic */ }
    console.error("Live session fetch failed", { url: safeUrl, error: error?.message || String(error) });
    return null;
  }
}

// Each fetcher returns { sessions, ok } rather than a bare array: ok is false only when
// the request itself failed (timeout, non-2xx, network error) - not configured is a
// legitimate "nothing to report" state and stays ok:true. This lets the reconciliation
// in scheduled.js's refreshLiveSessions() tell "the server said nothing is playing" apart
// from "we couldn't ask the server this time", so a transient network blip can't get
// mistaken for every in-progress session having stopped.
// Whether a live Plex session belongs to the configured user.
//
// The name comparison alone is not sufficient: Plex can return `<User />` with
// no attributes at all, which made every such session read as "not the
// configured user" and vanish from Now Playing. `<Player userID>` still names
// the account in that case, so it is resolved against /accounts through the
// same memoized lookup the watched-history sync already uses
// (resolvePlexAccountId in plexClient.js), rather than a second mechanism.
//
// A session Plex attributes to nobody at all still does not match. Other
// accounts exist on a typical server, so accepting an unattributable session
// would risk recording someone else's play as the configured user's - see
// docs/decisions.md on preferring a missed watch over a phantom one.
function plexSessionMatchesUser(session, username, accountId) {
  if (session.client?.userIdSource === "player" && String(session.client.userId) === "1" && !session.client.userName) return false;
  const sessionUser = String(session.client?.userName || "").trim().toLowerCase();
  if (sessionUser && sessionUser === String(username).trim().toLowerCase()) return true;

  if (accountId == null) return false;
  const sessionAccountId = Number(session.client?.userId);
  return Number.isFinite(sessionAccountId) && sessionAccountId === Number(accountId);
}

export async function fetchPlexSessions(config, { allUsers = false } = {}) {
  if (!config.plex.baseUrl || !config.plex.token) return { sessions: [], ok: true };
  const url = new URL(`${config.plex.baseUrl}/status/sessions`);

  try {
    const response = await fetchPlexWithRefresh(config.plex, url, { headers: { Accept: "application/xml, text/xml, application/json" } });
    if (!response.ok) throw new Error(`Request failed with ${response.status}`);
    const text = await response.text();
    const parsed = parsePlexSessions(text, config.plex);
    if (allUsers) return { sessions: parsed, ok: true };
    if (!config.plex.username) return { sessions: parsed, ok: true };

    // Memoized for 10 minutes inside resolvePlexAccountId, so the poller's own
    // cadence does not turn this into a per-poll request to Plex.
    const accountId = await resolvePlexAccountId(config.plex, { lane: "interactive" }).catch(() => null);
    const sessions = parsed.filter((session) => plexSessionMatchesUser(session, config.plex.username, accountId));

    for (const session of parsed) {
      if (sessions.includes(session)) continue;
      console.warn("Plex live session skipped: not the configured user", {
        title: session.title,
        sessionUserName: session.client?.userName || "",
        sessionUserId: session.client?.userId || "",
        configuredUsername: config.plex.username,
        resolvedAccountId: accountId,
      });
    }

    return { sessions, ok: true };
  } catch (error) {
    console.error("Plex live session fetch failed", { url: String(url), error: error?.message || String(error) });
    return { sessions: [], ok: false };
  }
}

// Older Plembfin Up Next rail seeds opened a short playback session on the media
// server. Keep filtering that legacy device identity during upgrades so an old
// session cannot appear as Now Playing or displace the queue.
export function isUpNextSeedSession(session = {}) {
  const raw = session.raw || {};
  return [
    raw.DeviceId,
    raw.deviceId,
    session.deviceId,
    session.client?.deviceId,
    session.client?.device_id,
    session.client?.DeviceId,
  ].some(isUpNextSeedDeviceId);
}

// Emby and Jellyfin list an episode's own ProviderIds on its session item, so a
// playing episode would otherwise carry episode ids where the show's belong
// (no artwork, wrong show link). Swap in the series ids, memoized per series.
async function withEpisodeSeriesIds(sessions, source, providerConfig) {
  return Promise.all(sessions.map(async (session) => {
    if (session.mediaType !== "episode" || !session.seriesItemId) return session;
    const seriesIds = await resolveSeriesIds(source, session.seriesItemId, providerConfig);
    return seriesIds ? { ...session, ids: { imdb: seriesIds.imdb, tmdb: seriesIds.tmdb, tvdb: seriesIds.tvdb } } : session;
  }));
}

async function fetchEmbySessions(config) {
  if (!config.emby.baseUrl || !config.emby.apiKey) return { sessions: [], ok: true };
  const url = new URL(`${config.emby.baseUrl}/Sessions`);
  url.searchParams.set("api_key", config.emby.apiKey);
  const json = await fetchJson(url, { Accept: "application/json", "X-Emby-Token": config.emby.apiKey });
  if (!json) return { sessions: [], ok: false };
  const sessions = Array.isArray(json) ? json : json.Items || json.Sessions || [];
  const normalized = sessions
    .map((session) => normalizeSessionItem(session, "emby", config.emby))
    .filter(Boolean)
    .filter((session) => !config.emby.userId || String(session.raw?.UserId || "").toLowerCase() === String(config.emby.userId).toLowerCase())
    .filter((session) => !isUpNextSeedSession(session));
  return { sessions: await withEpisodeSeriesIds(normalized, "emby", config.emby), ok: true };
}

async function fetchJellyfinSessions(config) {
  if (!config.jellyfin.baseUrl || !jellyfinCredential(config.jellyfin)) return { sessions: [], ok: true };
  const url = new URL(`${config.jellyfin.baseUrl}/Sessions`);
  const json = await fetchJson(url, jellyfinAuthHeaders(config.jellyfin));
  if (!json) return { sessions: [], ok: false };
  const sessions = Array.isArray(json) ? json : json.Items || json.Sessions || [];
  const normalized = sessions
    .map((session) => normalizeSessionItem(session, "jellyfin", config.jellyfin))
    .filter(Boolean)
    .filter((session) => !config.jellyfin.userId || String(session.raw?.UserId || "").toLowerCase() === String(config.jellyfin.userId).toLowerCase())
    .filter((session) => !isUpNextSeedSession(session));
  return { sessions: await withEpisodeSeriesIds(normalized, "jellyfin", config.jellyfin), ok: true };
}

// Returns { sessions, failedSources }: failedSources names which of "plex"/"emby"/
// "jellyfin" could not be reached this call, so callers can avoid treating that
// platform's (forced-empty) result as proof nothing is playing on it.
export async function fetchLiveSessions(config, { plexSessions } = {}) {
  const sourceNames = ["plex", "emby", "jellyfin"];
  const results = await Promise.allSettled([plexSessions ?? fetchPlexSessions(config), fetchEmbySessions(config), fetchJellyfinSessions(config)]);
  const sessions = [];
  const failedSources = new Set();
  results.forEach((result, index) => {
    const source = sourceNames[index];
    if (result.status === "fulfilled") {
      sessions.push(...result.value.sessions);
      if (!result.value.ok) failedSources.add(source);
    } else {
      console.error("Live session resolver failed", { source, error: result.reason?.message || String(result.reason) });
      failedSources.add(source);
    }
  });
  return { sessions, failedSources };
}

export async function loadLiveTrackingCache(db, options = {}) {
  return loadLiveTrackingCacheFromDb(db, options);
}

export function buildCacheRow(session) {
  return {
    session_id: sessionKey(session),
    title: session.title || "Unknown media",
    source_platform: session.source || "unknown",
    last_progress: Number(session.progress || 0),
    updated_at: Date.now(),
    completed_at: null,
    payload_json: JSON.stringify(session),
  };
}

export function sessionIdentity(session) {
  return sessionKey(session);
}

export function hydrateCachedSession(row = {}) {
  let payload = {};
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch (error) {
      payload = {};
    }
  }
  return {
    ...payload,
    source: row.source_platform || payload.source || "unknown",
    sessionId: row.session_id,
    title: decodeHtmlEntities(row.title || payload.title || "Unknown media"),
    progress: Number(row.last_progress || payload.progress || 0),
    offsetMs: payload.offsetMs || 0,
    durationMs: payload.durationMs || 0,
    mediaType: payload.mediaType || payload.media_type || "unknown",
    season: payload.season ?? null,
    episode: payload.episode ?? null,
    posterUrl: payload.posterUrl || payload.poster_url || "",
    // Rows cached before paused sessions were retained carry no flag; absent
    // means playing, which is what those rows always were.
    paused: payload.paused === true,
    playbackState: payload.paused === true ? "paused" : payload.playbackState || "playing",
    updatedAt: Number(row.updated_at || Date.now()),
    completedAt: row.completed_at || null,
  };
}

// Paused sessions stay live (decision 13), so one that vanishes was closed.
// Paused in the credits (at or past the watched threshold) and seen within the
// staleness window counts as finished; a paused row below the threshold never
// does (user decision, core-sync-health step 2, 29 Sept 2026).
export function canInferLiveSessionCompletion(row = {}, now = Date.now()) {
  if (isStaleLiveSessionRow(row, now)) return false;
  const session = hydrateCachedSession(row);
  const paused = session.paused || String(session.playbackState || "").toLowerCase() === "paused";
  if (!paused) return true;
  return Number(row.last_progress || 0) >= watchedThresholdPercent();
}
