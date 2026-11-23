import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

globalThis.document.querySelector = () => null;
globalThis.document.querySelectorAll = () => [];

const { state } = await import("../public/modules/state.js");
const { manualShowMatches, provenDifferentShow } = await import("../public/modules/up-next-shared.js");
const { removeUpNextItem, setUpNextRemovalPending, removeWatchedUpNextItems, removeDismissedUpNextItems, addShowToUpNext } = await import("../public/modules/up-next.js");

// The two live Scrubs cards from defect AK: both sit at S01E02, so they share
// the show:title and episode-coordinate keys, and only their ids differ.
const reboot = {
  id: "episode|series:imdb:tt40197357|s:1|e:2",
  media_key: "episode|series:imdb:tt40197357|s:1|e:2",
  media_type: "episode",
  queue_kind: "next_up",
  show_title: "Scrubs (2026)",
  season: 1,
  episode: 2,
  tmdb_id: "6638204",
  tvdb_id: "11426443",
  show_imdb_id: "tt40197357",
  show_tmdb_id: "295778",
  show_tvdb_id: "465690",
  provider_items: { plex: ["3310"], emby: ["22115"] },
};
const original = {
  id: "episode|series:imdb:tt0285403|s:1|e:2",
  media_key: "episode|series:imdb:tt0285403|s:1|e:2",
  media_type: "episode",
  queue_kind: "next_up",
  show_title: "Scrubs",
  season: 1,
  episode: 2,
  tmdb_id: "6992248",
  tvdb_id: "184603",
  show_imdb_id: "tt0285403",
  show_tmdb_id: "4556",
  show_tvdb_id: "76156",
  provider_items: { plex: ["3261"], emby: ["22069"] },
};

function resetRail() {
  state.upNextItems = [{ ...reboot }, { ...original }];
  state.upNextPendingRemovals = [];
}

test("provenDifferentShow compares show ids, not an episode card's own episode ids", () => {
  assert.equal(provenDifferentShow(reboot, original), true);
  assert.equal(provenDifferentShow(reboot, { ...reboot, id: "other" }), false);
  // A show record carries its show ids in the plain fields.
  assert.equal(provenDifferentShow({ title: "Scrubs", tmdb_id: "4556" }, original), false);
  assert.equal(provenDifferentShow({ title: "Scrubs", tmdb_id: "4556" }, reboot), true);
  // An id-less side proves nothing.
  assert.equal(provenDifferentShow({ show_title: "Scrubs", media_type: "episode" }, reboot), false);
});

test("manualShowMatches never pairs same-title shows whose show ids conflict", () => {
  assert.equal(manualShowMatches({ title: "Scrubs", tmdb_id: "295778" }, { ...reboot, show_title: "Scrubs" }), true);
  assert.equal(manualShowMatches({ title: "Scrubs", tmdb_id: "295778" }, original), false);
  assert.equal(manualShowMatches({ title: "Scrubs", tmdb_id: "4556" }, original), true);
  assert.equal(manualShowMatches({ title: "Scrubs" }, original), true);
});

test("removing one Scrubs card from the rail keeps the other (defect AK)", () => {
  for (const [removed, kept] of [[reboot, original], [original, reboot]]) {
    resetRail();
    removeUpNextItem(removed.id, removed, { showScope: true });
    assert.deepEqual(state.upNextItems.map((item) => item.id), [kept.id]);
  }
});

test("a pending removal of one Scrubs card does not mark the other pending", () => {
  resetRail();
  setUpNextRemovalPending(reboot, true);
  assert.equal(state.upNextPendingRemovals.length, 1);
  // The rail preserves pending cards across a refresh; only the reboot may be.
  removeUpNextItem(original.id, original, { showScope: true });
  assert.equal(state.upNextPendingRemovals.length, 1, "removing the 2001 card must not clear the reboot's pending state");
  removeUpNextItem(reboot.id, reboot, { showScope: true });
  assert.equal(state.upNextPendingRemovals.length, 0);
  assert.deepEqual(state.upNextItems, []);
});

test("show-scoped removal still takes every card of the same show", () => {
  const laterEpisode = { ...reboot, id: "episode|series:imdb:tt40197357|s:1|e:3", media_key: "episode|series:imdb:tt40197357|s:1|e:3", episode: 3 };
  state.upNextItems = [{ ...reboot }, laterEpisode, { ...original }];
  state.upNextPendingRemovals = [];
  removeUpNextItem(reboot.id, reboot, { showScope: true });
  assert.deepEqual(state.upNextItems.map((item) => item.id), [original.id]);
});

