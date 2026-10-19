import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.history = { state: {} };
globalThis.window = { addEventListener() {} };
globalThis.document = { addEventListener() {} };

const { state } = await import("../public/modules/state.js?v=1.1.2.0.0");
const {
  groupManualWatchReviews,
  groupReviewsByEpisode,
  groupReviewsBySeason,
  initManualWatchReview,
  loadManualWatchReview,
  orderManualWatchReviewGroups,
  reviewActionScopeLabel,
  manualWatchReviewConfirmation,
  manualWatchReviewNearbyLabel,
  manualWatchReviewFailureOptions,
  buildManualWatchReviewEpisodeCatalog,
  manualWatchReviewEpisodeStatusLabel,
  stopManualWatchReviewPolling,
  manualWatchReviewGroupShowIdentity,
  manualWatchReviewShowLookupUrl,
} = await import("../public/modules/manual-watch-review.js");
const { posterUrlFor } = await import("../public/modules/images.js?v=1.1.2.0.0");

test("manual watch review groups preserve newest incoming order and sort episodes within a show", () => {
  const reviews = [
    { id: "zeta-2", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 2 },
    { id: "alpha-1", media_type: "episode", show_title: "Alpha Show", season: 1, episode: 1 },
    { id: "zeta-1", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 1 },
  ];

  const groups = groupManualWatchReviews(reviews);

  assert.deepEqual(groups.map((group) => group.title), ["Zeta Show", "Alpha Show"]);
  assert.deepEqual(groups[0].reviews.map((review) => review.episode), [1, 2]);
});

test("a show group whose title two shows share looks its show up by proven ids, never by title alone", () => {
  // Live: the 2001 Scrubs group drew the 2026 reboot's poster from a title lookup.
  const plex = { id: "p", media_type: "episode", show_title: "Scrubs", season: 1, episode: 23, show_title_ambiguous: true, media: {} };
  const emby = { ...plex, id: "e", proven_show_ids: { tmdb: "4556", tvdb: "76156" } };
  const proven = { key: "show:scrubs", title: "Scrubs", reviews: [plex, emby] };
  assert.deepEqual(manualWatchReviewGroupShowIdentity(proven).ids, { imdb: "", tmdb: "4556", tvdb: "76156" });
  assert.equal(manualWatchReviewShowLookupUrl(proven), "/api/show?tmdbId=4556&tvdbId=76156");

  const unproven = { key: "show:scrubs", title: "Scrubs", reviews: [plex] };
  const identity = manualWatchReviewGroupShowIdentity(unproven);
  assert.equal(identity.ambiguous, true);
  assert.equal(Boolean(identity.ids.imdb || identity.ids.tmdb || identity.ids.tvdb), false);

  const conflicting = { ...proven, reviews: [emby, { ...emby, id: "x", proven_show_ids: { tmdb: "295778" } }] };
  assert.deepEqual(manualWatchReviewGroupShowIdentity(conflicting).ids, { imdb: "", tmdb: "", tvdb: "" });

  const unique = { key: "show:zeta", title: "Zeta Show", reviews: [{ id: "z", media_type: "episode", show_title: "Zeta Show", media: {} }] };
  assert.equal(manualWatchReviewShowLookupUrl(unique), "/api/show?title=Zeta+Show");
});

test("manual watch review keeps a show in place after removing its first episode", () => {
  const reviews = [
    { id: "zeta-2", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 2 },
    { id: "alpha-1", media_type: "episode", show_title: "Alpha Show", season: 1, episode: 1 },
    { id: "zeta-1", media_type: "episode", show_title: "Zeta Show", season: 1, episode: 1 },
  ];
  const initialGroups = groupManualWatchReviews(reviews);
  const afterRemoval = groupManualWatchReviews(reviews.filter((review) => review.id !== "zeta-2"));

  const stableGroups = orderManualWatchReviewGroups(
    afterRemoval,
    initialGroups.map((group) => group.key),
  );

  assert.deepEqual(stableGroups.map((group) => group.title), ["Zeta Show", "Alpha Show"]);
});

