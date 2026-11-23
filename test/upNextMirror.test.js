import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-up-next-mirror-");
const { normalizeUpNextCandidate } = await import("../server/src/utils/upNextIdentity.js");
const { checkUpNextMirrorEnable, commitUpNextMirrorEnable, planUpNextMirrorHides, previewUpNextMirror, validateUpNextMirrorEnable } = await import("../server/src/utils/upNextMirror.js");
const { recordUpNextDismissal } = await import("../server/src/utils/upNextDismissals.js");
const { dropTitle } = await import("../server/src/utils/droppedTitles.js");
const { completeUpNextProviderFeed, listActiveUpNextProviderItems, recordUpNextProviderFeed, startUpNextProviderFeed } = await import("../server/src/utils/upNextRepository.js");
const { loadMediaConfig, normalizeUpNextSyncSection, saveMediaConfig } = await import("../server/src/utils/configStore.js");
const { buildUpNextSyncStatusSummary, readUpNextSyncStatus, recordUpNextSyncStatus } = await import("../server/src/utils/upNextAutoSync.js");
const { upsertPlaystateForMediaSync } = await import("../server/src/utils/dataRepo.js");
const { refreshProviderRail, syncUpNextToProviders } = await import("../server/src/utils/upNextProviderSync.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const {
  isRecentOutboundJellyfinNextUpNudge,
  isRecentOutboundPlayedEcho,
  isRecentOutboundPlayedFlagEcho,
  isRecentOutboundRailRefresh,
  isRecentOutboundUnplayedFlagEcho,
} = await import("../server/src/utils/syncOrchestrator.js");

const now = Date.parse("2026-11-18T12:00:00Z");
const builtAt = now - 60_000;
const episode = (title, tvdb, number = 1) => normalizeUpNextCandidate({
  provider: "plex", feed_kind: "resume", provider_item_id: `${tvdb}-${number}`,
  media_type: "episode", show_title: title, season: 1, episode: number, show_ids: { tvdb },
});

test("Mirror protects recent and unknown items, genuine progress and dual-lane rewatches", () => {
  const dismissed = episode("Dismissed", "123");
  const recent = episode("Recent", "456");
  const rewatch = episode("Rewatch", "789");
  const extra = episode("Unknown", "100");
  const changed = episode("Changed progress", "101");
  for (const item of [dismissed, recent, changed]) recordUpNextDismissal(item, { now: now - 30_000 });
  const prior = [dismissed, rewatch, extra, changed].map((item) => ({ ...item, observed_at: now - 60 * 60_000 }));
  prior.push({ ...recent, observed_at: now - 10 * 60_000 });
  const options = {
    provider: "plex", visible: [dismissed, recent, rewatch, extra, { ...changed, position_ms: 5000 }], prior, builtAt, now,
    desired: [{ ...episode("Rewatch", "789", 2), up_next_lane: "new" }],
  };
  assert.deepEqual(planUpNextMirrorHides(options), [{ providerItemId: "123-1", title: dismissed.title, reason: "Dismissed" }]);
  assert.deepEqual(planUpNextMirrorHides({ ...options, provider: "jellyfin" }), []);
  assert.deepEqual(planUpNextMirrorHides({ ...options, builtAt: now - 2 * 60 * 60_000 }), []);
});

test("Mirror approval requires a complete preview for the current destination and is consumed", async () => {
  await saveMediaConfig({ plex: { baseUrl: "http://mirror-plex.test", token: "fixture-token" }, upNextSync: { enabled: false } });
  const mirrorConfig = { upNextSync: { mirror: { plex: true } } };
  assert.equal(await validateUpNextMirrorEnable(mirrorConfig), false);
  const config = await loadMediaConfig();
  const before = await previewUpNextMirror(config, "plex", { items: [], builtAt });
  assert.equal(before.complete, false);
  assert.equal(await validateUpNextMirrorEnable({ ...mirrorConfig, upNextMirrorPreview: { plex: before.token } }), false);
  recordUpNextProviderFeed("plex", "resume", []);
  const preview = await previewUpNextMirror(config, "plex", { items: [], builtAt });
  assert.equal(preview.complete, true);
  const approval = { ...mirrorConfig, upNextMirrorPreview: { plex: preview.token } };
  assert.equal(await validateUpNextMirrorEnable({ ...approval, plex: { baseUrl: "http://another-plex.test" } }), false);
  assert.equal(await validateUpNextMirrorEnable(approval), true);
  assert.equal(await validateUpNextMirrorEnable(approval), false);
});

