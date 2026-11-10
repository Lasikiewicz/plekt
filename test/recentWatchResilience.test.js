import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const root = makeTempDataDir("plekt-recent-watch-resilience-");
const { db } = await import("../server/src/db.js");
const { setRuntimeState } = await import("../server/src/utils/configStore.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { syncRecentlyWatchedFromPlex, syncRecentlyWatchedFromEmby, syncRecentlyWatchedFromJellyfin } = await import("../server/src/utils/recentWatchImport.js");

test("Plex catch-up rotates its six-library cap and keeps the cursor per server", async (t) => {
  const calls = [];
  const sections = Array.from({ length: 8 }, (_, i) => ({ key: String(i + 1), type: "movie" }));
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/status/sessions/history/all") return Response.json({ MediaContainer: { Metadata: [] } });
    if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: sections } });
    calls.push(url.pathname);
    return Response.json({ MediaContainer: { Metadata: [] } });
  });
  await setRuntimeState({ plexCatchupSectionCursor: null });
  const config = { plex: { baseUrl: "http://plex.test", token: "test" } };
  await syncRecentlyWatchedFromPlex(config, {}, () => {});
  assert.deepEqual(calls.splice(0), [1, 2, 3, 4, 5, 6].map((id) => `/library/sections/${id}/all`));
  await syncRecentlyWatchedFromPlex(config, {}, () => {});
  assert.deepEqual(calls.splice(0), [7, 8, 1, 2, 3, 4].map((id) => `/library/sections/${id}/all`));
  await syncRecentlyWatchedFromPlex({ plex: { ...config.plex, baseUrl: "http://other-plex.test" } }, {}, () => {});
  assert.equal(calls[0], "/library/sections/1/all");
});

test("Plex advances the saved library cursor after a section fails", async (t) => {
  const sections = Array.from({ length: 8 }, (_, i) => ({ key: String(i + 1), type: "movie" }));
  const calls = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/status/sessions/history/all") return Response.json({ MediaContainer: { Metadata: [] } });
    if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: sections } });
    calls.push(url.pathname);
    if (fail) { fail = false; throw new Error("temporary section failure"); }
    return Response.json({ MediaContainer: { Metadata: [] } });
  });
  const config = { plex: { baseUrl: "http://failed-section.test", token: "test" } };
  await syncRecentlyWatchedFromPlex(config, {}, () => {});
  assert.deepEqual(calls.splice(0), ["/library/sections/1/all"]);
  await syncRecentlyWatchedFromPlex(config, {}, () => {});
  assert.equal(calls[0], "/library/sections/2/all");
});

test("Plex library cursors are isolated between user databases", async (t) => {
  const calls = [];
  const sections = Array.from({ length: 8 }, (_, i) => ({ key: String(i + 1), type: "movie" }));
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/status/sessions/history/all") return Response.json({ MediaContainer: { Metadata: [] } });
    if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: sections } });
    calls.push(url.pathname);
    return Response.json({ MediaContainer: { Metadata: [] } });
  });
  const aliceDir = path.join(root, "users", "alice");
  fs.mkdirSync(aliceDir, { recursive: true });
  const config = { plex: { baseUrl: "http://per-user-plex.test", token: "test" } };
  const sync = () => syncRecentlyWatchedFromPlex(config, {}, () => {});
  await sync();
  calls.length = 0;
  await runWithUserContext({ name: "alice", dataDir: aliceDir, role: "user" }, sync);
  assert.equal(calls[0], "/library/sections/1/all");
  calls.length = 0;
  await sync();
  assert.equal(calls[0], "/library/sections/7/all");
});

test("a malformed Plex history date does not block later items", async (t) => {
  const items = [
    { type: "movie", title: "Invalid date", ratingKey: "invalid-date", lastViewedAt: 1e100 },
    { type: "movie", title: "Valid date", ratingKey: "valid-date", lastViewedAt: Date.parse("2026-01-15T12:00:00Z") / 1000 },
  ];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    return Response.json({ MediaContainer: url.pathname === "/status/sessions/history/all" ? { Metadata: items } : { Directory: [] } });
  });
  const logs = [];
  await syncRecentlyWatchedFromPlex({ plex: { baseUrl: "http://dates-plex.test", token: "test" } }, { get: async () => null }, (message) => logs.push(message));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE title = 'Valid date'").get().n, 1);
  assert.ok(logs.some((line) => line.includes("Invalid date")));
});

for (const [provider, sync] of [["plex", syncRecentlyWatchedFromPlex], ["emby", syncRecentlyWatchedFromEmby], ["jellyfin", syncRecentlyWatchedFromJellyfin]]) {
  test(`${provider} catch-up continues after one watch insert fails`, async (t) => {
    const date = new Date("2026-01-15T12:00:00Z");
    const plexItems = ["Bad", "Good"].map((label, i) => ({ type: "movie", title: `${label} ${provider}`, ratingKey: `${provider}-${i}`, lastViewedAt: date.getTime() / 1000 }));
    const embyItems = ["Bad", "Good"].map((label, i) => ({ Type: "Movie", Name: `${label} ${provider}`, Id: `${provider}-${i}`, UserData: { Played: true, LastPlayedDate: date.toISOString() } }));
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      if (url.pathname === "/status/sessions/history/all") return Response.json({ MediaContainer: { Metadata: plexItems } });
      if (url.pathname === "/library/sections") return Response.json({ MediaContainer: { Directory: [] } });
      return Response.json({ Items: embyItems, TotalRecordCount: 2 });
    });
    db.exec("CREATE TRIGGER fail_bad_catchup BEFORE INSERT ON watch_history WHEN NEW.title LIKE 'Bad %' BEGIN SELECT RAISE(ABORT, 'bad watch'); END");
    const logs = [];
    try {
      const config = provider === "plex"
        ? { plex: { baseUrl: "http://plex.test", token: "test" } }
        : { [provider]: { baseUrl: `http://${provider}.test`, apiKey: "test", userId: "test" } };
      await sync(config, { get: async () => null }, (message) => logs.push(message));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_history WHERE title = ?").get(`Good ${provider}`).n, 1);
      assert.ok(logs.some((line) => line.includes("bad watch")));
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_bad_catchup");
    }
  });
}
