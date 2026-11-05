import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-episode-order-targets-");

const { matchEpisodeOrderTarget, resolveEpisodeOrderTargets, resolveSourceOrderEpisode } = await import("../server/src/utils/episodeOrderTargets.js");
const { db } = await import("../server/src/db.js");

test.after(() => db.close());

test("matches an exact Plex TVDB episode guid and returns native coordinates", () => {
  assert.deepEqual(matchEpisodeOrderTarget([
    { ratingKey: "plex-ep", parentIndex: 2, index: 4, Guid: [{ id: "tvdb://12345" }] },
  ], { provider: "plex", episodeId: "12345" }), {
    id: "plex-ep", season: 2, episode: 4, episodeId: "12345",
  });
});

test("matches exact Emby and Jellyfin TVDB provider ids", () => {
  const emby = matchEpisodeOrderTarget([
    { Id: "emby-ep", ParentIndexNumber: 3, IndexNumber: 7, ProviderIds: { Tvdb: "tvdb-ep" } },
  ], { provider: "emby", episodeId: "tvdb-ep" });
  const jellyfin = matchEpisodeOrderTarget([
    { Id: "jellyfin-ep", ParentIndexNumber: 3, IndexNumber: 8, ProviderIds: { tvdb: "tvdb-ep" } },
  ], { provider: "jellyfin", episodeId: "tvdb-ep" });
  assert.deepEqual(emby, { id: "emby-ep", season: 3, episode: 7, episodeId: "tvdb-ep" });
  assert.deepEqual(jellyfin, { id: "jellyfin-ep", season: 3, episode: 8, episodeId: "tvdb-ep" });
});

test("refuses missing, duplicate, malformed, or multi-episode matches", () => {
  const exact = { Id: "one", ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: { Tvdb: "42" } };
  assert.equal(matchEpisodeOrderTarget([exact], { provider: "emby", episodeId: "43" }), null);
  assert.equal(matchEpisodeOrderTarget([exact, { ...exact, Id: "two" }], { provider: "emby", episodeId: "42" }), null);
  assert.equal(matchEpisodeOrderTarget([{ ...exact, IndexNumberEnd: 3 }], { provider: "emby", episodeId: "42" }), null);
  assert.equal(matchEpisodeOrderTarget([{ ...exact, ParentIndexNumber: null }], { provider: "emby", episodeId: "42" }), null);
});

test("does not use numeric coordinates as evidence of a TVDB identity", () => {
  assert.equal(matchEpisodeOrderTarget([
    { Id: "coordinate-only", ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: {} },
  ], { provider: "emby", episodeId: "42" }), null);
});

test("preflight fetches only allowed receiving targets and clears native item hints", async () => {
  const calls = [];
  const result = await resolveEpisodeOrderTargets({
    aired: { id: "42", seriesId: "100", season: 1, episode: 2 },
    media: { title: "Example", provider_item_id: "wrong-native-id", providerItems: { plex: ["wrong"] }, syncTargets: ["emby"] },
    config: {
      plex: { baseUrl: "http://plex", token: "token", sync: { watched: "off" } },
      emby: { baseUrl: "http://emby", apiKey: "key", userId: "user" },
    },
    dependencies: {
      fetchEpisodes: {
        emby: async (_config, seriesMedia) => {
          calls.push(seriesMedia);
          return [{ Id: "emby-42", ParentIndexNumber: 4, IndexNumber: 8, ProviderIds: { Tvdb: "42" } }];
        },
        plex: async () => { throw new Error("Plex should not be read"); },
      },
      listTrackerConnections: () => [],
      watchedPlayedSyncEnabled: () => true,
    },
  });
  assert.deepEqual(result.providerItems, { emby: ["emby-42"] });
  assert.equal(result.targets.emby.season, 4);
  assert.equal(Object.hasOwn(calls[0], "provider_item_id"), false);
  assert.equal(Object.hasOwn(calls[0], "providerItems"), false);
  assert.deepEqual(calls[0].ids, { tvdb: "100" });
});

test("a connected Simkl account is skipped instead of blocking the other destinations", async () => {
  const result = await resolveEpisodeOrderTargets({
    aired: { id: "42", seriesId: "100", season: 1, episode: 2 },
    media: {},
    config: {},
    dependencies: {
      watchedPlayedSyncEnabled: () => true,
      listTrackerConnections: () => [{ provider: "simkl", status: "connected" }, { provider: "trakt", status: "connected" }],
      getTrackerConnection: () => ({ clientId: "client", accessToken: "token" }),
      hydrateTraktAppCredentials: (connection) => connection,
      fetchTraktEpisode: async () => ({ id: "trakt-episode", showId: "trakt-show", season: 1, episode: 2, traktOverride: { tvdb_episode_id: "42" } }),
    },
  });
  assert.equal(result.targets.trakt.id, "trakt-episode");
  assert.equal(result.targets.simkl, undefined);
});

