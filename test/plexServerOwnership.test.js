import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-plex-ownership-");
process.env.PLEKT_CREDENTIAL_KEY = "33".repeat(32);
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/mediaConnectionRepo.js");
const manager = await import("../server/src/utils/plexTokenManager.js");
const tenancy = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { plexHistoryItemMatchesConfiguredUser } = await import("../server/src/utils/recentWatchImport.js");
const { otherPlektUserOnPlexAccount } = await import("../server/src/utils/plexAccountClaims.js");

function connect(remoteUserId, extra = {}) {
  const device = repo.getOrCreatePlexAuthDevice({ deviceName: "Plekt test" });
  return repo.saveMediaConnection({ provider: "plex", baseUrl: "http://192.168.1.10:32400", serverId: "machine-1", authDeviceId: device.id, remoteUserId, remoteUsername: "friend", authKind: "plex_legacy", credential: "account-token", ...extra });
}

function resources(owned) {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => [{ product: "Plex Media Server", clientIdentifier: "machine-1", owned }] };
  };
  return { fetchImpl, calls: () => calls };
}

test("an older connection learns its server ownership from plex.tv once", async () => {
  connect("friend-1");
  assert.equal(repo.getMediaConnection("plex").serverOwned, null);
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  assert.equal(await manager.ensurePlexServerOwnership({ fetchImpl: failing }), null);
  assert.equal(repo.getMediaConnection("plex").serverOwned, null, "a failed lookup records nothing");

  const plexTv = resources(false);
  assert.equal(await manager.ensurePlexServerOwnership({ fetchImpl: plexTv.fetchImpl }), false);
  assert.equal(await manager.ensurePlexServerOwnership({ fetchImpl: plexTv.fetchImpl }), false);
  assert.equal(plexTv.calls(), 1);
  assert.equal(repo.getMediaConnection("plex").serverOwned, false);
  assert.equal(repo.resolveConnectedProviderConfig("plex", {}).serverOwned, false);
});

test("ownership recorded at sign-in is used without asking plex.tv", async () => {
  connect("owner-1", { serverOwned: true });
  const plexTv = resources(false);
  assert.equal(await manager.ensurePlexServerOwnership({ fetchImpl: plexTv.fetchImpl }), true);
  assert.equal(plexTv.calls(), 0);
  assert.equal(repo.resolveConnectedProviderConfig("plex", {}).serverOwned, true);
});

test("unlabelled library rows count as the user's own only for a recorded non-owner sign-in", () => {
  const unlabelled = { type: "movie", title: "Batman: Knightfall - Part 1: Knightfall" };
  const other = { ...unlabelled, User: { title: "someone-else" } };
  const base = { username: "lasiki", accountId: null, accountScoped: false };
  assert.equal(plexHistoryItemMatchesConfiguredUser(unlabelled, base), false);
  assert.equal(plexHistoryItemMatchesConfiguredUser(unlabelled, { ...base, tokenScoped: true }), true);
  assert.equal(plexHistoryItemMatchesConfiguredUser(other, { ...base, tokenScoped: true }), false, "a row naming another user is never taken");
  assert.equal(plexHistoryItemMatchesConfiguredUser({ ...unlabelled, User: { title: "lasiki" } }, base), true);
});

test("a Plex account already connected to another Plekt user is reported, and the same user is not", () => {
  db.prepare("DELETE FROM media_connections").run();
  connect("shared-1");
  tenancy.saveUsersRegistry({ version: 1, users: [{ name: "bob", role: "user", passwordHash: "x" }, { name: "carol", role: "user", passwordHash: "x" }] }, dataDir);
  const bob = { name: "bob", role: "user", dataDir: tenancy.ensureTenantDataDir("bob", dataDir) };
  const carol = { name: "carol", role: "user", dataDir: tenancy.ensureTenantDataDir("carol", dataDir) };
  const adminName = tenancy.resolveAdminUserName(dataDir);

  assert.equal(otherPlektUserOnPlexAccount("shared-1"), "", "the admin reconnecting its own account is allowed");
  assert.equal(runWithUserContext(bob, () => otherPlektUserOnPlexAccount("shared-1")), adminName);
  assert.equal(runWithUserContext(bob, () => otherPlektUserOnPlexAccount("bob-own")), "");

  runWithUserContext(carol, () => connect("carol-own"));
  assert.equal(otherPlektUserOnPlexAccount("carol-own"), "carol");
  assert.equal(runWithUserContext(bob, () => otherPlektUserOnPlexAccount("carol-own")), "carol");
  assert.equal(runWithUserContext(carol, () => otherPlektUserOnPlexAccount("carol-own")), "");
  runWithUserContext(carol, () => repo.disableMediaConnection("plex"));
  assert.equal(runWithUserContext(bob, () => otherPlektUserOnPlexAccount("carol-own")), "", "a disconnected account is free again");
});

test("concurrent server-token discoveries stay in each user's context", async () => {
  const users = ["bob", "carol"].map((name) => ({ name, role: "user", dataDir: tenancy.ensureTenantDataDir(name, dataDir) }));
  for (const user of users) runWithUserContext(user, () => connect(user.name));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const pending = users.map((user) => runWithUserContext(user, () => manager.getValidPlexServerToken({
    force: true,
    fetchImpl: async () => {
      calls.push(user.name);
      await gate;
      return { ok: true, status: 200, json: async () => [{ clientIdentifier: "machine-1", accessToken: `${user.name}-server-token` }] };
    },
  })));
  release();
  assert.deepEqual(await Promise.all(pending), ["bob-server-token", "carol-server-token"]);
  assert.deepEqual(calls.sort(), ["bob", "carol"]);
  for (const user of users) {
    assert.equal(runWithUserContext(user, () => repo.getMediaConnection("plex", { includeCredential: true }).serverCredential), `${user.name}-server-token`);
  }
});
