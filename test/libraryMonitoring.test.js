import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-libmon-test-"));
process.env.DATA_DIR = tempDir;

const {
  attachProviderLibraryMonitoring,
  buildLibrarySkipDiagnostic,
  clearServerIdentityCache,
  discoverProviderLibraries,
  filterAuthorizedTargetItems,
  getProviderLibrarySelection,
  getUnselectedConnectedProviders,
  invalidateLibraryMembershipCache,
  isNonVideoMediaType,
  normalizeLibraryMonitoringSection,
  resolveItemLibraryMembership,
  validateLibrarySelectionSave,
} = await import("../server/src/utils/librarySelection.js");
const { parseEmbyWebhook, parseJellyfinWebhook, parsePlexWebhook } = await import("../server/src/utils/parsers.js");
globalThis.history = globalThis.history || { state: {} };
globalThis.window = globalThis.window || globalThis;
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = globalThis.document || { querySelector: () => null, dispatchEvent() {} };
const { formatLibraryDisambiguator, formatLibraryTypeLabel, formatUnselectedBannerCopy } = await import("../public/modules/library-monitoring.js");

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows SQLite lock until exit */ }
});

test("empty or missing libraryMonitoring monitors nothing and flags connected servers for the app-wide banner", async () => {
  const config = attachProviderLibraryMonitoring({
    plex: { baseUrl: "http://plex.local:32400", token: "tok", disabled: false, serverId: "plex-srv-1" },
    emby: { baseUrl: "http://emby.local:8096", apiKey: "ekey", userId: "u1", disabled: false, serverId: "emby-srv-1" },
    jellyfin: { baseUrl: "", apiKey: "", userId: "", disabled: true },
  });

  const plexSel = getProviderLibrarySelection(config, "plex");
  assert.equal(plexSel.hasSelectedLibraries, false);
  assert.deepEqual(plexSel.selectedIds, []);
  assert.equal(plexSel.reason, "not_configured");

  const unselected = getUnselectedConnectedProviders(config);
  assert.deepEqual(unselected.map((item) => item.provider), ["plex", "emby"]);
  assert.match(formatUnselectedBannerCopy(unselected), /Plex and Emby/);

  let apiCalls = 0;
  const decision = await resolveItemLibraryMembership("plex", config, { ratingKey: "100", librarySectionID: "1" }, {
    fetchPlexMetadata: async () => { apiCalls += 1; return { librarySectionID: "1" }; },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, "not_configured");
  assert.equal(apiCalls, 0);
});

test("non-video media types (Audio/Photo) drop before any external Ancestors or metadata call", async () => {
  assert.equal(isNonVideoMediaType("Audio"), true);
  assert.equal(isNonVideoMediaType("Photo"), true);
  assert.equal(isNonVideoMediaType("Movie"), false);
  assert.equal(isNonVideoMediaType("Episode"), false);

  const config = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.local:8096", apiKey: "k", userId: "u1", serverId: "emby-1" },
    libraryMonitoring: {
      emby: { serverId: "emby-1", revision: 1, selectedIds: ["lib-movies"] },
    },
  });

  let ancestorCalls = 0;
  const audioDecision = await resolveItemLibraryMembership("emby", config, { Id: "audio-1", Type: "Audio" }, {
    fetchAncestors: async () => { ancestorCalls += 1; return []; },
  });
  const photoDecision = await resolveItemLibraryMembership("emby", config, { Id: "photo-1", MediaType: "Photo" }, {
    fetchAncestors: async () => { ancestorCalls += 1; return []; },
  });
  assert.equal(audioDecision.allowed, false);
  assert.equal(audioDecision.status, "non_video");
  assert.equal(audioDecision.evidenceOrigin, "non_video_drop");
  assert.equal(photoDecision.allowed, false);
  assert.equal(photoDecision.status, "non_video");
  assert.equal(ancestorCalls, 0);
});

test("Emby/Jellyfin root membership resolves via Ancestors (never episode ParentId), caches negative hits per revision, and invalidates on selection change", async () => {
  invalidateLibraryMembershipCache();
  const configRev1 = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.local:8096", apiKey: "k", userId: "u1", serverId: "emby-1" },
    libraryMonitoring: {
      emby: { serverId: "emby-1", revision: 1, selectedIds: ["lib-tv"] },
    },
  });

  let ancestorCalls = 0;
  const fetchAncestors = async (_provider, _cfg, itemId) => {
    ancestorCalls += 1;
    if (itemId === "ep-home") {
      // Episode ParentId is season-1; true root is homevideos library lib-home.
      return [
        { Id: "season-1", Type: "Season", Name: "Season 1" },
        { Id: "series-1", Type: "Series", Name: "Family Trips" },
        { Id: "lib-home", Type: "CollectionFolder", CollectionType: "homevideos", Name: "Home Videos" },
        { Id: "root", Type: "AggregateFolder", Name: "Media Folders" },
      ];
    }
    if (itemId === "ep-overlap") {
      return [
        { Id: "lib-tv", Type: "CollectionFolder", CollectionType: "tvshows", Name: "TV" },
        { Id: "lib-home", Type: "CollectionFolder", CollectionType: "homevideos", Name: "Home Videos" },
      ];
    }
    return [
      { Id: "season-9", Type: "Season", Name: "Season 1" },
      { Id: "lib-tv", Type: "CollectionFolder", CollectionType: "tvshows", Name: "TV Shows" },
      { Id: "root", Type: "AggregateFolder", Name: "Media Folders" },
    ];
  };

  // Repeated playback progress pings on an unselected library only hit Ancestors once!
  const first = await resolveItemLibraryMembership("emby", configRev1, { Id: "ep-home", ParentId: "lib-tv", Type: "Episode" }, { fetchAncestors });
  const second = await resolveItemLibraryMembership("emby", configRev1, { Id: "ep-home", ParentId: "lib-tv", Type: "Episode" }, { fetchAncestors });
  assert.equal(first.allowed, false);
  assert.equal(first.status, "unselected");
  assert.equal(second.allowed, false);
  assert.equal(second.cached, true);
  assert.equal(ancestorCalls, 1);

  // Overlapping selected + unselected roots fail closed as ambiguous.
  const ambiguous = await resolveItemLibraryMembership("emby", configRev1, { Id: "ep-overlap", Type: "Episode" }, { fetchAncestors });
  assert.equal(ambiguous.allowed, false);
  assert.equal(ambiguous.status, "ambiguous");

  // Selection revision bump immediately re-evaluates and allows newly selected library.
  const configRev2 = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.local:8096", apiKey: "k", userId: "u1", serverId: "emby-1" },
    libraryMonitoring: {
      emby: { serverId: "emby-1", revision: 2, selectedIds: ["lib-tv", "lib-home"] },
    },
  });
  const afterEnable = await resolveItemLibraryMembership("emby", configRev2, { Id: "ep-home", Type: "Episode" }, { fetchAncestors });
  assert.equal(afterEnable.allowed, true);
  assert.equal(afterEnable.status, "selected");
  assert.equal(afterEnable.libraryId, "lib-home");
});

