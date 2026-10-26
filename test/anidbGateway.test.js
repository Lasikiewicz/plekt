import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchWithTimeout } from "../server/src/utils/outbound.js";
import { createAnidbGateway } from "../server/src/utils/anidbGateway.js";
import { createAnidbRepository, ANIDB_DAY_MS } from "../server/src/utils/anidbRepository.js";
import { parseAnidbAnime, readAnidbXml, ANIDB_MAX_BYTES } from "../server/src/utils/anidbProtocol.js";

// Synthetic, not copied provider content or a redistributed mapping dataset.
const xml = (aid = "101", title = "Example &amp; Stars") => `<?xml version="1.0"?><anime id="${aid}">
  <type>TV Series</type><titles><title xml:lang="en" type="short">ES</title>
  <title xml:lang="x-jat" type="main">Rei no Hoshi</title><title xml:lang="en" type="official">${title}</title></titles>
  <description>Meet https://anidb.net/ch123 [Aster]. &lt;b&gt;Hello&lt;/b&gt;</description>
  <episodes><episode id="991"><epno type="3">C1</epno><title xml:lang="en">Opening</title></episode></episodes></anime>`;
const schema = fs.readFileSync(new URL("../server/src/schema.sql", import.meta.url), "utf8");

function setup(t, fetcher) {
  const db = new Database(":memory:");
  db.exec(schema);
  t.after(() => db.close());
  const repository = createAnidbRepository(db);
  let clock = 100_000;
  const starts = [];
  const gateway = createAnidbGateway({ repository, now: () => clock,
    sleep: async (ms) => { clock += ms; },
    fetcher: async (url, options) => {
      starts.push(clock);
      return fetcher ? fetcher(url, options) : new Response(xml(new URL(url).searchParams.get("aid")));
    },
  });
  return { db, repository, gateway, starts, advance: (ms) => { clock += ms; } };
}

test("AniDB chooses official English then romanized titles and retains native episode type", () => {
  const data = parseAnidbAnime(xml(), "101");
  assert.equal(data.title, "Example & Stars");
  assert.equal(data.overview, "Meet Aster. Hello");
  assert.deepEqual(data.episodes[0], { id: "991", number: "C1", type: "3", titles: [{ language: "en", type: "", text: "Opening" }] });
  assert.equal(parseAnidbAnime(xml().replace(/<title xml:lang="en" type="official">.*?<\/title>/, ""), "101").title, "Rei no Hoshi");
  assert.equal(data.source.url, "https://anidb.net/anime/101");
  assert.equal(data.id, undefined); // No TMDB-shaped canonical ID or season coordinates.
});

test("AniDB rejects malformed, mismatched, deeply nested and DTD payloads", () => {
  for (const body of ["<anime>", xml("102"), '<!DOCTYPE anime [<!ENTITY x "boom">]>' + xml(),
    `<anime id="101">${"<node>".repeat(40)}text${"</node>".repeat(40)}</anime>`, "x".repeat(ANIDB_MAX_BYTES + 1)]) {
    assert.throws(() => parseAnidbAnime(body, "101"));
  }
  assert.throws(() => parseAnidbAnime('<error code="500">Banned</error>', "101"), { code: "BANNED" });
  assert.throws(() => parseAnidbAnime('<error>Client version rejected</error>', "101"), { code: "CLIENT_REJECTED" });
});

test("AniDB body reader caps decompressed bytes and rejects invalid UTF-8", async () => {
  await assert.rejects(readAnidbXml(new Response(new Uint8Array(ANIDB_MAX_BYTES + 1))), { code: "RESPONSE_TOO_LARGE" });
  await assert.rejects(readAnidbXml(new Response(new Uint8Array([0xff]))), { code: "INVALID_ENCODING" });
  assert.equal(await readAnidbXml(new Response(xml())), xml());
});

