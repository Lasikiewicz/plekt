import crypto from "node:crypto";
import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { bumpDataVersion, db, transaction, writeAuditLog } from "../db.js";
import { getCanonicalPosterUrl } from "../utils/mediaArtwork.js";
import { loadMediaConfig, publicMediaConfig } from "../utils/configStore.js";
import { queuePersonalRatingMutation } from "../utils/personalRatingSync.js";
import { recordWatchlistMutation } from "../utils/personalWatchlistRepository.js";
import { normalizePersonalMediaType as normalizeMediaType, personalMediaKey } from "../utils/personalMediaKey.js";
import { schedulePlaylistRuleCheck, schedulePlaylistSync } from "../utils/playlistSyncTriggers.js";
import { handOffAutomaticPlaylistItem } from "../utils/playlistWatched.js";
import { checkPlaylistRule,confirmPlaylistRuleHold, discardPlaylistRuleHold, isPlaylistRuleChecking, normalizePlaylistRule, parsePlaylistRule, stopPlaylistRule } from "../utils/playlistRuleEngine.js";
import { confirmHeldPlaylistChange, discardHeldPlaylistChange, syncPlaylist } from "../utils/playlistPullEngine.js";
import { fetchShowEpisodes } from "../utils/playlistShowConversion.js";
import { importAppPlaylists, listPlaylistImportCandidates } from "../utils/playlistImport.js";
import { playlistRuleGenres, readLibraryCatalogues } from "../utils/playlistRuleCatalogue.js";
import { resolveProcessRole, roleHasWorker } from "../utils/processRole.js";

export { personalMediaKey };

const PERSONAL_MEDIA_TYPES = new Set(["movie", "tv", "episode"]);
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 4000;
const MAX_URL_LENGTH = 2000;

function cleanText(value, maxLength = MAX_TEXT_LENGTH) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

const knownTvTmdbIdStmt = db.prepare("SELECT 1 FROM tmdb_metadata_cache WHERE media_type = 'tv' AND tmdb_id = ? LIMIT 1");
const knownSeriesTvdbIdStmt = db.prepare("SELECT 1 FROM tvdb_metadata_cache WHERE id LIKE 'series_%' AND tvdb_id = ? LIMIT 1");

function isKnownTvTmdbId(value) {
  const id = cleanText(value, 100);
  return Boolean(id && knownTvTmdbIdStmt.get(id));
}

function isKnownSeriesTvdbId(value) {
  const id = cleanText(value, 100);
  return Boolean(id && knownSeriesTvdbIdStmt.get(id));
}

