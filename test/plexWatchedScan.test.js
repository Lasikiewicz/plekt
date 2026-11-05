import test from "node:test";
import assert from "node:assert/strict";
import { fetchPlexWatchedItems } from "../server/src/utils/plexClient.js";

const config = { baseUrl: "https://plex-scan.example.test", token: "test" };
const json = (MediaContainer) => new Response(JSON.stringify({ MediaContainer }));

async function withScanFetch(scan, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/library/sections") return json({ Directory: [
      { key: "1", type: "movie" }, { key: "2", type: "show" },
    ] });
    return scan(url);
  };
  try { await run(); } finally { globalThis.fetch = original; }
}

test("Plex watched scan pages selected sections and filters unplayed rows", async () => {
  const starts = [];
  await withScanFetch((url) => {
    assert.equal(url.pathname, "/library/sections/2/all");
    assert.equal(url.searchParams.get("type"), "4");
    assert.equal(url.searchParams.get("unwatched"), "0");
    assert.equal(url.searchParams.get("X-Plex-Container-Size"), "200");
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    starts.push(start);
    return json({ totalSize: 201, Metadata: Array.from({ length: start === 0 ? 200 : 1 }, (_, i) => ({ ratingKey: String(start + i), viewCount: start + i === 0 ? 0 : 1 })) });
  }, async () => {
    const items = await fetchPlexWatchedItems(config, { libraryIds: ["2"] });
    assert.equal(items.length, 200);
    assert.equal(items.at(-1).ratingKey, "200");
    assert.deepEqual(starts, [0, 200]);
  });
});

for (const failure of ["http", "network", "json"]) {
  test(`Plex watched scan rejects ${failure} failure after a successful section`, async () => {
    await withScanFetch((url) => {
      if (url.pathname === "/library/sections/1/all") return json({ totalSize: 1, Metadata: [{ ratingKey: "1", viewCount: 1 }] });
      if (failure === "http") return new Response("failed", { status: 500 });
      if (failure === "json") return new Response("invalid json");
      throw new Error("network failure");
    }, async () => {
      await assert.rejects(fetchPlexWatchedItems(config), failure === "http" ? /status 500.*section 2/ : failure === "network" ? /Upstream request failed/ : SyntaxError);
    });
  });
}

test("Plex watched scan rejects a failed later page", async () => {
  await withScanFetch((url) => {
    if (url.searchParams.get("X-Plex-Container-Start") !== "0") return new Response("failed", { status: 500 });
    return json({ totalSize: 201, Metadata: Array.from({ length: 200 }, (_, i) => ({ ratingKey: String(i), viewCount: 1 })) });
  }, async () => {
    await assert.rejects(fetchPlexWatchedItems(config, { libraryIds: ["1"] }), /status 500/);
  });
});

test("Plex watched scan rejects a server repeating the first page", async () => {
  await withScanFetch(() => json({ totalSize: 201, Metadata: Array.from({ length: 200 }, (_, i) => ({ ratingKey: String(i), viewCount: 1 })) }), async () => {
    await assert.rejects(fetchPlexWatchedItems(config, { libraryIds: ["1"] }), /paging did not advance/);
  });
});

test("Plex watched scan rejects a missing page advertised by totalSize", async () => {
  await withScanFetch(() => json({ totalSize: 3 }), async () => {
    await assert.rejects(fetchPlexWatchedItems(config, { libraryIds: ["1"] }), /incomplete metadata/);
  });
});

test("Plex watched scan follows short capped pages when totalSize is absent", async () => {
  const starts = [];
  await withScanFetch(url => {
    const start = Number(url.searchParams.get("X-Plex-Container-Start"));
    starts.push(start);
    return json({ Metadata: start < 2 ? [{ ratingKey: String(start), viewCount: 1 }] : [] });
  }, async () => {
    assert.equal((await fetchPlexWatchedItems(config, { libraryIds: ["1"] })).length, 2);
    assert.deepEqual(starts, [0, 1, 2]);
  });
});

test("Plex watched scan rejects an ambiguous empty success response", async () => {
  await withScanFetch(() => json({}), async () => {
    await assert.rejects(fetchPlexWatchedItems(config, { libraryIds: ["1"] }), /incomplete metadata/);
  });
});
