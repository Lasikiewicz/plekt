import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-multi-library-upnext-");

const { recordUpNextProviderFeed, listActiveUpNextProviderItems } = await import("../server/src/utils/upNextRepository.js");
const { syncMediaPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
const { markJellyfinPlayed, __resetJellyfinSeriesCache } = await import("../server/src/utils/jellyfinClient.js");
const { markEmbyPlayed, __resetEmbySeriesCache } = await import("../server/src/utils/embyClient.js");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("syncMediaPlaystate marks all Jellyfin library copies even when Up Next only observed one copy", async (t) => {
  __resetJellyfinSeriesCache();
  // Seed Up Next with only the 1080p Jellyfin item id, mimicking /Shows/NextUp returning one library copy.
  recordUpNextProviderFeed("jellyfin", "next_up", [{
    Id: "jf-1080p-s02e09",
    Type: "Episode",
    Name: "Another Man's Shadow",
    SeriesName: "Outlander: Blood of My Blood",
    SeriesId: "jf-series-1080p",
    ParentIndexNumber: 2,
    IndexNumber: 9,
    SeriesProviderIds: { Imdb: "tt18332852", Tmdb: "207484", Tvdb: "429964" },
  }], { triggerAutoSync: false });
  assert.deepEqual(
    listActiveUpNextProviderItems().map((item) => item.provider_items),
    [{ jellyfin: ["jf-1080p-s02e09"] }],
  );

  const markedIds = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    if (init.method === "POST" && url.pathname.includes("/PlayedItems/")) {
      markedIds.push(url.pathname.split("/PlayedItems/")[1]);
      return jsonResponse({ Played: true });
    }
    if (url.searchParams.get("IncludeItemTypes") === "Series") {
      return jsonResponse({
        Items: [
          { Id: "jf-series-1080p", Name: "Outlander: Blood of My Blood", ProviderIds: { Tmdb: "207484", Tvdb: "429964", Imdb: "tt18332852" } },
          { Id: "jf-series-4k", Name: "Outlander: Blood of My Blood", ProviderIds: { Tmdb: "207484", Tvdb: "429964", Imdb: "tt18332852" } },
        ],
      });
    }
    if (url.searchParams.get("IncludeItemTypes") === "Episode") {
      const parentId = url.searchParams.get("ParentId");
      if (parentId === "jf-series-1080p") {
        return jsonResponse({ Items: [{ Id: "jf-1080p-s02e09", Type: "Episode", ParentIndexNumber: 2, IndexNumber: 9 }] });
      }
      if (parentId === "jf-series-4k") {
        return jsonResponse({ Items: [{ Id: "jf-4k-s02e09", Type: "Episode", ParentIndexNumber: 2, IndexNumber: 9 }] });
      }
    }
    return jsonResponse({ Items: [] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    __resetJellyfinSeriesCache();
  });

  const config = {
    plex: { baseUrl: "https://plex.example.test", token: "tok" },
    emby: { disabled: true },
    jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "jf-key", userId: "jf-user" },
  };
  const summary = await syncMediaPlaystate({
    source: "plex",
    type: "episode",
    title: "Outlander: Blood of My Blood - S02E09",
    show_title: "Outlander: Blood of My Blood",
    season: 2,
    episode: 9,
    watched_at: "2026-11-20T23:07:50.000Z",
    ids: { imdb: "tt18332852", tmdb: "207484", tvdb: "429964" },
    isValid: true,
  }, config, null, { trackDispatch: false, includeTrackers: false });

  assert.equal(summary.status, "success");
  assert.deepEqual(markedIds.sort(), ["jf-1080p-s02e09", "jf-4k-s02e09"]);
});