test("marking one Scrubs show watched removes only its own card", () => {
  resetRail();
  state.upNextPendingWatchedRemovals = [];
  const removed = removeWatchedUpNextItems({ scope: "show", showTitle: "Scrubs", showTmdbId: "295778", showTvdbId: "465690", episodes: [] });
  assert.equal(removed, 1);
  assert.deepEqual(state.upNextItems.map((item) => item.id), [original.id]);
});

test("marking one Scrubs episode watched removes only that show's card at the shared coordinate", () => {
  resetRail();
  state.upNextPendingWatchedRemovals = [];
  removeWatchedUpNextItems({
    scope: "episode",
    showTmdbId: "4556",
    episodes: [{ showTitle: "Scrubs", showTmdbId: "4556", showTvdbId: "76156", season: 1, episode: 2 }],
  });
  assert.deepEqual(state.upNextItems.map((item) => item.id), [reboot.id]);
});

test("unwatching one Scrubs show restores only its own dismissal", async () => {
  const restored = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/api/up-next/restore")) restored.push(JSON.parse(init.body).id);
    return { ok: true, status: 200, json: async () => ({ items: [], manualShows: [] }) };
  };
  try {
    state.upNextDismissed = [
      { id: "d-reboot", media_type: "episode", show_title: "Scrubs (2026)", item: { ...reboot } },
      { id: "d-original", media_type: "episode", show_title: "Scrubs", item: { ...original } },
    ];
    await removeDismissedUpNextItems({ showTitle: "Scrubs", showTmdbId: "4556", showTvdbId: "76156" });
    assert.deepEqual(restored, ["d-original"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("addShowToUpNext loads season options, honors cancel, and sends target_season", async () => {
  const realFetch = globalThis.fetch;
  const requests = [];
  const optionsPayload = {
    ok: true,
    earliestUnwatched: { season: 1, episode: 2, title: "Two" },
    watchedSeasons: [1, 3],
    watchedSeasonCount: 2,
    seasons: [
      { season_number: 1, episode_count: 10, watched_count: 1, has_unwatched: true, next_episode: { season: 1, episode: 2, title: "Two" } },
      { season_number: 3, episode_count: 10, watched_count: 2, has_unwatched: true, next_episode: { season: 3, episode: 3, title: "Three" } },
    ],
  };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (String(url).startsWith("/api/up-next/show?")) {
      return { ok: true, status: 200, json: async () => optionsPayload };
    }
    if (String(url) === "/api/up-next/show") {
      return { ok: true, status: 200, json: async () => ({ ok: true, manualShows: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [], manualShows: [], dismissed: [] }) };
  };
  const makeButton = () => {
    const label = { innerHTML: "Add to <br>Up Next" };
    const classes = new Set();
    return {
      disabled: false,
      title: "",
      textContent: "",
      dataset: { upNextShowTitle: "Multi Show", upNextShowTmdbId: "88055", upNextShowAction: "add" },
      classes,
      classList: { add(c) { classes.add(c); }, remove(c) { classes.delete(c); } },
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      removeAttribute(k) { delete this.attrs[k]; },
      querySelector(sel) { return sel === "span" ? label : null; },
      __label: label,
    };
  };
  try {
    const cancelledButton = makeButton();
    await addShowToUpNext(cancelledButton, { chooseOptions: async () => null });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
    assert.equal(cancelledButton.dataset.upNextShowAction, "add");
    assert.equal(cancelledButton.__label.innerHTML, "Add to <br>Up Next");

    requests.length = 0;
    const confirmedButton = makeButton();
    let receivedOptions = null;
    await addShowToUpNext(confirmedButton, {
      chooseOptions: async (_show, opts) => {
        receivedOptions = opts;
        return { targetSeason: 3 };
      },
    });
    assert.deepEqual(receivedOptions, optionsPayload);
    const post = requests.find((r) => r.url === "/api/up-next/show" && r.method === "POST");
    assert.equal(post?.body?.target_season, 3);
    assert.equal(confirmedButton.dataset.upNextShowAction, "remove");
  } finally {
    globalThis.fetch = realFetch;
  }
});
