import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-artwork-restore-");

const { MEDIA_DIR } = await import("../server/src/paths.js");
const { db } = await import("../server/src/db.js");
const { cacheArtworkFromUrl, getPosterCache, restoreMissingCachedArtwork } = await import("../server/src/utils/posterCache.js");
const { getCanonicalPosterUrl, saveCanonicalPoster } = await import("../server/src/utils/mediaArtwork.js");

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const REMOTE = "https://artworks.thetvdb.com/banners/v4/series/372264/posters/restore-test.png";

test("a cached poster whose file went missing is downloaded again from its source", async () => {
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(Buffer.from(PNG_BASE64, "base64"), { status: 200, headers: { "content-type": "image/png" } });
  };
  try {
    const mediaKey = "tmdb:tv:restore-test";
    await cacheArtworkFromUrl(mediaKey, REMOTE, "tvdb", { variant: "poster", width: 340, quality: 80 });
    const cached = await getPosterCache(mediaKey);
    assert.equal(cached.status, "cached");
    fs.rmSync(path.join(MEDIA_DIR, cached.storagePath));

    const url = await restoreMissingCachedArtwork(cached.storagePath);

    assert.ok(url?.startsWith("/media/posters/"));
    assert.ok(fs.existsSync(path.join(MEDIA_DIR, url.replace(/^\/media\//, ""))));
    assert.equal(fetches, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a missing cached file with no recorded source is not restored", async () => {
  assert.equal(await restoreMissingCachedArtwork("posters/no-such-artwork.webp"), null);
});

test("canonical show poster skips a missing cached override and falls back to provider artwork", () => {
  const tmdbId = "restore-show";
  const missingUrl = "/media/posters/missing-show-poster.webp";
  db.prepare(`
    INSERT INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, poster_path, cached_poster_url, updated_at_ms)
    VALUES (?, ?, 'tv', ?, ?, ?, ?, ?)
  `).run(
    `tv_${tmdbId}`,
    tmdbId,
    "Restore Show",
    JSON.stringify({ id: tmdbId, name: "Restore Show", poster_path: "/provider-fallback.jpg" }),
    "/provider-fallback.jpg",
    missingUrl,
    Date.now(),
  );
  saveCanonicalPoster({ title: "Restore Show", tmdb_id: tmdbId }, missingUrl, { source: "manual" });

  const posterUrl = getCanonicalPosterUrl({ title: "Restore Show", tmdb_id: tmdbId });

  assert.equal(
    posterUrl,
    `/api/tmdb-poster?path=${encodeURIComponent("/provider-fallback.jpg")}&tmdbId=${tmdbId}&mediaType=tv`,
  );
});
