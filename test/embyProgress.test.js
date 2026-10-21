import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-emby-progress-test-"));
process.env.DATA_DIR = dataDir;

const { embyResumeLastPlayedDate, setEmbyProgress } = await import("../server/src/utils/embyClient.js");

const {
  listPlaybackProgressRowsForReplay,
  progressRowToMedia,
  updatePlaybackProgressTelemetry,
  upsertPlaybackProgress,
} = await import(`../server/src/utils/dataRepo.js?test=${Date.now()}`);
const { db } = await import("../server/src/db.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const config = {
  baseUrl: "https://emby.example.test",
  apiKey: "test-token",
  userId: "test-user",
};

async function captureProgressRequest(media, { unhideStatus = 204 } = {}) {
  const originalFetch = globalThis.fetch;
  let progressRequest = null;
  const requests = [];

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    if (requestUrl.pathname === "/Users/test-user/Items" && options.method !== "POST") {
      return new Response(JSON.stringify({
        Items: [{ Id: "movie-1", Name: "Arrival", ProviderIds: { Tmdb: "329865" } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (requestUrl.pathname === "/Users/test-user/Items/movie-1/UserData" && options.method === "POST") {
      progressRequest = { url: requestUrl, options };
      requests.push("userdata");
      return new Response(null, { status: 200 });
    }
    if (requestUrl.pathname === "/Users/test-user/Items/movie-1/HideFromResume" && options.method === "POST") {
      requests.push(`hide=${requestUrl.searchParams.get("Hide")}`);
      return new Response(null, { status: unhideStatus });
    }
    throw new Error(`Unexpected Emby request: ${options.method || "GET"} ${requestUrl}`);
  };

  try {
    const result = await setEmbyProgress(config, {
      title: "Arrival",
      type: "movie",
      ids: { tmdb: "329865" },
      isValid: true,
      ...media,
    });
    return { result, request: progressRequest, requests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Emby resume updates include the source progress date for Continue Watching", async () => {
  const updatedAt = Date.parse("2026-08-23T10:15:30.000Z");
  const { result, request } = await captureProgressRequest({ positionMs: 970_000, updatedAt });

  assert.equal(result.status, "fulfilled");
  assert.ok(request, "expected an Emby UserData update");
  assert.deepEqual(JSON.parse(request.options.body), {
    PlaybackPositionTicks: 9_700_000_000,
    Played: false,
    LastPlayedDate: "2026-08-23T10:15:30.000Z",
  });
});

// A Hide from Resume flag survives UserData writes, so without the unhide the
// item kept its position but never returned to Continue Watching, and the Up
// Next push rewrote it on every run.
test("an Emby resume write lifts a stale Hide from Resume flag after the position is stored", async () => {
  const { result, requests } = await captureProgressRequest({ positionMs: 970_000, updatedAt: Date.now() });

  assert.equal(result.status, "fulfilled");
  assert.deepEqual(requests, ["userdata", "hide=false"]);
});

test("clearing Emby resume state never unhides the item", async () => {
  const { requests } = await captureProgressRequest({ positionMs: 0 });

  assert.deepEqual(requests, ["userdata"]);
});

test("a failed Emby unhide does not fail the stored resume position", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const { result, requests } = await captureProgressRequest({ positionMs: 970_000 }, { unhideStatus: 404 });
    assert.equal(result.status, "fulfilled");
    assert.equal(result.positionMs, 970_000);
    assert.deepEqual(requests, ["userdata", "hide=false"]);
  } finally {
    console.error = originalError;
  }
});

test("Emby resume date falls back to the dispatch time when the source has no timestamp", () => {
  assert.equal(
    embyResumeLastPlayedDate({}, Date.parse("2026-08-23T10:16:00.000Z")),
    "2026-08-23T10:16:00.000Z",
  );
});

test("clearing Emby resume state does not make the item look recently played", async () => {
  const { request } = await captureProgressRequest({
    positionMs: 0,
    updatedAt: Date.parse("2026-08-23T10:15:30.000Z"),
  });

  assert.ok(request, "expected an Emby UserData update");
  assert.deepEqual(JSON.parse(request.options.body), {
    PlaybackPositionTicks: 0,
    Played: false,
  });
});

test("telemetry-only updates preserve the source date replayed to Emby", async () => {
  const sourceUpdatedAt = Date.parse("2026-08-20T20:30:00.000Z");
  const stored = await upsertPlaybackProgress({
    title: "Arrival",
    media_type: "movie",
    source: "plex",
    tmdb_id: "329865",
    position_ms: 970_000,
    duration_ms: 2_492_490,
    progress: 38.9169,
    updated_at: sourceUpdatedAt,
    sync_dispatch_telemetry: "pending",
  });

  await updatePlaybackProgressTelemetry(stored, "Dispatch status: success");

  const replayRows = await listPlaybackProgressRowsForReplay({ limit: 10 });
  assert.equal(replayRows.length, 1);
  assert.equal(replayRows[0].updated_at, sourceUpdatedAt);
  assert.equal(replayRows[0].sync_dispatch_telemetry, "Dispatch status: success");

  const replayMedia = progressRowToMedia(replayRows[0], "manual");
  const { request } = await captureProgressRequest(replayMedia);
  assert.equal(
    JSON.parse(request.options.body).LastPlayedDate,
    "2026-08-20T20:30:00.000Z",
  );
});
