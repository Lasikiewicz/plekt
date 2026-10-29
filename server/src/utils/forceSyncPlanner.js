// Force Sync planner - the read-only half of Force Sync.
//
// This module inspects the connected media servers and Plembfin's own watch
// history and produces a *plan*: an ordered list of typed actions describing
// exactly what an execution run would change, without performing any local or
// remote write. The executor (executeForceSyncPlan in scheduled.js) is the only
// place plan actions turn into writes.
//
// Invariant: nothing in this module writes to the database or issues a
// mark-played/mark-unplayed call. It imports no client write functions and no
// dataRepo write helpers. Tests assert this stays true.

import { canonicalTitleKey, mediaKeyFor, showTitleFrom } from "./dataRepo.js";
import { remoteEpisodeImportError } from "./episodeImportGuard.js";
import { normalizeProviderIds, parsePlexMediaIds } from "./parsers.js";
import {
  releaseDateForItem,
  releaseDateForPlexItem,
  watchedAtForEmbyLikeItem,
  watchedAtForPlexItem,
} from "./watchDates.js";
import {
  countPlexWatchedItems,
  fetchPlexWatchedItems,
  listPlexLibraries,
} from "./plexClient.js";
import {
  countEmbyWatchedItems,
  fetchEmbyWatchedItems,
  listEmbyLibraries,
} from "./embyClient.js";
import {
  countJellyfinWatchedItems,
  fetchJellyfinWatchedItems,
  listJellyfinLibraries,
} from "./jellyfinClient.js";
import { canReceiveState, syncRolesRevision } from "./syncRoles.js";

export const SYNC_SERVERS = ["plex", "emby", "jellyfin"];
export const PLAN_TTL_MS = 15 * 60 * 1000;

// A plan whose destructive action count crosses either bound requires the
// stronger typed confirmation in the UI.
export const DESTRUCTIVE_CONFIRM_COUNT = 25;
export const DESTRUCTIVE_CONFIRM_HISTORY_FRACTION = 0.1;

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