test("plugin libraryContext fast-path verifies server identity, rejects forged serverId, and falls back to Ancestors when unresolved", async () => {
  invalidateLibraryMembershipCache();
  const config = attachProviderLibraryMonitoring({
    jellyfin: { baseUrl: "http://jf.local:8096", apiKey: "jkey", userId: "u1", serverId: "jf-server-1" },
    libraryMonitoring: {
      jellyfin: { serverId: "jf-server-1", revision: 3, selectedIds: ["jf-movies"] },
    },
  });

  let apiCalls = 0;
  const fetchAncestors = async () => {
    apiCalls += 1;
    return [{ Id: "jf-movies", Type: "CollectionFolder", CollectionType: "movies", Name: "Movies" }];
  };

  // Valid verified plugin context hits fast path with zero Ancestors call.
  const fast = await resolveItemLibraryMembership("jellyfin", config, {
    Id: "movie-1",
    Type: "Movie",
    libraryContext: { version: 1, serverId: "jf-server-1", libraryId: "jf-movies", itemId: "movie-1", resolutionStatus: "resolved" },
  }, { fetchAncestors });
  assert.equal(fast.allowed, true);
  assert.equal(fast.evidenceOrigin, "plugin_context_verified");
  assert.equal(apiCalls, 0);

  // Forged cross-server context is rejected immediately.
  const forged = await resolveItemLibraryMembership("jellyfin", config, {
    Id: "movie-2",
    Type: "Movie",
    libraryContext: { version: 1, serverId: "other-server", libraryId: "jf-movies", itemId: "movie-2", resolutionStatus: "resolved" },
  }, { fetchAncestors });
  assert.equal(forged.allowed, false);
  assert.equal(forged.status, "server_mismatch");
  assert.equal(apiCalls, 0);

  // Unresolved plugin context falls back to Ancestors API.
  const fallback = await resolveItemLibraryMembership("jellyfin", config, {
    Id: "movie-3",
    Type: "Movie",
    libraryContext: { version: 1, serverId: "jf-server-1", resolutionStatus: "unresolved" },
  }, { fetchAncestors });
  assert.equal(fallback.allowed, true);
  assert.equal(fallback.evidenceOrigin, "jellyfin_ancestors_api");
  assert.equal(apiCalls, 1);
});

test("filterAuthorizedTargetItems permits writes only to selected native item IDs when duplicate media exists in multiple libraries", async () => {
  invalidateLibraryMembershipCache();
  const config = attachProviderLibraryMonitoring({
    plex: { baseUrl: "http://plex.local:32400", token: "tok", serverId: "plex-1" },
    libraryMonitoring: {
      plex: { serverId: "plex-1", revision: 1, selectedIds: ["1"] },
    },
  });

  const { allowed, blocked } = await filterAuthorizedTargetItems("plex", config, [
    { ratingKey: "1001", librarySectionID: "1", title: "Dune" },
    { ratingKey: "2002", librarySectionID: "9", title: "Dune" },
  ]);

  assert.deepEqual(allowed.map((i) => i.ratingKey), ["1001"]);
  assert.deepEqual(blocked.map((b) => b.item.ratingKey), ["2002"]);
  assert.equal(blocked[0].decision.status, "unselected");
});

test("validateLibrarySelectionSave rejects forged or inaccessible IDs and server identity mismatch", async () => {
  const mockDiscover = async () => ({
    provider: "plex",
    serverId: "plex-real",
    serverName: "Home Plex",
    libraries: [
      { id: "1", name: "Movies", type: "movie", collectionType: "movie", serverId: "plex-real" },
      { id: "2", name: "Personal Media", type: "movie", collectionType: "movie", isPersonalMedia: true, serverId: "plex-real" },
    ],
  });

  await assert.rejects(
    () => validateLibrarySelectionSave({
      provider: "plex",
      providerConfig: {},
      requestedIds: ["1", "forged-999"],
      discover: mockDiscover,
    }),
    (err) => err.code === "INVALID_LIBRARY_SELECTION" && err.status === 400,
  );

  await assert.rejects(
    () => validateLibrarySelectionSave({
      provider: "plex",
      providerConfig: {},
      requestedIds: ["1"],
      expectedServerId: "plex-other",
      discover: mockDiscover,
    }),
    (err) => err.code === "LIBRARY_SERVER_MISMATCH" && err.status === 409,
  );

  const saved = await validateLibrarySelectionSave({
    provider: "plex",
    providerConfig: {},
    requestedIds: ["1"],
    currentMonitoring: { revision: 2 },
    expectedServerId: "plex-real",
    discover: mockDiscover,
  });
  assert.equal(saved.selection.revision, 3);
  assert.deepEqual(saved.selection.selectedIds, ["1"]);
  assert.equal(saved.selection.serverId, "plex-real");
});

test("server identity mismatch blocks monitoring until re-selected", () => {
  const config = attachProviderLibraryMonitoring({
    plex: { baseUrl: "http://plex.local:32400", token: "tok", serverId: "plex-new-server" },
    libraryMonitoring: {
      plex: { serverId: "plex-old-server", revision: 4, selectedIds: ["1"] },
    },
  });
  const sel = getProviderLibrarySelection(config, "plex");
  assert.equal(sel.serverMismatch, true);
  assert.equal(sel.hasSelectedLibraries, false);
  assert.deepEqual(sel.selectedIds, []);
  assert.equal(sel.reason, "server_mismatch");
  assert.match(buildLibrarySkipDiagnostic("plex", { status: "server_mismatch" }, "Arrival"), /identity changed/i);
});