test("syncMediaPlaystate falls back to Up Next Jellyfin hint when library search finds no match", async (t) => {
  __resetJellyfinSeriesCache();
  recordUpNextProviderFeed("jellyfin", "next_up", [{
    Id: "jf-hint-only-id",
    Type: "Episode",
    Name: "Episode 3",
    SeriesName: "Unmatched Show",
    SeriesId: "jf-unmatched-series",
    ParentIndexNumber: 1,
    IndexNumber: 3,
    SeriesProviderIds: { Tmdb: "777001" },
  }], { triggerAutoSync: false });
  assert.deepEqual(
    listActiveUpNextProviderItems().map((item) => item.provider_items),
    [{ jellyfin: ["jf-hint-only-id"] }],
  );

  const markedIds = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    if (init.method === "POST" && url.pathname.includes("/PlayedItems/")) {
      markedIds.push(url.pathname.split("/PlayedItems/")[1]);
      return jsonResponse({ Played: true });
    }
    return jsonResponse({ Items: [] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    __resetJellyfinSeriesCache();
  });

  const config = {
    plex: { baseUrl: "https://plex.example.test", token: "tok" },
    emby: { disabled: true },
    jellyfin: { baseUrl: "https://jellyfin.example.test", apiKey: "jf-key", userId: "jf-user" },
  };
  const summary = await syncMediaPlaystate({
    source: "plex",
    type: "episode",
    title: "Unmatched Show - S01E03",
    show_title: "Unmatched Show",
    season: 1,
    episode: 3,
    watched_at: "2026-11-20T23:07:50.000Z",
    ids: { tmdb: "777001" },
    isValid: true,
  }, config, null, { trackDispatch: false, includeTrackers: false });

  assert.equal(summary.status, "success");
  assert.deepEqual(markedIds, ["jf-hint-only-id"]);
});

test("markJellyfinPlayed and markEmbyPlayed drop stale direct item ids on 404 retry and mark the current item", async (t) => {
  __resetJellyfinSeriesCache();
  __resetEmbySeriesCache();

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    if (init.method === "POST" && url.pathname.includes("/PlayedItems/")) {
      const id = url.pathname.split("/PlayedItems/")[1];
      calls.push(id);
      if (id === "stale-404-id") return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ Played: true });
    }
    if (url.searchParams.get("IncludeItemTypes") === "Series") {
      return jsonResponse({ Items: [{ Id: "series-1", Name: "Outlander: Blood of My Blood", ProviderIds: { Tmdb: "207484" } }] });
    }
    if (url.searchParams.get("IncludeItemTypes") === "Episode") {
      return jsonResponse({ Items: [{ Id: "fresh-current-id", Type: "Episode", ParentIndexNumber: 2, IndexNumber: 9 }] });
    }
    return jsonResponse({ Items: [] });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    __resetJellyfinSeriesCache();
    __resetEmbySeriesCache();
  });

  const jfResult = await markJellyfinPlayed(
    { baseUrl: "https://jellyfin.example.test", apiKey: "jf-key", userId: "jf-user" },
    {
      type: "episode",
      title: "Outlander: Blood of My Blood - S02E09",
      season: 2,
      episode: 9,
      ids: { tmdb: "207484" },
      provider_items: { jellyfin: ["stale-404-id"] },
    },
  );
  assert.equal(jfResult.status, "fulfilled");
  assert.equal(jfResult.itemId, "fresh-current-id");
  assert.deepEqual(calls, ["stale-404-id", "fresh-current-id"]);

  calls.length = 0;
  const embyResult = await markEmbyPlayed(
    { baseUrl: "https://emby.example.test", apiKey: "emby-key", userId: "emby-user" },
    {
      type: "episode",
      title: "Outlander: Blood of My Blood - S02E09",
      season: 2,
      episode: 9,
      ids: { tmdb: "207484" },
      provider_items: { emby: ["stale-404-id"] },
    },
  );
  assert.equal(embyResult.status, "fulfilled");
  assert.equal(embyResult.itemId, "fresh-current-id");
  assert.deepEqual(calls, ["stale-404-id", "fresh-current-id"]);
});
