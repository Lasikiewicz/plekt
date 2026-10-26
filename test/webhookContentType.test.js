import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-webhook-content-type-");

const { handleWebhook, normalizeWebhook } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { deleteActiveSession, listActiveSessions } = await import("../server/src/utils/activeSessions.js");
const { getWatchRecordById, insertWatchRecord, upsertPlaystateForMedia } = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { recordOutboundPlayedMarks, recordOutboundRailRefresh, recordOutboundUnplayedMarks } = await import("../server/src/utils/syncOrchestrator.js");
const { UP_NEXT_SEED_DEVICE_ID } = await import("../server/src/utils/embyClient.js");

function request({ contentType = "", userAgent = "test-agent", body = "" } = {}) {
  const headers = { "content-type": contentType, "user-agent": userAgent };
  return {
    get: (name) => headers[String(name).toLowerCase()] || "",
    rawBody: Buffer.from(body, "utf8"),
  };
}

function responseCapture() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    send(body) {
      this.body = JSON.parse(body);
      return this;
    },
  };
  return response;
}

function webhookRequest(body) {
  const headers = {
    "content-type": "application/json",
    "x-plembfin-webhook-secret": AUTH.webhookSecret,
  };
  return {
    method: "POST",
    query: {},
    body,
    headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
  };
}

// Jellyfin's webhook plugin posts valid JSON under a text/plain content type.
// Trusting the header drops every event it sends, including the mark-played and
// mark-unplayed events unwatch propagation depends on.
const jellyfinBody = JSON.stringify({
  ServerId: "d00d1f450389495c9bd54d6eeb9cda53",
  ServerName: "jellyfin",
  NotificationType: "ItemMarkPlayed",
  Item: {
    Type: "Movie",
    Name: "Arrival",
    ProviderIds: { Tmdb: "329865" },
    UserData: { Played: true, LastPlayedDate: "2026-07-25T20:15:47.000Z" },
  },
});

test("valid JSON sent as text/plain is parsed, not rejected", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "text/plain; charset=utf-8", userAgent: "Jellyfin-Server/10.11.9", body: jellyfinBody }),
  );

  assert.equal(media.isValid, true, "a text/plain body holding JSON must still be handled");
  assert.equal(media.source, "jellyfin");
  assert.equal(media.phase, "completed");
  assert.equal(media.playedFlagOnly, true);
});

test("a declared JSON content type still parses the same payload", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "application/json", body: jellyfinBody }),
  );
  assert.equal(media.isValid, true);
  assert.equal(media.source, "jellyfin");
});

