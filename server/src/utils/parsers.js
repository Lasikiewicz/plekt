import { watchedThresholdPercent } from "./tuning.js";
import { buildWatchProvenance } from "./watchProvenance.js";
import { releaseDateForItem, releaseDateForPlexItem } from "./watchDates.js";

const EMPTY_IDS = { imdb: undefined, tmdb: undefined, tvdb: undefined };
const PLEX_ACTIVE_EVENTS = ["media.play", "media.resume", "media.progress", "media.pause"];
// user.playrate (a rating) is deliberately absent: rating a title is not
// evidence that it was played, and counting it recorded a phantom watch dated
// now that reached every target and Trakt (core-sync-health step 2).
const PLEX_COMPLETE_EVENTS = ["media.scrobble"];
const EMBY_ACTIVE_EVENTS = ["playback.start", "playback.unpause", "playback.progress", "playback.pause"];
const JELLYFIN_ACTIVE_EVENTS = ["PlaybackStart", "PlaybackProgress", "PlaybackPause"];
const JELLYFIN_PLAYBACK_SAVE_REASONS = ["playbackstart", "playbackprogress", "playbackfinished"];

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Single-pass decode so each entity is expanded exactly once. Decoding in chained
// .replace() calls double-unescapes inputs like "&#38;amp;" (numeric -> "&amp;" -> "&");
// matching all forms in one regex avoids that.
export function decodeHtmlEntities(str) {
  return String(str ?? "").replace(
    /&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos|#39);/gi,
    (match, hex, dec, named) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (dec !== undefined) return String.fromCharCode(Number(dec));
      if (named === "#39") return "'";
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    }
  );
}

function normalizeType(value) {
  const type = String(value || "").toLowerCase();
  if (type === "movie") return "movie";
  if (type === "episode" || type === "tvchannel") return "episode";
  if (type === "season") return "season";
  if (type === "series" || type === "show") return "series";
  return undefined;
}

function firstDefined(...values) {
  return values.find((value) => value != null && value !== "");
}

