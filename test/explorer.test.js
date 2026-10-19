import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { state } from "../public/modules/state.js";

const { shouldHideWatchedShows, isAlphabeticalExplorerSort, renderShowRecord } = await import("../public/modules/explorer.js");

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
