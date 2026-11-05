import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-tenant-drop-drains-");
const { db } = await import("../server/src/db.js");
const { saveUsersRegistry, ensureTenantDataDir } = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { closeAllTenantDatabases } = await import("../server/src/utils/tenantDatabase.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { dropTitle } = await import("../server/src/utils/droppedTitles.js");
await import("../server/src/utils/droppedTitleTrackerSync.js");
saveUsersRegistry({ version: 1, users: [{ name: "bob", role: "user", passwordHash: "x" }, { name: "carol", role: "user", passwordHash: "x" }] }, dataDir);
const users = ["bob", "carol"].map(name => ({ name, role: "user", dataDir: ensureTenantDataDir(name, dataDir) }));
test.after(() => { closeAllTenantDatabases(); db.close(); });

test("two users' queued dropped-title drains do not suppress each other", async () => {
  const originalFetch = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (input, options = {}) => {
    const pathname = new URL(input).pathname;
    if (options.method === "POST") {
      writes.push(options.headers.authorization);
      return new Response(JSON.stringify({ added: { shows: 1 }, not_found: { shows: [] } }));
    }
    return new Response(JSON.stringify(pathname === "/sync/last_activities" ? { shows: { dropped_at: "2026-01-01T00:00:00Z" } } : []));
  };
  try {
    for (const user of users) runWithUserContext(user, () => {
      saveTrackerConnection({ provider: "trakt", clientId: "fixture", remoteUserId: user.name, accessToken: `fixture-${user.name}`, refreshToken: "fixture", accessTokenExpiresAt: Date.now() + 86400000 });
      dropTitle({ media_type: "tv", title: "Disposable tenant drain", tmdb_id: "999999997" });
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !users.every(user => runWithUserContext(user, () => Boolean(db.prepare("SELECT last_error FROM dropped_title_tracker_state WHERE provider='trakt'").get()?.last_error)))) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(writes.sort(), ["Bearer fixture-bob", "Bearer fixture-carol"]);
  } finally { globalThis.fetch = originalFetch; }
});