function mediaFromBody(body = {}, { allowEpisode = false } = {}) {
  const mediaType = normalizeMediaType(body.media_type || body.mediaType || body.type);
  const title = cleanText(body.title || body.episode_title || body.episodeTitle || body.name, MAX_TITLE_LENGTH);
  if (!PERSONAL_MEDIA_TYPES.has(mediaType) || (mediaType === "episode" && !allowEpisode)) {
    const error = new Error(allowEpisode ? "media_type must be movie, tv, or episode" : "media_type must be movie or tv");
    error.status = 400;
    throw error;
  }
  if (!title) {
    const error = new Error("A title is required");
    error.status = 400;
    throw error;
  }
  const isEpisode = mediaType === "episode";
  const showTitle = isEpisode
    ? cleanText(body.show_title || body.showTitle || body.series_title || body.seriesTitle, MAX_TITLE_LENGTH)
    : "";
  const season = isEpisode ? numberOrNull(body.season ?? body.seasonNumber) : null;
  const episode = isEpisode ? numberOrNull(body.episode ?? body.episodeNumber) : null;
  if (isEpisode && !showTitle) {
    const error = new Error("A show title is required for episode ratings");
    error.status = 400;
    throw error;
  }
  if (isEpisode && (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1)) {
    const error = new Error("A valid season and episode number are required for episode ratings");
    error.status = 400;
    throw error;
  }
  const rawTmdbId = cleanText(body.tmdb_id || body.tmdbId, 100);
  const rawTvdbId = cleanText(body.tvdb_id || body.tvdbId, 100);
  const episodeTmdbId = isEpisode ? cleanText(body.episode_tmdb_id || body.episodeTmdbId, 100) : "";
  const episodeTvdbId = isEpisode ? cleanText(body.episode_tvdb_id || body.episodeTvdbId, 100) : "";
  const episodeImdbId = isEpisode ? cleanText(body.episode_imdb_id || body.episodeImdbId, 100) : "";
  const explicitShowTmdbId = cleanText(body.show_tmdb_id || body.showTmdbId, 100);
  const explicitShowTvdbId = cleanText(body.show_tvdb_id || body.showTvdbId, 100);
  const explicitShowImdbId = cleanText(body.show_imdb_id || body.showImdbId, 100);
  const tmdbId = isEpisode
    ? (explicitShowTmdbId || (isKnownTvTmdbId(rawTmdbId) ? rawTmdbId : ""))
    : rawTmdbId;
  const tvdbId = isEpisode
    ? (explicitShowTvdbId || (isKnownSeriesTvdbId(rawTvdbId) ? rawTvdbId : ""))
    : rawTvdbId;
  const imdbId = isEpisode ? explicitShowImdbId : cleanText(body.imdb_id || body.imdbId, 100);
  const media = {
    media_key: personalMediaKey({
      ...body,
      media_type: mediaType,
      title,
      show_title: showTitle,
      tmdb_id: tmdbId,
      tvdb_id: tvdbId,
      imdb_id: imdbId,
      show_tmdb_id: tmdbId,
      show_tvdb_id: tvdbId,
      show_imdb_id: imdbId,
      season,
      episode,
    }),
    media_type: mediaType,
    title,
    tmdb_id: tmdbId,
    tvdb_id: tvdbId,
    imdb_id: imdbId,
    poster_url: cleanText(body.poster_url || body.posterUrl, MAX_URL_LENGTH),
    overview: cleanText(body.overview || body.description, MAX_TEXT_LENGTH),
    release_date: cleanText(body.release_date || body.releaseDate || body.first_air_date, 40),
    show_title: showTitle,
    show_tmdb_id: isEpisode ? tmdbId : "",
    show_tvdb_id: isEpisode ? tvdbId : "",
    show_imdb_id: isEpisode ? imdbId : "",
    episode_tmdb_id: episodeTmdbId,
    episode_tvdb_id: episodeTvdbId,
    episode_imdb_id: episodeImdbId,
    season,
    episode,
  };
  if (!isEpisode) return media;

  const submittedShowIdentity = Boolean(
    explicitShowTmdbId
    || explicitShowTvdbId
    || explicitShowImdbId
    || isKnownTvTmdbId(rawTmdbId)
    || isKnownSeriesTvdbId(rawTvdbId)
  );
  if (submittedShowIdentity) return media;

  // Older history records may only contain an episode-level provider id. If
  // the canonical media-page rating already exists, reuse its identity and
  // metadata instead of creating a second key for the same episode.
  const existing = db.prepare(`
    SELECT *
    FROM personal_ratings
    WHERE media_type = 'episode'
      AND lower(trim(show_title)) = lower(trim(?))
      AND season = ?
      AND episode = ?
    ORDER BY updated_at DESC, media_key ASC
  `).all(showTitle, season, episode);
  const canonical = existing
    .map((row) => ({ row, score: (isKnownTvTmdbId(row.tmdb_id) ? 100 : 0) + (isKnownSeriesTvdbId(row.tvdb_id) ? 100 : 0) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.row.updated_at || 0) - Number(left.row.updated_at || 0))[0]?.row;
  if (!canonical) return media;
  return {
    ...media,
    media_key: canonical.media_key,
    title: canonical.title || media.title,
    tmdb_id: canonical.tmdb_id || media.tmdb_id,
    tvdb_id: canonical.tvdb_id || media.tvdb_id,
    imdb_id: canonical.imdb_id || media.imdb_id,
    poster_url: canonical.poster_url || media.poster_url,
    overview: canonical.overview || media.overview,
    release_date: canonical.release_date || media.release_date,
    show_title: canonical.show_title || media.show_title,
    show_tmdb_id: canonical.tmdb_id || media.show_tmdb_id,
    show_tvdb_id: canonical.tvdb_id || media.show_tvdb_id,
    show_imdb_id: canonical.imdb_id || media.show_imdb_id,
    episode_tmdb_id: canonical.episode_tmdb_id || media.episode_tmdb_id,
    episode_tvdb_id: canonical.episode_tvdb_id || media.episode_tvdb_id,
    episode_imdb_id: canonical.episode_imdb_id || media.episode_imdb_id,
  };
}

function mediaRow(row = {}, extra = {}) {
  const mediaType = normalizeMediaType(row.media_type) || "movie";
  const showTmdbId = mediaType === "episode" && isKnownTvTmdbId(row.tmdb_id) ? row.tmdb_id : "";
  const showTvdbId = mediaType === "episode" && isKnownSeriesTvdbId(row.tvdb_id) ? row.tvdb_id : "";
  const showPosterUrl = mediaType === "episode"
    ? getCanonicalPosterUrl({
      ...row,
      media_type: "episode",
      show_title: row.show_title || row.title || "",
    }, { allowEpisodeProviderIds: true })
    : mediaType === "tv"
      ? getCanonicalPosterUrl({ ...row, media_type: "tv" })
      : "";
  return {
    media_key: row.media_key,
    id: row.media_key,
    media_type: mediaType,
    title: row.title,
    tmdb_id: row.tmdb_id || "",
    tvdb_id: row.tvdb_id || "",
    imdb_id: row.imdb_id || "",
    show_tmdb_id: showTmdbId || "",
    show_tvdb_id: showTvdbId || "",
    show_imdb_id: mediaType === "episode" ? row.imdb_id || "" : "",
    episode_tmdb_id: mediaType === "episode" ? row.episode_tmdb_id || "" : "",
    episode_tvdb_id: mediaType === "episode" ? row.episode_tvdb_id || "" : "",
    episode_imdb_id: mediaType === "episode" ? row.episode_imdb_id || "" : "",
    poster_url: row.poster_url || "",
    show_poster_url: showPosterUrl || "",
    overview: row.overview || "",
    release_date: row.release_date || "",
    show_title: row.show_title || "",
    season: row.season ?? null,
    episode: row.episode ?? null,
    created_at: row.created_at || 0,
    updated_at: row.updated_at || 0,
    ...extra,
  };
}

const selectRatingsStmt = db.prepare("SELECT * FROM personal_ratings ORDER BY updated_at DESC, media_key ASC");
const selectWatchlistStmt = db.prepare("SELECT * FROM personal_watchlist ORDER BY updated_at DESC, media_key ASC");
const selectListsStmt = db.prepare("SELECT * FROM personal_lists WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE ASC, id ASC");
const selectListItemsStmt = db.prepare("SELECT * FROM personal_list_items WHERE list_id = ? ORDER BY position ASC, media_key ASC");
const selectDeletedListsStmt = db.prepare(`
  SELECT l.*, (SELECT COUNT(*) FROM personal_list_items i WHERE i.list_id = l.id) AS item_count
  FROM personal_lists l WHERE l.deleted_at IS NOT NULL ORDER BY l.deleted_at DESC, l.id ASC
`);
const selectListTargetsStmt = db.prepare("SELECT * FROM personal_list_targets WHERE list_id = ? ORDER BY provider ASC");
const selectListAvailabilityStmt = db.prepare("SELECT * FROM personal_list_item_availability WHERE list_id = ?");
const selectListHeldStmt = db.prepare("SELECT * FROM personal_list_held_changes WHERE list_id = ? ORDER BY provider ASC, kind ASC");

const PLAYLIST_PROVIDERS = ["plex", "emby", "jellyfin"];
const PLAYLIST_PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };

