import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
const { filterDroppedTitles, fetchDroppedTitles } = await import("../public/modules/dropped-title-views.js");
const { state } = await import("../public/modules/state.js");

test("dropped views include titles without history and distinguish movie/show filters", () => {
  const rows = [
    { title: "Same Title", media_type: "movie", id: "m" },
    { title: "Same Title", media_type: "show", id: "s" },
    { title: "Another", media_type: "show", id: "a" },
  ];
  assert.deepEqual(filterDroppedTitles(rows, { type: "show", search: " SAME " }).map(row => row.id), ["s"]);
  assert.deepEqual(filterDroppedTitles(rows, { type: "movie" }).map(row => row.id), ["m"]);
  assert.equal(filterDroppedTitles(rows).length, 3);
});

test("dropped views use authenticated API data and expose a failed load instead of a false empty list", async () => {
  const original = globalThis.fetch;
  state.token = "test-api-key";
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "/api/dropped-titles");
      assert.equal(options.headers["X-Api-Key"], "test-api-key");
      return { ok: true, json: async () => ({ items: [{ title: "Unwatched movie", media_type: "movie" }] }) };
    };
    assert.equal((await fetchDroppedTitles())[0].title, "Unwatched movie");
    globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: "Sign in again" }) });
    await assert.rejects(fetchDroppedTitles(), /Sign in again/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    await assert.rejects(fetchDroppedTitles(), /incomplete/);
  } finally {
    globalThis.fetch = original;
    state.token = "";
  }
});

test("Dropped-only library cards use the TV Shows card with the saved poster and the drop date", async () => {
  const { renderDroppedShowCard } = await import("../public/modules/dropped-title-views.js");
  const { renderDashboardHistoryPageCard } = await import("../public/modules/dashboard.js");
  const html = renderDroppedShowCard({
    id: "drop-1", media_type: "show", title: "The Grand Tour", tmdb_id: "62425",
    snapshot: { poster_url: "/api/tmdb-poster?path=%2Fgrand.jpg" }, dropped_at: Date.UTC(2026, 9, 24),
  }, renderDashboardHistoryPageCard);
  assert.match(html, /class="history-page-card[^"]*explorer-history-card[^"]*folder-card/);
  assert.match(html, /href="\/tvshow\/tmdb\/62425/);
  assert.match(html, /grand\.jpg/);
  assert.match(html, />Dropped:</);
  assert.doesNotMatch(html, /Last Played:/);
  // A dropped-title id is not a history id, so the card must not ask /api/poster for it.
  assert.doesNotMatch(html, /api\/poster\?format=image&id=drop-1/);
  // The three-dot menu is the only way to un-drop from this view.
  assert.match(html, /data-poster-menu-mode="dropped"/);
  assert.match(html, /<template data-dropped-menu-action>[\s\S]*data-dropped-tmdb="62425"/);
});

test("the Up Next card Drop action carries the show poster for the saved snapshot", async () => {
  const { renderDashboardUpNextCard } = await import("../public/modules/dashboard.js");
  const html = renderDashboardUpNextCard({
    id: "up-1", media_type: "episode", title: "Episode", show_title: "The Grand Tour", show_tmdb_id: "62425",
    season: 1, episode: 2, show_poster_url: "/api/tmdb-poster?path=%2Fgrand.jpg",
  });
  assert.match(html, /data-dropped-poster="[^"]*grand\.jpg/);
});

// The hidden Dropped panel sits in the library's flex row; if its display rule
// beats [hidden] it takes a slot and squeezes the TV Shows/Movies grid.
test("hidden Dropped panel is removed from layout", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const rule = css.match(/([^{}]*#explorerDroppedPanel\[hidden\][^{}]*)\{([^}]*)\}/);
  assert.ok(rule, "missing #explorerDroppedPanel[hidden] rule");
  assert.match(rule[2], /display:\s*none/);
});
