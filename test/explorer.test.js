import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { state } from "../public/modules/state.js";

const explorerModule = await import("../public/modules/explorer.js");
const { shouldHideWatchedShows, isAlphabeticalExplorerSort, renderShowRecord } = explorerModule;

test("show searches include fully watched shows even when the filter is enabled", () => {
  assert.equal(shouldHideWatchedShows("", true), true);
  assert.equal(shouldHideWatchedShows("   ", true), true);
  assert.equal(shouldHideWatchedShows("Clarkson's Farm", true), false);
  assert.equal(shouldHideWatchedShows("Clarkson's Farm", false), false);
});

test("A-Z navigation is reserved for alphabetical explorer sorts", () => {
  assert.equal(isAlphabeticalExplorerSort("title_asc"), true);
  assert.equal(isAlphabeticalExplorerSort("title_desc"), true);
  assert.equal(isAlphabeticalExplorerSort("watched_desc"), false);
  assert.equal(isAlphabeticalExplorerSort("watched_asc"), false);
  assert.equal(isAlphabeticalExplorerSort("next_air_asc"), false);
});

test("Next Airing show cards link to the show's media page", () => {
  const previous = { mode: state.explorerMode, view: state.explorerViewShows, sort: state.explorerSortShows };
  try {
    state.explorerMode = "shows";
    state.explorerViewShows = "list";
    state.explorerSortShows = "next_air_asc";
    const html = renderShowRecord({ title: "Blue Lights", tmdb_id: "123" });

    assert.match(html, /^\s*<a\b/);
    assert.match(html, /href="\/tvshow\/tmdb\/123-blue-lights"/);
    assert.match(html, /aria-label="Open Blue Lights media page"/);
    assert.match(html, /<\/a>\s*$/);
  } finally {
    state.explorerMode = previous.mode;
    state.explorerViewShows = previous.view;
    state.explorerSortShows = previous.sort;
  }
});

test("Next Airing cards show total regular seasons instead of only watched seasons", () => {
  const previous = { mode: state.explorerMode, view: state.explorerViewShows, sort: state.explorerSortShows };
  const cacheKey = "tv|123|blue lights||";
  const previousMetadata = state.tmdbDetailsCache.get(cacheKey);
  try {
    state.explorerMode = "shows";
    state.explorerViewShows = "list";
    state.explorerSortShows = "next_air_asc";
    state.tmdbDetailsCache.set(cacheKey, {
      first_air_date: "2023-01-01",
      number_of_episodes: 24,
      number_of_seasons: 4,
      seasons: [1, 2, 3, 4].map((season_number) => ({ season_number })),
    });
    const html = renderShowRecord({ title: "Blue Lights", tmdb_id: "123", season_count: 1 });

    assert.match(html, /data-list-season-count>4<\/span>/);
  } finally {
    state.explorerMode = previous.mode;
    state.explorerViewShows = previous.view;
    state.explorerSortShows = previous.sort;
    if (previousMetadata) state.tmdbDetailsCache.set(cacheKey, previousMetadata);
    else state.tmdbDetailsCache.delete(cacheKey);
  }
});

test("History search re-renders never overwrite text the user is still typing", () => {
  const { syncHistorySearchInput } = explorerModule;
  const previous = { search: state.historyViewSearch, active: document.activeElement };
  try {
    const input = { value: "Will Tr" };
    state.historyViewSearch = "Will";
    document.activeElement = input;
    syncHistorySearchInput(input);
    assert.equal(input.value, "Will Tr");

    // A trailing space trims to the applied search, so it stays even when unfocused.
    document.activeElement = null;
    input.value = "Will ";
    syncHistorySearchInput(input);
    assert.equal(input.value, "Will ");

    // Unfocused and genuinely different (route restore): the applied search wins.
    input.value = "Old";
    syncHistorySearchInput(input);
    assert.equal(input.value, "Will");
  } finally {
    state.historyViewSearch = previous.search;
    document.activeElement = previous.active;
  }
});
