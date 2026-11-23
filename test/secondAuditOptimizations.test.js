import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./domStubs.js";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-second-audit-opt-");
const { db, getDataVersion } = await import("../server/src/db.js");
const { loadMediaConfig, saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { insertWatchRecord } = await import("../server/src/utils/dataRepo.js");
const { flushShowProgressUpdates, queueShowProgressUpdate } = await import("../server/src/utils/showProgressCache.js");
const { createUpNextMetadataCache } = await import("../server/src/utils/episodeOrderUpNext.js");
const { reconcileAvailableWatchedItems } = await import("../server/src/utils/libraryAvailabilitySync.js");
const { resolveItemLibraryMembership } = await import("../server/src/utils/librarySelection.js");
const { isPlexLocalOnly } = await import("../server/src/utils/parsers.js");

test("loadMediaConfig memoizes repeated reads, returns isolated clones, and invalidates on settings or env changes", async () => {
  await saveMediaConfig({ plex: { baseUrl: "http://plex-one.local:32400", token: "tok-1", authMode: "manual" } });
  const first = await loadMediaConfig({ resolveConnections: false });
  assert.equal(first.plex.baseUrl, "http://plex-one.local:32400");
  // Mutating the returned object must not poison the memoized base config.
  first.plex.baseUrl = "http://mutated.invalid";

  const second = await loadMediaConfig({ resolveConnections: false });
  assert.equal(second.plex.baseUrl, "http://plex-one.local:32400");

  await saveMediaConfig({ plex: { baseUrl: "http://plex-two.local:32400", token: "tok-2", authMode: "manual" } });
  const third = await loadMediaConfig({ resolveConnections: false });
  assert.equal(third.plex.baseUrl, "http://plex-two.local:32400");

  const prevUrl = process.env.PLEKT_PUBLIC_URL;
  try {
    process.env.PLEKT_PUBLIC_URL = "https://plekt.example.test";
    const fourth = await loadMediaConfig({ resolveConnections: false });
    assert.equal(fourth.publicBaseUrl, "https://plekt.example.test");
  } finally {
    if (prevUrl === undefined) delete process.env.PLEKT_PUBLIC_URL;
    else process.env.PLEKT_PUBLIC_URL = prevUrl;
  }
});

test("showProgressCache skips file rewrite and second data-version bump when progress did not change", async () => {
  await insertWatchRecord({
    title: "Range Index Show - S01E01",
    show_title: "Range Index Show (2024)",
    media_type: "episode",
    season: 1,
    episode: 1,
    watched_at: "2026-11-10T10:00:00.000Z",
    source: "plex",
    sync_action: "watched",
  }, { prefetch: false });
  await flushShowProgressUpdates();

  const cachePath = path.join(dataDir, "tv_progress_cache.json");
  assert.equal(fs.existsSync(cachePath), true);
  const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const entry = Object.values(saved).find((row) => row?.title === "Range Index Show");
  assert.equal(entry?.episode_count, 1);

  const mtimeBefore = fs.statSync(cachePath).mtimeMs;
  const versionBefore = getDataVersion();
  queueShowProgressUpdate("Range Index Show");
  await flushShowProgressUpdates();
  assert.equal(getDataVersion(), versionBefore);
  assert.equal(fs.statSync(cachePath).mtimeMs, mtimeBefore);
});

test("reconcileAvailableWatchedItems runs configured providers concurrently", async () => {
  const started = [];
  let active = 0;
  let maxConcurrent = 0;
  const delayedFetch = (name) => async () => {
    started.push(name);
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    await new Promise((resolve) => setTimeout(resolve, 60));
    active -= 1;
    return [];
  };
  await reconcileAvailableWatchedItems({
    plex: { baseUrl: "http://plex.test", token: "t" },
    emby: { baseUrl: "http://emby.test", apiKey: "k", userId: "u" },
    jellyfin: { baseUrl: "http://jf.test", apiKey: "k", userId: "u" },
  }, {
    clients: {
      plex: { fetch: delayedFetch("plex") },
      emby: { fetch: delayedFetch("emby") },
      jellyfin: { fetch: delayedFetch("jellyfin") },
    },
  });
  assert.equal(started.length, 3);
  assert.equal(maxConcurrent, 3);
});

test("createUpNextMetadataCache memoizes details, season, and displayMap lookups per build", () => {
  const cache = createUpNextMetadataCache();
  assert.equal(typeof cache.orderDetails, "function");
  assert.equal(typeof cache.orderSeason, "function");
  assert.equal(typeof cache.orderDisplayMap, "function");
  const d1 = cache.orderDetails({ mediaType: "tv", tmdbId: "999999999", title: "Missing Show" });
  const d2 = cache.orderDetails({ mediaType: "tv", tmdbId: "999999999", title: "Missing Show" });
  assert.equal(d1, d2);
  const s1 = cache.orderSeason({ tmdbId: "999999999", tvdbId: "", seasonNumber: 1 });
  const s2 = cache.orderSeason({ tmdbId: "999999999", tvdbId: "", seasonNumber: 1 });
  assert.equal(s1, s2);
});

test("positionSeasonDetails batches geometry reads before writes and measures wrapped detail heights after width writes", async () => {
  const ops = [];
  const makeStyle = (label) => {
    const bag = new Map();
    const record = (prop, value) => { ops.push(`write:${label}.${prop}`); bag.set(prop, value); };
    return {
      set left(v) { record("left", v); },
      get left() { return bag.get("left") || ""; },
      set top(v) { record("top", v); },
      get top() { return bag.get("top") || ""; },
      set width(v) { record("width", v); },
      get width() { return bag.get("width") || ""; },
      set minHeight(v) { record("minHeight", v); },
      get minHeight() { return bag.get("minHeight") || ""; },
      setProperty(k, v) { record(k, v); },
      removeProperty(k) { record(`remove:${k}`, ""); bag.delete(k); },
      getPropertyValue(k) { return bag.get(k) || ""; },
    };
  };
  const cards = new Map();
  const details = [1, 2].map((num) => {
    const card = {
      get offsetHeight() { ops.push(`read:card${num}.offsetHeight`); return 120; },
      getBoundingClientRect() { ops.push(`read:card${num}.rect`); return { right: 200, top: 100 + (num - 1) * 140 }; },
    };
    cards.set(String(num), { closest: () => card });
    const style = makeStyle(`detail${num}`);
    return {
      dataset: { seasonDetail: String(num) },
      style,
      get offsetHeight() {
        ops.push(`read:detail${num}.offsetHeight`);
        // Height reflects the width written in pass 1.
        return style.width === "584px" ? 260 : 999;
      },
    };
  });
  const listStyle = makeStyle("list");
  const list = {
    currentCSSZoom: 1,
    style: listStyle,
    getBoundingClientRect() { ops.push("read:list.rect"); return { left: 0, top: 100, width: 800 }; },
    querySelectorAll(sel) { return sel === "[data-season-detail]" ? details : []; },
    querySelector(sel) {
      const m = /^\[data-season-accordion="(\d+)"\]$/.exec(sel);
      return m ? cards.get(m[1]) : null;
    },
  };
  const root = { querySelectorAll(sel) { return sel === ".season-accordion-list" ? [list] : []; } };
  const prevMatchMedia = window.matchMedia;
  const prevDpr = window.devicePixelRatio;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  try {
    window.devicePixelRatio = 1;
    window.matchMedia = () => ({ matches: true });
    globalThis.getComputedStyle = () => { ops.push("read:list.gap"); return { columnGap: "16px" }; };
    const { positionSeasonDetails } = await import("../public/modules/media-detail-show.js");
    positionSeasonDetails(root);

    assert.equal(details[0].style.left, "216px");
    assert.equal(details[0].style.top, "0px");
    assert.equal(details[0].style.width, "584px");
    assert.equal(details[1].style.top, "140px");
    assert.equal(list.style.minHeight, "400px");

    // Verify phase ordering: Pass 1 reads -> Pass 1 writes -> Pass 2 height reads -> Pass 2 minHeight write.
    const firstWriteIdx = ops.findIndex((op) => op.startsWith("write:"));
    const lastCardReadIdx = ops.reduce((idx, op, i) => (op.startsWith("read:card") || op.startsWith("read:list")) ? i : idx, -1);
    const firstDetailHeightReadIdx = ops.findIndex((op) => op.endsWith(".offsetHeight") && op.startsWith("read:detail"));
    const lastDetailWriteIdx = ops.reduce((idx, op, i) => op.startsWith("write:detail") ? i : idx, -1);
    const minHeightWriteIdx = ops.indexOf("write:list.minHeight");
    assert.ok(lastCardReadIdx < firstWriteIdx, `all card/list reads must precede first write: ${ops.join(", ")}`);
    assert.ok(lastDetailWriteIdx < firstDetailHeightReadIdx, `all detail width writes must precede detail height reads: ${ops.join(", ")}`);
    assert.ok(firstDetailHeightReadIdx < minHeightWriteIdx, `detail height reads must precede minHeight write: ${ops.join(", ")}`);
  } finally {
    window.matchMedia = prevMatchMedia;
    window.devicePixelRatio = prevDpr;
    globalThis.getComputedStyle = prevGetComputedStyle;
  }
});

test("resolveItemLibraryMembership does not reuse stale allowed decision when selectedIds changes at same revision", async () => {
  const base = { baseUrl: "http://plex-cache.test", token: "tok", serverId: "srv-1", libraryMonitoringEnforced: true, monitoredLibraryRevision: 1 };
  const item = { ratingKey: "item-99", librarySectionID: "1", type: "movie" };
  const denied = await resolveItemLibraryMembership("plex", { ...base, monitoredLibraryIds: ["2"] }, item);
  assert.equal(denied.allowed, false);
  const allowed = await resolveItemLibraryMembership("plex", { ...base, monitoredLibraryIds: ["1"] }, item);
  assert.equal(allowed.allowed, true);
});

test("isPlexLocalOnly matches local and agents.none guids and leaves normal tmdb movies untouched", () => {
  assert.equal(isPlexLocalOnly({ type: "movie", title: "Arrival", guid: "local://123" }), true);
  assert.equal(isPlexLocalOnly({ type: "movie", title: "Arrival", guid: "com.plexapp.agents.none://123?lang=xn" }), true);
  assert.equal(isPlexLocalOnly({ type: "movie", title: "Arrival", guid: "plex://movie/abc", Guid: [{ id: "tmdb://329865" }] }), false);
});
