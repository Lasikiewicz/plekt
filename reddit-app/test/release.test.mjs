import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/core/release.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(
  source
    .replace('import { reddit, redis } from "@devvit/web/server";', "const { reddit, redis } = mocks;")
    .replace('import release from "../generated/release.json";', "const release = mocks.release;"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

const bundled = {
  version: "2.1.0",
  date: "2026-10-16T15:24:45.418Z",
  summary: "Plekt release",
  bullets: ["Release detail"],
};

async function run({ stored, release = bundled } = {}) {
  const calls = [];
  const mocks = {
    release,
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
  return { calls, submitReleasePost: exports.submitReleasePost };
}

test("first run stores the bundled version without posting", async () => {
  const { calls } = await run();
  assert.deepEqual(calls, [["get", "lastAnnouncedVersion"], ["set", "lastAnnouncedVersion", "2.1.0"]]);
});

test("matching stored version is not posted or rewritten", async () => {
  const { calls } = await run({ stored: "2.1.0" });
  assert.deepEqual(calls, [["get", "lastAnnouncedVersion"]]);
});

test("new bundled version is posted exactly once and saved after the post", async () => {
  const { calls } = await run({ stored: "2.0.0" });
  assert.equal(calls[1][0], "post");
  assert.equal(calls[1][1].title, "Plekt v2.1.0 released");
  assert.match(calls[1][1].text, /Plekt release[\s\S]*Release detail/);
  assert.equal(calls[1][1].subredditName, "plekt");
  assert.deepEqual(calls.slice(2), [["sticky", 1], ["set", "lastAnnouncedVersion", "2.1.0"]]);
});

test("manual form submission can supply edited title and body", async () => {
  const { calls, submitReleasePost } = await run({ stored: "2.1.0" });
  await submitReleasePost({ ...bundled, version: "2.1.0" }, "Edited title", "Edited body");
  assert.deepEqual(calls[1], ["post", {
    subredditName: "plekt", title: "Edited title", text: "Edited body", runAs: "APP",
  }]);
});

test("release code contains no outbound fetch", async () => {
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /https:\/\/(?:plekt\.net|raw\.githubusercontent\.com)/);
});