test("AniDB handles gzip through the production outbound boundary", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/xml", "Content-Encoding": "gzip" });
    res.end(gzipSync(xml()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const { gateway } = setup(t, async (_url, options) => fetchWithTimeout(`http://127.0.0.1:${server.address().port}/anime`, options));
  assert.equal((await gateway.getAnime("101")).data.title, "Example & Stars");
});

test("AniDB shared requests deduplicate and daily cache avoids all transport", async (t) => {
  const { gateway, starts, repository } = setup(t);
  const [first, second] = await Promise.all([gateway.getAnime("101"), gateway.getAnime("101")]);
  assert.equal(first.data.title, "Example & Stars");
  assert.deepEqual(second, first);
  assert.equal((await gateway.getAnime("101")).status, "fresh");
  assert.equal(starts.length, 1);
  assert.equal(repository.stats().entries, 1);
  assert.ok(repository.stats().bytes > 0);
});

test("AniDB cache-only and invalid IDs never consume a request budget", async (t) => {
  const { gateway, starts, db } = setup(t);
  assert.equal((await gateway.getAnime("101", { cacheOnly: true })).status, "missing");
  for (const aid of ["0", "-1", "1e3", "1&aid=2", "999999999999"]) assert.throws(() => gateway.getAnime(aid));
  assert.equal(starts.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM anidb_request_state").get().n, 0);
});

test("AniDB requests for different datasets stay serialized with at least two-second spacing", async (t) => {
  const { gateway, starts } = setup(t);
  await Promise.all([gateway.getAnime("101"), gateway.getAnime("102")]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 2000);
});

test("AniDB retains last-good metadata on error without refreshing its success time", async (t) => {
  let fail = false;
  const state = setup(t, async (url) => fail ? new Response("outage", { status: 503 }) : new Response(xml(new URL(url).searchParams.get("aid"))));
  const first = await state.gateway.getAnime("101");
  state.advance(ANIDB_DAY_MS);
  fail = true;
  const failed = await state.gateway.getAnime("101");
  assert.equal(failed.status, "error");
  assert.equal(failed.fetchedAt, first.fetchedAt);
  assert.deepEqual(failed.data, first.data);
  assert.equal((await state.gateway.getAnime("101")).status, "held");
  assert.equal(state.starts.length, 2);
});

test("AniDB cache deletion and a new gateway cannot bypass the persistent daily guard", async (t) => {
  const { gateway, repository, starts } = setup(t);
  await gateway.getAnime("101");
  assert.equal(gateway.clearCache(), 1);
  const restarted = createAnidbGateway({ repository, now: () => 101_000,
    fetcher: async () => { throw new Error("Must not fetch"); } });
  const held = await restarted.getAnime("101");
  assert.equal(held.status, "held");
  assert.equal(held.data, null);
  assert.equal(starts.length, 1);
});

test("AniDB XML bans create provider-wide cooldown even for another AID after restart", async (t) => {
  const { gateway, repository, starts } = setup(t, async () => new Response('<error>Banned</error>'));
  assert.equal((await gateway.getAnime("101")).error, "BANNED");
  const restarted = createAnidbGateway({ repository, now: () => 101_000,
    fetcher: async () => { throw new Error("Must not fetch"); } });
  const held = await restarted.getAnime("102");
  assert.equal(held.status, "held");
  assert.equal(held.error, "COOLDOWN");
  assert.equal(starts.length, 1);
});

test("AniDB honors Retry-After longer than the daily request boundary", async (t) => {
  const state = setup(t, async () => new Response("limit", { status: 429, headers: { "Retry-After": "172800" } }));
  assert.equal((await state.gateway.getAnime("101")).error, "RATE_LIMITED");
  state.advance(ANIDB_DAY_MS + 1);
  assert.equal((await state.gateway.getAnime("102")).error, "COOLDOWN");
  assert.equal(state.starts.length, 1);
});

test("AniDB lease and daily guard are shared across independent database connections", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-anidb-"));
  const file = path.join(dir, "cache.db");
  const first = new Database(file);
  first.exec(schema);
  const second = new Database(file);
  t.after(() => { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const a = createAnidbRepository(first);
  const b = createAnidbRepository(second);
  const lease = a.reserve("101", 1000);
  assert.ok(lease.token);
  assert.ok(b.reserve("102", 1000).waitMs);
  assert.equal(b.reserve("101", 1000).held, true);
  // Expired ownership can never publish after another connection takes over.
  const replacement = b.reserve("102", 62_000);
  assert.ok(replacement.token);
  assert.equal(a.finish("101", lease.token, { now: 62_001, data: { aid: "101" } }), false);
  assert.equal(a.read("101"), null);
});

test("AniDB cancelled subscriber does not cancel another subscriber's shared fetch", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { gateway, starts } = setup(t, async () => { await blocked; return new Response(xml()); });
  const controller = new AbortController();
  const cancelled = gateway.getAnime("101", { signal: controller.signal });
  const kept = gateway.getAnime("101");
  controller.abort(new Error("Cancelled by caller"));
  await assert.rejects(cancelled, /Cancelled by caller/);
  release();
  assert.equal((await kept).status, "fresh");
  assert.equal(starts.length, 1);
});

test("simultaneous Node processes share one AniDB daily request reservation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-anidb-process-"));
  const file = path.join(dir, "cache.db");
  const database = new Database(file);
  database.exec(schema);
  database.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repositoryUrl = new URL("../server/src/utils/anidbRepository.js", import.meta.url).href;
  const databaseUrl = import.meta.resolve("better-sqlite3");
  const script = `import Database from ${JSON.stringify(databaseUrl)};
    import { createAnidbRepository } from ${JSON.stringify(repositoryUrl)};
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 5000');
    try { console.log(JSON.stringify(createAnidbRepository(db).reserve('101', 1000))); }
    finally { db.close(); }`;
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, file], { timeout: 10_000 });
  const results = (await Promise.all([run(), run()])).map(({ stdout }) => JSON.parse(stdout));
  assert.equal(results.filter((value) => value.token).length, 1);
  assert.equal(results.filter((value) => value.held).length, 1);
});
