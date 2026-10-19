import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "./domStubs.js";

const cacheSource = fs.readFileSync(new URL("../public/modules/explorer-page-cache.js", import.meta.url), "utf8");
const stateVersion = cacheSource.match(/from ["']\.\/state\.js(\?v=[^"']+)?["']/)?.[1] || "";
const { state } = await import(`../public/modules/state.js${stateVersion}`);
const { cachedExplorerPage, isStaleExplorerPage, rememberExplorerPage } = await import("../public/modules/explorer-page-cache.js");

test("stale explorer caches revalidate the first page and discard later pages", () => {
  const firstPage = new URL("/api/movies?limit=40&offset=0", window.location.origin).toString();
  const secondPage = new URL("/api/movies?limit=40&offset=40", window.location.origin).toString();

  state.explorerPageCache.clear();
  state.historyVersion = "history-v1";
  localStorage.clear();
  rememberExplorerPage(firstPage, { movies: [{ id: "first-page" }] });
  rememberExplorerPage(secondPage, { movies: [{ id: "second-page" }] });

  state.historyVersion = "history-v2";

  const staleFirstPage = cachedExplorerPage(firstPage);
  assert.equal(isStaleExplorerPage(staleFirstPage), true);
  assert.deepEqual(staleFirstPage.movies, [{ id: "first-page" }]);
  assert.equal(cachedExplorerPage(secondPage), null);

  state.explorerPageCache.delete(firstPage);
  state.explorerPageCache.delete(secondPage);
  assert.equal(isStaleExplorerPage(cachedExplorerPage(firstPage)), true);
  assert.equal(cachedExplorerPage(secondPage), null);
});