test("checkUpNextMirrorEnable is read-only until commitUpNextMirrorEnable runs", async () => {
  await saveMediaConfig({ plex: { baseUrl: "http://mirror-plex-2.test", token: "fixture-token" }, upNextSync: { enabled: false, mirror: { plex: false } } });
  recordUpNextProviderFeed("plex", "resume", []);
  const config = await loadMediaConfig();
  const preview = await previewUpNextMirror(config, "plex", { items: [], builtAt });
  const approval = { upNextSync: { mirror: { plex: true } }, upNextMirrorPreview: { plex: preview.token } };
  const firstCheck = await checkUpNextMirrorEnable(approval);
  assert.equal(firstCheck.ok, true);
  assert.deepEqual(firstCheck.enabling, ["plex"]);
  // Calling check again still succeeds because commit has not consumed the token yet.
  const secondCheck = await checkUpNextMirrorEnable(approval);
  assert.equal(secondCheck.ok, true);
  await commitUpNextMirrorEnable(secondCheck.enabling, secondCheck.current);
  const afterCommit = await checkUpNextMirrorEnable(approval);
  assert.equal(afterCommit.ok, false);
});

test("normalizeUpNextCandidate preserves up_next_lane across disk cache reload and numeric showOverride IDs survive normalization", () => {
  const rewatch = normalizeUpNextCandidate({
    media_type: "episode",
    show_title: "Lost",
    season: 1,
    episode: 2,
    show_tmdb_id: "4607",
    up_next_lane: "rewatch",
  });
  const fresh = normalizeUpNextCandidate({
    media_type: "episode",
    show_title: "Lost",
    season: 3,
    episode: 1,
    show_tmdb_id: "4607",
    up_next_lane: "new",
  });
  assert.equal(rewatch.up_next_lane, "rewatch");
  assert.equal(fresh.up_next_lane, "new");

  const normalized = normalizeUpNextSyncSection({
    showOverrides: [{ tmdb_id: 1399, tvdb_id: 121361, episodeChoice: "latest_released", placement: "top" }],
  });
  assert.equal(normalized.showOverrides.length, 1);
  assert.equal(normalized.showOverrides[0].tmdb_id, "1399");
  assert.equal(normalized.showOverrides[0].tvdb_id, "121361");
});

test("Mirror hides Dropped, Finished (zero-progress only), and Superseded items while protecting active rewatch progress", () => {
  const droppedShow = episode("Dropped Show", "501");
  dropTitle({ mediaType: "show", title: "Dropped Show", tvdbId: "501" });

  const finishedShowEp = episode("Finished Show", "502");
  const finishedRewatchEp = normalizeUpNextCandidate({
    provider: "emby", feed_kind: "resume", provider_item_id: "502-rewatch",
    media_type: "episode", show_title: "Finished Show", season: 1, episode: 2,
    show_ids: { tvdb: "502" }, position_ms: 90_000, playback_position_known: true,
  });

  const finishedMovie = normalizeUpNextCandidate({
    provider: "emby", feed_kind: "resume", provider_item_id: "mov-1",
    media_type: "movie", title: "Watched Movie", tmdb_id: "9001", position_ms: 0,
  });
  upsertPlaystateForMediaSync({
    type: "movie", title: "Watched Movie",
    ids: { tmdb: "9001" },
  }, "watched", new Date(now - 120_000).toISOString());

  const supersededEp = episode("Advancing Show", "503", 1);
  const desiredNext = episode("Advancing Show", "503", 2);

  const visible = [droppedShow, finishedShowEp, finishedRewatchEp, finishedMovie, supersededEp];
  const prior = visible.map((item) => ({ ...item, observed_at: now - 60 * 60_000 }));
  const hides = planUpNextMirrorHides({
    provider: "emby",
    visible,
    prior,
    desired: [desiredNext],
    finished: [{ show_tvdb_id: "502" }],
    builtAt,
    now,
  });

  assert.deepEqual(
    hides.map(({ providerItemId, reason }) => ({ providerItemId, reason })),
    [
      { providerItemId: "501-1", reason: "Dropped" },
      { providerItemId: "502-1", reason: "Finished" },
      { providerItemId: "mov-1", reason: "Finished" },
      { providerItemId: "503-1", reason: "Superseded" },
    ],
  );
});