// Which apps can receive playlists. Read without resolving connections, so
// the page load never waits on a token refresh.
async function playlistProviderAvailability() {
  const config = publicMediaConfig(await loadMediaConfig({ resolveConnections: false }));
  return PLAYLIST_PROVIDERS.map((provider) => ({
    provider,
    configured: Boolean(config?.[provider]?.configured && !config?.[provider]?.disabled),
  }));
}

function targetStatus(target) {
  if (target.last_error) return "error";
  if (target.missing_since) return "missing";
  if (!target.remote_playlist_id) return "pending";
  return "synced";
}

function playlistPayload(list) {
  const targets = selectListTargetsStmt.all(list.id).filter((target) => target.desired_state === "present");
  const selected = new Set(targets.map((target) => target.provider));
  const availability = new Map();
  for (const row of selectListAvailabilityStmt.all(list.id)) {
    if (!selected.has(row.provider)) continue;
    if (!availability.has(row.media_key)) availability.set(row.media_key, {});
    availability.get(row.media_key)[row.provider] = {
      status: row.status,
      reason: row.reason || "",
      episode_count: row.episode_count ?? null,
      checked_at: row.checked_at,
    };
  }
  return {
    id: list.id,
    name: list.name,
    kind: list.kind || null,
    // Automatic playlists (step 8b): the rule, the last check, and a held check.
    rule: parsePlaylistRule(list.rule_json),
    rule_checked_at: list.rule_checked_at || null,
    rule_error: list.rule_error || "",
    // A check running now in this process (decision 63).
    rule_checking: Boolean(list.rule_json) && isPlaylistRuleChecking(list.id),
    rule_hold: list.rule_hold_json ? { ...(parsePlaylistRule(list.rule_hold_json) || {}), confirmed: Boolean(list.rule_hold_confirmed_at) } : null,
    // "Remove items once watched" (step 8e, decision 55).
    remove_watched: Boolean(list.remove_watched),
    created_at: list.created_at,
    updated_at: list.updated_at,
    providers: targets.map((target) => ({
      provider: target.provider,
      status: targetStatus(target),
      last_synced_at: target.last_synced_at || null,
      last_error: target.last_error || "",
      unidentified_count: Number(target.unidentified_count || 0),
    })),
    held_changes: selectListHeldStmt.all(list.id).map((hold) => ({
      provider: hold.provider,
      kind: hold.kind,
      change_count: hold.change_count,
      reason: hold.reason || "",
      held_at: hold.held_at,
      confirmed: Boolean(hold.confirmed_at),
    })),
    items: selectListItemsStmt.all(list.id).map((item) => mediaRow(item, {
      position: item.position,
      availability: availability.get(item.media_key) || {},
    })),
  };
}

function deletedPlaylistPayload(list) {
  const targets = selectListTargetsStmt.all(list.id);
  return {
    id: list.id,
    name: list.name,
    deleted_at: list.deleted_at,
    deleted_origin: list.deleted_origin || "local",
    item_count: list.item_count,
    providers: targets.filter((target) => target.desired_state === "present").map((target) => target.provider),
    // Apps that still hold a copy the sync has not deleted yet.
    pending_app_deletes: targets.filter((target) => target.remote_playlist_id).map((target) => target.provider),
  };
}

// A fingerprint of everything the Playlists page draws, so the open page can
// ask cheaply whether a scheduled pass changed anything (decision 67).
function playlistsStamp(lists, deletedLists) {
  return crypto.createHash("sha1").update(JSON.stringify([lists, deletedLists])).digest("hex");
}

function currentPlaylistsStamp() {
  return playlistsStamp(selectListsStmt.all().map(playlistPayload), selectDeletedListsStmt.all().map(deletedPlaylistPayload));
}

async function personalPayload() {
  const lists = selectListsStmt.all().map(playlistPayload);
  const deletedLists = selectDeletedListsStmt.all().map(deletedPlaylistPayload);
  return {
    ratings: selectRatingsStmt.all().map((row) => mediaRow(row, { rating: row.rating })),
    watchlist: selectWatchlistStmt.all().map((row) => mediaRow(row)),
    lists,
    deleted_lists: deletedLists,
    playlists_stamp: playlistsStamp(lists, deletedLists),
    playlist_providers: await playlistProviderAvailability(),
  };
}

function httpError(message, status, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.publicCode = code;
  return error;
}

const PLAYLIST_KINDS = ["movie", "tv", "mixed"];

// Plembfin-side adds are type-checked (decision 14): a show is added as the
// episodes picked for it, never whole. A Mixed playlist takes movies and
// episodes (decision 25). An untyped playlist (empty before playlists had a
// type) takes the type of its first item (decision 19).
function claimPlaylistKind(listId, mediaType) {
  if (mediaType === "tv") {
    throw httpError("Choose the episodes to add; a playlist holds episodes, not whole shows.", 400, "show_needs_episodes");
  }
  const itemKind = mediaType === "movie" ? "movie" : "tv";
  const list = db.prepare("SELECT kind FROM personal_lists WHERE id = ?").get(listId);
  if (list?.kind && list.kind !== "mixed" && list.kind !== itemKind) {
    throw httpError(list.kind === "movie" ? "This is a Movies playlist; episodes go in a TV or Mixed playlist." : "This is a TV playlist; movies go in a Movies or Mixed playlist.", 400, "wrong_type");
  }
  if (!list?.kind) db.prepare("UPDATE personal_lists SET kind = ? WHERE id = ? AND kind IS NULL").run(itemKind, listId);
}

