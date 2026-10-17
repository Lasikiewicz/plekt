import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

// db.js opens its SQLite file at import time, so point DATA_DIR at a throwaway
// directory before the orchestrator loads.
makeTempDataDir("plekt-unwatch-resume-clear-test-");

const { syncMediaUnplayedPlaystate } = await import("../server/src/utils/syncOrchestrator.js");

const embyOnlyConfig = {
  plex: { disabled: true },
  jellyfin: { disabled: true },
  emby: { baseUrl: "https://emby.example.test", apiKey: "fixture-key", userId: "fixture-user" },
};

const movie = {
  title: "Arrival",
  type: "movie",
  source: "manual",
  isValid: true,
  ids: { tmdb: "329865" },
  syncTargets: ["emby"],
};

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("a failed resume clear during unwatch is reported on the target while mark-unplayed still succeeds", async (t) => {
  const writes = [];
  stubFetch(t, async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/Users/fixture-user/Items") {
      return new Response(JSON.stringify({ Items: [{ Id: "movie-1", Name: "Arrival", ProviderIds: { Tmdb: "329865" } }] }), { status: 200 });
    }
    if (url.pathname.endsWith("/UserData")) {
      writes.push("progress-clear");
      return new Response(null, { status: 500 });
    }
    if (url.pathname.includes("/PlayedItems/")) {
      writes.push("mark-unplayed");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected mock request ${url} ${options.method || "GET"}`);
  });

  const summary = await syncMediaUnplayedPlaystate(movie, embyOnlyConfig, null, { trackDispatch: false, includeTrackers: false });
  const emby = (summary.targetStates || []).find((entry) => entry.target === "emby");

  assert.deepEqual(writes, ["progress-clear", "mark-unplayed"]);
  assert.equal(emby?.status, "success", summary.details);
  assert.match(emby?.detail || "", /200 OK/);
  assert.match(emby?.detail || "", /resume progress not cleared/);
});

test("an unwatch whose resume clear succeeds keeps the plain success detail", async (t) => {
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/Users/fixture-user/Items") {
      return new Response(JSON.stringify({ Items: [{ Id: "movie-2", Name: "Arrival", ProviderIds: { Tmdb: "329865" } }] }), { status: 200 });
    }
    if (url.pathname.endsWith("/UserData")) return new Response(null, { status: 200 });
    if (url.pathname.includes("/PlayedItems/")) return new Response(null, { status: 200 });
    throw new Error(`Unexpected mock request ${url}`);
  });

  const summary = await syncMediaUnplayedPlaystate(movie, embyOnlyConfig, null, { trackDispatch: false, includeTrackers: false });
  const emby = (summary.targetStates || []).find((entry) => entry.target === "emby");

  assert.equal(emby?.status, "success", summary.details);
  assert.equal(emby?.detail, "200 OK");
});