test("manual watch review separates season groups and names their action scope", () => {
  const seasons = groupReviewsBySeason([
    { id: "s2e1", media_type: "episode", season: 2, episode: 1 },
    { id: "s1e2", media_type: "episode", season: 1, episode: 2 },
    { id: "s1e1", media_type: "episode", season: 1, episode: 1 },
  ]);

  assert.deepEqual(seasons.map((season) => [season.title, season.reviews.length]), [
    ["Season 2", 1],
    ["Season 1", 2],
  ]);
  assert.equal(reviewActionScopeLabel("show", "now"), "Mark all reviewed episodes watched");
  assert.equal(reviewActionScopeLabel("show", "dismiss"), "Mark all reviewed episodes unwatched");
  assert.equal(reviewActionScopeLabel("season", "now", "Emby", "Season 2"), "Mark reviewed Season 2 episodes watched");
  assert.equal(reviewActionScopeLabel("season", "dismiss", "Emby", "Season 2"), "Mark reviewed Season 2 episodes unwatched");
});

test("manual watch review combines provider records for the same episode", () => {
  const episodes = groupReviewsByEpisode([
    { id: "emby-s12e3", media_type: "episode", season: 12, episode: 3, episode_title: "Course", source: "emby" },
    { id: "plex-s12e3", media_type: "episode", season: 12, episode: 3, episode_title: "Course", source: "plex" },
  ]);

  assert.equal(episodes.length, 1);
  assert.deepEqual(episodes[0].sources, ["Emby", "Plex"]);
  assert.deepEqual(episodes[0].reviews.map((review) => review.id), ["emby-s12e3", "plex-s12e3"]);
});

test("manual watch review builds a full season catalog with local status and pending actions", () => {
  const pending = {
    id: "emby-s2e2",
    media_type: "episode",
    show_title: "Foodtopia",
    season: 2,
    episode: 2,
    episode_title: "Tenth Course",
    release_date: "2025-08-13",
    source: "emby",
  };
  const catalog = buildManualWatchReviewEpisodeCatalog({
    seasonNumber: 2,
    showTitle: "Foodtopia",
    pendingReviews: [pending],
    metadataEpisodes: [
      { episode_number: 1, name: "Ninth Course", air_date: "2025-08-13" },
      { episode_number: 2, name: "Tenth Course", air_date: "2025-08-13" },
      { episode_number: 3, name: "Eleventh Course", air_date: "2025-08-20" },
    ],
    localEpisodes: [
      { season: 2, episode: 1, episode_title: "Ninth Course", watched_at: "2025-09-07T18:57:00.000Z", sync_action: "watched" },
      { season: 2, episode: 3, episode_title: "Eleventh Course", watched_at: "2025-09-08T18:57:00.000Z", sync_action: "unwatched" },
    ],
  });

  assert.deepEqual(catalog.map((episode) => [episode.episode, episode.title, episode.state]), [
    [1, "Ninth Course", "watched"],
    [2, "Tenth Course", "pending"],
    [3, "Eleventh Course", "unwatched"],
  ]);
  assert.equal(catalog[0].release_date, "2025-08-13");
  assert.equal(catalog[2].state_at, "2025-09-08T18:57:00.000Z");
  assert.equal(catalog[1].pendingReview.reviews[0].id, "emby-s2e2");
  assert.match(manualWatchReviewEpisodeStatusLabel(catalog[0]), /^Watched - /);
  assert.equal(manualWatchReviewEpisodeStatusLabel(catalog[1]), "Marked watched on Emby");
  assert.match(manualWatchReviewEpisodeStatusLabel(catalog[2]), /^Unwatched - /);
});

test("manual watch review show posters do not reuse an episode thumbnail cache entry", () => {
  state.posterLookupCache.set("review-poster", "/media/posters/episode-thumb.webp");
  assert.equal(
    posterUrlFor({
      id: "review-poster",
      poster_url: "/media/posters/episode-thumb.webp",
      show_poster_url: "/media/posters/foodtopia.webp",
      prefer_show_poster: true,
    }),
    "/media/posters/foodtopia.webp",
  );
  state.posterLookupCache.delete("review-poster");
});