// Items of an automatic playlist are picked by its rule (decision 35).
function refuseAutomatic(listId) {
  if (db.prepare("SELECT rule_json FROM personal_lists WHERE id = ?").get(listId)?.rule_json) {
    throw httpError("This playlist is automatic: its rule picks the items. Stop updating it to change them by hand.", 409, "automatic_playlist");
  }
}

function requireListId(body = {}, { deleted = false } = {}) {
  const listId = cleanText(body.list_id || body.listId, 100);
  if (!listId) throw httpError("A playlist id is required", 400);
  const condition = deleted ? "deleted_at IS NOT NULL" : "deleted_at IS NULL";
  if (!db.prepare(`SELECT id FROM personal_lists WHERE id = ? AND ${condition}`).get(listId)) {
    throw httpError(deleted ? "Deleted playlist not found" : "Playlist not found", 404);
  }
  return listId;
}

function nameTaken(name, exceptId = "") {
  return Boolean(db.prepare("SELECT id FROM personal_lists WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id <> ?").get(name, exceptId));
}

// Undefined means "leave the apps unchanged". Newly selected apps must be
// connected; an app already selected may stay while it is disconnected.
async function providersFromBody(body, currentProviders = []) {
  if (body.providers === undefined) return null;
  if (!Array.isArray(body.providers)) throw httpError("providers must be a list", 400);
  const providers = [...new Set(body.providers.map((value) => cleanText(value, 20).toLowerCase()))];
  const unknown = providers.filter((provider) => !PLAYLIST_PROVIDERS.includes(provider));
  if (unknown.length) throw httpError(`Unknown app: ${unknown.join(", ")}`, 400);
  const configured = new Set((await playlistProviderAvailability()).filter((entry) => entry.configured).map((entry) => entry.provider));
  const unavailable = providers.filter((provider) => !currentProviders.includes(provider) && !configured.has(provider));
  if (unavailable.length) {
    throw httpError(`${unavailable.map((provider) => PLAYLIST_PROVIDER_LABELS[provider]).join(", ")} is not connected`, 400);
  }
  return PLAYLIST_PROVIDERS.filter((provider) => providers.includes(provider));
}

function presentProviders(listId) {
  return selectListTargetsStmt.all(listId).filter((target) => target.desired_state === "present").map((target) => target.provider);
}

// A deselected app keeps its row as 'absent' until the sync deletes its
// playlist; with no app playlist yet there is nothing to delete.
function setListTargets(listId, providers, timestamp) {
  const existing = new Map(selectListTargetsStmt.all(listId).map((target) => [target.provider, target]));
  for (const provider of providers) {
    if (existing.has(provider)) {
      db.prepare("UPDATE personal_list_targets SET desired_state = 'present', updated_at = ? WHERE list_id = ? AND provider = ?").run(timestamp, listId, provider);
    } else {
      db.prepare("INSERT INTO personal_list_targets (list_id, provider, desired_state, created_at, updated_at) VALUES (?, ?, 'present', ?, ?)").run(listId, provider, timestamp, timestamp);
    }
  }
  for (const [provider, target] of existing) {
    if (providers.includes(provider) || target.desired_state === "absent") continue;
    if (target.remote_playlist_id) {
      db.prepare("UPDATE personal_list_targets SET desired_state = 'absent', updated_at = ? WHERE list_id = ? AND provider = ?").run(timestamp, listId, provider);
    } else {
      db.prepare("DELETE FROM personal_list_targets WHERE list_id = ? AND provider = ?").run(listId, provider);
      db.prepare("DELETE FROM personal_list_item_availability WHERE list_id = ? AND provider = ?").run(listId, provider);
    }
  }
}

function touchList(listId, timestamp) {
  db.prepare("UPDATE personal_lists SET updated_at = ? WHERE id = ?").run(timestamp, listId);
}

function upsertMedia(tableName, media, timestamp, { rating = null } = {}) {
  if (tableName === "personal_ratings") {
    db.prepare(`
      INSERT INTO personal_ratings
        (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, show_title, season, episode, episode_tmdb_id, episode_tvdb_id, episode_imdb_id, rating, origin, canonical_updated_at, created_at, updated_at)
      VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @show_title, @season, @episode, @episode_tmdb_id, @episode_tvdb_id, @episode_imdb_id, @rating, 'manual', @updated_at, @created_at, @updated_at)
      ON CONFLICT(media_key) DO UPDATE SET
        media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
        tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
        overview=excluded.overview, release_date=excluded.release_date, show_title=excluded.show_title,
        season=excluded.season, episode=excluded.episode, episode_tmdb_id=excluded.episode_tmdb_id,
        episode_tvdb_id=excluded.episode_tvdb_id, episode_imdb_id=excluded.episode_imdb_id, rating=excluded.rating,
        origin='manual', canonical_updated_at=excluded.canonical_updated_at,
        updated_at=excluded.updated_at
    `).run({ ...media, rating, created_at: timestamp, updated_at: timestamp });
    return;
  }
  db.prepare(`
    INSERT INTO personal_watchlist
      (media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date, created_at, updated_at)
    VALUES (@media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date, @created_at, @updated_at)
    ON CONFLICT(media_key) DO UPDATE SET
      media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
      tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
      overview=excluded.overview, release_date=excluded.release_date, updated_at=excluded.updated_at
  `).run({ ...media, created_at: timestamp, updated_at: timestamp });
}

