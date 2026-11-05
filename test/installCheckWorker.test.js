import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import worker, { handleRequest, parseCheckBody, pruneOldDays, readDay } from "../workers/install-check/src/index.js";

// A small stand-in for the D1 binding, backed by an in-memory SQLite database.
function fakeD1() {
  const sqlite = new Database(":memory:");
  sqlite.exec(fs.readFileSync(new URL("../workers/install-check/schema.sql", import.meta.url), "utf8"));
  const wrap = (sql, args) => ({
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => {
      sqlite.prepare(sql).run(...args);
      return { success: true };
    },
    sync: () => sqlite.prepare(sql).run(...args),
  });
  return {
    sqlite,
    prepare: (sql) => ({ bind: (...args) => wrap(sql, args) }),
    batch: async (statements) => {
      sqlite.transaction(() => statements.forEach((statement) => statement.sync()))();
      return statements.map(() => ({ success: true }));
    },
  };
}

const NOW = new Date("2026-11-04T12:00:00Z");
const TOKEN = "read-token-for-tests";
const VALID = { first: false, week: true, month: false, v: "2.2.3", channel: "main", arch: "amd64" };

function post(body, headers = {}, raw = null) {
  return new Request("https://active.plekt.net/v1/active", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

function stats(query = "", token = TOKEN) {
  return new Request(`https://active.plekt.net/v1/stats${query}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function setup() {
  const db = fakeD1();
  return { db, env: { DB: db, READ_TOKEN: TOKEN } };
}

test("a valid check is counted by day, version, channel and architecture", async () => {
  const { db, env } = setup();
  assert.equal((await handleRequest(post(VALID), env, NOW)).status, 204);
  assert.equal((await handleRequest(post({ ...VALID, first: true, month: true, v: "2.2.4", arch: "arm64" }), env, NOW)).status, 204);
  assert.deepEqual(await readDay(db, "2026-11-04"), {
    date: "2026-11-04",
    checks: 2,
    new: 1,
    week: 2,
    month: 1,
    versions: { "2.2.3": 1, "2.2.4": 1 },
    channels: { main: 2 },
    archs: { amd64: 1, arm64: 1 },
  });
});

test("counters are kept per UTC day of receipt", async () => {
  const { db, env } = setup();
  await handleRequest(post(VALID), env, new Date("2026-11-04T23:59:59Z"));
  await handleRequest(post(VALID), env, new Date("2026-11-05T00:00:01Z"));
  assert.equal((await readDay(db, "2026-11-04")).checks, 1);
  assert.equal((await readDay(db, "2026-11-05")).checks, 1);
});

test("concurrent checks are all counted", async () => {
  const { db, env } = setup();
  await Promise.all(Array.from({ length: 25 }, () => handleRequest(post(VALID), env, NOW)));
  assert.equal((await readDay(db, "2026-11-04")).checks, 25);
});

test("malformed bodies are rejected and counted as nothing", async () => {
  const { db, env } = setup();
  const bad = [
    "not json",
    "[]",
    "null",
    "{}",
    JSON.stringify({ ...VALID, extra: 1 }),
    JSON.stringify({ ...VALID, first: "yes" }),
    JSON.stringify({ ...VALID, week: 1 }),
    JSON.stringify({ ...VALID, v: "2.2" }),
    JSON.stringify({ ...VALID, v: "2.2.3; DROP TABLE counter" }),
    JSON.stringify({ ...VALID, v: 2 }),
    JSON.stringify({ ...VALID, channel: "develop" }),
    JSON.stringify({ ...VALID, channel: "other" }),
    JSON.stringify({ ...VALID, arch: "riscv" }),
    JSON.stringify({ first: false, week: true, month: false, v: "2.2.3", channel: "main" }),
  ];
  for (const raw of bad) {
    const response = await handleRequest(post(null, {}, raw), env, NOW);
    assert.equal(response.status, 400, raw);
  }
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM counter").get().c, 0);
});

test("an oversized body is rejected with 413", async () => {
  const { db, env } = setup();
  const big = JSON.stringify({ ...VALID, pad: "x".repeat(2000) });
  assert.equal((await handleRequest(post(null, {}, big), env, NOW)).status, 413);
  // Same without a Content-Length header: the streamed read still stops at the cap.
  const stream = new Request("https://active.plekt.net/v1/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(400)));
        controller.enqueue(new TextEncoder().encode("x".repeat(400)));
        controller.close();
      },
    }),
    duplex: "half",
  });
  assert.equal((await handleRequest(stream, env, NOW)).status, 413);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS c FROM counter").get().c, 0);
});

test("wrong method, content type and path are refused", async () => {
  const { env } = setup();
  assert.equal((await handleRequest(new Request("https://active.plekt.net/v1/active"), env, NOW)).status, 405);
  assert.equal((await handleRequest(new Request("https://active.plekt.net/v1/stats", { method: "POST" }), env, NOW)).status, 405);
  assert.equal((await handleRequest(post(VALID, { "content-type": "text/plain" }), env, NOW)).status, 415);
  assert.equal((await handleRequest(new Request("https://active.plekt.net/"), env, NOW)).status, 404);
  assert.equal((await handleRequest(new Request("https://active.plekt.net/v1/other"), env, NOW)).status, 404);
});

test("stats need the read token", async () => {
  const { env } = setup();
  assert.equal((await handleRequest(stats("", null), env, NOW)).status, 401);
  assert.equal((await handleRequest(stats("", "wrong"), env, NOW)).status, 401);
  assert.equal((await handleRequest(stats("", ""), env, NOW)).status, 401);
  assert.equal((await handleRequest(stats(""), env, NOW)).status, 200);
  // No token configured on the Worker: nothing can read the stats.
  assert.equal((await handleRequest(stats("", ""), { ...env, READ_TOKEN: "" }, NOW)).status, 401);
  assert.equal((await handleRequest(stats(""), { ...env, READ_TOKEN: undefined }, NOW)).status, 401);
});

test("stats return the requested date, today by default, and validate the date", async () => {
  const { env } = setup();
  await handleRequest(post(VALID), env, NOW);
  const today = await (await handleRequest(stats(), env, NOW)).json();
  assert.equal(today.date, "2026-11-04");
  assert.equal(today.checks, 1);
  const other = await (await handleRequest(stats("?date=2026-11-03"), env, NOW)).json();
  assert.deepEqual(other, { date: "2026-11-03", checks: 0, new: 0, week: 0, month: 0, versions: {}, channels: {}, archs: {} });
  for (const date of ["2026-13-01", "2026-02-30", "yesterday", "2026-1-1", "20261104"]) {
    assert.equal((await handleRequest(stats(`?date=${date}`), env, NOW)).status, 400, date);
  }
});

test("a flood of distinct versions is folded into one bucket", async () => {
  const { db, env } = setup();
  for (let patch = 0; patch < 60; patch += 1) {
    await handleRequest(post({ ...VALID, v: `9.9.${patch}` }), env, NOW);
  }
  const day = await readDay(db, "2026-11-04");
  assert.equal(day.checks, 60);
  assert.equal(Object.keys(day.versions).length, 41);
  assert.equal(day.versions.other, 20);
});

test("pruning drops counters older than 90 days and keeps the rest", async () => {
  const { db } = setup();
  for (const day of ["2026-07-01", "2026-08-05", "2026-08-06", "2026-11-04"]) {
    db.sqlite.prepare("INSERT INTO counter (day, name, n) VALUES (?, 'checks', 1)").run(day);
  }
  assert.equal(await pruneOldDays(db, NOW), "2026-08-06");
  const days = db.sqlite.prepare("SELECT day FROM counter ORDER BY day").all().map((row) => row.day);
  assert.deepEqual(days, ["2026-08-06", "2026-11-04"]);
});

test("nothing per request or per install is stored", async () => {
  const { db, env } = setup();
  const request = post(VALID, { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.7", "user-agent": "Plekt/2.2.3" });
  await handleRequest(request, env, NOW);
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.deepEqual(tables, ["counter"]);
  const columns = db.sqlite.prepare("PRAGMA table_info(counter)").all().map((row) => row.name);
  assert.deepEqual(columns, ["day", "name", "n"]);
  const dump = JSON.stringify(db.sqlite.prepare("SELECT * FROM counter").all());
  assert.doesNotMatch(dump, /203\.0\.113|198\.51\.100|Plekt\/2\.2\.3/);
});

test("the Worker source never reads request headers other than the ones it needs, and has no logging", () => {
  const source = fs.readFileSync(new URL("../workers/install-check/src/index.js", import.meta.url), "utf8");
  const headers = [...source.matchAll(/headers\.get\("([^"]+)"\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(headers, ["authorization", "content-length", "content-type"]);
  assert.doesNotMatch(source, /console\.|connecting-ip|x-forwarded|request\.cf|waitUntil/i);
  const config = fs.readFileSync(new URL("../workers/install-check/wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /\[observability\]\s*\nenabled = false/);
  assert.match(config, /workers_dev = false/);
});

test("the default export wraps failures in a plain 500", async () => {
  const response = await worker.fetch(post(VALID), { DB: { prepare: () => { throw new Error("boom"); } }, READ_TOKEN: TOKEN });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal error" });
});

test("parseCheckBody accepts the body the app sends", () => {
  assert.deepEqual(parseCheckBody(JSON.stringify(VALID)), VALID);
  assert.deepEqual(parseCheckBody(JSON.stringify({ ...VALID, v: "unknown" })), { ...VALID, v: "unknown" });
  assert.deepEqual(parseCheckBody(JSON.stringify({ ...VALID, v: "2.3.0-beta.1", channel: "alpha" })), { ...VALID, v: "2.3.0-beta.1", channel: "alpha" });
});
