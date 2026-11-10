import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-watchlist-partial-read-");

const { db } = await import("../server/src/db.js");
const { listWatchlistProviderItems, listWatchlistSyncRuns } = await import("../server/src/utils/personalWatchlistRepository.js");
const { normalizePersonalWatchlistMedia } = await import("../server/src/utils/personalWatchlistIdentity.js");
const { fetchPlexWatchlistSnapshot } = await import("../server/src/utils/plexWatchlistClient.js");
const { runWatchlistSync } = await import("../server/src/utils/personalWatchlistSync.js");

const originalFetch = globalThis.fetch;
const plexConfig = { baseUrl: "https://plex.example", accountToken: "account-secret", watchlistListPath: "/library/sections/watchlist/all" };
const config = {
  plex: plexConfig,
  watchlistSync: {
    enabled: true,
    providers: { plex: { enabled: true, representation: "native", writeEnabled: true, publishConfirmedAt: 1 }, emby: { enabled: false, representation: "playlist", publishConfirmedAt: 0 }, jellyfin: { enabled: false, representation: "playlist", publishConfirmedAt: 0 } },
  },
};

// The Plex watchlist response for the current test. Each test sets `body` first.
let body = null;
globalThis.fetch = async (url) => {
  if (String(url).includes("/library/sections/watchlist/all")) {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(null, { status: 204 });
};

test.after(() => {
  globalThis.fetch = originalFetch;
  db.close();
});

function movie(id, tmdb) {
  return { type: "movie", ratingKey: id, title: `Movie ${tmdb}`, guid: `tmdb://${tmdb}`, year: 2020 };
}

function container(items) {
  return { MediaContainer: { Metadata: items, totalSize: items.length, size: items.length } };
}

function plexRowState(tmdb) {
  const media = normalizePersonalWatchlistMedia({ type: "movie", title: `Movie ${tmdb}`, tmdb_id: String(tmdb) });
  return listWatchlistProviderItems({ provider: "plex", mediaKey: media.media_key })[0]?.remote_state;
}

function plexRunStatus() {
  return listWatchlistSyncRuns().find((run) => run.provider === "plex")?.status;
}

test("an unrecognised Plex watchlist body fails the snapshot instead of reading as empty", async () => {
  body = {};
  await assert.rejects(() => fetchPlexWatchlistSnapshot(plexConfig), /unrecognised/i);
});

test("a row that cannot be normalised still counts as seen in the snapshot", async () => {
  body = container([movie("plex-7000", 7000), { ratingKey: "plex-bad-9", title: "No Type" }]);
  const snapshot = await fetchPlexWatchlistSnapshot(plexConfig);
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.items.some((item) => item.provider_item_id === "plex-bad-9" && item.unnormalized === true));
  assert.equal(snapshot.items.filter((item) => !item.unnormalized).length, 1);
});

test("an unrecognised body after a complete read removes nothing", async () => {
  body = container([movie("plex-7201", 7201), movie("plex-7202", 7202)]);
  await runWatchlistSync({ mode: "reconcile", config });
  // A second read settles the adds from the first, which carry a newer canonical revision.
  const settled = await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(settled.ok, true);
  body = {};
  await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(plexRowState(7201), "present");
  assert.equal(plexRowState(7202), "present");
});

test("a large watchlist removal is held until the same removal repeats", async () => {
  body = container([movie("plex-7101", 7101), movie("plex-7102", 7102), movie("plex-7103", 7103), movie("plex-7104", 7104)]);
  await runWatchlistSync({ mode: "reconcile", config });
  await runWatchlistSync({ mode: "reconcile", config });

  // 3 of 4 removed (75 percent): held on the first read.
  body = container([movie("plex-7101", 7101)]);
  await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(plexRunStatus(), "partial");
  assert.equal(plexRowState(7102), "present");
  assert.equal(plexRowState(7103), "present");
  assert.equal(plexRowState(7104), "present");

  // The same removal on the next read is applied.
  const repeated = await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(repeated.ok, true);
  assert.equal(plexRowState(7102), "absent");
  assert.equal(plexRowState(7103), "absent");
  assert.equal(plexRowState(7104), "absent");
  assert.equal(plexRowState(7101), "present");
});

test("an empty watchlist read with an existing baseline is held until it repeats", async () => {
  body = container([movie("plex-7301", 7301), movie("plex-7302", 7302)]);
  await runWatchlistSync({ mode: "reconcile", config });
  await runWatchlistSync({ mode: "reconcile", config });

  body = container([]);
  await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(plexRunStatus(), "partial");
  assert.equal(plexRowState(7301), "present");
  assert.equal(plexRowState(7302), "present");

  await runWatchlistSync({ mode: "reconcile", config });
  assert.equal(plexRowState(7301), "absent");
  assert.equal(plexRowState(7302), "absent");
});