test("manual watch review confirmation protects single-item unwatched decisions", () => {
  assert.deepEqual(manualWatchReviewConfirmation({
    action: "dismiss",
    title: "Lioness - S03E07",
    source: "Plex",
  }), {
    title: "Mark unwatched",
    body: "Keep “Lioness - S03E07” unwatched and mark it unplayed on Plex, Emby, and Jellyfin?",
    confirmLabel: "Mark unwatched",
    danger: true,
  });
});

test("manual watch review confirmation describes grouped watch decisions", () => {
  const prompt = manualWatchReviewConfirmation({
    action: "approve",
    mode: "episode_timing",
    title: "Lioness",
    count: 3,
  });

  assert.equal(prompt.title, "Confirm manual watch decisions");
  assert.match(prompt.body, /3 episodes from “Lioness”/);
  assert.match(prompt.body, /episode timing/);
  assert.equal(prompt.confirmLabel, "Confirm all decisions");
  assert.equal(prompt.danger, false);
});

test("manual watch review labels adjacent episode watch state", () => {
  assert.equal(
    manualWatchReviewNearbyLabel("before", { code: "S01E01", watched: true }),
    "Before S01E01: watched",
  );
  assert.equal(
    manualWatchReviewNearbyLabel("after", { code: "S01E03", state: "unknown" }),
    "After S01E03: not marked watched",
  );
  assert.equal(
    manualWatchReviewNearbyLabel("before", null),
    "Before: no earlier episode",
  );
});

test("manual watch review failure details identify the provider cause and retry", () => {
  const error = Object.assign(
    new Error('Could not complete the unwatched correction for "Castle Rock - S01E01". Failed on Jellyfin: Upstream request failed (connection refused). The review remains pending.'),
    {
      failureTargets: [{
        target: "jellyfin",
        provider: "Jellyfin",
        status: "error",
        detail: "Upstream request failed (connection refused)",
      }],
    },
  );
  const options = manualWatchReviewFailureOptions({
    reviews: [{ id: "review-castle-rock", media_type: "episode", show_title: "Castle Rock", season: 1, episode: 1, source: "plex" }],
    action: "dismiss",
    scope: "episode",
  }, error);

  assert.equal(options.title, "Unwatch correction failed");
  assert.equal(options.context.affectedMedia, "Castle Rock - S01E01");
  assert.equal(options.context.provider, "Jellyfin");
  assert.match(options.context.failureReason, /connection refused/);
  assert.equal(options.retry.endpoint, "/api/manual-watch-review/review-castle-rock/dismiss");
  assert.match(options.recommendations[0], /Jellyfin/);
});