test("webhook parsers preserve Plex librarySectionId/serverId and Emby/Jellyfin libraryContext", async () => {
  const formData = new Map([
    ["payload", JSON.stringify({
      event: "media.scrobble",
      Account: { title: "admin" },
      Server: { uuid: "plex-srv-1" },
      Metadata: { type: "movie", title: "Arrival", ratingKey: "55", librarySectionID: "7", Guid: [{ id: "tmdb://329865" }] },
    })],
  ]);
  const plexParsed = await parsePlexWebhook(formData);
  assert.equal(plexParsed.librarySectionId, "7");
  assert.equal(plexParsed.serverId, "plex-srv-1");
  assert.equal(plexParsed.rawType, "movie");

  const embyParsed = parseEmbyWebhook({
    Event: "playback.stop",
    Server: { Id: "emby-srv-1" },
    User: { Id: "u1" },
    Item: { Id: "42", Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } },
    PlaybackInfo: { PlayedToCompletion: true },
    LibraryContext: { Version: 1, ServerId: "emby-srv-1", LibraryId: "lib-1", ResolutionStatus: "resolved" },
  });
  assert.equal(embyParsed.serverId, "emby-srv-1");
  assert.equal(embyParsed.libraryContext?.libraryId, "lib-1");
  assert.equal(embyParsed.libraryContext?.resolutionStatus, "resolved");

  const jfParsed = parseJellyfinWebhook({
    NotificationType: "PlaybackStop",
    ServerId: "jf-srv-1",
    UserId: "u1",
    PlayedToCompletion: true,
    Item: { Id: "99", Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } },
    LibraryContext: { Version: 1, ServerId: "jf-srv-1", LibraryId: "jf-lib-1", ResolutionStatus: "resolved" },
  });
  assert.equal(jfParsed.serverId, "jf-srv-1");
  assert.equal(jfParsed.libraryContext?.libraryId, "jf-lib-1");
});

test("UI library label helpers distinguish Personal Media and duplicate names without paths", () => {
  assert.equal(formatLibraryTypeLabel({ type: "movie", isPersonalMedia: true }), "Movies · Personal Media");
  assert.equal(formatLibraryTypeLabel({ type: "homevideos" }), "Home Videos");
  assert.equal(formatLibraryTypeLabel({ type: "mixed" }), "Mixed");
  assert.equal(formatLibraryDisambiguator({ id: "section-123456789", type: "movie", duplicateName: true }), "Movies · ID section-");
  assert.equal(normalizeLibraryMonitoringSection({}).plex.selectedIds.length, 0);
  clearServerIdentityCache();
  assert.equal(typeof discoverProviderLibraries, "function");
});

const { AUTH } = await import("../server/src/appConfig.js");
const { db } = await import("../server/src/db.js");
const { saveMediaConfig, saveProviderLibraryMonitoring } = await import("../server/src/utils/configStore.js");
const { handleLibraryMonitoring } = await import("../server/src/routes/libraryMonitoring.js");
const { handleWebhook } = await import("../server/src/routes/sync.js");
const { authorizeQueuedLibraryWatch } = await import("../server/src/utils/queuedLibraryMonitoring.js");
const { syncPendingManualDispatches } = await import("../server/src/utils/syncDispatchQueue.js");
const { insertWatchRecordSync } = await import("../server/src/utils/dataRepo.js");
const { loadMediaConfig } = await import("../server/src/utils/configStore.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { enqueueManualWatchReview } = await import("../server/src/utils/manualWatchReview.js");
const { handleManualWatchReview } = await import("../server/src/routes/manualWatchReview.js");
const { markEmbyPlayed } = await import("../server/src/utils/embyClient.js");

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; },
    send(payload) { this.body = JSON.parse(payload); return this; },
  };
}

function adminReq(method = "GET", body = null) {
  const headers = { "x-api-key": AUTH.apiKey, host: "localhost:3000", origin: "http://localhost:3000" };
  return {
    method,
    query: {},
    body,
    headers,
    cookies: {},
    ip: "127.0.0.1",
    get(name) { return headers[String(name).toLowerCase()] || ""; },
  };
}

