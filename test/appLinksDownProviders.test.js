import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeTempDataDir } from "./helpers.js";

// db.js opens its SQLite file at import time and admin.js pulls it in.
makeTempDataDir("plembfin-app-links-down-test-");

const { fetchConfiguredAppLinks, __resetAppLinkProviderDown } = await import("../server/src/routes/admin.js");
const { createUpstreamTimeoutError } = await import("../server/src/utils/outbound.js");

const config = {
  emby: { enabled: true, baseUrl: "http://emby.test:8096", apiKey: "k", userId: "u" },
  jellyfin: { enabled: true, baseUrl: "http://jellyfin.test:8096", apiKey: "k", userId: "u" },
};
const media = { type: "movie", title: "Example", ids: { tmdb: "1" } };

function connectionRefused() {
  const error = new Error("Upstream request failed (connection refused)");
  error.code = "UPSTREAM_REQUEST_FAILED";
  return error;
}

function stubLookup(behaviour) {
  const calls = [];
  const lookup = async (target) => {
    calls.push(target);
    const outcome = behaviour[target];
    if (outcome instanceof Error) throw outcome;
    return outcome ? { target, label: target, url: `http://${target}.test/item` } : null;
  };
  return { lookup, calls };
}

test("a server that times out is skipped for a minute, then tried again", async () => {
  __resetAppLinkProviderDown();
  let clock = 1_000_000;
  const now = () => clock;
  const down = stubLookup({ emby: createUpstreamTimeoutError(8000), jellyfin: true });

  const first = await fetchConfiguredAppLinks(config, media, null, { lookup: down.lookup, now });
  assert.deepEqual(first.links.map((link) => link.target), ["jellyfin"]);
  assert.equal(first.partial, true);
  assert.deepEqual(down.calls.sort(), ["emby", "jellyfin"]);

  clock += 59_000;
  const skipped = stubLookup({ emby: true, jellyfin: true });
  const second = await fetchConfiguredAppLinks(config, media, null, { lookup: skipped.lookup, now });
  assert.deepEqual(skipped.calls, ["jellyfin"], "the down server is not asked inside the window");
  assert.equal(second.partial, true, "a skipped server makes the answer partial");

  clock += 2_000;
  const back = stubLookup({ emby: true, jellyfin: true });
  const third = await fetchConfiguredAppLinks(config, media, null, { lookup: back.lookup, now });
  assert.deepEqual(back.calls.sort(), ["emby", "jellyfin"], "after the window the server is tried again");
  assert.deepEqual(third.links.map((link) => link.target).sort(), ["emby", "jellyfin"]);
  assert.equal(third.partial, false);
});

test("a refused connection marks the server down too", async () => {
  __resetAppLinkProviderDown();
  const now = () => 5_000_000;
  await fetchConfiguredAppLinks(config, media, null, { lookup: stubLookup({ emby: connectionRefused(), jellyfin: true }).lookup, now });
  const next = stubLookup({ emby: true, jellyfin: true });
  await fetchConfiguredAppLinks(config, media, null, { lookup: next.lookup, now });
  assert.deepEqual(next.calls, ["jellyfin"]);
});

test("not found and HTTP errors never mark a server down", async () => {
  __resetAppLinkProviderDown();
  const now = () => 7_000_000;
  const httpError = Object.assign(new Error("Emby request failed with status 500"), { status: 500 });

  const notFound = await fetchConfiguredAppLinks(config, media, null, { lookup: stubLookup({ emby: false, jellyfin: false }).lookup, now });
  assert.deepEqual(notFound, { links: [], partial: false }, "not found is a final empty answer");

  const failed = await fetchConfiguredAppLinks(config, media, null, { lookup: stubLookup({ emby: httpError, jellyfin: false }).lookup, now });
  assert.equal(failed.partial, true, "a failed lookup is still not final");

  const next = stubLookup({ emby: true, jellyfin: true });
  await fetchConfiguredAppLinks(config, media, null, { lookup: next.lookup, now });
  assert.deepEqual(next.calls.sort(), ["emby", "jellyfin"], "both servers are still asked");
});

test("a partial answer is never stored as an empty result", () => {
  const adminSource = fs.readFileSync(new URL("../server/src/routes/admin.js", import.meta.url), "utf8");
  const handler = adminSource.match(/export async function handleMediaAppLinks[\s\S]*?\n}/)?.[0] || "";
  const partialReturn = handler.indexOf("if (partial)");
  const emptyStore = handler.indexOf("emptyAppLinksCaches().set(");
  assert.ok(partialReturn > 0 && emptyStore > partialReturn, "the partial answer returns before the empty cache is written");
  assert.match(handler.slice(partialReturn, emptyStore), /return sendJson\(res, \{ ok: true, links, partial: true \}/);
});

test("the browser refreshes a partial answer after the one-minute window", () => {
  const sharedSource = fs.readFileSync(new URL("../public/modules/media-detail-shared.js", import.meta.url), "utf8");
  assert.match(sharedSource, /APP_LINKS_PARTIAL_REFRESH_TTL_MS = 60 \* 1000/);
  assert.match(sharedSource, /cachedEntry\?\.partial \? APP_LINKS_PARTIAL_REFRESH_TTL_MS : APP_LINKS_REFRESH_TTL_MS/);
  assert.match(sharedSource, /writeAppLinksCacheEntry\(cacheKey, body\.links, body\.partial === true\)/);
});
