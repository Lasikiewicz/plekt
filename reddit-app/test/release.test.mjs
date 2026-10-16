import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/core/release.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(
  source.replace('import { reddit, redis } from "@devvit/web/server";', "const { reddit, redis, fetch } = mocks;"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

async function run({ stored, status = 200, feed }) {
  const calls = [];
  const mocks = {
    fetch: async (url, options) => {
      assert.equal(url, "https://plekt.net/release.json");
      assert.equal(options.redirect, "error");
      return { ok: status === 200, status, json: async () => feed };
    },
    redis: {
      get: async (key) => { calls.push(["get", key]); return stored; },
      set: async (...args) => { calls.push(["set", ...args]); },
    },
    reddit: {
      getAppUser: async () => ({ username: "plekt-app" }),
      getHotPosts: () => ({ all: async () => [] }),
      submitPost: async (post) => {
        calls.push(["post", post]);
        return { sticky: async (slot) => { calls.push(["sticky", slot]); } };
      },
    },
  };
  const exports = {};
  new Function("mocks", "exports", compiled)(mocks, exports);
  await exports.checkAndAnnounceNewRelease();
  return calls;
}

const feed = { version: "2.0.0", entries: [{ version: "2.0.0", summary: "Plekt release", bullets: ["Release detail"] }] };

test("first successful fetch records current version without posting", async () => {
  assert.deepEqual(await run({ feed }), [["get", "lastAnnouncedVersion"], ["set", "lastAnnouncedVersion", "2.0.0"]]);
});
test("same version does not post or rewrite state", async () => {
  assert.deepEqual(await run({ stored: "2.0.0", feed }), [["get", "lastAnnouncedVersion"]]);
});
test("later release uses website summary and bullets, pins then records version", async () => {
  const calls = await run({ stored: "1.3.1", feed });
  assert.equal(calls[1][1].title, "Plekt v2.0.0 released");
  assert.match(calls[1][1].text, /Plekt release[\s\S]*Release detail/);
  assert.equal(calls[1][1].subredditName, "plekt");
  assert.deepEqual(calls.slice(2), [["sticky", 1], ["set", "lastAnnouncedVersion", "2.0.0"]]);
});
test("404 and malformed or mismatched feeds never touch Redis or Reddit", async () => {
  for (const options of [
    { status: 404 }, { feed: {} },
    { feed: { ...feed, version: "1.3.1" } },
    { feed: { version: "2.0.0", entries: [{ version: "2.0.0", summary: "x", bullets: [42] }] } },
  ]) assert.deepEqual(await run(options), []);
});