test("handleLibraryMonitoring discovers, validates, saves, detects conflicts, and preserves selection on discovery error", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; clearServerIdentityCache(); });

  await saveMediaConfig({
    plex: { baseUrl: "http://plex-api.test:32400", token: "tok", disabled: false },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  });

  let discoveryBroken = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (discoveryBroken) return new Response("down", { status: 503 });
    if (url.pathname === "/identity") {
      return Response.json({ MediaContainer: { machineIdentifier: "plex-id-1", friendlyName: "Test Plex" } });
    }
    if (url.pathname === "/library/sections") {
      return Response.json({
        MediaContainer: {
          Directory: [
            { key: "1", uuid: "u-1", title: "Movies", type: "movie", agent: "tv.plex.agents.movie", scanner: "Plex Movie" },
            { key: "2", uuid: "u-2", title: "Personal Media", type: "movie", agent: "com.plexapp.agents.none", scanner: "Plex Video Files Scanner" },
            { key: "3", uuid: "u-3", title: "Music", type: "artist" },
          ],
        },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  // Initial status flags Plex as unselected connected provider.
  const statusRes = mockResponse();
  await handleLibraryMonitoring(adminReq("GET"), statusRes, "library-monitoring");
  assert.equal(statusRes.statusCode, 200);
  assert.deepEqual(statusRes.body.unselectedConnectedProviders.map((p) => p.provider), ["plex"]);

  // Live discovery includes Personal Media (movie type) and excludes Music (artist).
  const listRes = mockResponse();
  await handleLibraryMonitoring(adminReq("GET"), listRes, "library-monitoring/plex/libraries");
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(listRes.body.libraries.map((l) => l.id), ["1", "2"]);
  assert.equal(listRes.body.libraries[1].isPersonalMedia, true);

  // Forged library ID is rejected with 400.
  const forgedRes = mockResponse();
  await handleLibraryMonitoring(adminReq("PUT", { selectedIds: ["1", "999"], serverId: "plex-id-1" }), forgedRes, "library-monitoring/plex");
  assert.equal(forgedRes.statusCode, 400);
  assert.equal(forgedRes.body.code, "INVALID_LIBRARY_SELECTION");

  // Valid save succeeds, increments revision, and clears banner list.
  const saveRes = mockResponse();
  await handleLibraryMonitoring(adminReq("PUT", { selectedIds: ["1"], serverId: "plex-id-1", expectedRevision: 0 }), saveRes, "library-monitoring/plex");
  assert.equal(saveRes.statusCode, 200);
  assert.equal(saveRes.body.saved.revision, 1);
  assert.deepEqual(saveRes.body.libraryMonitoring.unselectedConnectedProviders, []);

  // Concurrent stale revision is rejected with 409.
  const conflictRes = mockResponse();
  await handleLibraryMonitoring(adminReq("PUT", { selectedIds: ["1", "2"], serverId: "plex-id-1", expectedRevision: 0 }), conflictRes, "library-monitoring/plex");
  assert.equal(conflictRes.statusCode, 409);
  assert.equal(conflictRes.body.code, "LIBRARY_SELECTION_CONFLICT");
  assert.throws(
    () => saveProviderLibraryMonitoring("plex", { serverId: "plex-id-1", selectedIds: ["2"] }, { expectedRevision: 0 }),
    { code: "LIBRARY_SELECTION_CONFLICT", currentRevision: 1 },
  );

  // Discovery failure returns 502 and preserves the saved selection.
  discoveryBroken = true;
  clearServerIdentityCache();
  const brokenRes = mockResponse();
  await handleLibraryMonitoring(adminReq("GET"), brokenRes, "library-monitoring/plex/libraries");
  assert.equal(brokenRes.statusCode, 502);
  assert.equal(brokenRes.body.error, "Internal server error");
  discoveryBroken = false;
  const recoveredRes = mockResponse();
  await handleLibraryMonitoring(adminReq("GET"), recoveredRes, "library-monitoring/plex/libraries");
  assert.equal(recoveredRes.statusCode, 200);
  assert.deepEqual(recoveredRes.body.selection.selectedIds, ["1"]);
});

test("handleWebhook and handleManualWatchReview enforce explicit library selection end-to-end", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await saveMediaConfig({
    plex: { baseUrl: "http://plex-e2e.test:32400", token: "tok", disabled: false },
    emby: { baseUrl: "http://emby-e2e.test:8096", apiKey: "ekey", userId: "u1", disabled: false },
    jellyfin: { disabled: true },
  });
  saveProviderLibraryMonitoring("plex", { serverId: "plex-e2e", selectedIds: ["1"] });
  saveProviderLibraryMonitoring("emby", { serverId: "emby-e2e", selectedIds: ["emby-movies"] });

  const historyBefore = db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n;
  const headers = { "content-type": "application/x-www-form-urlencoded", "x-plekt-webhook-secret": AUTH.webhookSecret };

  // Unselected Plex Personal Media library (section 2) is blocked with zero history writes.
  const blockedRes = mockResponse();
  await handleWebhook({
    method: "POST",
    query: {},
    headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
    body: Buffer.from(new URLSearchParams({
      payload: JSON.stringify({
        event: "media.scrobble",
        Account: { title: "admin" },
        Server: { uuid: "plex-e2e" },
        Metadata: { type: "movie", title: "Home Video", ratingKey: "hv-1", librarySectionID: "2", Guid: [{ id: "tmdb://555001" }] },
      }),
    }).toString()),
  }, blockedRes);
  assert.equal(blockedRes.statusCode, 200);
  assert.equal(blockedRes.body.skipped, true);
  assert.equal(blockedRes.body.libraryStatus, "unselected");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n, historyBefore);

  const personalRes = mockResponse();
  await handleWebhook({
    method: "POST",
    query: {},
    headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
    body: Buffer.from(new URLSearchParams({
      payload: JSON.stringify({
        event: "media.scrobble",
        Server: { uuid: "plex-e2e" },
        Metadata: { type: "movie", title: "Arrival", ratingKey: "personal-arrival", librarySectionID: "1", guid: "local://personal-arrival" },
      }),
    }).toString()),
  }, personalRes);
  assert.equal(personalRes.body.inserted, true);
  assert.equal(personalRes.body.propagated, false);
  const personal = db.prepare("SELECT * FROM watch_history WHERE source = 'plex_personal_media'").get();
  assert.equal(personal.title, "Arrival");
  assert.equal(personal.tmdb_id, null);
  assert.match(personal.media_key, /:plex-local:personal-arrival$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tracker_write_intents WHERE watch_record_id = ?").get(personal.id).n, 0);

  // Pre-existing review from unselected Plex library is blocked on approval with 409.
  const queuedUnselected = enqueueManualWatchReview({
    title: "Home Video",
    type: "movie",
    source: "plex",
    itemId: "hv-2",
    librarySectionId: "2",
    ids: { tmdb: "555002" },
    isValid: true,
  }, { sourceFingerprint: "plex|hv-2|1" });
  const reviewRes = mockResponse();
  await handleManualWatchReview(adminReq("POST", { mode: "now" }), reviewRes, `manual-watch-review/${queuedUnselected.review.id}/approve`);
  assert.equal(reviewRes.statusCode, 409);
  assert.equal(reviewRes.body.code, "LIBRARY_NOT_MONITORED");
  assert.equal(reviewRes.body.libraryStatus, "unselected");

  // Outbound write to Emby with duplicate items mutates ONLY the selected native ID.
  const writes = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) {
      return Response.json({
        Items: [
          { Id: "dup-selected", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" } },
          { Id: "dup-unselected", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" } },
        ],
      });
    }
    if (url.pathname === "/Items/dup-selected/Ancestors") {
      return Response.json([{ Id: "emby-movies", Type: "CollectionFolder", CollectionType: "movies" }]);
    }
    if (url.pathname === "/Items/dup-unselected/Ancestors") {
      return Response.json([{ Id: "emby-homevideos", Type: "CollectionFolder", CollectionType: "homevideos" }]);
    }
    if (url.pathname.startsWith("/Users/u1/PlayedItems/") && options.method === "POST") {
      writes.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected Emby URL: ${url}`);
  };

  const embyConfig = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby-e2e.test:8096", apiKey: "ekey", userId: "u1", serverId: "emby-e2e" },
    libraryMonitoring: { emby: { serverId: "emby-e2e", revision: 1, selectedIds: ["emby-movies"] } },
  }).emby;
  const writeResult = await markEmbyPlayed(embyConfig, {
    type: "movie",
    title: "Dune",
    ids: { tmdb: "438631" },
    watched_at: "2026-10-01T20:00:00.000Z",
  });
  assert.equal(writeResult.status, "fulfilled");
  assert.deepEqual(writes, ["/Users/u1/PlayedItems/dup-selected"]);

  const queuedWatch = { source: "emby", type: "movie", watchProvenance: { item_id: "dup-selected" } };
  const isLibraryCurrent = await authorizeQueuedLibraryWatch(queuedWatch);
  assert.equal(isLibraryCurrent(), true);
  saveProviderLibraryMonitoring("emby", { serverId: "emby-e2e", selectedIds: [] });
  assert.equal(isLibraryCurrent(), false);
  assert.equal(await authorizeQueuedLibraryWatch(queuedWatch), null);
  assert.equal((await authorizeQueuedLibraryWatch({ source: "manual", type: "movie" }))(), true);
  const held = insertWatchRecordSync({
    title: "Queued from deselected library",
    media_type: "movie",
    source: "emby",
    watch_provenance: queuedWatch.watchProvenance,
    sync_dispatch_telemetry: "Dispatch status: pending",
  });
  const before = Date.now();
  assert.equal(await syncPendingManualDispatches(await loadMediaConfig(), createLoopStore(), () => {}), 0);
  const retry = db.prepare("SELECT sync_retry_count, sync_next_retry_at FROM watch_history WHERE id = ?").get(held.id);
  assert.equal(retry.sync_retry_count, 0);
  assert.ok(retry.sync_next_retry_at > before);
  assert.deepEqual(writes, ["/Users/u1/PlayedItems/dup-selected"]);
});

test("Step 2c: malformed, forged, contradictory, ambiguous, and unrelated-item plugin LibraryContext never bypasses API verification", async () => {
  invalidateLibraryMembershipCache();
  const config = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.local:8096", apiKey: "ekey", userId: "u1", serverId: "emby-real" },
    libraryMonitoring: {
      emby: { serverId: "emby-real", revision: 5, selectedIds: ["3"] },
    },
  });

  let apiCalls = 0;
  const fetchAncestors = async (_provider, _cfg, itemId) => {
    apiCalls += 1;
    if (itemId === "selected-item") {
      return [{ Id: "3", Type: "CollectionFolder", CollectionType: "movies", Name: "Movies" }];
    }
    return [{ Id: "841", Type: "CollectionFolder", CollectionType: "tvshows", Name: "TV shows" }];
  };

  // 1. Prime positive cache for selected-item, then verify contradictory LibraryContext.ServerId
  //    even when top-level Server.Id matches is STILL rejected immediately (never served from cache).
  const primed = await resolveItemLibraryMembership("emby", config, {
    Id: "selected-item",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", ItemId: "selected-item", LibraryId: "3", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors });
  assert.equal(primed.allowed, true);
  const wrongCtxServer = await resolveItemLibraryMembership("emby", config, {
    Id: "selected-item",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-other", ItemId: "selected-item", LibraryId: "3", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors });
  assert.equal(wrongCtxServer.allowed, false);
  assert.equal(wrongCtxServer.status, "server_mismatch");
  assert.equal(apiCalls, 0);

  // 2. Claimed selected ID on an unrelated item (LibraryContext.ItemId != Item.Id) -> falls through to Ancestors API & blocks.
  const unrelated = await resolveItemLibraryMembership("emby", config, {
    Id: "unselected-item",
    Type: "Episode",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", ItemId: "selected-item", LibraryId: "3", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(unrelated.allowed, false);
  assert.equal(unrelated.status, "unselected");
  assert.equal(unrelated.evidenceOrigin, "emby_ancestors_api");
  assert.equal(apiCalls, 1);

  // 3. Contradictory LibraryId vs LibraryIds -> falls through to Ancestors API & blocks.
  const contradictory = await resolveItemLibraryMembership("emby", config, {
    Id: "unselected-2",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", ItemId: "unselected-2", LibraryId: "841", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(contradictory.allowed, false);
  assert.equal(contradictory.evidenceOrigin, "emby_ancestors_api");
  assert.equal(apiCalls, 2);

  // 4. "resolved" with multiple libraryIds -> falls through to Ancestors API.
  const multiResolved = await resolveItemLibraryMembership("emby", config, {
    Id: "unselected-3",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", ItemId: "unselected-3", LibraryId: "3", LibraryIds: ["3", "841"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(multiResolved.allowed, false);
  assert.equal(multiResolved.evidenceOrigin, "emby_ancestors_api");
  assert.equal(apiCalls, 3);

  // 5. Missing native Item.Id with claimed selected LibraryContext -> never fast-paths, blocked as unresolved.
  const missingItemId = await resolveItemLibraryMembership("emby", config, {
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", LibraryId: "3", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(missingItemId.allowed, false);
  assert.equal(missingItemId.status, "unresolved");
  assert.equal(apiCalls, 3);

  // 6. Unknown version (v2) and malformed non-object LibraryContext -> fall through to Ancestors API.
  const unknownVersion = await resolveItemLibraryMembership("emby", config, {
    Id: "selected-item",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 2, ServerId: "emby-real", ItemId: "selected-item", LibraryId: "3", LibraryIds: ["3"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(unknownVersion.allowed, true);
  assert.equal(unknownVersion.evidenceOrigin, "emby_ancestors_api");
  assert.equal(apiCalls, 4);

  const malformed = await resolveItemLibraryMembership("emby", config, {
    Id: "unselected-4",
    Type: "Movie",
    libraryContext: "not-an-object",
  }, { fetchAncestors, bypassCache: true });
  assert.equal(malformed.allowed, false);
  assert.equal(malformed.evidenceOrigin, "emby_ancestors_api");
  assert.equal(apiCalls, 5);

  // 7. Old plugin / built-in webhook (no LibraryContext) -> Ancestors API enforces identically.
  const oldPluginSelected = await resolveItemLibraryMembership("emby", config, {
    Id: "selected-item",
    Type: "Movie",
  }, { fetchAncestors, bypassCache: true });
  assert.equal(oldPluginSelected.allowed, true);
  assert.equal(oldPluginSelected.evidenceOrigin, "emby_ancestors_api");

  const oldPluginUnselected = await resolveItemLibraryMembership("emby", config, {
    Id: "unselected-5",
    Type: "Episode",
  }, { fetchAncestors, bypassCache: true });
  assert.equal(oldPluginUnselected.allowed, false);
  assert.equal(oldPluginUnselected.status, "unselected");

  // 8. Unknown root in resolved plugin context -> blocked cleanly as unselected with 0 API calls.
  const callsBeforeUnknown = apiCalls;
  const unknownRoot = await resolveItemLibraryMembership("emby", config, {
    Id: "unknown-root-item",
    Type: "Movie",
    serverId: "emby-real",
    libraryContext: { Version: 1, ServerId: "emby-real", ItemId: "unknown-root-item", LibraryId: "99999", LibraryIds: ["99999"], ResolutionStatus: "resolved" },
  }, { fetchAncestors, bypassCache: true });
  assert.equal(unknownRoot.allowed, false);
  assert.equal(unknownRoot.status, "unselected");
  assert.equal(unknownRoot.evidenceOrigin, "plugin_context_verified");
  assert.equal(apiCalls, callsBeforeUnknown);
});

test("Step 2e: duplicate library names, renames, recreated libraries, denied permissions, and invalidation behave accurately", async () => {
  invalidateLibraryMembershipCache();

  // Duplicate library names with distinct native IDs: selecting only lib-a blocks lib-b.
  const dupConfig = attachProviderLibraryMonitoring({
    jellyfin: { baseUrl: "http://jf.local:8096", apiKey: "k", userId: "u1", serverId: "jf-dup" },
    libraryMonitoring: {
      jellyfin: {
        serverId: "jf-dup",
        revision: 1,
        selectedIds: ["lib-a"],
        selectedLibraries: [{ id: "lib-a", name: "Movies", type: "movie", collectionType: "movies" }],
      },
    },
  });
  const dupAllowed = await resolveItemLibraryMembership("jellyfin", dupConfig, {
    Id: "item-a",
    Type: "Movie",
    libraryContext: { Version: 1, ServerId: "jf-dup", ItemId: "item-a", LibraryId: "lib-a", LibraryIds: ["lib-a"], LibraryName: "Movies", ResolutionStatus: "resolved" },
  });
  const dupBlocked = await resolveItemLibraryMembership("jellyfin", dupConfig, {
    Id: "item-b",
    Type: "Movie",
    libraryContext: { Version: 1, ServerId: "jf-dup", ItemId: "item-b", LibraryId: "lib-b", LibraryIds: ["lib-b"], LibraryName: "Movies", ResolutionStatus: "resolved" },
  });
  assert.equal(dupAllowed.allowed, true);
  assert.equal(dupBlocked.allowed, false);
  assert.equal(dupBlocked.status, "unselected");

  // Renamed library (same ID "lib-a", new name "Cinema") keeps authorization; recreated library ("lib-a-new") stays blocked.
  const renamedAllowed = await resolveItemLibraryMembership("jellyfin", dupConfig, {
    Id: "item-renamed",
    Type: "Movie",
    libraryContext: { Version: 1, ServerId: "jf-dup", ItemId: "item-renamed", LibraryId: "lib-a", LibraryIds: ["lib-a"], LibraryName: "Cinema", ResolutionStatus: "resolved" },
  });
  const recreatedBlocked = await resolveItemLibraryMembership("jellyfin", dupConfig, {
    Id: "item-recreated",
    Type: "Movie",
    libraryContext: { Version: 1, ServerId: "jf-dup", ItemId: "item-recreated", LibraryId: "lib-a-new", LibraryIds: ["lib-a-new"], LibraryName: "Movies", ResolutionStatus: "resolved" },
  });
  assert.equal(renamedAllowed.allowed, true);
  assert.equal(recreatedBlocked.allowed, false);
  assert.equal(recreatedBlocked.status, "unselected");

  // Denied access (403) fails closed with permissions_denied and does not cache as allowed.
  const denied = await resolveItemLibraryMembership("jellyfin", dupConfig, {
    Id: "item-denied",
    Type: "Movie",
  }, {
    bypassCache: true,
    fetchAncestors: async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    },
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.status, "permissions_denied");
  assert.match(buildLibrarySkipDiagnostic("jellyfin", denied, "Secret"), /denied permission/i);
});

test("Step 2e: resumable, Next Up, and personal rating client fetchers obey empty and partial library selections with zero fallback leaks", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; invalidateLibraryMembershipCache(); });
  invalidateLibraryMembershipCache();

  const { fetchPlexContinueWatchingItems, fetchPlexResumableItems, fetchPlexPersonalRatingSnapshot } = await import("../server/src/utils/plexClient.js");
  const { fetchEmbyResumableItems, fetchEmbyNextUpItems, fetchEmbyPersonalRatingSnapshot } = await import("../server/src/utils/embyClient.js");
  const { fetchJellyfinResumableItems, fetchJellyfinNextUpItems, fetchJellyfinPersonalRatingSnapshot } = await import("../server/src/utils/jellyfinClient.js");

  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Should not call server when selection is empty"); };

  const empty = attachProviderLibraryMonitoring({
    plex: { baseUrl: "http://plex.test:32400", token: "tok", serverId: "p1" },
    emby: { baseUrl: "http://emby.test:8096", apiKey: "ek", userId: "u1", serverId: "e1" },
    jellyfin: { baseUrl: "http://jf.test:8096", apiKey: "jk", userId: "u1", serverId: "j1" },
  });
  assert.deepEqual(await fetchPlexContinueWatchingItems(empty.plex), []);
  assert.deepEqual(await fetchPlexResumableItems(empty.plex), []);
  assert.deepEqual(await fetchPlexPersonalRatingSnapshot(empty.plex), []);
  assert.deepEqual(await fetchEmbyResumableItems(empty.emby), []);
  assert.deepEqual(await fetchEmbyNextUpItems(empty.emby), []);
  assert.deepEqual(await fetchEmbyPersonalRatingSnapshot(empty.emby), []);
  assert.deepEqual(await fetchJellyfinResumableItems(empty.jellyfin), []);
  assert.deepEqual(await fetchJellyfinNextUpItems(empty.jellyfin), []);
  assert.deepEqual(await fetchJellyfinPersonalRatingSnapshot(empty.jellyfin), []);
  assert.equal(calls, 0);

  // Selected library filters out unselected items from Emby Resume & Next Up and scopes rating scans by ParentId.
  const partial = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.test:8096", apiKey: "ek", userId: "u1", serverId: "e1" },
    libraryMonitoring: { emby: { serverId: "e1", revision: 1, selectedIds: ["3"] } },
  });
  const seenRatingParents = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/Items/Resume") || url.pathname.endsWith("/Shows/NextUp")) {
      return Response.json({
        Items: [
          { Id: "ok-1", Type: "Movie", Name: "Selected" },
          { Id: "no-2", Type: "Movie", Name: "Unselected" },
        ],
        TotalRecordCount: 2,
      });
    }
    if (url.pathname === "/Items/ok-1/Ancestors") return Response.json([{ Id: "3", Type: "CollectionFolder" }]);
    if (url.pathname === "/Items/no-2/Ancestors") return Response.json([{ Id: "99", Type: "CollectionFolder" }]);
    if (url.pathname === "/Users/u1/Items") {
      seenRatingParents.push(url.searchParams.get("ParentId"));
      return Response.json({ Items: [], TotalRecordCount: 0 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  assert.deepEqual((await fetchEmbyResumableItems(partial.emby)).map((i) => i.Id), ["ok-1"]);
  assert.deepEqual((await fetchEmbyNextUpItems(partial.emby)).map((i) => i.Id), ["ok-1"]);
  await fetchEmbyPersonalRatingSnapshot(partial.emby);
  assert.deepEqual(seenRatingParents, ["3"]);
});

test("Step 2d/2b hardening: rating writes, hideJellyfinFromResume, syncRolesRevision, portable restore, multi-user isolation, and deselection safety", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; invalidateLibraryMembershipCache(); });
  invalidateLibraryMembershipCache();

  const { setPlexPersonalRating } = await import("../server/src/utils/plexClient.js");
  const { setEmbyPersonalRating } = await import("../server/src/utils/embyClient.js");
  const { setJellyfinPersonalRating, hideJellyfinFromResume } = await import("../server/src/utils/jellyfinClient.js");
  const { syncRolesRevision } = await import("../server/src/utils/syncRoles.js");
  const { importCollectionBatch } = await import("../server/src/utils/backup.js");
  const { runWithUserContext } = await import("../server/src/utils/userContext.js");
  const { runRatingSync } = await import("../server/src/utils/personalRatingSync.js");
  const { checkEmbyUnwatchedStatus } = await import("../server/src/utils/unwatchedStatusPoll.js");

  // 1. Empty selection skips personal rating writes and hideJellyfinFromResume with zero HTTP calls.
  let emptyCalls = 0;
  globalThis.fetch = async () => { emptyCalls += 1; throw new Error("Must not call provider with empty selection"); };
  const empty = attachProviderLibraryMonitoring({
    plex: { baseUrl: "http://plex.test:32400", token: "tok", serverId: "p1" },
    emby: { baseUrl: "http://emby.test:8096", apiKey: "ek", userId: "u1", serverId: "e1" },
    jellyfin: { baseUrl: "http://jf.test:8096", apiKey: "jk", userId: "u1", serverId: "j1" },
  });
  const media = { type: "movie", media_type: "movie", title: "Dune", tmdb_id: "438631", ids: { tmdb: "438631" } };
  assert.equal((await setPlexPersonalRating(empty.plex, media, 8)).status, "skipped");
  assert.equal((await setEmbyPersonalRating(empty.emby, media, 8)).status, "skipped");
  assert.equal((await setJellyfinPersonalRating(empty.jellyfin, media, 8)).status, "skipped");
  assert.equal((await hideJellyfinFromResume(empty.jellyfin, "item-1")).status, "skipped");
  assert.equal(emptyCalls, 0);

  // 2. Duplicate media rating writes mutate ONLY selected native IDs; hideJellyfinFromResume blocks unselected item.
  const writtenPaths = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) {
      return Response.json({
        Items: [
          { Id: "rate-selected", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" } },
          { Id: "rate-unselected", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" } },
        ],
      });
    }
    if (url.pathname === "/Items/rate-selected/Ancestors") return Response.json([{ Id: "lib-sel", Type: "CollectionFolder", CollectionType: "movies" }]);
    if (url.pathname === "/Items/rate-unselected/Ancestors") return Response.json([{ Id: "lib-unsel", Type: "CollectionFolder", CollectionType: "homevideos" }]);
    if (url.pathname.endsWith("/UserData") && options.method === "POST") {
      writtenPaths.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/Users/u1/Items/rate-selected") {
      return Response.json({ Id: "rate-selected", UserData: { Rating: 9 } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const embyPartial = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby.test:8096", apiKey: "ek", userId: "u1", serverId: "e1" },
    libraryMonitoring: { emby: { serverId: "e1", revision: 1, selectedIds: ["lib-sel"] } },
  });
  const jfPartial = attachProviderLibraryMonitoring({
    jellyfin: { baseUrl: "http://jf.test:8096", apiKey: "jk", userId: "u1", serverId: "j1" },
    libraryMonitoring: { jellyfin: { serverId: "j1", revision: 1, selectedIds: ["lib-sel"] } },
  });
  const embyRateRes = await setEmbyPersonalRating(embyPartial.emby, media, 9);
  assert.equal(embyRateRes.status, "fulfilled");
  assert.deepEqual(embyRateRes.itemIds, ["rate-selected"]);
  const jfRateRes = await setJellyfinPersonalRating(jfPartial.jellyfin, media, 9);
  assert.equal(jfRateRes.status, "fulfilled");
  assert.deepEqual(jfRateRes.itemIds, ["rate-selected"]);
  assert.equal((await hideJellyfinFromResume(jfPartial.jellyfin, "rate-unselected")).status, "not_found");
  assert.deepEqual(writtenPaths, ["/Users/u1/Items/rate-selected/UserData", "/Users/u1/Items/rate-selected/UserData"]);

  // 3. syncRolesRevision invalidates draft Force Sync plans when libraryMonitoring changes.
  const revA = syncRolesRevision({ libraryMonitoring: { plex: { serverId: "p1", revision: 1, selectedIds: ["1"] } } });
  const revB = syncRolesRevision({ libraryMonitoring: { plex: { serverId: "p1", revision: 2, selectedIds: ["1", "2"] } } });
  assert.notEqual(revA, revB);

  // 4. Portable settings restore ignores incoming libraryMonitoring selections instead of blindly authorizing them.
  saveProviderLibraryMonitoring("plex", { serverId: "plex-local", selectedIds: [] });
  importCollectionBatch("settings", [{
    id: "media_config",
    data: {
      libraryMonitoring: { plex: { serverId: "foreign-server", revision: 9, selectedIds: ["99"] } },
    },
  }], { portable: true });
  const afterPortable = await loadMediaConfig();
  assert.deepEqual(afterPortable.libraryMonitoring?.plex?.selectedIds || [], []);

  // 5. Two Plekt users on the same server keep isolated membership caches and decisions.
  invalidateLibraryMembershipCache();
  const sharedServer = { baseUrl: "http://emby-shared.test:8096", apiKey: "ek", userId: "u1", serverId: "shared-srv" };
  const cfgUserA = attachProviderLibraryMonitoring({
    emby: sharedServer,
    libraryMonitoring: { emby: { serverId: "shared-srv", revision: 1, selectedIds: ["lib-a"] } },
  });
  const cfgUserB = attachProviderLibraryMonitoring({
    emby: sharedServer,
    libraryMonitoring: { emby: { serverId: "shared-srv", revision: 1, selectedIds: ["lib-b"] } },
  });
  const sharedAncestors = async () => [{ Id: "lib-a", Type: "CollectionFolder", CollectionType: "movies" }];
  const resUserA = await runWithUserContext({ name: "alice", dataDir: tempDir }, () =>
    resolveItemLibraryMembership("emby", cfgUserA, { Id: "shared-movie", Type: "Movie" }, { fetchAncestors: sharedAncestors }));
  const resUserB = await runWithUserContext({ name: "bob", dataDir: tempDir }, () =>
    resolveItemLibraryMembership("emby", cfgUserB, { Id: "shared-movie", Type: "Movie" }, { fetchAncestors: sharedAncestors }));
  assert.equal(resUserA.allowed, true);
  assert.equal(resUserB.allowed, false);
  assert.equal(resUserB.status, "unselected");

  // 6. Deleted item (404 from Ancestors) fails closed with allowed=false.
  const deleted = await resolveItemLibraryMembership("emby", cfgUserA, { Id: "deleted-404", Type: "Movie" }, {
    bypassCache: true,
    fetchAncestors: async () => { throw Object.assign(new Error("Not found"), { status: 404 }); },
  });
  assert.equal(deleted.allowed, false);
  assert.ok(["error", "unresolved"].includes(deleted.status));

  // 7. Revoked library access surfaces in unavailableLibraries without permitting activity.
  await saveMediaConfig({
    plex: { baseUrl: "http://plex-revoke.test:32400", token: "tok", disabled: false },
    emby: { disabled: true },
    jellyfin: { disabled: true },
  });
  saveProviderLibraryMonitoring("plex", {
    serverId: "plex-rev",
    selectedIds: ["1", "2"],
    selectedLibraries: [
      { id: "1", name: "Movies", type: "movie" },
      { id: "2", name: "Removed Library", type: "movie" },
    ],
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/identity") return Response.json({ MediaContainer: { machineIdentifier: "plex-rev", friendlyName: "Revoke Plex" } });
    if (url.pathname === "/library/sections") {
      return Response.json({ MediaContainer: { Directory: [{ key: "1", uuid: "u1", title: "Movies", type: "movie" }] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const revRes = mockResponse();
  await handleLibraryMonitoring(adminReq("GET"), revRes, "library-monitoring/plex/libraries");
  assert.equal(revRes.statusCode, 200);
  assert.deepEqual(revRes.body.unavailableLibraries.map((l) => l.id), ["2"]);

  // 8. Deselecting a library during personal rating sync re-baselines without synthetic rating clears.
  const ratingConfigTwoLibs = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby-rate.test:8096", apiKey: "ek", userId: "u1", serverId: "emby-rate" },
    ratingSync: { enabled: true, providers: { emby: { enabled: true, direction: "bidirectional" } } },
    libraryMonitoring: { emby: { serverId: "emby-rate", revision: 1, selectedIds: ["lib-1", "lib-2"] } },
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const parentId = url.searchParams.get("ParentId");
    if (url.pathname === "/Users/u1/Items") {
      if (parentId === "lib-1") {
        return Response.json({ Items: [{ Id: "m1", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" }, UserData: { Rating: 8 } }], TotalRecordCount: 1 });
      }
      if (parentId === "lib-2") {
        return Response.json({ Items: [{ Id: "m2", Name: "Arrival", Type: "Movie", ProviderIds: { Tmdb: "329865" }, UserData: { Rating: 9 } }], TotalRecordCount: 1 });
      }
      return Response.json({ Items: [], TotalRecordCount: 0 });
    }
    if (url.pathname === "/Items/m1/Ancestors") return Response.json([{ Id: "lib-1", Type: "CollectionFolder" }]);
    if (url.pathname === "/Items/m2/Ancestors") return Response.json([{ Id: "lib-2", Type: "CollectionFolder" }]);
    throw new Error(`Unexpected rating URL: ${url}`);
  };
  const firstScan = await runRatingSync({ providers: ["emby"], mode: "incremental", snapshot: true, drain: false, config: ratingConfigTwoLibs });
  assert.equal(firstScan.providers[0]?.status, "succeeded");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_ratings").get().n, 2);

  // Now deselect lib-2: Arrival is no longer in the snapshot, yet canonical rating MUST NOT be cleared or held.
  const ratingConfigOneLib = attachProviderLibraryMonitoring({
    emby: { baseUrl: "http://emby-rate.test:8096", apiKey: "ek", userId: "u1", serverId: "emby-rate" },
    ratingSync: { enabled: true, providers: { emby: { enabled: true, direction: "bidirectional" } } },
    libraryMonitoring: { emby: { serverId: "emby-rate", revision: 2, selectedIds: ["lib-1"] } },
  });
  const afterDeselect = await runRatingSync({ providers: ["emby"], mode: "incremental", snapshot: true, drain: false, config: ratingConfigOneLib });
  assert.equal(afterDeselect.providers[0]?.status, "succeeded");
  assert.equal(afterDeselect.providers[0]?.cleared, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM personal_ratings").get().n, 2);

  // 9. Unwatched fallback poll ignores unplayed duplicate in an unselected Emby library (no synthetic unwatch).
  const oldWatch = insertWatchRecordSync({
    title: "Dune",
    media_type: "movie",
    tmdb_id: "438631",
    source: "emby",
    watched_at: "2026-01-01T10:00:00.000Z",
    sync_dispatch_telemetry: "Target emby status: fulfilled",
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.has("AnyProviderIdEquals")) {
      return Response.json({
        Items: [{ Id: "unselected-unplayed", Name: "Dune", Type: "Movie", ProviderIds: { Tmdb: "438631" }, UserData: { Played: false } }],
      });
    }
    if (url.pathname === "/Items/unselected-unplayed/Ancestors") {
      return Response.json([{ Id: "lib-unselected", Type: "CollectionFolder", CollectionType: "homevideos" }]);
    }
    throw new Error(`Unexpected unwatched poll URL: ${url}`);
  };
  await checkEmbyUnwatchedStatus(embyPartial, createLoopStore());
  const stillWatched = db.prepare("SELECT sync_action FROM watch_history WHERE id = ?").get(oldWatch.id);
  assert.notEqual(stillWatched?.sync_action, "unwatched");
});