function isoOrEmpty(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function normalizeScope(scope = {}) {
  const servers = Array.isArray(scope.servers)
    ? scope.servers.map((s) => String(s).toLowerCase()).filter((s) => SYNC_SERVERS.includes(s))
    : [];
  const mediaTypes = Array.isArray(scope.mediaTypes)
    ? scope.mediaTypes.map((t) => String(t).toLowerCase()).filter((t) => ["movie", "episode"].includes(t))
    : [];
  const libraries = Array.isArray(scope.libraries)
    ? scope.libraries
        .filter((lib) => lib && SYNC_SERVERS.includes(String(lib.server || "").toLowerCase()) && String(lib.id || "").trim())
        .map((lib) => ({
          server: String(lib.server).toLowerCase(),
          id: String(lib.id).trim(),
          name: String(lib.name || "").trim(),
        }))
    : [];
  const maxChangesRaw = Number(scope.maxChanges);
  const maxChanges = Number.isFinite(maxChangesRaw) && maxChangesRaw > 0 ? Math.round(maxChangesRaw) : 0;
  return {
    servers,
    mediaTypes,
    libraries,
    watchedAfter: isoOrEmpty(scope.watchedAfter),
    watchedBefore: isoOrEmpty(scope.watchedBefore),
    // Distinct from watchedAfter/watchedBefore: those filter by when the item
    // was actually watched (its source playback timestamp), which is often
    // old and spread across the library. updatedAfter/updatedBefore filter by
    // when Plembfin's own history row was last touched - the right dimension
    // for scoping a repair to "whatever a specific incident/bug run touched
    // just now", regardless of how old the underlying real watch is.
    updatedAfter: isoOrEmpty(scope.updatedAfter),
    updatedBefore: isoOrEmpty(scope.updatedBefore),
    maxChanges,
  };
}

export function scopeIsDefault(scope = {}) {
  const normalized = normalizeScope(scope);
  return (
    !normalized.servers.length &&
    !normalized.mediaTypes.length &&
    !normalized.libraries.length &&
    !normalized.watchedAfter &&
    !normalized.watchedBefore &&
    !normalized.updatedAfter &&
    !normalized.updatedBefore &&
    !normalized.maxChanges
  );
}

export function describeScope(scope = {}) {
  const normalized = normalizeScope(scope);
  if (scopeIsDefault(normalized)) return "all servers, all libraries, all media types, full history";
  const parts = [];
  parts.push(normalized.servers.length ? `servers: ${normalized.servers.join(", ")}` : "all servers");
  if (normalized.libraries.length) {
    parts.push(`libraries: ${normalized.libraries.map((lib) => lib.name || `${lib.server}/${lib.id}`).join(", ")}`);
  }
  parts.push(normalized.mediaTypes.length ? `types: ${normalized.mediaTypes.join(", ")}` : "all media types");
  if (normalized.watchedAfter) parts.push(`watched after ${normalized.watchedAfter.slice(0, 10)}`);
  if (normalized.watchedBefore) parts.push(`watched before ${normalized.watchedBefore.slice(0, 10)}`);
  if (normalized.updatedAfter) parts.push(`updated after ${normalized.updatedAfter}`);
  if (normalized.updatedBefore) parts.push(`updated before ${normalized.updatedBefore}`);
  if (normalized.maxChanges) parts.push(`max ${normalized.maxChanges} changes`);
  return parts.join("; ");
}

function serverInScope(scope, server) {
  return !scope.servers.length || scope.servers.includes(server);
}

function scopedLibraryIds(scope, server) {
  const ids = scope.libraries.filter((lib) => lib.server === server).map((lib) => lib.id);
  return ids.length ? ids : null;
}

function itemInScope(scope, media) {
  if (scope.mediaTypes.length && !scope.mediaTypes.includes(media.type)) return false;
  if (scope.watchedAfter || scope.watchedBefore) {
    const time = media.timestamp ? new Date(media.timestamp).getTime() : 0;
    if (scope.watchedAfter && (!time || time < new Date(scope.watchedAfter).getTime())) return false;
    if (scope.watchedBefore && (!time || time > new Date(scope.watchedBefore).getTime())) return false;
  }
  return true;
}

function historyRowInScope(scope, row) {
  if (scope.mediaTypes.length && !scope.mediaTypes.includes(String(row.media_type || ""))) return false;
  if (scope.watchedAfter || scope.watchedBefore) {
    const time = row.watched_at ? new Date(row.watched_at).getTime() : 0;
    if (scope.watchedAfter && (!time || time < new Date(scope.watchedAfter).getTime())) return false;
    if (scope.watchedBefore && (!time || time > new Date(scope.watchedBefore).getTime())) return false;
  }
  if (scope.updatedAfter || scope.updatedBefore) {
    const updatedAt = Number(row.updated_at || 0);
    if (scope.updatedAfter && (!updatedAt || updatedAt < new Date(scope.updatedAfter).getTime())) return false;
    if (scope.updatedBefore && (!updatedAt || updatedAt > new Date(scope.updatedBefore).getTime())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Server item mapping (identical shaping to the pre-planner runForceSync)
// ---------------------------------------------------------------------------

export function mapPlexWatchedItem(item = {}) {
  const { watchedAt } = watchedAtForPlexItem(item);
  const releaseDate = watchedAt ? "" : releaseDateForPlexItem(item);
  // Episodes carry their own tmdb/tvdb guid, distinct from the show's - prefer
  // the grandparent (series) guid so imported episodes key on the same show
  // identity every other ingestion path and outbound client resolves.
  const ids = parsePlexMediaIds(item, item.type);
  const media = {
    title: item.title,
    type: item.type,
    season: item.parentIndex != null ? Number(item.parentIndex) : null,
    episode: item.index != null ? Number(item.index) : null,
    imdb: ids.imdb || null,
    tmdb: ids.tmdb || null,
    tvdb: ids.tvdb || null,
    source: "plex",
    timestamp: watchedAt || releaseDate
      ? new Date(watchedAt || releaseDate)
      : null,
    timestampInferredFromRelease: Boolean(!watchedAt && releaseDate),
  };
  if (item.type === "episode") {
    media.title = `${item.grandparentTitle} - S${String(media.season ?? "?").padStart(2, "0")}E${String(media.episode ?? "?").padStart(2, "0")}`;
    media.episodeTitle = item.title;
  }
  return media;
}

export function mapEmbyLikeWatchedItem(item = {}, source = "emby") {
  const ids = normalizeProviderIds(
    item.Type === "Episode"
      ? { ...(item.ProviderIds || {}), ...(item.SeriesProviderIds || {}) }
      : (item.ProviderIds || {}),
  );
  const { watchedAt } = watchedAtForEmbyLikeItem(item);
  const releaseDate = watchedAt ? "" : releaseDateForItem(item);
  return {
    title:
      item.Type === "Episode"
        ? `${item.SeriesName} - S${String(item.ParentIndexNumber ?? "?").padStart(2, "0")}E${String(item.IndexNumber ?? "?").padStart(2, "0")}`
        : item.Name,
    type: item.Type === "Episode" ? "episode" : "movie",
    season: item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null,
    episode: item.IndexNumber != null ? Number(item.IndexNumber) : null,
    imdb: ids.imdb || null,
    tmdb: ids.tmdb || null,
    tvdb: ids.tvdb || null,
    episodeTitle: item.Type === "Episode" ? item.Name : null,
    // The ids above are usually the episode's own; this lets an importer
    // resolve the series ids before storing (decision 15).
    seriesItemId: item.Type === "Episode" ? item.SeriesId || null : null,
    source,
    timestamp: watchedAt || releaseDate ? new Date(watchedAt || releaseDate) : null,
    timestampInferredFromRelease: Boolean(!watchedAt && releaseDate),
  };
}

// ---------------------------------------------------------------------------
// Server enablement
// ---------------------------------------------------------------------------

export function configuredSyncServers(config = {}) {
  const servers = [];
  if (!config.plex?.disabled && Boolean(config.plex?.baseUrl && config.plex?.token)) servers.push("plex");
  if (!config.emby?.disabled && Boolean(config.emby?.baseUrl && config.emby?.apiKey && config.emby?.userId)) servers.push("emby");
  if (!config.jellyfin?.disabled && Boolean(config.jellyfin?.baseUrl && config.jellyfin?.apiKey && config.jellyfin?.userId)) servers.push("jellyfin");
  return servers;
}

// ---------------------------------------------------------------------------
// Collection (read-only outbound traffic)
// ---------------------------------------------------------------------------

const DEFAULT_CLIENTS = {
  fetchPlexWatchedItems,
  fetchEmbyWatchedItems,
  fetchJellyfinWatchedItems,
  listPlexLibraries,
  listEmbyLibraries,
  listJellyfinLibraries,
  countPlexWatchedItems,
  countEmbyWatchedItems,
  countJellyfinWatchedItems,
};

async function verifyScopedLibraries(server, config, scope, clients, logger) {
  const requested = scope.libraries.filter((lib) => lib.server === server);
  if (!requested.length) return { ok: true, missing: [] };
  const listFn = {
    plex: clients.listPlexLibraries,
    emby: clients.listEmbyLibraries,
    jellyfin: clients.listJellyfinLibraries,
  }[server];
  const available = await listFn(config[server]);
  const availableIds = new Set(available.map((lib) => String(lib.id)));
  const missing = requested.filter((lib) => !availableIds.has(lib.id));
  if (missing.length) {
    logger(
      `Force Sync scope ERROR: ${server} is missing scoped librar${missing.length === 1 ? "y" : "ies"} ` +
        `${missing.map((lib) => lib.name || lib.id).join(", ")}. Skipping ${server} (scope fails closed).`,
    );
    return { ok: false, missing: missing.map((lib) => lib.id) };
  }
  return { ok: true, missing: [] };
}

function fingerprintFor(items = []) {
  let maxWatchedAt = 0;
  for (const media of items) {
    const time = media.timestamp ? new Date(media.timestamp).getTime() : 0;
    if (time > maxWatchedAt) maxWatchedAt = time;
  }
  return { maxWatchedAt };
}

// Inspects each configured, in-scope server and returns the mapped watched
// items plus per-server fingerprints for later staleness checks. Read-only.
export async function collectServerWatchedItems(config, { scope: rawScope, logger = () => {}, clients: clientOverrides } = {}) {
  const scope = normalizeScope(rawScope);
  const clients = { ...DEFAULT_CLIENTS, ...(clientOverrides || {}) };
  const configuredServers = configuredSyncServers(config);
  const itemsByServer = { plex: [], emby: [], jellyfin: [] };
  const fingerprints = {};
  const scopeErrors = [];
  const scannedServers = [];

  const tasks = configuredServers
    .filter((server) => serverInScope(scope, server))
    .map(async (server) => {
      const verified = await verifyScopedLibraries(server, config, scope, clients, logger).catch((error) => {
        logger(`Force Sync scope ERROR: could not verify ${server} libraries: ${error.message}. Skipping ${server} (scope fails closed).`);
        return { ok: false, missing: [], error: error.message };
      });
      if (!verified.ok) {
        scopeErrors.push({ server, missing: verified.missing, error: verified.error || "" });
        return;
      }

      const libraryIds = scopedLibraryIds(scope, server);
      try {
        let rawItems = [];
        let mapped = [];
        if (server === "plex") {
          logger("Plex: scanning library sections...");
          rawItems = await clients.fetchPlexWatchedItems(config.plex, { libraryIds });
          logger(`Plex: fetched ${rawItems.length} watched library items.`);
          mapped = rawItems.map((item) => mapPlexWatchedItem(item));
        } else {
          const label = server === "emby" ? "Emby" : "Jellyfin";
          logger(`${label}: querying played items...`);
          const fetchFn = server === "emby" ? clients.fetchEmbyWatchedItems : clients.fetchJellyfinWatchedItems;
          rawItems = await fetchFn(config[server], { libraryIds });
          logger(`${label}: fetched ${rawItems.length} played library items.`);
          mapped = rawItems.map((item) => mapEmbyLikeWatchedItem(item, server));
        }

        const scoped = mapped.filter((media) => {
          const rejection = remoteEpisodeImportError(media, { context: "library_scan" });
          if (rejection) {
            logger(`${server}: skipped malformed watched item ${media.title || "unknown"}: ${rejection.message}.`);
            return false;
          }
          return itemInScope(scope, media);
        });
        itemsByServer[server] = scoped;
        fingerprints[server] = { rawCount: rawItems.length, itemCount: scoped.length, ...fingerprintFor(mapped) };
        scannedServers.push(server);
      } catch (error) {
        const label = server.charAt(0).toUpperCase() + server.slice(1);
        logger(`${label} ERROR: failed to fetch watched items: ${error.message}`);
        itemsByServer[server] = [];
        fingerprints[server] = { rawCount: 0, itemCount: 0, maxWatchedAt: 0, fetchError: error.message };
        // An unavailable server must never be treated as an empty library.
        // Keep it out of the executable target set and surface the failure in
        // the plan so confirmation can fail closed.
        scopeErrors.push({ server, missing: [], error: error.message });
      }
    });

  await Promise.all(tasks);
  scannedServers.sort((a, b) => SYNC_SERVERS.indexOf(a) - SYNC_SERVERS.indexOf(b));
  return { scope, itemsByServer, fingerprints, scopeErrors, scannedServers, configuredServers };
}

// Cheap per-server watched-item counts, used to detect a stale plan before
// execution without repeating the full library scan.
export async function collectServerFingerprintCounts(config, { scope: rawScope, clients: clientOverrides, onError = () => {} } = {}) {
  const scope = normalizeScope(rawScope);
  const clients = { ...DEFAULT_CLIENTS, ...(clientOverrides || {}) };
  const counts = {};
  const servers = configuredSyncServers(config).filter((server) => serverInScope(scope, server));
  await Promise.all(
    servers.map(async (server) => {
      const libraryIds = scopedLibraryIds(scope, server);
      const countFn = {
        plex: clients.countPlexWatchedItems,
        emby: clients.countEmbyWatchedItems,
        jellyfin: clients.countJellyfinWatchedItems,
      }[server];
      try {
        const count = await countFn(config[server], { libraryIds });
        if (!Number.isFinite(Number(count)) || Number(count) < 0) throw new Error("server returned an invalid watched-item count");
        counts[server] = Number(count);
      } catch (error) {
        counts[server] = null; // unknown - execution treats this as a failed verification
        onError(server, error);
      }
    }),
  );
  return counts;
}

// ---------------------------------------------------------------------------
// Grouping and matching (identical logic to the pre-planner runForceSync)
// ---------------------------------------------------------------------------

export function findLooseMatch(media, groups) {
  for (const group of groups) {
    if (media.type !== group.type) continue;
    if (media.imdb && group.imdb && media.imdb === group.imdb) return group;
    if (media.tmdb && group.tmdb && media.tmdb === group.tmdb) return group;
    if (media.tvdb && group.tvdb && media.tvdb === group.tvdb) return group;

    const cleanTitle = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (media.type === "episode") {
      const getShowName = (t) => t.split(" - ")[0].trim();
      const mediaShow = getShowName(media.title);
      const groupShow = getShowName(group.title);
      if (
        cleanTitle(mediaShow) === cleanTitle(groupShow) &&
        Number(media.season) === Number(group.season) &&
        Number(media.episode) === Number(group.episode)
      ) {
        return group;
      }
    } else if (cleanTitle(media.title) === cleanTitle(group.title)) {
      return group;
    }
  }
  return null;
}

export function groupWatchedItems(allWatchedItems = []) {
  const groups = [];
  for (const media of allWatchedItems) {
    const group = findLooseMatch(media, groups);
    if (group) {
      group.watchedOn.add(media.source);
      if (media.timestamp && (!group.timestamp || media.timestamp > group.timestamp)) {
        group.timestamp = media.timestamp;
      }
      if (!group.imdb && media.imdb) group.imdb = media.imdb;
      if (!group.tmdb && media.tmdb) group.tmdb = media.tmdb;
      if (!group.tvdb && media.tvdb) group.tvdb = media.tvdb;
      if (!group.episodeTitle && media.episodeTitle) group.episodeTitle = media.episodeTitle;
    } else {
      groups.push({
        title: media.title,
        type: media.type,
        season: media.season,
        episode: media.episode,
        imdb: media.imdb,
        tmdb: media.tmdb,
        tvdb: media.tvdb,
        timestamp: media.timestamp,
        episodeTitle: media.episodeTitle || null,
        watchedOn: new Set([media.source]),
      });
    }
  }
  return groups;
}

function matchBasisFor(media = {}) {
  const ids = media.ids || {};
  return ids.imdb || ids.tmdb || ids.tvdb ? "provider-id" : "title";
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

// Builds the full action list from collected server items + history rows.
// Pure: no I/O, no writes. `historyRows` are raw rows from getCachedHistory().
// The server item a write lands on: the target plus the title and, for an
// episode, its season and episode. Provider ids are left out on purpose, since
// the clash below comes from one item held under two different id sets.
function writeCoordinate(action = {}) {
  const media = action.media || {};
  if (!action.target) return "";
  if (media.type === "episode") {
    const title = canonicalTitleKey(showTitleFrom(media.title));
    if (!title || media.season == null || media.episode == null) return "";
    return `${action.target}|episode|${title}|${media.season}|${media.episode}`;
  }
  const title = canonicalTitleKey(media.title);
  return title ? `${action.target}|${media.type || "movie"}|${title}` : "";
}

// Two Plekt identities for one server item (an episode stored under its own ids
// and under its series ids) can ask one target to mark it played and unplayed in
// the same plan. The executor runs actions concurrently, so whichever request
// landed last would decide (Emby item 1787031 was unplayed then played 1 ms
// apart). Neither write is evidence enough, so both are dropped and the item is
// listed as skipped for the identity split to be fixed.
// Movies are matched by provider id, so two same-titled movies with a differing
// IMDb/TMDB/TVDB id are different films (Moana 2016 and 2026), not one split
// item. Only ids that cannot tell them apart (one side lacks the kind) clash.
// Episodes keep the title/season/episode match: a split episode's two
// identities carry unrelated ids by definition.
function movieIdsCompatible(a = {}, b = {}) {
  return ["imdb", "tmdb", "tvdb"].every((kind) => !a[kind] || !b[kind] || String(a[kind]) === String(b[kind]));
}

export function dropOpposingWrites(actions = [], skipped = []) {
  const writesByCoordinate = new Map();
  for (const action of actions) {
    if (action.kind !== "mark_played" && action.kind !== "mark_unplayed") continue;
    const coordinate = writeCoordinate(action);
    if (!coordinate) continue;
    if (!writesByCoordinate.has(coordinate)) writesByCoordinate.set(coordinate, []);
    writesByCoordinate.get(coordinate).push(action);
  }
  const clashingActions = new Set();
  for (const writes of writesByCoordinate.values()) {
    const played = writes.filter((action) => action.kind === "mark_played");
    const unplayed = writes.filter((action) => action.kind === "mark_unplayed");
    for (const p of played) {
      for (const u of unplayed) {
        if (p.media?.type === "episode" || movieIdsCompatible(p.media?.ids, u.media?.ids)) {
          clashingActions.add(p);
          clashingActions.add(u);
        }
      }
    }
  }
  if (!clashingActions.size) return actions;
  const reported = new Set();
  return actions.filter((action) => {
    if (!clashingActions.has(action)) return true;
    const coordinate = writeCoordinate(action);
    if (!reported.has(coordinate)) {
      reported.add(coordinate);
      skipped.push({
        mediaKey: action.mediaKey,
        title: action.media?.title,
        target: action.target,
        reason: `Plekt holds this item as both watched and unwatched under different identities, so ${action.target} was not asked to mark it played or unplayed. Fix the duplicate match, then run Force Sync again.`,
      });
    }
    return false;
  });
}

export function buildForceSyncPlan({
  itemsByServer = {},
  historyRows = [],
  scope: rawScope,
  config = {},
  scannedServers = [],
  fingerprints = {},
  scopeErrors = [],
  now = Date.now(),
} = {}) {
  const scope = normalizeScope(rawScope);
  // Force Sync is a canonical replay from Plembfin. Connected servers are
  // inspected only to find destinations that are out of date; they never win
  // a conflict or create/delete Plembfin history here.
  const authority = { conflictPolicy: "plembfin", server: "" };

  // Which servers may receive each state type (per-server direction, M4).
  const writeTargetsFor = (stateType) => scannedServers.filter((server) => canReceiveState(config, server, stateType));

  const allWatchedItems = SYNC_SERVERS.flatMap((server) => itemsByServer[server] || []);
  const groups = groupWatchedItems(allWatchedItems);

  const watchedMap = new Map();
  for (const group of groups) {
    const mediaObj = {
      title: group.title,
      type: group.type,
      season: group.season,
      episode: group.episode,
      ids: {
        imdb: group.imdb || undefined,
        tmdb: group.tmdb || undefined,
        tvdb: group.tvdb || undefined,
      },
      episodeTitle: group.episodeTitle || undefined,
    };
    const key = mediaKeyFor(mediaObj);
    watchedMap.set(key, { media: mediaObj, group });
  }

  const rowById = new Map();
  const historyMap = new Map();
  let scopedHistoryRowCount = 0;
  for (const row of historyRows) {
    if (!historyRowInScope(scope, row)) continue;
    scopedHistoryRowCount += 1;
    rowById.set(row.id, row);
    const mKey = row.media_key;
    if (!historyMap.has(mKey)) historyMap.set(mKey, []);
    historyMap.get(mKey).push({
      id: row.id,
      syncAction: row.sync_action || "watched",
      watchedAt: row.watched_at || new Date(now).toISOString(),
    });
  }
  for (const records of historyMap.values()) {
    records.sort((a, b) => new Date(b.watchedAt) - new Date(a.watchedAt));
  }

  const allConsideredKeys = new Set(historyMap.keys());
  const actions = [];
  const skipped = [];
  let seq = 0;

  const pushAction = (action) => {
    seq += 1;
    actions.push({ seq, ...action });
  };

  for (const [key, entry] of watchedMap.entries()) {
    if (historyMap.has(key)) continue;
    skipped.push({
      mediaKey: key,
      title: entry.media.title,
      reason: "Watched on a server but absent from Plekt history; the server-only state was not imported because Plekt is canonical.",
    });
  }

  for (const key of allConsideredKeys) {
    const serverWatchedEntry = watchedMap.get(key);
    const historyRecords = historyMap.get(key) || [];
    const lastHistoryRecord = historyRecords[0];

    // No local history row at all means Plembfin never recorded a decision
    // for this item - not that it was explicitly marked unwatched. Treating
    // an absent row as canonical-unwatched would generate a destructive
    // mark_unplayed action against a server that genuinely has it watched
    // (e.g. after a history row is deleted by the phantom-watch repair
    // tool). Only an explicit unwatched record is canonical.
    let newestState = null;
    let newestTime = 0;
    let decidedBy = { policy: "plembfin", evidence: "no history" };

    if (lastHistoryRecord) {
      newestState = lastHistoryRecord.syncAction === "unwatched" ? "unwatched" : "watched";
      newestTime = new Date(lastHistoryRecord.watchedAt).getTime();
      decidedBy = { policy: "plembfin", evidence: "Plekt history", timestamp: newestTime };
    }

    let serverWatchedOn = new Set();
    let mediaObj = serverWatchedEntry ? serverWatchedEntry.media : null;

    if (serverWatchedEntry) {
      serverWatchedOn = serverWatchedEntry.group.watchedOn;
    }

    if (!mediaObj && lastHistoryRecord) {
      const docData = rowById.get(lastHistoryRecord.id) || {};
      mediaObj = {
        title: docData.title,
        type: docData.media_type,
        season: docData.season != null ? Number(docData.season) : null,
        episode: docData.episode != null ? Number(docData.episode) : null,
        ids: {
          imdb: docData.imdb_id || undefined,
          tmdb: docData.tmdb_id || undefined,
          tvdb: docData.tvdb_id || undefined,
        },
      };
    }

    if (!mediaObj) continue;

    const matchBasis = matchBasisFor(mediaObj);
    const base = { mediaKey: key, media: mediaObj, matchBasis, decidedBy };

    if (newestState === "watched") {
      if (lastHistoryRecord && lastHistoryRecord.syncAction === "unwatched") {
        const unwatchedIds = historyRecords.filter((r) => r.syncAction === "unwatched").map((r) => r.id);
        pushAction({
          ...base,
          kind: "remove_unwatched_marker",
          risk: "additive",
          historyRowIds: unwatchedIds,
          reason: "A newer watched state supersedes the stored unwatched marker.",
        });
      }

      for (const target of writeTargetsFor("watched")) {
        if (!serverWatchedOn.has(target)) {
          pushAction({
            ...base,
            kind: "mark_played",
            target,
            risk: "additive",
            reason: `Watched in Plekt;${target} does not have it marked played.`,
          });
        }
      }
    } else if (newestState === "unwatched") {
      // Plembfin's unwatched marker is already canonical. Never delete or
      // recreate local history because a remote server reports played.

      for (const target of writeTargetsFor("unwatched")) {
        if (serverWatchedOn.has(target)) {
          pushAction({
            ...base,
            kind: "mark_unplayed",
            target,
            risk: "destructive",
            reason: `Unwatched in Plekt;${target} still has it marked played.`,
          });
        }
      }
    } else {
      skipped.push({
        mediaKey: key,
        title: mediaObj.title,
        reason: "A server shows this watched but Plekt has no history record for it, so its unwatched/watched state cannot be determined safely.",
      });
    }
  }

  const conflictFreeActions = dropOpposingWrites(actions, skipped);
  const summary = summarizePlan({
    actions: conflictFreeActions,
    skipped,
    scope,
    scannedServers,
    scopeErrors,
    totalWatchedFoundAcrossServers: watchedMap.size,
    consideredKeys: allConsideredKeys.size,
    historyRowCount: scopedHistoryRowCount,
    authority,
  });

  return {
    createdAt: now,
    scope,
    scannedServers,
    fingerprints,
    scopeErrors,
    configRevision: syncRolesRevision(config),
    actions: conflictFreeActions,
    skipped,
    summary,
  };
}

export function summarizePlan(input = {}) {
  const {
    actions = [],
    skipped = [],
    scope: rawScope,
    scannedServers = [],
    scopeErrors = [],
    totalWatchedFoundAcrossServers = 0,
    consideredKeys = 0,
    historyRowCount = 0,
    authority = { conflictPolicy: "plembfin", server: "" },
  } = Array.isArray(input) ? { actions: input } : input;
  const scope = normalizeScope(rawScope);
  const byKind = {};
  const byTarget = {};
  let destructive = 0;
  let additive = 0;
  let uncertainMatches = 0;
  let outboundWrites = 0;
  const uncertainKeys = new Set();

  for (const action of actions) {
    byKind[action.kind] = (byKind[action.kind] || 0) + 1;
    if (action.target) {
      byTarget[action.target] = byTarget[action.target] || { additive: 0, destructive: 0 };
      byTarget[action.target][action.risk] += 1;
      outboundWrites += 1;
    }
    if (action.risk === "destructive") destructive += 1;
    else additive += 1;
    if (action.matchBasis === "title" && !uncertainKeys.has(action.mediaKey)) {
      uncertainKeys.add(action.mediaKey);
      uncertainMatches += 1;
    }
  }

  const overLimit = scope.maxChanges > 0 && actions.length > scope.maxChanges;
  const requiresStrongConfirmation =
    destructive >= DESTRUCTIVE_CONFIRM_COUNT ||
    (historyRowCount > 0 && destructive >= Math.ceil(historyRowCount * DESTRUCTIVE_CONFIRM_HISTORY_FRACTION));

  return {
    totalActions: actions.length,
    byKind,
    byTarget,
    additive,
    destructive,
    uncertainMatches,
    skippedCount: skipped.length,
    outboundWrites,
    totalWatchedFoundAcrossServers,
    consideredKeys,
    historyRowCount,
    scannedServers,
    scopeErrors,
    scopeDescription: describeScope(scope),
    scopeIsDefault: scopeIsDefault(scope),
    maxChanges: scope.maxChanges,
    overLimit,
    snapshotRequired: destructive > 0,
    requiresStrongConfirmation,
    conflictPolicy: authority.conflictPolicy,
    authoritativeServer: authority.server || "",
  };
}

// Compares a stored plan against fresh cheap counts + config revision.
// Returns { stale: boolean, reasons: [] }.
export function planStaleness(plan, { counts = {}, config = {}, now = Date.now() } = {}) {
  const reasons = [];
  if (!plan) return { stale: true, reasons: ["Plan not found."] };
  if (now - Number(plan.createdAt || 0) > PLAN_TTL_MS) {
    reasons.push(`Plan is older than ${Math.round(PLAN_TTL_MS / 60000)} minutes.`);
  }
  const currentRevision = syncRolesRevision(config);
  if (plan.configRevision && plan.configRevision !== currentRevision) {
    reasons.push("Server connection or sync-role settings changed after the plan was created.");
  }
  for (const [server, fingerprint] of Object.entries(plan.fingerprints || {})) {
    const fresh = counts[server];
    if (fresh === null || fresh === undefined) continue; // could not verify - TTL still applies
    if (Number(fresh) !== Number(fingerprint.rawCount)) {
      reasons.push(`${server} watched-item count changed (${fingerprint.rawCount} → ${fresh}).`);
    }
  }
  return { stale: reasons.length > 0, reasons };
}