// A new item joins the playlist at `position` (the top by default) and the
// items from there down shift; re-adding an existing one keeps its place.
// Returns whether the item was new.
function upsertListItem(listId, media, timestamp, position = 0) {
  const exists = db.prepare("SELECT 1 FROM personal_list_items WHERE list_id = ? AND media_key = ?").get(listId, media.media_key);
  if (!exists) db.prepare("UPDATE personal_list_items SET position = position + 1 WHERE list_id = ? AND position >= ?").run(listId, position);
  db.prepare(`
    INSERT INTO personal_list_items
      (list_id, media_key, media_type, title, tmdb_id, tvdb_id, imdb_id, poster_url, overview, release_date,
       show_title, season, episode, episode_tmdb_id, episode_tvdb_id, episode_imdb_id, position, created_at, updated_at)
    VALUES (@list_id, @media_key, @media_type, @title, @tmdb_id, @tvdb_id, @imdb_id, @poster_url, @overview, @release_date,
      @show_title, @season, @episode, @episode_tmdb_id, @episode_tvdb_id, @episode_imdb_id, @position, @created_at, @updated_at)
    ON CONFLICT(list_id, media_key) DO UPDATE SET
      media_type=excluded.media_type, title=excluded.title, tmdb_id=excluded.tmdb_id,
      tvdb_id=excluded.tvdb_id, imdb_id=excluded.imdb_id, poster_url=excluded.poster_url,
      overview=excluded.overview, release_date=excluded.release_date, show_title=excluded.show_title,
      season=excluded.season, episode=excluded.episode, episode_tmdb_id=excluded.episode_tmdb_id,
      episode_tvdb_id=excluded.episode_tvdb_id, episode_imdb_id=excluded.episode_imdb_id, updated_at=excluded.updated_at
  `).run({
    list_id: listId,
    ...media,
    show_title: media.media_type === "episode" ? media.show_title : null,
    episode_tmdb_id: media.episode_tmdb_id || null,
    episode_tvdb_id: media.episode_tvdb_id || null,
    episode_imdb_id: media.episode_imdb_id || null,
    position,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return !exists;
}

function deleteEpisodeRatingAliases(media, { keepMediaKey = "" } = {}) {
  if (media.media_type !== "episode") return;
  const conditions = [
    "media_type = 'episode'",
    "lower(trim(show_title)) = lower(trim(?))",
    "season = ?",
    "episode = ?",
  ];
  const params = [media.show_title, media.season, media.episode];
  if (keepMediaKey) {
    conditions.push("media_key <> ?");
    params.push(keepMediaKey);
  }
  db.prepare(`DELETE FROM personal_ratings WHERE ${conditions.join(" AND ")}`).run(...params);
}

export async function handlePersonalMedia(req, res) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  if (req.method === "GET") {
    return sendJson(res, await personalPayload(), 200, {
      "Cache-Control": "private, max-age=20, stale-while-revalidate=60",
      Vary: "Authorization",
    });
  }
  if (req.method !== "POST") return methodNotAllowed(res);

  const body = await readJson(req);
  const action = cleanText(body.action, 60).toLowerCase();
  try {
    if (action === "watchlist-add" || action === "watchlist-remove" || action === "rate" || action === "remove-rating" || action === "list-add" || action === "list-remove") {
      const media = mediaFromBody(body, { allowEpisode: action !== "watchlist-add" && action !== "watchlist-remove" });
      const timestamp = Date.now();
      // A local rating must not depend on a provider refresh or network call.
      // The transaction below commits Plembfin's canonical value first; the
      // separate queue worker resolves provider credentials later.
      const ratingSyncConfig = ["rate", "remove-rating"].includes(action)
        ? await loadMediaConfig({ resolveConnections: false })
        : null;
      const watchlistSyncConfig = ["watchlist-add", "watchlist-remove"].includes(action)
        ? await loadMediaConfig({ resolveConnections: false })
        : null;
      let ratingQueue = { queued: 0, providers: [] };
      let watchlistMutation = null;
      transaction(() => {
        if (action === "watchlist-add") {
          watchlistMutation = recordWatchlistMutation({
            media,
            desiredState: "present",
            origin: "local",
            reason: "manual_add",
            config: watchlistSyncConfig,
            timestamp,
          });
        }
        if (action === "watchlist-remove") {
          watchlistMutation = recordWatchlistMutation({
            media,
            desiredState: "absent",
            origin: "local",
            reason: "manual_remove",
            config: watchlistSyncConfig,
            timestamp,
          });
        }
        if (action === "rate") {
          const rating = Number(body.rating);
          if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
            const error = new Error("Rating must be a whole number from 1 to 10");
            error.status = 400;
            throw error;
          }
          deleteEpisodeRatingAliases(media, { keepMediaKey: media.media_key });
          upsertMedia("personal_ratings", media, timestamp, { rating });
          ratingQueue = queuePersonalRatingMutation(media, rating, { config: ratingSyncConfig, source: "manual", timestamp });
        }
        if (action === "remove-rating") {
          if (media.media_type === "episode") deleteEpisodeRatingAliases(media);
          else db.prepare("DELETE FROM personal_ratings WHERE media_key = ?").run(media.media_key);
          ratingQueue = queuePersonalRatingMutation(media, null, { config: ratingSyncConfig, source: "manual", timestamp });
        }
        if (action === "list-add") {
          const listId = requireListId(body);
          refuseAutomatic(listId);
          claimPlaylistKind(listId, media.media_type);
          upsertListItem(listId, media, timestamp);
          touchList(listId, timestamp);
        }
        if (action === "list-remove") {
          const listId = requireListId(body);
          // An automatic playlist never adds the title back (decision 65).
          if (db.prepare("SELECT rule_json FROM personal_lists WHERE id = ?").get(listId)?.rule_json) handOffAutomaticPlaylistItem(listId, media, timestamp);
          else db.prepare("DELETE FROM personal_list_items WHERE list_id = ? AND media_key = ?").run(listId, media.media_key);
          touchList(listId, timestamp);
        }
      });
      bumpDataVersion();
      writeAuditLog(`personal.${action}`, { detail: { mediaKey: media.media_key } });
      if (action === "list-add" || action === "list-remove") schedulePlaylistSync(requireListId(body));
      return sendJson(res, {
        ok: true,
        media_key: media.media_key,
        rating_sync: ratingQueue,
        watchlist_sync: watchlistMutation
          ? {
              mutation_id: watchlistMutation.mutation?.id || "",
              revision: watchlistMutation.mutation?.canonical_revision || 0,
              queued: watchlistMutation.queued?.length || 0,
              providers: (watchlistMutation.queued || []).map((item) => item.provider),
              stale: Boolean(watchlistMutation.stale),
            }
          : null,
      }, 200);
    }

    // Each episode picked for one show, added at the top as one block in
    // episode order (decision 20). Episodes already in the playlist keep their place.
    if (action === "list-add-episodes") {
      const listId = requireListId(body);
      refuseAutomatic(listId);
      const show = body.show && typeof body.show === "object" ? body.show : {};
      const picked = Array.isArray(body.episodes) ? body.episodes.slice(0, 2000) : [];
      if (!picked.length) return sendJson(res, { error: "Choose at least one episode" }, 400);
      const showTitle = cleanText(show.title || show.show_title, MAX_TITLE_LENGTH);
      const episodes = picked.map((entry) => mediaFromBody({
        media_type: "episode",
        title: cleanText(entry?.title, MAX_TITLE_LENGTH) || `Episode ${entry?.episode ?? ""}`.trim(),
        show_title: showTitle,
        show_tmdb_id: show.tmdb_id,
        show_tvdb_id: show.tvdb_id,
        show_imdb_id: show.imdb_id,
        poster_url: show.poster_url,
        overview: entry?.overview,
        release_date: entry?.release_date || entry?.air_date,
        season: entry?.season,
        episode: entry?.episode,
      }, { allowEpisode: true }))
        .sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
      const timestamp = Date.now();
      let added = 0;
      transaction(() => {
        claimPlaylistKind(listId, "episode");
        const seen = new Set();
        for (const media of episodes) {
          if (seen.has(media.media_key)) continue;
          seen.add(media.media_key);
          if (upsertListItem(listId, media, timestamp, added)) added += 1;
        }
        touchList(listId, timestamp);
      });
      bumpDataVersion();
      writeAuditLog("personal.list-add-episodes", { detail: { listId, show: showTitle, added } });
      schedulePlaylistSync(listId);
      return sendJson(res, { ok: true, added }, 200);
    }

    // Every episode the metadata lists for a show, for the episode picker.
    if (action === "show-episodes") {
      const show = body.show && typeof body.show === "object" ? body.show : body;
      try {
        const { ids, episodes } = await fetchShowEpisodes({
          title: cleanText(show.title, MAX_TITLE_LENGTH),
          tmdb_id: cleanText(show.tmdb_id, 100),
          tvdb_id: cleanText(show.tvdb_id, 100),
          imdb_id: cleanText(show.imdb_id, 100),
        });
        return sendJson(res, { ok: true, ids, episodes }, 200);
      } catch (error) {
        return sendJson(res, { error: `Could not load the episodes: ${error?.message || error}` }, 502);
      }
    }

    if (action === "list-create") {
      const name = cleanText(body.name, 100);
      if (!name) return sendJson(res, { error: "A playlist name is required" }, 400);
      const kind = cleanText(body.kind, 10).toLowerCase();
      if (!PLAYLIST_KINDS.includes(kind)) return sendJson(res, { error: "Choose Movies, TV, or Mixed for the playlist", code: "kind_required" }, 400);
      // An automatic playlist is Movies or TV (decision 38).
      const rule = body.rule === undefined || body.rule === null ? null : normalizePlaylistRule(body.rule, kind);
      const removeWatched = body.remove_watched ? 1 : 0;
      if (nameTaken(name)) return sendJson(res, { error: "A playlist with that name already exists" }, 409);
      const providers = (await providersFromBody(body)) || [];
      const id = crypto.randomUUID();
      const timestamp = Date.now();
      try {
        transaction(() => {
          db.prepare("INSERT INTO personal_lists (id, name, kind, rule_json, remove_watched, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, name, kind, rule ? JSON.stringify(rule) : null, removeWatched, timestamp, timestamp);
          setListTargets(id, providers, timestamp);
        });
      } catch (error) {
        if (String(error?.code || "").startsWith("SQLITE_CONSTRAINT")) return sendJson(res, { error: "A playlist with that name already exists" }, 409);
        throw error;
      }
      bumpDataVersion();
      writeAuditLog("personal.list-create", { detail: { listId: id, providers, automatic: Boolean(rule) } });
      if (rule) schedulePlaylistRuleCheck(id);
      else schedulePlaylistSync(id);
      return sendJson(res, { ok: true, list: playlistPayload({ id, name, kind, rule_json: rule ? JSON.stringify(rule) : null, remove_watched: removeWatched, created_at: timestamp, updated_at: timestamp }) }, 201);
    }

    // Rename and/or change which apps hold the playlist.
    if (action === "list-update") {
      const listId = requireListId(body);
      const name = body.name === undefined ? null : cleanText(body.name, 100);
      if (name !== null && !name) return sendJson(res, { error: "A playlist name is required" }, 400);
      if (name && nameTaken(name, listId)) return sendJson(res, { error: "A playlist with that name already exists" }, 409);
      // A rule can be changed on an automatic playlist; a manual playlist
      // cannot be turned automatic (decision 42).
      let rule = null;
      if (body.rule !== undefined && body.rule !== null) {
        const current = db.prepare("SELECT kind, rule_json FROM personal_lists WHERE id = ?").get(listId);
        if (!current.rule_json) return sendJson(res, { error: "A playlist that picks its items by hand cannot be made automatic", code: "not_automatic" }, 400);
        rule = normalizePlaylistRule(body.rule, current.kind);
      }
      const providers = await providersFromBody(body, presentProviders(listId));
      // Turning it on removes watched items on the next pass (or the rule
      // check below); turning it off keeps earlier hand-offs (decision 56).
      const removeWatched = body.remove_watched === undefined || body.remove_watched === null ? null : (body.remove_watched ? 1 : 0);
      const turnedOn = removeWatched === 1 && !db.prepare("SELECT remove_watched FROM personal_lists WHERE id = ?").get(listId)?.remove_watched;
      const timestamp = Date.now();
      transaction(() => {
        if (name) db.prepare("UPDATE personal_lists SET name = ? WHERE id = ?").run(name, listId);
        if (removeWatched !== null) db.prepare("UPDATE personal_lists SET remove_watched = ? WHERE id = ?").run(removeWatched, listId);
        if (providers) setListTargets(listId, providers, timestamp);
        if (rule) {
          db.prepare(`
            UPDATE personal_lists SET rule_json = ?, rule_checked_at = NULL, rule_error = NULL, rule_hold_json = NULL, rule_hold_confirmed_at = NULL
            WHERE id = ?
          `).run(JSON.stringify(rule), listId);
        }
        touchList(listId, timestamp);
      });
      bumpDataVersion();
      writeAuditLog("personal.list-update", { detail: { listId, renamed: Boolean(name), providers, ruleChanged: Boolean(rule), removeWatched } });
      // New apps change which libraries a library-source rule reads.
      const automatic = Boolean(db.prepare("SELECT rule_json FROM personal_lists WHERE id = ?").get(listId)?.rule_json);
      if (automatic && (rule || providers || turnedOn)) schedulePlaylistRuleCheck(listId);
      else schedulePlaylistSync(listId);
      return sendJson(res, { ok: true }, 200);
    }

    // `order` is every media key of the playlist in the new order, so a stale
    // page cannot drop or duplicate items.
    if (action === "list-reorder") {
      const listId = requireListId(body);
      refuseAutomatic(listId);
      const order = Array.isArray(body.order) ? body.order.map((key) => cleanText(key, 500)) : [];
      const current = selectListItemsStmt.all(listId).map((item) => item.media_key);
      const sameSet = order.length === current.length
        && new Set(order).size === order.length
        && order.every((key) => current.includes(key));
      if (!sameSet) return sendJson(res, { error: "The playlist changed. Reload the page and try again." }, 409);
      const timestamp = Date.now();
      transaction(() => {
        const update = db.prepare("UPDATE personal_list_items SET position = ? WHERE list_id = ? AND media_key = ?");
        order.forEach((key, index) => update.run(index, listId, key));
        db.prepare("UPDATE personal_lists SET order_updated_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, listId);
      });
      bumpDataVersion();
      writeAuditLog("personal.list-reorder", { detail: { listId } });
      schedulePlaylistSync(listId);
      return sendJson(res, { ok: true }, 200);
    }

    // Every deleted playlist goes to Recently deleted. The sync deletes the
    // app copies and keeps the target rows, so Restore knows where to recreate it.
    if (action === "list-delete") {
      const listId = requireListId(body);
      const timestamp = Date.now();
      transaction(() => {
        db.prepare("UPDATE personal_lists SET deleted_at = ?, deleted_origin = 'local', updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(timestamp, timestamp, listId);
        db.prepare("DELETE FROM personal_list_held_changes WHERE list_id = ?").run(listId);
      });
      bumpDataVersion();
      writeAuditLog("personal.list-delete", { detail: { listId } });
      schedulePlaylistSync(listId);
      return sendJson(res, { ok: true }, 200);
    }

    // Restore recreates the playlist in every app it targeted. An app that was
    // being deselected when the playlist was deleted stays deselected. When a
    // live playlist took the name meanwhile, the restore is refused with
    // code "name_taken" and the page asks for a new name.
    if (action === "list-restore") {
      const listId = requireListId(body, { deleted: true });
      const list = db.prepare("SELECT name FROM personal_lists WHERE id = ?").get(listId);
      const requested = body.name === undefined ? null : cleanText(body.name, 100);
      if (requested !== null && !requested) return sendJson(res, { error: "A playlist name is required" }, 400);
      const name = requested || list.name;
      if (nameTaken(name, listId)) {
        return sendJson(res, { error: `A playlist named "${name}" already exists. Choose a new name to restore it.`, code: "name_taken", name }, 409);
      }
      const timestamp = Date.now();
      transaction(() => {
        db.prepare("UPDATE personal_lists SET name = ?, deleted_at = NULL, deleted_origin = NULL, updated_at = ? WHERE id = ?").run(name, timestamp, listId);
        db.prepare("DELETE FROM personal_list_targets WHERE list_id = ? AND desired_state = 'absent' AND remote_playlist_id IS NULL").run(listId);
        db.prepare(`
          UPDATE personal_list_targets
          SET not_found_passes = 0, missing_since = NULL, last_error = NULL, last_error_at = NULL, updated_at = ?
          WHERE list_id = ? AND desired_state = 'present'
        `).run(timestamp, listId);
      });
      bumpDataVersion();
      writeAuditLog("personal.list-restore", { detail: { listId } });
      schedulePlaylistSync(listId);
      return sendJson(res, { ok: true, name }, 200);
    }

    // Permanent delete waits until the sync has deleted every app copy it
    // can reach; an app that is no longer connected does not block it.
    if (action === "list-purge") {
      const listId = requireListId(body, { deleted: true });
      const connected = new Set((await playlistProviderAvailability()).filter((entry) => entry.configured).map((entry) => entry.provider));
      const pending = selectListTargetsStmt.all(listId)
        .filter((target) => target.remote_playlist_id && connected.has(target.provider))
        .map((target) => PLAYLIST_PROVIDER_LABELS[target.provider]);
      if (pending.length) {
        schedulePlaylistSync(listId);
        return sendJson(res, { error: `Plekt is still deleting this playlist from ${pending.join(", ")}. Try again in a few minutes.` }, 409);
      }
      db.prepare("DELETE FROM personal_lists WHERE id = ? AND deleted_at IS NOT NULL").run(listId);
      bumpDataVersion();
      writeAuditLog("personal.list-purge", { detail: { listId } });
      return sendJson(res, { ok: true }, 200);
    }

    // A change the sync held back for confirmation (many app-side removals,
    // or an app-side deletion). Web-only processes leave the sync to the worker.
    if (action === "list-held") {
      const listId = requireListId(body);
      const provider = cleanText(body.provider, 20).toLowerCase();
      const kind = cleanText(body.kind, 20).toLowerCase();
      const decision = cleanText(body.decision, 20).toLowerCase();
      if (!PLAYLIST_PROVIDERS.includes(provider) || !["removals", "delete"].includes(kind) || !["confirm", "discard"].includes(decision)) {
        return sendJson(res, { error: "provider, kind, and decision (confirm or discard) are required" }, 400);
      }
      const sync = roleHasWorker(resolveProcessRole());
      const result = decision === "confirm"
        ? await confirmHeldPlaylistChange(listId, provider, kind, { sync })
        : await discardHeldPlaylistChange(listId, provider, kind, { sync });
      if (result?.status === "not_found") return sendJson(res, { error: "That held change is no longer pending" }, 404);
      bumpDataVersion();
      writeAuditLog("personal.list-held", { detail: { listId, provider, kind, decision } });
      return sendJson(res, { ok: true, synced: sync }, 200);
    }

    // Refresh now (decision 36): checks the rule at once, rereading the
    // libraries, then syncs. Web-only processes mark it due for the worker.
    if (action === "list-refresh-rule") {
      const listId = requireListId(body);
      if (!db.prepare("SELECT rule_json FROM personal_lists WHERE id = ?").get(listId)?.rule_json) return sendJson(res, { error: "This playlist is not automatic", code: "not_automatic" }, 400);
      if (!roleHasWorker(resolveProcessRole())) {
        db.prepare("UPDATE personal_lists SET rule_checked_at = NULL WHERE id = ?").run(listId);
        return sendJson(res, { ok: true, status: "queued" }, 202);
      }
      const result = await checkPlaylistRule(listId, { config: await loadMediaConfig(), force: true });
      writeAuditLog("personal.list-refresh-rule", { detail: { listId, status: result.status } });
      schedulePlaylistSync(listId, { delayMs: 0 });
      return sendJson(res, { ok: result.status !== "error", ...result }, 200);
    }

    // Stop updating (decision 42): the playlist keeps its items as a manual one.
    if (action === "list-stop-rule") {
      const listId = requireListId(body);
      const result = await stopPlaylistRule(listId, { push: roleHasWorker(resolveProcessRole()) });
      if (result.status === "not_automatic") return sendJson(res, { error: "This playlist is not automatic", code: "not_automatic" }, 400);
      writeAuditLog("personal.list-stop-rule", { detail: { listId } });
      return sendJson(res, { ok: true, providers: result.providers }, 200);
    }

    // A rule check held for confirmation (decisions 41, 47, 48). Confirm
    // re-checks and applies; Discard keeps the items until the next hourly check.
    if (action === "list-rule-held") {
      const listId = requireListId(body);
      const decision = cleanText(body.decision, 20).toLowerCase();
      if (!["confirm", "discard"].includes(decision)) return sendJson(res, { error: "decision must be confirm or discard" }, 400);
      const found = decision === "confirm" ? confirmPlaylistRuleHold(listId) : discardPlaylistRuleHold(listId);
      if (!found) return sendJson(res, { error: "That held change is no longer pending" }, 404);
      bumpDataVersion();
      writeAuditLog("personal.list-rule-held", { detail: { listId, decision } });
      const worker = roleHasWorker(resolveProcessRole());
      if (decision === "confirm") {
        if (worker) schedulePlaylistRuleCheck(listId);
        else db.prepare("UPDATE personal_lists SET rule_checked_at = NULL WHERE id = ?").run(listId);
      }
      return sendJson(res, { ok: true, synced: worker }, 200);
    }

    // The open Playlists page polls this and reloads only when it changed.
    if (action === "list-stamp") {
      return sendJson(res, { ok: true, stamp: currentPlaylistsStamp() }, 200);
    }

    // App playlists that can be imported (step 7). Reads only.
    if (action === "list-import-candidates") {
      return sendJson(res, { ok: true, ...(await listPlaylistImportCandidates({ config: await loadMediaConfig() })) }, 200);
    }

    // Genres offered by the automatic playlist rule editor (step 8a): TMDB's
    // plus those the apps' libraries report, merged (decision 43). Reads only.
    if (action === "list-rule-genres") {
      const kind = cleanText(body.kind, 10).toLowerCase();
      if (!["movie", "tv"].includes(kind)) return sendJson(res, { error: "kind must be movie or tv" }, 400);
      const catalogues = await readLibraryCatalogues(PLAYLIST_PROVIDERS, await loadMediaConfig());
      const apps = Object.fromEntries(Object.entries(catalogues).map(([provider, catalogue]) => [provider, { status: catalogue.status, error: catalogue.error || "" }]));
      return sendJson(res, { ok: true, kind, genres: playlistRuleGenres(kind, catalogues), apps }, 200);
    }

    // Links the picked app playlists and runs their first sync (step 7).
    // Web-only processes leave the sync to the worker's scheduled pass.
    if (action === "list-import") {
      const syncList = roleHasWorker(resolveProcessRole()) ? (listId) => syncPlaylist(listId) : null;
      return sendJson(res, { ok: true, ...(await importAppPlaylists(body.picks, { config: await loadMediaConfig(), syncList })) }, 200);
    }

    return sendJson(res, { error: "Unknown personal media action" }, 400);
  } catch (error) {
    return sendJson(res, { error: error.message || "Personal media update failed", ...(error.publicCode ? { code: error.publicCode } : {}) }, error.status || 500);
  }
}
