import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-artwork-restore-");

const { MEDIA_DIR } = await import("../server/src/paths.js");
const { cacheArtworkFromUrl, getPosterCache, restoreMissingCachedArtwork } = await import("../server/src/utils/posterCache.js");

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