export function normalizeProviderIds(providerIds = {}) {
  const ids = { ...EMPTY_IDS };
  for (const [key, value] of Object.entries(providerIds || {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "imdb") ids.imdb = String(value);
    if (normalizedKey === "tmdb") ids.tmdb = String(value);
    if (normalizedKey === "tvdb") ids.tvdb = String(value);
  }
  return ids;
}

export function parsePlexGuids(metadata = {}) {
  const ids = { ...EMPTY_IDS };
  const guidEntries = Array.isArray(metadata.Guid) ? metadata.Guid : [];
  const rawGuids = [
    metadata.guid,
    ...guidEntries.map((entry) => (typeof entry === "string" ? entry : entry.id)),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid).split("?")[0];
    // Flexible parsing supporting both slug styles (proto://id and proto/id)
    // and both the modern (tmdb/tvdb) and legacy Plex agent (themoviedb/thetvdb) prefixes.
    if (guid.includes("imdb")) ids.imdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tmdb") || guid.includes("themoviedb")) ids.tmdb = guid.split(/:\/\/|\//).pop();
    if (guid.includes("tvdb") || guid.includes("thetvdb")) ids.tvdb = guid.split(/:\/\/|\//).pop();
  }
  return ids;
}

function preferProviderIds(fallback = {}, preferred = {}) {
  const result = { ...EMPTY_IDS, ...fallback };
  for (const key of Object.keys(EMPTY_IDS)) {
    if (preferred?.[key]) result[key] = preferred[key];
  }
  return result;
}

export function parsePlexMediaIds(metadata = {}, type = "") {
  const itemIds = parsePlexGuids(metadata);
  if (type !== "episode") return itemIds;

  // Plex episode GUIDs can identify the episode itself. When the webhook also
  // includes the grandparent (series) GUID, prefer that identity because every
  // outbound client resolves a series first and then selects SxxExx.
  const seriesIds = parsePlexGuids({
    guid: metadata.grandparentGuid || metadata.grandparentGUID,
    Guid: metadata.GrandparentGuid || metadata.GrandparentGUID || [],
  });
  return preferProviderIds(itemIds, seriesIds);
}

function extractTitle(type, metadata, source) {
  const season = seasonNumberFrom(metadata);
  const episode = episodeNumberFrom(metadata);
  const hasEpisodeCoordinates = season != null || episode != null;

  if (source === "plex") {
    const showTitle = decodeHtmlEntities(metadata.grandparentTitle || "");
    const movieTitle = decodeHtmlEntities(metadata.title);
    if (type === "episode") {
      if (hasEpisodeCoordinates) {
        return `${showTitle || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
      }
      return showTitle || "Unknown Episode";
    }
    return movieTitle || "Unknown Movie";
  }
  
  // Jellyfin / Emby
  if (type === "episode") {
    if (hasEpisodeCoordinates) {
      return `${seriesTitleFrom(metadata) || "Unknown Show"} - S${String(season ?? "?").padStart(2, "0")}E${String(episode ?? "?").padStart(2, "0")}`;
    }
    return seriesTitleFrom(metadata) || itemTitleFrom(metadata) || "Unknown Episode";
  }
  return itemTitleFrom(metadata) || "Unknown Movie";
}

function itemTitleFrom(item = {}) {
  return firstDefined(item.Name, item.name, item.Title, item.title, item.ItemName, item.itemName);
}

function seriesTitleFrom(item = {}) {
  return firstDefined(item.SeriesName, item.seriesName, item.ShowTitle, item.showTitle, item.GrandparentTitle, item.grandparentTitle, item.ParentName, item.parentName, item.Name, item.name);
}

function seasonNumberFrom(item = {}) {
  return firstDefined(item.ParentIndexNumber, item.parentIndexNumber, item.SeasonNumber, item.seasonNumber, item.Season, item.season, item.ParentIndex, item.parentIndex);
}

function episodeNumberFrom(item = {}) {
  return firstDefined(item.IndexNumber, item.indexNumber, item.EpisodeNumber, item.episodeNumber, item.Episode, item.episode, item.Index, item.index);
}

function providerIdsFrom(item = {}, json = {}) {
  return item.ProviderIds || item.providerIds || json.ProviderIds || json.providerIds || {};
}

function mediaProviderIdsFrom(item = {}, json = {}, type = "") {
  const itemIds = normalizeProviderIds(providerIdsFrom(item, json));
  if (type !== "episode") return itemIds;
  const seriesProviderIds = item.SeriesProviderIds || item.seriesProviderIds || json.SeriesProviderIds || json.seriesProviderIds || {};
  return preferProviderIds(itemIds, normalizeProviderIds(seriesProviderIds));
}

function embyLikeTypeFrom(item = {}, json = {}) {
  return normalizeType(firstDefined(item.Type, item.type, item.MediaType, item.mediaType, item.ItemType, item.itemType, json.Type, json.type, json.MediaType, json.mediaType, json.ItemType, json.itemType));
}

function embyLikeUserFrom(json = {}) {
  return firstDefined(json.UserId, json.userId, json.User?.Id, json.User?.Name, json.UserName, json.Username, json.userName, json.username) || "";
}

function plexClientFrom(payload = {}) {
  const player = payload.Player || payload.player || {};
  return {
    device: firstDefined(player.title, player.device, player.model, player.product, player.platform) || "",
    deviceId: firstDefined(player.machineIdentifier, player.machine_identifier, player.deviceId) || "",
    client: firstDefined(player.product, player.platform) || "",
    clientVersion: firstDefined(player.version, player.clientVersion) || "",
    sessionId: firstDefined(player.machineIdentifier, player.sessionKey) || "",
  };
}

function embyLikeClientFrom(json = {}, item = {}) {
  const session = json.Session || json.session || json.PlaybackInfo?.Session || json.playbackInfo?.Session || {};
  return {
    device: firstDefined(json.DeviceName, json.deviceName, session.DeviceName, session.deviceName, session.Device, session.device, json.Client, json.client) || "",
    deviceId: firstDefined(json.DeviceId, json.deviceId, session.DeviceId, session.deviceId) || "",
    client: firstDefined(json.Client, json.client, session.Client, session.client, json.Application, json.application) || "",
    clientVersion: firstDefined(json.ApplicationVersion, json.applicationVersion, session.ApplicationVersion, session.applicationVersion) || "",
    sessionId: firstDefined(json.SessionId, json.sessionId, session.Id, session.SessionId) || "",
  };
}

function plexPosterInfo(metadata = {}, type = "unknown") {
  const path =
    type === "episode"
      ? metadata.grandparentThumb || metadata.parentThumb || metadata.thumb
      : metadata.thumb || metadata.grandparentThumb || metadata.parentThumb;
  return path ? { path } : undefined;
}

function embyLikePosterInfo(item = {}, type = "unknown") {
  const imageTags = item.ImageTags || {};
  const itemId = type === "episode" ? item.SeriesId || item.ParentId || item.Id : item.Id;
  const tag =
    type === "episode"
      ? item.SeriesPrimaryImageTag || item.ParentPrimaryImageTag || imageTags.Primary
      : imageTags.Primary || item.PrimaryImageTag;

  return itemId ? { itemId, tag } : undefined;
}

function progressPercentFrom(values = {}) {
  // The stop event's own position comes before UserData, which can still hold
  // the resume point saved before this play reached the credits.
  const position =
    Number(values.viewOffset) ||
    Number(values.PlaybackPositionTicks) ||
    Number(values.PositionTicks) ||
    Number(values.PlayState?.PositionTicks) ||
    Number(values.PlaybackInfo?.PositionTicks) ||
    Number(values.PlaybackInfo?.PlayState?.PositionTicks) ||
    Number(values.UserData?.PlaybackPositionTicks);
  const duration =
    Number(values.duration) ||
    Number(values.RunTimeTicks) ||
    Number(values.DurationTicks) ||
    Number(values.Item?.RunTimeTicks) ||
    Number(values.PlaybackInfo?.MediaSource?.RunTimeTicks) ||
    Number(values.PlaybackInfo?.RunTimeTicks);

  if (position > 0 && duration > 0) {
    return Math.max(0, Math.min(100, (position / duration) * 100));
  }

  const direct = Number(
    values.progress ??
      values.Progress ??
      values.PercentComplete ??
      values.PlayedPercentage ??
      values.PlaybackProgress ??
      values.PlaybackProgressPercentage,
  );
  // Every named field is a 0-100 percentage. Guessing that a value of 1 or
  // less was a fraction turned a real 0.8% into 80%, close to a phantom watch.
  if (Number.isFinite(direct)) return Math.max(0, Math.min(100, direct));

  return 0;
}

// Emby (PlaybackInfo) and Jellyfin (top level) say on the stop event itself
// whether the player reached the end. That is playback evidence from the same
// event, unlike a later played flag.
function playedToCompletion(...values) {
  return values.some((value) => value && typeof value === "object" && (
    value.PlayedToCompletion === true
    || value.PlaybackInfo?.PlayedToCompletion === true
  ));
}

function readPlayedState(...values) {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidates = [
      value.Played,
      value.IsPlayed,
      value.played,
      value.isPlayed,
      value.UserData?.Played,
      value.UserData?.IsPlayed,
      value.Item?.UserData?.Played,
      value.Item?.UserData?.IsPlayed,
      value.NowPlayingItem?.UserData?.Played,
      value.NowPlayingItem?.UserData?.IsPlayed,
    ];
    for (const candidate of candidates) {
      if (candidate === true || candidate === "true" || candidate === 1 || candidate === "1") return true;
      if (candidate === false || candidate === "false" || candidate === 0 || candidate === "0") return false;
    }
  }
  return undefined;
}

// Emby and Jellyfin emit these whenever an item's played *flag* changes, which
// includes plembfin marking the item played during outbound sync. They carry no
// playback evidence, so they are never proof on their own that a new play
// happened - see the same reasoning applied to library polling in watchDates.js.
const PLAYED_FLAG_ONLY_EVENTS = [
  "itemmarkplayed",
  "itemmarkedplayed",
  "itemmarkedasplayed",
  "itemplayed",
  "userdatasaved",
  "userdatachanged",
  "itemuserdatachanged",
];

function compactEventKey(event) {
  return String(event || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isPlayedFlagOnlyEvent(event) {
  return PLAYED_FLAG_ONLY_EVENTS.includes(compactEventKey(event));
}

// The media server's own record of when the item was last played. Preferred over
// arrival time because webhook delivery can lag by hours: a late event stamped
// with Date.now() lands in history as a watch that never happened.
function playedAtFrom(...values) {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const raw =
      value.UserData?.LastPlayedDate ||
      value.UserData?.PlayedDate ||
      value.UserData?.DatePlayed ||
      value.LastPlayedDate ||
      value.PlayedDate ||
      value.DatePlayed ||
      value.LastWatchedDate;
    if (!raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function ticksToMilliseconds(value) {
  const ticks = Number(value || 0);
  return Number.isFinite(ticks) && ticks > 0 ? Math.round(ticks / 10000) : 0;
}

function millisecondsFrom(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function positionMillisecondsFrom(values = {}) {
  const directMs = millisecondsFrom(values.viewOffset || values.offsetMs || values.positionMs);
  if (directMs) return directMs;

  return ticksToMilliseconds(
    values.PlaybackPositionTicks ||
      values.PositionTicks ||
      values.PlayState?.PositionTicks ||
      values.PlaybackInfo?.PositionTicks ||
      values.PlaybackInfo?.PlayState?.PositionTicks ||
      values.UserData?.PlaybackPositionTicks ||
      values.Item?.UserData?.PlaybackPositionTicks ||
      values.Item?.PlaybackPositionTicks,
  );
}

function durationMillisecondsFrom(values = {}) {
  const directMs = millisecondsFrom(values.duration || values.durationMs || values.Duration);
  if (directMs) return directMs;

  return ticksToMilliseconds(
    values.RunTimeTicks ||
      values.DurationTicks ||
      values.Item?.RunTimeTicks ||
      values.Item?.DurationTicks ||
      values.PlaybackInfo?.MediaSource?.RunTimeTicks ||
      values.PlaybackInfo?.RunTimeTicks,
  );
}

// A server announcing new content. This is not a play event - it means the
// media now exists there, which is the moment a watch Plembfin already knows
// about can finally be applied to that server.
const ADDED_EVENT_KEYS = ["librarynew", "itemadded", "libraryitemadded", "itemcreated"];

function isAddedEvent(event) {
  return ADDED_EVENT_KEYS.includes(String(event || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function phaseFromPlexEvent(event, metadata) {
  const progress = progressPercentFrom(metadata);
  if (isAddedEvent(event)) return "added";
  if (PLEX_COMPLETE_EVENTS.includes(event)) return "completed";
  if (event === "media.stop") return progress >= watchedThresholdPercent() ? "completed" : "ended";
  if (PLEX_ACTIVE_EVENTS.includes(event)) return "active";
  return "ignored";
}

function phaseFromEmbyEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const positionMs = positionMillisecondsFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const compactEventKey = eventKey.replace(/[^a-z0-9]/g, "");
  const played = readPlayedState(json, item);
  const userDataEvent = ["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey);
  if (isAddedEvent(event)) return "added";
  if (["itemmarkplayed", "itemmarkedplayed", "itemmarkedasplayed", "itemplayed"].includes(compactEventKey)) return "completed";
  if (["itemmarkunplayed", "itemmarkedunplayed", "itemmarkedasunplayed", "itemunplayed"].includes(compactEventKey)) return "unplayed";
  if (userDataEvent && played === true) return "completed";
  // Emby writes Played=false as part of every positive resume-position
  // update. That flag means "not completed", not "the user explicitly
  // marked this item unwatched". Treat the accompanying positive position
  // as stopped/partial playback so it can refresh Continue Watching without
  // creating a newer unwatched playstate that immediately deletes the same
  // progress on the next scheduled scan. Explicit mark-unplayed event names
  // above, and zero-position UserData changes, remain real unwatches.
  if (userDataEvent && played === false) return positionMs > 0 ? "ended" : "unplayed";
  if (compactEventKey === "playbackstop") return progress >= watchedThresholdPercent() || playedToCompletion(json, item) ? "completed" : "ended";
  if (EMBY_ACTIVE_EVENTS.map((activeEvent) => activeEvent.replace(/[^a-z0-9]/g, "")).includes(compactEventKey)) return "active";
  return "ignored";
}

function phaseFromJellyfinEvent(event, json, item) {
  const progress = progressPercentFrom({ ...json, ...item });
  const positionMs = positionMillisecondsFrom({ ...json, ...item });
  const eventKey = String(event || "").toLowerCase();
  const compactEventKey = eventKey.replace(/[^a-z0-9]/g, "");
  const played = readPlayedState(json, item);
  const userDataEvent = ["userdatasaved", "userdatachanged", "itemuserdatachanged"].includes(compactEventKey);
  if (isAddedEvent(event)) return "added";
  if (["itemmarkplayed", "itemmarkedplayed", "itemmarkedasplayed", "itemplayed"].includes(compactEventKey)) return "completed";
  if (["itemmarkunplayed", "itemmarkedunplayed", "itemmarkedasunplayed", "itemunplayed"].includes(compactEventKey)) return "unplayed";
  if (userDataEvent && played === true) return "completed";
  // Jellyfin uses the same UserData shape as Emby: positive progress is
  // persisted together with Played=false. Do not turn that ordinary partial
  // play into an explicit canonical unwatch.
  if (userDataEvent && played === false && positionMs > 0) return "ended";
  // Starting a play saves Played=false at position 0 (SaveReason PlaybackStart,
  // and PlaybackProgress/PlaybackFinished near the start). That is playback
  // bookkeeping, not the user unmarking the item: as an unwatch it restamped
  // the playstate after the play began and blocked the play's own resume
  // position. A user unplay arrives as TogglePlayed (or UpdateUserData).
  if (userDataEvent && played === false && JELLYFIN_PLAYBACK_SAVE_REASONS.includes(String(json?.SaveReason || "").toLowerCase())) return "ignored";
  if (userDataEvent && played === false) return "unplayed";
  if (compactEventKey === "playbackstop") return progress >= watchedThresholdPercent() || playedToCompletion(json, item) ? "completed" : "ended";
  if (JELLYFIN_ACTIVE_EVENTS.map((activeEvent) => activeEvent.toLowerCase()).includes(eventKey)) return "active";
  return "ignored";
}

function pickWebhookItem(json = {}) {
  return json.Item || json.Metadata || json.MediaItem || json.ItemInfo || json.NowPlayingItem || json;
}

function buildPayload({
  type,
  source,
  ids,
  season,
  episode,
  title,
  event,
  phase = "completed",
  progress = 0,
  offsetMs = 0,
  durationMs = 0,
  user,
  device,
  deviceId,
  client,
  clientVersion,
  sessionId,
  posterUrl,
  poster,
  itemId,
  // The media server's id for the *series* an episode belongs to. Episode
  // payloads carry episode-level provider ids; resolving the series identity
  // that the rest of the app keys on needs a second lookup, and this is the
  // handle for it. See utils/seriesIdentity.js.
  seriesItemId,
  episodeTitle,
  playedAt = "",
  playedFlagOnly = false,
  releaseDate = "",
  ingestPath = "",
  watchProvenance = null,
  rawPayloadDebug = {},
}) {
  const isActionable = ["active", "completed", "ended", "unplayed", "added"].includes(phase);
  const resolvedWatchProvenance = watchProvenance || buildWatchProvenance(
    {
      source,
      event,
      phase,
      itemId,
      user,
      device,
      deviceId,
      client,
      clientVersion,
      sessionId,
      // A flag-only event can expose a server-updated LastPlayedDate even
      // though no playback occurred. It is useful for echo detection, but it
      // is not the historical watch timestamp we should display/store.
      playedAt: playedFlagOnly ? "" : playedAt,
    },
    {
      ingestPath,
      sourceTimestamp: playedFlagOnly ? "" : playedAt,
      note: playedFlagOnly && releaseDate
        ? "The source reported a manual played flag without playback evidence; the release date will be used as the watch date."
        : "",
    },
  );
  return {
    playedAt,
    playedFlagOnly: Boolean(playedFlagOnly),
    releaseDate,
    title: title || "Unknown media",
    type,
    source,
    ids: { ...EMPTY_IDS, ...ids },
    season: season == null ? undefined : Number(season),
    episode: episode == null ? undefined : Number(episode),
    event,
    phase,
    progress: Number.isFinite(Number(progress)) ? Number(progress) : 0,
    offsetMs: Number.isFinite(Number(offsetMs)) ? Math.max(0, Math.round(Number(offsetMs))) : 0,
    durationMs: Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : 0,
    user,
    device,
    deviceId,
    client,
    clientVersion,
    sessionId,
    posterUrl,
    poster,
    itemId,
    seriesItemId: seriesItemId ? String(seriesItemId) : "",
    episodeTitle,
    watchProvenance: resolvedWatchProvenance,
    rawPayloadDebug,
    isValid: Boolean(isActionable && type && source && title),
  };
}

export async function parsePlexWebhook(formData) {
  const formKeys = [...formData.keys()];
  try {
    const rawPayload = formData.get("payload");
    if (!rawPayload) {
      return buildPayload({
        source: "plex",
        ids: EMPTY_IDS,
        title: "Plex Raw Event: missing payload",
        phase: "ignored",
        ingestPath: "plex_webhook",
        rawPayloadDebug: { formKeys, hasPayload: false },
      });
    }

    const payload = JSON.parse(rawPayload);
    const metadata = payload.Metadata || {};
    const type = normalizeType(metadata.type);
    const event = payload.event || "unknown";
    const rawPayloadDebug = {
      formKeys,
      hasPayload: true,
      event,
      payloadKeys: Object.keys(payload),
      metadataKeys: Object.keys(metadata),
      guidCount: Array.isArray(metadata.Guid) ? metadata.Guid.length : 0,
      rawPayload,
    };
    const title = extractTitle(type, metadata, "plex");

    const phase = phaseFromPlexEvent(event, metadata);
    const progress = progressPercentFrom(metadata);
    const offsetMs = positionMillisecondsFrom(metadata);
    const durationMs = durationMillisecondsFrom(metadata);
    const ids = parsePlexMediaIds(metadata, type);
    const releaseDate = releaseDateForPlexItem(metadata);
    const user = payload.Account?.title || "";
    const client = plexClientFrom(payload);

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "plex",
        title: event ? `Plex Raw Event: ${event} - ${title}` : title,
        ids,
        season: metadata.parentIndex,
        episode: metadata.index,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        device: client.device,
        deviceId: client.deviceId,
        client: client.client,
        clientVersion: client.clientVersion,
        sessionId: client.sessionId,
        itemId: metadata.ratingKey,
        seriesItemId: metadata.grandparentRatingKey,
        releaseDate,
        ingestPath: "plex_webhook",
        poster: plexPosterInfo(metadata, type),
        episodeTitle: type === "episode" ? metadata.title : null,
        rawPayloadDebug,
      });
    }

    return buildPayload({
      type,
      source: "plex",
      title,
      ids,
      season: metadata.parentIndex,
      episode: metadata.index,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      device: client.device,
      deviceId: client.deviceId,
      client: client.client,
      clientVersion: client.clientVersion,
      sessionId: client.sessionId,
      itemId: metadata.ratingKey,
        seriesItemId: metadata.grandparentRatingKey,
      releaseDate,
      ingestPath: "plex_webhook",
      poster: plexPosterInfo(metadata, type),
      episodeTitle: type === "episode" ? metadata.title : null,
      rawPayloadDebug,
    });
  } catch (error) {
    console.error("Plex parser failed", error);
    return buildPayload({
      source: "plex",
      ids: EMPTY_IDS,
      title: "Plex Raw Event: parser failure",
      phase: "ignored",
      ingestPath: "plex_webhook",
      rawPayloadDebug: { formKeys, error: error.message },
    });
  }
}

// Builds a normalized media object from a Plex `/library/metadata/{ratingKey}` item
// (i.e. without a webhook event payload). Plex never emits a webhook when an item is
// marked unwatched, so the real-time notification listener resolves the changed
// ratingKey to its metadata and runs it through this builder. It reuses the exact same
// GUID/title/coordinate extraction as the webhook path, so `media.ids`, `media.title`,
// `media.season` and `media.episode` are identical to a Plex webhook - which is what
// lets the Emby and Jellyfin clients match the item the same way they do for any sync.
export function buildPlexMediaFromMetadata(metadata = {}, { phase = "unplayed" } = {}) {
  const type = normalizeType(metadata.type);
  const ids = parsePlexMediaIds(metadata, type);
  const title = extractTitle(type, metadata, "plex");
  const releaseDate = releaseDateForPlexItem(metadata);
  return buildPayload({
    type,
    source: "plex",
    title,
    ids,
    season: metadata.parentIndex,
    episode: metadata.index,
    event: "notification.viewstate",
    phase,
    ingestPath: "plex_notification",
    user: "",
    itemId: metadata.ratingKey,
        seriesItemId: metadata.grandparentRatingKey,
    releaseDate,
    durationMs: durationMillisecondsFrom(metadata),
    // This notification is a library-state change, not a playback lifecycle
    // payload. The caller may upgrade it to a real playback date when a recent
    // live session proves that the watched threshold was reached.
    playedFlagOnly: phase === "completed",
    poster: plexPosterInfo(metadata, type),
    episodeTitle: type === "episode" ? metadata.title : null,
    rawPayloadDebug: { source: "plex_notification", ratingKey: metadata.ratingKey },
  });
}

// The Jellyfin webhook plugin sends a flat body where ItemId is the item and a
// top-level Id is the playback session, so a flat body is read by ItemId.
function jellyfinFlatSessionId(json = {}) {
  const flat = pickWebhookItem(json) === json;
  return flat && json.ItemId && json.Id && json.Id !== json.ItemId ? String(json.Id) : "";
}

export function parseJellyfinWebhook(json) {
  try {
    const picked = pickWebhookItem(json);
    const item = picked === json && json?.ItemId ? { ...json, Id: json.ItemId } : picked;
    const event = json?.NotificationType || "unknown";
    const type = embyLikeTypeFrom(item, json);
    const phase = phaseFromJellyfinEvent(event, json, item);
    const title = extractTitle(type, item, "jellyfin");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = embyLikeUserFrom(json);
    const providerIds = mediaProviderIdsFrom(item, json, type);
    const season = seasonNumberFrom(item);
    const episode = episodeNumberFrom(item);
    const episodeTitle = type === "episode" ? itemTitleFrom(item) : null;
    const client = embyLikeClientFrom(json, item);
    client.sessionId = client.sessionId || jellyfinFlatSessionId(json);
    const releaseDate = releaseDateForItem(item);

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "jellyfin",
        ids: providerIds,
        title: `Jellyfin Raw Event: ${event} - ${title}`,
        season,
        episode,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        device: client.device,
        deviceId: client.deviceId,
        client: client.client,
        clientVersion: client.clientVersion,
        sessionId: client.sessionId,
        itemId: item.Id,
        seriesItemId: item.SeriesId || item.ParentId,
        releaseDate,
        ingestPath: "jellyfin_webhook",
        poster: embyLikePosterInfo(item, type),
        episodeTitle,
        rawPayloadDebug: {
          payloadKeys: Object.keys(json || {}),
          itemKeys: Object.keys(item || {}),
          rawPayload: JSON.stringify(json),
        },
      });
    }

    return buildPayload({
      type,
      source: "jellyfin",
      title,
      ids: providerIds,
      season,
      episode,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      device: client.device,
      deviceId: client.deviceId,
      client: client.client,
      clientVersion: client.clientVersion,
      sessionId: client.sessionId,
      itemId: item.Id,
        seriesItemId: item.SeriesId || item.ParentId,
      ingestPath: "jellyfin_webhook",
      poster: embyLikePosterInfo(item, type),
      episodeTitle,
      playedAt: playedAtFrom(item, json),
      playedFlagOnly: isPlayedFlagOnlyEvent(event),
      releaseDate,
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(providerIds || {}),
        rawPayload: JSON.stringify(json),
      },
    });
  } catch (error) {
    console.error("Jellyfin parser failed", error);
    return buildPayload({
      source: "jellyfin",
      ids: EMPTY_IDS,
      title: "Jellyfin Raw Event: parser failure",
      phase: "ignored",
      ingestPath: "jellyfin_webhook",
      rawPayloadDebug: { error: error.message },
    });
  }
}

export function parseEmbyWebhook(json) {
  try {
    const item = pickWebhookItem(json);
    const event = json?.Event || "unknown";
    const type = embyLikeTypeFrom(item, json);
    const phase = phaseFromEmbyEvent(event, json, item);
    const title = extractTitle(type, item, "emby");
    const progress = progressPercentFrom({ ...json, ...item });
    const offsetMs = positionMillisecondsFrom({ ...json, ...item });
    const durationMs = durationMillisecondsFrom({ ...json, ...item });
    const user = embyLikeUserFrom(json);
    const providerIds = mediaProviderIdsFrom(item, json, type);
    const season = seasonNumberFrom(item);
    const episode = episodeNumberFrom(item);
    const episodeTitle = type === "episode" ? itemTitleFrom(item) : null;
    const client = embyLikeClientFrom(json, item);
    const releaseDate = releaseDateForItem(item);

    if (phase === "ignored") {
      return buildPayload({
        type,
        source: "emby",
        ids: providerIds,
        title: `Emby Raw Event: ${event} - ${title}`,
        season,
        episode,
        event,
        phase,
        progress,
        offsetMs,
        durationMs,
        user,
        device: client.device,
        deviceId: client.deviceId,
        client: client.client,
        clientVersion: client.clientVersion,
        sessionId: client.sessionId,
        itemId: item.Id,
        seriesItemId: item.SeriesId || item.ParentId,
        releaseDate,
        ingestPath: "emby_webhook",
        poster: embyLikePosterInfo(item, type),
        episodeTitle,
        rawPayloadDebug: {
          payloadKeys: Object.keys(json || {}),
          itemKeys: Object.keys(item || {}),
          rawPayload: JSON.stringify(json),
        },
      });
    }

    return buildPayload({
      type,
      source: "emby",
      title,
      ids: providerIds,
      season,
      episode,
      event,
      phase,
      progress,
      offsetMs,
      durationMs,
      user,
      device: client.device,
      deviceId: client.deviceId,
      client: client.client,
      clientVersion: client.clientVersion,
      sessionId: client.sessionId,
      itemId: item.Id,
        seriesItemId: item.SeriesId || item.ParentId,
      ingestPath: "emby_webhook",
      poster: embyLikePosterInfo(item, type),
      episodeTitle,
      playedAt: playedAtFrom(item, json),
      playedFlagOnly: isPlayedFlagOnlyEvent(event),
      releaseDate,
      rawPayloadDebug: {
        payloadKeys: Object.keys(json || {}),
        itemKeys: Object.keys(item),
        providerKeys: Object.keys(providerIds || {}),
        rawPayload: JSON.stringify(json),
      },
    });
  } catch (error) {
    console.error("Emby parser failed", error);
    return buildPayload({
      source: "emby",
      ids: EMPTY_IDS,
      title: "Emby Raw Event: parser failure",
      phase: "ignored",
      ingestPath: "emby_webhook",
      rawPayloadDebug: { error: error.message },
    });
  }
}

export function parseCustomWebhook(json) {
  if (!json || json.source !== "plex" || json.event !== "media.unscrobble") {
    return { isValid: false };
  }
  const type = normalizeType(json.type);
  const phase = "unplayed";
  const user = json.user || "";
  const title = json.title || "";
  
  const ids = {
    imdb: json.imdb_id || undefined,
    tmdb: json.tmdb_id || undefined,
    tvdb: json.tvdb_id || undefined,
  };
  
  return buildPayload({
    type,
    source: "plex",
    title,
    ids,
    season: json.season != null && json.season !== "" ? Number(json.season) : undefined,
    episode: json.episode != null && json.episode !== "" ? Number(json.episode) : undefined,
    event: json.event,
    phase,
    ingestPath: "custom_webhook",
    user,
    device: json.device || json.deviceName,
    deviceId: json.deviceId || json.device_id,
    client: json.client,
    clientVersion: json.clientVersion || json.client_version,
    sessionId: json.sessionId || json.session_id,
    posterUrl: json.posterUrl || json.poster_url,
    rawPayloadDebug: json,
  });
}
