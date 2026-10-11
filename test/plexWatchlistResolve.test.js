import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-plex-watchlist-resolve-");

const plex = await import("../server/src/utils/plexWatchlistClient.js");

const originalFetch = globalThis.fetch;
test.after(() => {
  globalThis.fetch = originalFetch;
});

const config = { baseUrl: "https://plex.example", accountToken: "account-secret", representation: "native" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function searchResponse(metadata) {
  return jsonResponse({
    MediaContainer: { SearchResults: [{ SearchResult: metadata.map((item) => ({ Metadata: item })) }] },
  });
}

// Live-verified shape: Discover search never carries external Guid arrays, so
// provider ids are only available from the full metadata endpoint.
test("resolution narrows a same-title candidate to the one with the requested year", async () => {
  globalThis.fetch = async () => searchResponse([
    { type: "movie", ratingKey: "plex-undated", title: "Example Film" },
    { type: "movie", ratingKey: "plex-2025", title: "Example Film", year: 2025 },
  ]);
  const resolved = await plex.resolvePlexWatchlistTargets(config, {
    media_type: "movie",
    title: "Example Film",
    year: 2025,
  });
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.primaryTarget?.id, "plex-2025");
});

test("same-title, same-year duplicates are told apart by fetching metadata for the requested tmdb id", async () => {
  const requestedPaths = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.startsWith("/library/metadata/")) {
      requestedPaths.push(parsed.pathname);
      const key = parsed.pathname.split("/").pop();
      const tmdb = key === "plex-b" ? "888" : "111";
      return jsonResponse({
        MediaContainer: {
          Metadata: [{ type: "movie", ratingKey: key, title: "Example Film", year: 2025, Guid: [{ id: `tmdb://${tmdb}` }] }],
        },
      });
    }
    return searchResponse([
      { type: "movie", ratingKey: "plex-a", title: "Example Film", year: 2025 },
      { type: "movie", ratingKey: "plex-b", title: "Example Film", year: 2025 },
    ]);
  };
  const resolved = await plex.resolvePlexWatchlistTargets(config, {
    media_type: "movie",
    title: "Example Film",
    tmdb_id: "888",
    year: 2025,
  });
  assert.equal(resolved.ambiguous, false);
  assert.equal(resolved.primaryTarget?.id, "plex-b");
  assert.equal(requestedPaths.length, 2);
});