test("manual watch review does not repaint an acted-on item from a stale full refresh", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  t.after(() => {
    stopManualWatchReviewPolling();
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  const makeElement = () => ({
    dataset: {},
    innerHTML: "",
    classList: { toggle() {} },
    addEventListener(type, handler) {
      this.handlers = this.handlers || {};
      this.handlers[type] = handler;
    },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  });
  const rows = makeElement();
  const body = makeElement();
  const document = {
    body,
    querySelector(selector) {
      return selector === "#manualWatchReviewRows" ? rows : null;
    },
    querySelectorAll() { return []; },
  };
  globalThis.document = document;
  globalThis.window = {
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
  };

  const review = {
    id: "review-stale-refresh",
    media_type: "movie",
    title: "Stale refresh movie",
    source: "plex",
  };
  state.token = "test-token";
  state.activeView = "manualWatchReview";
  state.manualWatchReviews = [review];
  state.manualWatchReviewCount = 1;
  state.manualWatchReviewLoaded = true;
  state.manualWatchReviewLoading = false;
  state.manualWatchReviewError = "";

  let resolvePost;
  const fullRefreshes = [];
  globalThis.fetch = (url, options = {}) => {
    if (options.method === "POST") {
      return new Promise((resolve) => { resolvePost = resolve; });
    }
    return new Promise((resolve) => { fullRefreshes.push(resolve); });
  };

  initManualWatchReview({ openConfirmDialog: async () => true });
  const card = makeElement();
  card.dataset.manualWatchReviewId = review.id;
  const button = makeElement();
  button.dataset.manualWatchReviewAction = "approve";
  button.dataset.manualWatchReviewMode = "now";
  button.disabled = false;
  button.closest = (selector) => selector.includes("data-manual-watch-review") ? card : null;
  const target = {
    closest(selector) {
      if (selector === "button" || selector.includes("data-manual-watch-review-action")) return button;
      return null;
    },
  };
  rows.handlers.click({ target, button: 0 });

  for (let attempt = 0; attempt < 10 && !resolvePost; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(typeof resolvePost, "function");
  assert.equal(state.manualWatchReviews.length, 0, "the action should remove the row immediately");

  // The first request was started before the action completed and returns an
  // empty snapshot. A newer request then returns a stale copy of the item.
  const olderRefresh = loadManualWatchReview();
  resolvePost({ ok: true, status: 200, async json() { return { ok: true, count: 0 }; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newerRefresh = loadManualWatchReview();
  assert.equal(fullRefreshes.length, 2);

  fullRefreshes[0]({ ok: true, status: 200, async json() { return { ok: true, count: 0, reviews: [] }; } });
  await olderRefresh;
  fullRefreshes[1]({ ok: true, status: 200, async json() { return { ok: true, count: 1, reviews: [review] }; } });
  await newerRefresh;

  assert.deepEqual(state.manualWatchReviews, [], "a stale response must not repaint the acted-on row");
});

test("manual watch review summary still counts a new review after an earlier one was approved", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  t.after(() => {
    stopManualWatchReviewPolling();
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  const makeElement = () => ({
    dataset: {},
    innerHTML: "",
    classList: { toggle() {} },
    addEventListener(type, handler) {
      this.handlers = this.handlers || {};
      this.handlers[type] = handler;
    },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  });
  const rows = makeElement();
  globalThis.document = {
    body: makeElement(),
    querySelector(selector) {
      return selector === "#manualWatchReviewRows" ? rows : null;
    },
    querySelectorAll() { return []; },
  };
  globalThis.window = {
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
  };

  const approved = { id: "review-approved-earlier", media_type: "movie", title: "Approved movie", source: "plex" };
  state.token = "test-token";
  state.activeView = "manualWatchReview";
  state.manualWatchReviews = [approved];
  state.manualWatchReviewCount = 1;
  state.manualWatchReviewLoaded = true;
  state.manualWatchReviewLoading = false;
  state.manualWatchReviewError = "";

  let resolvePost;
  globalThis.fetch = (url, options = {}) => {
    if (options.method === "POST") return new Promise((resolve) => { resolvePost = resolve; });
    // The provider flag for a different title arrives after the approval:
    // the server now holds only that one new review.
    return Promise.resolve({
      ok: true,
      status: 200,
      async json() { return { ok: true, count: 1, reviewCount: 1, ids: ["review-new-flag"], reviews: [] }; },
    });
  };

  initManualWatchReview({ openConfirmDialog: async () => true });
  const card = makeElement();
  card.dataset.manualWatchReviewId = approved.id;
  const button = makeElement();
  button.dataset.manualWatchReviewAction = "approve";
  button.dataset.manualWatchReviewMode = "now";
  button.disabled = false;
  button.closest = (selector) => selector.includes("data-manual-watch-review") ? card : null;
  rows.handlers.click({
    target: {
      closest(selector) {
        if (selector === "button" || selector.includes("data-manual-watch-review-action")) return button;
        return null;
      },
    },
    button: 0,
  });
  for (let attempt = 0; attempt < 10 && !resolvePost; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  resolvePost({ ok: true, status: 200, async json() { return { ok: true, count: 0 }; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.manualWatchReviewCount, 0);

  // The user moves to another page; only the sidebar summary poll runs.
  state.activeView = "playlists";
  await loadManualWatchReview({ summaryOnly: true });
  assert.equal(state.manualWatchReviewCount, 1, "the approved review is no longer on the server, so it must not cancel out the new one");
});