test("a watched callback caused by Plembfin is acknowledged without re-reconciling", async () => {
  const media = {
    title: "Echo Guard Movie",
    type: "movie",
    mediaType: "movie",
    ids: { tmdb: "echo-guard-movie" },
    isValid: true,
  };
  const record = await insertWatchRecord({
    title: media.title,
    media_type: "movie",
    tmdb_id: media.ids.tmdb,
    watched_at: "2026-09-17T08:00:00.000Z",
    source: "manual",
  });
  await upsertPlaystateForMedia(media, "watched", record.record.watched_at);
  await recordOutboundPlayedMarks(media, ["jellyfin"], createLoopStore());

  const trackerSync = await import("../server/src/utils/trackerSync.js");
  trackerSync.resetTrackerEventCheckThrottle();
  const response = responseCapture();
  await handleWebhook(webhookRequest({
    ServerId: "echo-guard-server",
    NotificationType: "ItemMarkPlayed",
    Item: {
      Type: "Movie",
      Name: media.title,
      ProviderIds: { Tmdb: media.ids.tmdb },
      UserData: { Played: true, LastPlayedDate: "2026-09-17T08:01:00.000Z" },
    },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.skipped, true);
  assert.match(response.body.reason, /outbound mark/i);
  assert.equal(trackerSync.peekTrackerEventCheckAt(), 0, "Plekt outbound play echoes must not arm Simkl checks");
});

// Defect AG: the native rail refresh toggles a watched predecessor unplayed and
// back. Its unplayed callback was applied as a user unwatch whenever the
// canonical row the webhook resolved already read unwatched (an older
// series-keyed unwatch while the watch sat under other ids), and deleted the
// watch history row.
test("a native rail refresh callback never unwatches or deletes watch history", async () => {
  const media = {
    title: "Rail Echo Movie",
    type: "movie",
    mediaType: "movie",
    ids: { tmdb: "rail-echo-movie" },
    itemId: "emby-rail-echo",
    isValid: true,
  };
  const record = await insertWatchRecord({
    title: media.title,
    media_type: "movie",
    tmdb_id: media.ids.tmdb,
    watched_at: "2026-09-19T12:32:59.000Z",
    source: "emby",
  });
  await upsertPlaystateForMedia(media, "unwatched", "2026-09-12T22:58:10.000Z");
  const loopStore = createLoopStore();
  await recordOutboundRailRefresh(media, "emby", loopStore);
  await recordOutboundUnplayedMarks(media, ["emby"], loopStore);

  const trackerSync = await import("../server/src/utils/trackerSync.js");
  trackerSync.resetTrackerEventCheckThrottle();
  const response = responseCapture();
  await handleWebhook(webhookRequest({
    Event: "item.markunplayed",
    Item: {
      Id: media.itemId,
      Type: "Movie",
      Name: media.title,
      ProviderIds: { Tmdb: media.ids.tmdb },
      UserData: { Played: false },
    },
  }), response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.skipped, true);
  assert.match(response.body.reason, /rail refresh/i);
  assert.ok(record.id);
  assert.ok(await getWatchRecordById(record.id), "the watch history row is kept");
  // Up Next rail refresh is media-server/Plekt only; it must not arm Simkl checks.
  assert.equal(trackerSync.peekTrackerEventCheckAt(), 0);
});

test("a body that is not JSON at all is rejected with the sender recorded", async () => {
  const media = await normalizeWebhook(
    request({ contentType: "text/plain", userAgent: "Some-Server/1.0", body: "not json at all" }),
  );

  assert.equal(media.isValid, false);
  assert.equal(media.title, "Unsupported webhook content type");
  assert.equal(media.rawPayloadDebug.userAgent, "Some-Server/1.0");
  assert.equal(media.rawPayloadDebug.contentType, "text/plain");
  assert.match(media.rawPayloadDebug.bodyPreview, /not json at all/);
});

test("a malformed body claiming to be JSON is a client error", async () => {
  await assert.rejects(
    () => normalizeWebhook(request({ contentType: "application/json", body: "{ broken" })),
    (error) => error.status === 400,
    "declaring JSON and sending something else stays a 400 rather than being silently ignored",
  );
});

test("an empty body is rejected rather than treated as an event", async () => {
  const media = await normalizeWebhook(request({ contentType: "text/plain", body: "" }));
  assert.equal(media.isValid, false);
  assert.equal(media.title, "Unsupported webhook content type");
});

test("Emby Up Next seed callbacks never become active sessions", async () => {
  const seedPayload = {
    Event: "playback.start",
    UserId: "emby-user",
    DeviceId: UP_NEXT_SEED_DEVICE_ID,
    DeviceName: "Plembfin Up Next",
    Client: "Emby",
    ApplicationVersion: "1.0.0",
    SessionId: "plembfin-up-next-seed-episode",
    Item: {
      Type: "Movie",
      Name: "Arrival",
      ProviderIds: { Tmdb: "329865" },
      RunTimeTicks: 36_000_000_000,
    },
  };
  const seedResponse = responseCapture();

  await handleWebhook(webhookRequest(seedPayload), seedResponse);

  assert.equal(seedResponse.statusCode, 200);
  assert.equal(seedResponse.body.skipped, true);
  assert.equal(seedResponse.body.active, false);
  assert.equal((await listActiveSessions()).length, 0);

  const realPayload = {
    ...seedPayload,
    DeviceId: "a-real-device",
    DeviceName: "Real Emby Player",
    SessionId: "real-emby-session",
    Item: { ...seedPayload.Item, Name: "The Martian" },
  };
  const realResponse = responseCapture();
  await handleWebhook(webhookRequest(realPayload), realResponse);

  assert.equal(realResponse.body.active, true);
  assert.equal((await listActiveSessions()).length, 1);
  assert.equal((await listActiveSessions())[0].client.deviceId, "a-real-device");
  await deleteActiveSession({
    source: "emby",
    type: "movie",
    title: "The Martian",
    ids: { tmdb: "329865" },
  });
});