test("Trakt lookup receives hydrated credentials and verifies the parent before returning evidence", async () => {
  let authenticatedConnection;
  const result = await resolveEpisodeOrderTargets({
    aired: { id: "42", seriesId: "100", season: 1, episode: 2 },
    media: { syncTargets: ["trakt"] },
    config: {},
    dependencies: {
      watchedPlayedSyncEnabled: () => true,
      listTrackerConnections: () => [{ provider: "trakt", status: "connected" }],
      getTrackerConnection: (_provider, options) => {
        assert.equal(options.includeCredentials, true);
        return { clientId: "client", accessToken: "token" };
      },
      hydrateTraktAppCredentials: (connection) => ({ ...connection, clientId: connection.clientId || "hydrated-client" }),
      fetchTraktEpisode: async (connection) => {
        authenticatedConnection = connection;
        return {
          id: "trakt-episode", showId: "trakt-show", season: 2, episode: 4,
          traktOverride: { tmdb_id: "200", season: 2, episode: 4, tvdb_episode_id: "42", trakt_episode_id: "trakt-episode" },
        };
      },
    },
  });
  assert.equal(authenticatedConnection.clientId, "client");
  assert.equal(authenticatedConnection.accessToken, "token");
  assert.deepEqual(result.targets.traktOverride, {
    tmdb_id: "200", season: 2, episode: 4, tvdb_episode_id: "42", trakt_episode_id: "trakt-episode",
  });
});

test("source lookup maps source coordinates through its exact TVDB id to the official order", async () => {
  let fetchedMedia;
  const officialEpisode = { id: 42, seriesId: 100, season: 1, episode: 2, name: "Aired order" };
  const result = await resolveSourceOrderEpisode({
    media: {
      source: "plex-webhook", season: 2, episode: 4, itemId: "plex-ep",
      show_tvdb_id: "100", title: "Example - S02E04", provider_item_id: "stale", providerItems: { plex: ["stale"] },
    },
    config: { plex: { baseUrl: "http://plex", token: "token" } },
    catalogue: { tvdbId: 100, orders: { official: [officialEpisode] } },
    dependencies: {
      fetchEpisodes: {
        plex: async (_config, seriesMedia) => {
          fetchedMedia = seriesMedia;
          return [
            { ratingKey: "plex-ep", parentIndex: 2, index: 4, Guid: [{ id: "tvdb://42" }] },
          ];
        },
      },
    },
  });
  assert.equal(result, officialEpisode);
  assert.equal(Object.hasOwn(fetchedMedia, "provider_item_id"), false);
  assert.equal(Object.hasOwn(fetchedMedia, "providerItems"), false);
});

test("source lookup rejects explicit item and coordinate conflicts and ambiguous coordinates", async () => {
  const item = { Id: "emby-ep", ParentIndexNumber: 2, IndexNumber: 4, ProviderIds: { Tvdb: "42" } };
  const base = {
    media: { source: "emby", season: 2, episode: 3, show_tvdb_id: "100" },
    config: {},
    catalogue: { tvdbId: 100, orders: { official: [{ id: 42, seriesId: 100, season: 1, episode: 2 }] } },
    dependencies: { fetchEpisodes: { emby: async () => [item] } },
  };
  await assert.rejects(resolveSourceOrderEpisode({ ...base, media: { ...base.media, itemId: "emby-ep" } }), /conflicted with its native coordinates/);
  await assert.rejects(resolveSourceOrderEpisode({
    ...base,
    media: { ...base.media, season: 2, episode: 4 },
    dependencies: { fetchEpisodes: { emby: async () => [item, { ...item, Id: "duplicate" }] } },
  }), /did not identify one exact TVDB episode/);
});

test("Trakt verifies the exact leaf under its parent before returning native coordinates", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let wrongLeaf = false;
  globalThis.fetch = async (url,options) => {
    calls.push({url:String(url),method:options?.method || "GET"});
    const path = new URL(url).pathname;
    let body;
    if (path === "/search/tvdb/42") body = [{episode:{season:4,number:3,ids:{tvdb:42,trakt:900}}}];
    else if (path === "/search/tvdb/100") body = [{show:{ids:{tvdb:100,trakt:200,tmdb:300}}}];
    else if (path === "/shows/200") body = {ids:{tvdb:100,trakt:200,tmdb:300}};
    else if (path === "/shows/200/seasons/4/episodes/3") body = {ids:{tvdb:42,trakt:wrongLeaf ? 901 : 900}};
    else throw new Error(`Unexpected read ${path}`);
    return new Response(JSON.stringify(body),{headers:{"Content-Type":"application/json"}});
  };
  const options = {aired:{id:42,seriesId:100,season:1,episode:2},media:{syncTargets:["trakt"]},config:{},dependencies:{watchedPlayedSyncEnabled:()=>true,listTrackerConnections:()=>[{provider:"trakt",status:"connected"}],getTrackerConnection:()=>({clientId:"client",accessToken:"token"}),hydrateTraktAppCredentials:c=>c}};
  try {
    const result = await resolveEpisodeOrderTargets(options);
    assert.equal(result.targets.trakt.season,4);
    assert.equal(result.targets.trakt.episode,3);
    wrongLeaf = true;
    await assert.rejects(resolveEpisodeOrderTargets(options),/does not belong to the verified parent/);
    assert.ok(calls.every(call=>call.method === "GET"));
  } finally { globalThis.fetch = previousFetch; }
});

test("unwatch preflight uses unwatch roles rather than watched roles", async () => {
  const options = {aired:{id:42,seriesId:100,season:1,episode:2},config:{emby:{baseUrl:"https://emby.example",apiKey:"key",userId:"user",sync:{preset:"custom",watched:"off",unwatched:"receive"}}},dependencies:{watchedPlayedSyncEnabled:()=>true,listTrackerConnections:()=>[],fetchEpisodes:{emby:async()=>[{Id:"native",ParentIndexNumber:4,IndexNumber:3,ProviderIds:{Tvdb:"42"}}]}}};
  assert.deepEqual((await resolveEpisodeOrderTargets({...options,stateType:"watched"})).providerItems,{});
  assert.deepEqual((await resolveEpisodeOrderTargets({...options,stateType:"unwatched"})).providerItems,{emby:["native"]});
});