test("completeUpNextProviderFeed preserves first-seen observed_at across refreshes and resets on canonical_key change", () => {
  const tNow = Date.now();
  const firstSeen = tNow - 45 * 60_000;
  const secondSeen = tNow - 5 * 60_000;
  const thirdSeen = tNow;

  const gen1 = startUpNextProviderFeed("plex", "resume", { now: firstSeen });
  completeUpNextProviderFeed("plex", "resume", gen1, [
    {
      ratingKey: "item-keep",
      type: "episode",
      grandparentTitle: "Keep Show",
      parentIndex: 1,
      index: 1,
      show_ids: { tvdb: "701" },
    },
  ], { now: firstSeen });

  const gen2 = startUpNextProviderFeed("plex", "resume", { now: secondSeen });
  completeUpNextProviderFeed("plex", "resume", gen2, [
    {
      ratingKey: "item-keep",
      type: "episode",
      grandparentTitle: "Keep Show",
      parentIndex: 1,
      index: 1,
      show_ids: { tvdb: "701" },
    },
  ], { now: secondSeen });

  const afterStay = listActiveUpNextProviderItems().find((row) => row.provider_item_id === "item-keep");
  assert.equal(afterStay.observed_at, firstSeen, "first-seen observed_at stays unchanged when canonical_key stays the same");
  assert.equal(afterStay.last_seen_at, secondSeen, "last_seen_at advances on consecutive refresh");

  // If the same provider item ID switches to a different canonical_key, observed_at resets.
  const gen3 = startUpNextProviderFeed("plex", "resume", { now: thirdSeen });
  completeUpNextProviderFeed("plex", "resume", gen3, [
    {
      ratingKey: "item-keep",
      type: "episode",
      grandparentTitle: "Keep Show",
      parentIndex: 1,
      index: 2,
      show_ids: { tvdb: "701" },
    },
  ], { now: thirdSeen });

  const afterChange = listActiveUpNextProviderItems().find((row) => row.provider_item_id === "item-keep");
  assert.equal(afterChange.observed_at, thirdSeen, "observed_at resets when canonical_key changes");
});

test("recordUpNextSyncStatus preserves hide timestamps and rolling recentMirrorHides across subsequent pushes", async () => {
  const hideAt = now - 10_000;
  const first = buildUpNextSyncStatusSummary({
    mode: "auto",
    providers: ["plex"],
    summary: {
      ok: true,
      pushedProviders: ["plex"],
      mirrorHides: [{ provider: "plex", title: "Hidden Show", reason: "Dismissed", status: "hidden", at: hideAt }],
    },
    itemCount: 5,
    at: hideAt,
  });
  await recordUpNextSyncStatus(first);

  // A subsequent push with no new hides must keep the recent hide log visible.
  const second = buildUpNextSyncStatusSummary({
    mode: "auto",
    providers: ["plex"],
    summary: { ok: true, pushedProviders: ["plex"], mirrorHides: [] },
    itemCount: 5,
    at: now,
  });
  await recordUpNextSyncStatus(second);

  const stored = await readUpNextSyncStatus();
  assert.equal(stored.recentMirrorHides?.length, 1);
  assert.deepEqual(stored.recentMirrorHides[0], {
    provider: "plex",
    title: "Hidden Show",
    reason: "Dismissed",
    status: "hidden",
    at: hideAt,
  });
});

