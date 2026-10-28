import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-live-tenants-");
const { routePlexSessions, refreshTenantLiveSessions } = await import("../server/src/utils/liveSessionTenants.js");
const { getActiveUserName, runWithUserContext } = await import("../server/src/utils/userContext.js");
const { ensureTenantDataDir, saveUsersRegistry } = await import("../server/src/utils/tenancy.js");
const { fetchLiveSessions } = await import("../server/src/utils/liveSessions.js");
const { refreshLiveSessions } = await import("../server/src/utils/liveSessionCompletion.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");

const owner = { name: "admin", role: "admin", dataDir };
const friend = { name: "friend", role: "user", dataDir: path.join(dataDir, "users", "friend") };
const session = (id, title = id) => ({ source: "plex", sessionId: "player", mediaId: "movie", mediaType: "movie", title, offsetMs: 10_000, durationMs: 100_000, progress: 10, client: { userId: id } });
const entry = (tenant, serverId, owned, userIds) => ({ tenant, serverId, owned, userIds, config: { plex: {}, emby: {}, jellyfin: {} } });

test("owner poll routes by exact user ID and server, never username or unattributed data", () => {
  const entries = [entry(owner, "server-a", true, ["100", "1"]), entry(friend, "server-a", false, ["200"]), entry({ name: "elsewhere" }, "server-b", false, ["200"])];
  const ownerSession = session("1");
  const friendSession = session("200");
  const results = routePlexSessions(entries, new Map([["server-a", { ok: true, sessions: [ownerSession, friendSession, session("999"), { ...session(""), client: { userName: "friend" } }] }]]));
  assert.deepEqual(results.get("admin"), { ok: true, sessions: [ownerSession] });
  assert.deepEqual(results.get("friend"), { ok: true, sessions: [friendSession] });
  assert.deepEqual(results.get("elsewhere"), { ok: false, sessions: [] });
});

test("pre-existing duplicate account connections cannot receive one session twice", () => {
  const entries = [entry(owner, "a", true, ["100"]), entry(friend, "a", true, ["100"])];
  const results = routePlexSessions(entries, new Map([["a", { ok: true, sessions: [session("100")] }]]));
  assert.equal(results.get("admin").sessions.length, 1);
  assert.equal(results.get("friend").sessions.length, 0);
});

test("anonymous player ID 1 is not assigned to the owner, while an explicit owner session is", () => {
  const entries = [entry(owner, "a", true, ["100", "1"]), entry(friend, "a", false, ["200"])];
  const explicit = { ...session("1", "Owner stream"), client: { userId: "1", userIdSource: "user" } };
  const anonymous = { ...session("1", "Shared user's anonymous stream"), client: { userId: "1", userIdSource: "player" } };
  const results = routePlexSessions(entries, new Map([["a", { ok: true, sessions: [explicit, anonymous] }]]));
  assert.deepEqual(results.get("admin").sessions, [explicit]);
  assert.deepEqual(results.get("friend").sessions, []);
});

test("failed owner polls are failures for recipients, not evidence playback stopped", async () => {
  const results = routePlexSessions([entry(friend, "a", false, ["200"])], new Map([["a", { ok: false, sessions: [] }]]));
  const config = { plex: { baseUrl: "http://never-poll.test", token: "friend-token" }, emby: {}, jellyfin: {} };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("must not poll non-owner sessions"); };
  try {
    const result = await fetchLiveSessions(config, { plexSessions: results.get("friend") });
    assert.equal(result.failedSources.has("plex"), true);
    assert.deepEqual(result.sessions, []);
  } finally { globalThis.fetch = originalFetch; }
});

test("one owner fetch runs in its context; each refresh gets only its sessions and own config", async () => {
  const entries = [entry(owner, "a", true, ["100"]), entry(friend, "a", false, ["200"])];
  entries[0].config.plex.token = "owner-secret";
  entries[1].config.plex.token = "friend-secret";
  const calls = [];
  const refreshed = [];
  const result = await refreshTenantLiveSessions({}, {
    tenants: [owner, friend],
    read: async (tenant) => {
      assert.equal(getActiveUserName(), tenant.name);
      return entries.find((candidate) => candidate.tenant === tenant);
    },
    fetchOwner: async () => {
      calls.push(getActiveUserName());
      return { ok: true, sessions: [session("100"), session("200")] };
    },
    refresh: async (config, _loop, { plexSessions }) => {
      const name = getActiveUserName();
      assert.equal(config.plex.token, name === "admin" ? "owner-secret" : "friend-secret");
      assert.equal(JSON.stringify(plexSessions).includes("secret"), false);
      refreshed.push([name, plexSessions.sessions[0].client.userId]);
      return { currentRows: plexSessions.sessions, pendingConfirmations: 0 };
    },
  });
  assert.deepEqual(calls, ["admin"]);
  assert.deepEqual(refreshed, [["admin", "100"], ["friend", "200"]]);
  assert.equal(result.hasActiveSession, true);
});

test("a failing tenant does not stop another tenant's live refresh", async () => {
  const seen = [];
  const result = await refreshTenantLiveSessions({}, {
    tenants: [owner, friend],
    read: async (tenant) => entry(tenant, "", null, []),
    refresh: async () => {
      if (getActiveUserName() === "admin") throw new Error("fixture failure");
      seen.push(getActiveUserName());
      return { currentRows: [], pendingConfirmations: 1 };
    },
  });
  assert.deepEqual(seen, ["friend"]);
  assert.deepEqual(result, { hasActiveSession: true, failed: true });
});

test("missing-session confirmation counts stay separate even for identical session keys", async () => {
  saveUsersRegistry({ version: 1, users: [{ name: "friend", role: "user", passwordHash: "fixture" }] }, dataDir);
  ensureTenantDataDir("friend", dataDir);
  const config = { plex: {}, emby: {}, jellyfin: {} };
  for (const tenant of [owner, friend]) {
    await runWithUserContext(tenant, () => refreshLiveSessions(config, createLoopStore(), { plexSessions: { ok: true, sessions: [session("200", "Fixture movie")] } }));
  }
  for (const tenant of [owner, friend]) {
    const result = await runWithUserContext(tenant, () => refreshLiveSessions(config, createLoopStore(), { plexSessions: { ok: true, sessions: [] } }));
    assert.equal(result.pendingConfirmations, 1, tenant.name);
    assert.equal(result.progressUpdates.length, 0);
  }
});
