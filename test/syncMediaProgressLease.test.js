import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-progress-lease-");

// Functional audit finding F3: a resume write must run under the same per-target
// lease as watched and unwatched writes, so an older progress write cannot land
// after a newer unwatch or watched state on the same provider item.
const repo = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const {
  isRecentOutboundProgressEcho,
  syncMediaProgress,
  syncMediaUnplayedPlaystate,
} = await import("../server/src/utils/syncOrchestrator.js");

const EMBY_BASE = "https://emby.example.test";
const JELLYFIN_BASE = "https://jellyfin.example.test";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function movieMedia(tmdb, overrides = {}) {
  return {
    title: `Progress Lease ${tmdb}`,
    type: "movie",
    source: "plex",
    isValid: true,
    ids: { tmdb },
    positionMs: 600_000,
    durationMs: 6_000_000,
    progress: 10,
    updatedAt: Date.now() - 60_000,
    ...overrides,
  };
}

// Fake Emby/Jellyfin server. Every item lookup resolves to the same title, the
// played-state route can be held open by a test, and progress writes are recorded
// with the provider position that was in effect when each write landed.
function installProviderFake({ tmdb, holdPlayedRoute = null, holdLookupFor = null } = {}) {
  const state = {
    position: null,
    writes: [],
    playedStarted: deferred(),
    lookupStarted: deferred(),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const host = parsed.host;
    const targetName = host.includes("jellyfin") ? "jellyfin" : "emby";
    if (parsed.pathname.endsWith("/Items")) {
      if (holdLookupFor && host === new URL(holdLookupFor.base).host) {
        state.lookupStarted.resolve();
        await holdLookupFor.gate.promise;
      }
      return new Response(JSON.stringify({ Items: [{ Id: `${targetName}-item`, Name: "Progress Lease", ProviderIds: { Tmdb: tmdb } }] }), { status: 200 });
    }
    if (parsed.pathname.endsWith("/UserData")) {
      const ticks = JSON.parse(options.body || "{}").PlaybackPositionTicks;
      const position = Math.round(Number(ticks || 0) / 10_000);
      state.position = position;
      state.writes.push({ target: targetName, operation: "progress", position, echoRecognized: state.echoProbe ? await state.echoProbe() : null });
      return new Response(null, { status: 200 });
    }
    if (parsed.pathname.includes("/PlayedItems/")) {
      state.playedStarted.resolve();
      if (holdPlayedRoute) await holdPlayedRoute.promise;
      state.writes.push({ target: targetName, operation: options.method === "POST" ? "played" : "unplayed" });
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected mock request ${parsed}`);
  };
  state.restore = () => { globalThis.fetch = originalFetch; };
  return state;
}

const EMBY_ONLY = { plex: { disabled: true }, jellyfin: { disabled: true }, emby: { baseUrl: EMBY_BASE, apiKey: "fixture-key", userId: "fixture-user" } };
const EMBY_AND_JELLYFIN = {
  plex: { disabled: true },
  emby: { baseUrl: EMBY_BASE, apiKey: "fixture-key", userId: "fixture-user" },
  jellyfin: { baseUrl: JELLYFIN_BASE, apiKey: "fixture-key", userId: "fixture-user" },
};

test("a delayed progress write is skipped when a newer unwatch already landed", async () => {
  const tmdb = "3001";
  const kv = createLoopStore();
  const media = movieMedia(tmdb, { syncTargets: ["emby"] });
  const played = deferred();
  const fake = installProviderFake({ tmdb, holdPlayedRoute: played });
  try {
    // Manual unwatch records canonical state first, then dispatches under the lease.
    await repo.upsertPlaystateForMedia({ ...media, source: "manual" }, "unwatched");
    const unwatch = syncMediaUnplayedPlaystate({ ...media, source: "manual" }, EMBY_ONLY, kv, { trackDispatch: false, includeTrackers: false });
    await fake.playedStarted.promise;

    // The older progress write queues behind the unwatch instead of racing it.
    const olderProgress = syncMediaProgress(media, EMBY_ONLY, kv);
    await new Promise((resolve) => setTimeout(resolve, 50));
    played.resolve();

    await unwatch;
    const progress = await olderProgress;

    assert.equal(progress.status, "skipped", "the older progress write must not be sent");
    assert.equal(fake.writes.filter((write) => write.operation === "progress" && write.position === 600_000).length, 0);
    assert.equal(fake.position, 0, "the provider's final resume position stays cleared");
  } finally {
    fake.restore();
  }
});

test("a delayed progress write is skipped when a newer watched state already landed", async () => {
  const tmdb = "3002";
  const kv = createLoopStore();
  const media = movieMedia(tmdb, { syncTargets: ["emby"], updatedAt: Date.now() - 60_000 });
  await repo.upsertPlaystateForMedia({ ...media, source: "manual" }, "watched");
  const fake = installProviderFake({ tmdb });
  try {
    const progress = await syncMediaProgress(media, EMBY_ONLY, kv);
    assert.equal(progress.status, "skipped");
    assert.equal(fake.writes.filter((write) => write.operation === "progress").length, 0);
  } finally {
    fake.restore();
  }
});

test("a newer progress write after an unwatch is still sent", async () => {
  const tmdb = "3003";
  const kv = createLoopStore();
  const unwatchedAt = Date.now();
  const media = movieMedia(tmdb, { syncTargets: ["emby"], updatedAt: unwatchedAt + 60_000 });
  await repo.upsertPlaystateForMedia({ ...media, source: "manual", updatedAt: unwatchedAt }, "unwatched");
  const fake = installProviderFake({ tmdb });
  try {
    const progress = await syncMediaProgress(media, EMBY_ONLY, kv);
    assert.equal(progress.status, "success");
    assert.equal(fake.position, 600_000);
  } finally {
    fake.restore();
  }
});

test("one slow target does not hold up the other target's progress write", async () => {
  const tmdb = "3004";
  const kv = createLoopStore();
  const media = movieMedia(tmdb, { syncTargets: ["emby", "jellyfin"] });
  const emptyGate = deferred();
  const fake = installProviderFake({ tmdb, holdLookupFor: { base: EMBY_BASE, gate: emptyGate } });
  try {
    const progress = syncMediaProgress(media, EMBY_AND_JELLYFIN, kv);
    await fake.lookupStarted.promise;
    // Emby is still stuck on its lookup; Jellyfin must finish on its own.
    const jellyfinDone = await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (fake.writes.some((write) => write.target === "jellyfin")) {
          clearInterval(poll);
          resolve(true);
        }
      }, 5);
      setTimeout(() => { clearInterval(poll); resolve(false); }, 2000).unref();
    });
    assert.equal(jellyfinDone, true, "jellyfin's write must not wait behind emby's lookup");
    assert.equal(fake.writes.some((write) => write.target === "emby"), false);

    emptyGate.resolve();
    await progress;
    assert.equal(fake.writes.some((write) => write.target === "emby" && write.position === 600_000), true);
  } finally {
    fake.restore();
  }
});

test("the provider's progress write is still recognized as Plekt's own echo", async () => {
  const tmdb = "3005";
  const kv = createLoopStore();
  const media = movieMedia(tmdb, { syncTargets: ["emby"] });
  const fake = installProviderFake({ tmdb });
  fake.echoProbe = () => isRecentOutboundProgressEcho(media, "emby", kv);
  try {
    const progress = await syncMediaProgress(media, EMBY_ONLY, kv);
    assert.equal(progress.status, "success");
    const write = fake.writes.find((entry) => entry.operation === "progress");
    assert.equal(write?.echoRecognized, true, "the echo marker must be primed before the provider write");
    assert.equal(await isRecentOutboundProgressEcho(media, "emby", kv), true);
  } finally {
    fake.restore();
  }
});