test("Jellyfin date-only Mirror restamp records 10-minute nudge and played-mark echo guards for delayed callbacks", async () => {
  const prevFetch = globalThis.fetch;
  const episodes = [
    { Id: "jf-pred-1", Type: "Episode", Name: "E1", SeriesName: "Delayed Echo Show", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2025-01-01", UserData: { Played: true, PlayCount: 1, PlaybackPositionTicks: 0, LastPlayedDate: "2025-01-03T10:00:00.000Z" } },
    { Id: "jf-target-2", Type: "Episode", Name: "E2", SeriesName: "Delayed Echo Show", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2025-01-02", UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 0 } },
  ];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") return new Response(null, { status: 204 });
    let body = { Items: [] };
    if (url.searchParams.get("AnyProviderIdEquals")) {
      body = { Items: [{ Id: "jf-series-1", Type: "Series", Name: "Delayed Echo Show", ProviderIds: { Tmdb: "80800" } }] };
    } else if (url.searchParams.get("ParentId") === "jf-series-1") {
      body = { Items: episodes, TotalRecordCount: episodes.length };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const config = {
      jellyfin: { baseUrl: "http://jf-echo-mirror.test", apiKey: "k", userId: "u1" },
    };
    const item = {
      id: "episode|series:tmdb:80800|s:1|e:2",
      media_type: "episode",
      queue_kind: "next_up",
      title: "Delayed Echo Show - S01E02",
      show_title: "Delayed Echo Show",
      season: 1,
      episode: 2,
      show_tmdb_id: "80800",
      position_ms: 0,
    };
    const result = await refreshProviderRail({
      provider: "jellyfin",
      config,
      targets: [{ item, providerItemId: "jf-target-2" }],
      mirrorOrderIds: new Set(["jf-target-2"]),
    });
    assert.equal(result.refreshed_count, 1);

    const loopStore = createLoopStore();
    const callbackMedia = {
      type: "episode",
      itemId: "jf-pred-1",
      showTitle: "Delayed Echo Show",
      season: 1,
      episode: 1,
      ids: { tmdb: "80800" },
      playedFlagOnly: true,
    };
    // Simulate a delayed webhook arriving 4 minutes later (beyond the 2-minute rail_refresh window).
    const delayedNow = Date.now() + 4 * 60 * 1000;
    assert.equal(await isRecentOutboundRailRefresh(callbackMedia, "jellyfin", loopStore, { now: delayedNow }), false);
    assert.equal(await isRecentOutboundJellyfinNextUpNudge(callbackMedia, loopStore, { now: delayedNow }), true);
    assert.equal(await isRecentOutboundPlayedFlagEcho(callbackMedia, "jellyfin", loopStore, { now: delayedNow }), true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("Mirror off performs zero hides, preview matches executed hides, partial feed suppresses hides, and stale-aborted hides exclude provider from pushedProviders", async () => {
  const prevFetch = globalThis.fetch;
  const hideCalls = [];
  let failEmbyNextUp = false;
  const matureAt = Date.now() - 60 * 60_000;

  const embyResumeItem = {
    Id: "emby-hide-1",
    Type: "Episode",
    Name: "E1",
    SeriesId: "emby-series-hide",
    SeriesName: "Hide Fixture Show",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    SeriesProviderIds: { Tvdb: "91901" },
    ProviderIds: { Tvdb: "9190101" },
    UserData: { Played: false, PlaybackPositionTicks: 0, LastPlayedDate: new Date(matureAt).toISOString() },
  };
  const dismissedEp = normalizeUpNextCandidate({
    provider: "emby",
    feed_kind: "resume",
    provider_item_id: "emby-hide-1",
    media_type: "episode",
    show_title: "Hide Fixture Show",
    season: 1,
    episode: 1,
    show_tvdb_id: "91901",
  });
  recordUpNextDismissal(dismissedEp, { now: Date.now() - 30_000 });

  // Seed a mature prior observation on Emby resume (>30 min old) and empty next_up.
  const seedEmbyFeeds = () => {
    const gClear = startUpNextProviderFeed("emby", "resume", { now: matureAt - 1000 });
    completeUpNextProviderFeed("emby", "resume", gClear, [], { now: matureAt - 1000, triggerAutoSync: false });
    const g1 = startUpNextProviderFeed("emby", "resume", { now: matureAt });
    completeUpNextProviderFeed("emby", "resume", g1, [{ ...embyResumeItem, show_ids: { tvdb: "91901" } }], { now: matureAt, triggerAutoSync: false });
    const g2 = startUpNextProviderFeed("emby", "next_up", { now: matureAt });
    completeUpNextProviderFeed("emby", "next_up", g2, [], { now: matureAt, triggerAutoSync: false });
  };
  seedEmbyFeeds();

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    if (method === "POST" && url.pathname.includes("/HideFromResume")) {
      hideCalls.push(url.pathname);
      return new Response(null, { status: 204 });
    }
    if (url.pathname.includes("/Shows/NextUp")) {
      if (failEmbyNextUp) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.includes("/Items/Resume") || url.searchParams.get("Filters") === "IsResumable") {
      return new Response(JSON.stringify({ Items: [embyResumeItem] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname.includes("/Items/emby-series-hide") || url.searchParams.get("Ids")?.includes("emby-series-hide")) {
      return new Response(JSON.stringify({ Items: [{ Id: "emby-series-hide", Type: "Series", Name: "Hide Fixture Show", ProviderIds: { Tvdb: "91901" } }], Id: "emby-series-hide", Type: "Series", Name: "Hide Fixture Show", ProviderIds: { Tvdb: "91901" } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const embyCfg = { baseUrl: "http://emby-mirror-hide.test", apiKey: "emby-k", userId: "emby-u" };
    await saveMediaConfig({ emby: embyCfg, upNextSync: { enabled: true, mirror: { emby: false } } });
    const builtNow = Date.now() - 10_000;

    // 1) Mirror OFF: zero hides even though item is mature & dismissed (entry 36).
    const offSummary = await syncUpNextToProviders({
      desiredItems: [],
      builtAt: builtNow,
      config: await loadMediaConfig(),
      providers: ["emby"],
    });
    assert.equal(hideCalls.length, 0);
    assert.deepEqual(offSummary.mirrorHides, []);

    // 2) Preview + approval: preview matches planned hide.
    seedEmbyFeeds();
    const preview = await previewUpNextMirror(await loadMediaConfig(), "emby", { items: [], builtAt: builtNow });
    assert.equal(preview.complete, true);
    assert.equal(preview.hides.length, 1);
    assert.equal(preview.hides[0].reason, "Dismissed");
    assert.equal(await validateUpNextMirrorEnable({ upNextSync: { mirror: { emby: true } }, upNextMirrorPreview: { emby: preview.token } }), true);
    await saveMediaConfig({ upNextSync: { enabled: true, mirror: { emby: true } } });

    // 3) Partial feed (next_up 503): suppresses all hides.
    seedEmbyFeeds();
    failEmbyNextUp = true;
    const partialSummary = await syncUpNextToProviders({
      desiredItems: [],
      builtAt: builtNow,
      config: await loadMediaConfig(),
      providers: ["emby"],
    });
    assert.equal(hideCalls.length, 0, "partial feed must suppress hides");
    assert.deepEqual(partialSummary.mirrorHides, []);
    failEmbyNextUp = false;

    // 4) Stale before hides: skips hides AND excludes emby from pushedProviders so retry runs.
    seedEmbyFeeds();
    const unlockedConfig = await loadMediaConfig();
    unlockedConfig.emby = { ...unlockedConfig.emby, libraryMonitoringEnforced: false, monitoredLibraryIds: null };
    const staleSummary = await syncUpNextToProviders({
      desiredItems: [],
      builtAt: builtNow,
      config: unlockedConfig,
      providers: ["emby"],
      isStale: () => true,
    });
    assert.equal(hideCalls.length, 0);
    assert.equal(staleSummary.pushedProviders.includes("emby"), false, "stale-aborted hides must keep provider out of pushedProviders");

    // 5) Unselected library skips hide cleanly (zero hides); with library monitoring off, executes exact previewed hide and records timestamp.
    seedEmbyFeeds();
    const skippedSummary = await syncUpNextToProviders({
      desiredItems: [],
      builtAt: builtNow,
      config: await loadMediaConfig(),
      providers: ["emby"],
    });
    assert.equal(hideCalls.length, 0);
    assert.equal(skippedSummary.mirrorHides.every((entry) => entry.status === "skipped"), true);
    assert.equal(skippedSummary.pushedProviders.includes("emby"), true);

    seedEmbyFeeds();
    const onSummary = await syncUpNextToProviders({
      desiredItems: [],
      builtAt: builtNow,
      config: unlockedConfig,
      providers: ["emby"],
    });
    assert.equal(hideCalls.length, 1);
    assert.equal(onSummary.mirrorHides.length, 1);
    assert.equal(onSummary.mirrorHides[0].title, preview.hides[0].title);
    assert.equal(onSummary.mirrorHides[0].reason, preview.hides[0].reason);
    assert.equal(onSummary.mirrorHides[0].status, "hidden");
    assert.ok(onSummary.mirrorHides[0].at > 0);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("Plex and Emby rail restamps prime played, unplayed-flag, and rail-refresh echo guards", async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = String(options.method || "GET").toUpperCase();
    if (url.hostname === "plex-echo.test") {
      if (url.pathname === "/library/all") {
        return new Response(JSON.stringify({
          MediaContainer: {
            Metadata: [{ ratingKey: "plex-show", type: "show", title: "Echo Show" }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.includes("/library/metadata/plex-show/allLeaves")) {
        return new Response(JSON.stringify({
          MediaContainer: {
            Metadata: [
              { ratingKey: "plex-pred", type: "episode", title: "Echo Show - S01E01", grandparentTitle: "Echo Show", parentIndex: 1, index: 1, viewCount: 1, viewOffset: 0, lastViewedAt: 1700000000, originallyAvailableAt: "2025-01-01" },
              { ratingKey: "plex-target", type: "episode", title: "Echo Show - S01E02", grandparentTitle: "Echo Show", parentIndex: 1, index: 2, viewCount: 0, viewOffset: 0, originallyAvailableAt: "2025-01-02" },
            ],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("", { status: 200 });
    }
    if (url.hostname === "emby-echo.test") {
      if (method !== "GET") return new Response(null, { status: 204 });
      if (url.searchParams.get("AnyProviderIdEquals")) {
        return new Response(JSON.stringify({ Items: [{ Id: "emby-show", Type: "Series", Name: "Echo Show", ProviderIds: { Tmdb: "90900" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.searchParams.get("ParentId") === "emby-show") {
        return new Response(JSON.stringify({
          Items: [
            { Id: "emby-pred", Type: "Episode", SeriesName: "Echo Show", ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: "2025-01-01", UserData: { Played: true, PlayCount: 1, LastPlayedDate: "2025-01-03T10:00:00.000Z" } },
            { Id: "emby-target", Type: "Episode", SeriesName: "Echo Show", ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: "2025-01-02", UserData: { Played: false, PlayCount: 0 } },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ Items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("", { status: 404 });
  };
  try {
    const item = {
      id: "episode|series:tmdb:90900|s:1|e:2",
      media_type: "episode",
      queue_kind: "next_up",
      title: "Echo Show - S01E02",
      show_title: "Echo Show",
      season: 1,
      episode: 2,
      show_tmdb_id: "90900",
      position_ms: 0,
    };
    const cfg = {
      plex: { baseUrl: "http://plex-echo.test", token: "pt" },
      emby: { baseUrl: "http://emby-echo.test", apiKey: "ek", userId: "eu" },
      tuning: { plexHistoricalWatchedSync: true },
    };
    const [plexRes, embyRes] = await Promise.all([
      refreshProviderRail({ provider: "plex", config: cfg, targets: [{ item, providerItemId: "plex-target" }], mirrorOrderIds: new Set(["plex-target"]) }),
      refreshProviderRail({ provider: "emby", config: cfg, targets: [{ item, providerItemId: "emby-target" }], mirrorOrderIds: new Set(["emby-target"]) }),
    ]);
    assert.equal(plexRes.refreshed_count, 1);
    assert.equal(embyRes.refreshed_count, 1);

    const loopStore = createLoopStore();
    const plexCallback = { type: "episode", itemId: "plex-pred", showTitle: "Echo Show", season: 1, episode: 1, ids: { tmdb: "90900" }, playedFlagOnly: true };
    const embyCallback = { type: "episode", itemId: "emby-pred", showTitle: "Echo Show", season: 1, episode: 1, ids: { tmdb: "90900" }, playedFlagOnly: true };

    assert.equal(await isRecentOutboundPlayedEcho(plexCallback, "plex", loopStore), true);
    assert.equal(await isRecentOutboundUnplayedFlagEcho(plexCallback, "plex", loopStore), true);
    assert.equal(await isRecentOutboundRailRefresh(plexCallback, "plex", loopStore), true);

    assert.equal(await isRecentOutboundPlayedEcho(embyCallback, "emby", loopStore), true);
    assert.equal(await isRecentOutboundPlayedFlagEcho(embyCallback, "emby", loopStore), true);
    assert.equal(await isRecentOutboundUnplayedFlagEcho(embyCallback, "emby", loopStore), true);
    assert.equal(await isRecentOutboundRailRefresh(embyCallback, "emby", loopStore), true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
