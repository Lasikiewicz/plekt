import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const classes = new Set();
const makeEl = () => ({ innerHTML: "", dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {}, appendChild() {}, closest: () => null, contains: () => false, getBoundingClientRect: () => ({}) });
document.documentElement = { dataset: {}, style: {}, setAttribute() {}, addEventListener() {}, classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle() {} } };
const byId = {};
document.getElementById = (id) => (byId[id] ||= makeEl());
document.querySelector = () => null;
document.querySelectorAll = () => [];
document.createElement = makeEl;

const { episodeReviewNoticeHtml } = await import("../public/modules/episode-order.js");
const { renderShowModalContent } = await import("../public/modules/media-detail-show.js");
const { elements, state } = await import("../public/modules/state.js");

test("the review notice is empty when no watches need review", () => {
  assert.equal(episodeReviewNoticeHtml(0), "");
  assert.equal(episodeReviewNoticeHtml(undefined), "");
});

test("the review notice counts hidden watches and says nothing was changed", () => {
  const one = episodeReviewNoticeHtml(1);
  assert.match(one, /1 earlier watch is hidden/);
  assert.match(one, /Nothing was changed or removed/);
  assert.match(episodeReviewNoticeHtml(10), /10 earlier watches are hidden/);
});

test("TVDB episode stills in a chosen order render through the artwork proxy", () => {
  const root = makeEl();
  elements.modalBody = root; elements.explorerPanel = root; document.body = root;
  const previous = state.hideEpisodeSpoilers;
  state.hideEpisodeSpoilers = false;
  try {
    renderShowModalContent({ title: "Futurama", tmdb_id: "615", tvdb_id: "73871", episodes: [] }, {
      activeSeasonNum: 1,
      tmdbData: { id: 615, seasons: [{ season_number: 1, episode_count: 1 }], external_ids: { tvdb_id: "73871" } },
      seasonDetailsByNumber: new Map([[1, { episodes: [{ id: 1, episode_number: 1, name: "DVD 1", still_path: "/banners/series/73871/episodes/603977d5b6c1a.jpg" }] }]]),
    });
  } finally { state.hideEpisodeSpoilers = previous; }
  const html = root.innerHTML;
  assert.match(html, /<img class="episode-thumb" src="\/api\/remote-artwork\?variant=poster&amp;url=https%3A%2F%2Fartworks\.thetvdb\.com%2Fbanners%2Fseries%2F73871%2Fepisodes%2F603977d5b6c1a\.jpg"/);
  assert.doesNotMatch(html, /image\.tmdb\.org\/t\/p\/w300\/banners/);
});

test("watches without order provenance are not shown as duplicate episode cards", () => {
  const root = makeEl();
  elements.modalBody = root; elements.explorerPanel = root; document.body = root;
  const watch = (id, title, episode, extra) => ({ id, title, show_title: "Futurama", media_type: "episode", season: 1, episode, watched_at: "2025-08-15T10:12:00Z", sync_action: "watched", ...extra });
  renderShowModalContent({
    title: "Futurama", tmdb_id: "615", tvdb_id: "73871",
    season_numbering: { source: "dvd", translate: true, ready: true, pairs: {} },
    episodes: [
      watch("a", "Episode 01", 1, { numbering_review: true }),
      watch("b", "Episode 02", 2, { numbering_review: true }),
      watch("c", "Space Pilot", 3, { display_season: 1, display_episode: 3 }),
    ],
  }, {
    activeSeasonNum: 1,
    tmdbData: { id: 615, seasons: [{ season_number: 1, episode_count: 3 }], external_ids: { tvdb_id: "73871" } },
    seasonDetailsByNumber: new Map([[1, { episodes: [1, 2, 3].map((n) => ({ id: n, episode_number: n, name: `DVD ${n}` })) }]]),
  });
  const html = root.innerHTML;
  assert.doesNotMatch(html, /Unmatched/);
  assert.match(html, /2 earlier watches are hidden/);
  assert.match(html, /1 of 3 episodes watched/);
  for (const n of [1, 2, 3]) assert.match(html, new RegExp(`DVD ${n}`));
});
