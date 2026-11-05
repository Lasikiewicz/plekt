import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

// Guards for the event-loop stalls found in the November 2026 audit: per-show
// metadata lookups that scanned whole cache tables, and a users-registry read
// on every database statement in a user context.
const dataDir = makeTempDataDir("plekt-stall-guards-");
const { getSharedMetadataDb } = await import("../server/src/utils/sharedMetadataStore.js");
const tenancy = await import("../server/src/utils/tenancy.js");

function planFor(sql, ...params) {
  return getSharedMetadataDb(dataDir).prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(" | ");
}

test("per-show metadata cache lookups use an index instead of scanning the table", () => {
  const plans = [
    planFor("SELECT season_number FROM tmdb_season_cache WHERE tmdb_id = ? ORDER BY season_number", "1"),
    planFor("SELECT details FROM tvdb_season_cache WHERE tvdb_id = ? AND season_number = ?", "1", 1),
    planFor("SELECT details FROM tvdb_metadata_cache WHERE tvdb_id=? ORDER BY updated_at_ms DESC LIMIT 1", "1"),
    planFor("SELECT * FROM tmdb_metadata_cache WHERE media_type = 'tv' AND tmdb_id = ? ORDER BY updated_at_ms DESC LIMIT 1", "1"),
  ];
  for (const plan of plans) {
    assert.match(plan, /USING (?:COVERING )?INDEX idx_/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, plan);
  }
});

test("the users registry is reused while unchanged and reread after a save", () => {
  tenancy.saveUsersRegistry({ version: 1, users: [{ name: "owner", role: "admin" }, { name: "friend", role: "user" }] }, dataDir);
  const first = tenancy.loadUsersRegistry(dataDir);
  // Each caller gets its own copy, so editing one cannot leak into the next read.
  first.users[1].disabled = true;
  first.users.push({ name: "ghost", role: "user" });
  const second = tenancy.loadUsersRegistry(dataDir);
  assert.equal(second.users.length, 2);
  assert.equal(second.users[1].disabled, false);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "owner");

  tenancy.saveUsersRegistry({ version: 1, users: [{ name: "boss", role: "admin" }, { name: "friend", role: "user", disabled: true }] }, dataDir);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "boss");
  assert.equal(tenancy.findUser("friend", dataDir).disabled, true);
});

test("the admin name falls back to config.json and follows edits to it", () => {
  fs.rmSync(tenancy.usersRegistryPath(dataDir), { force: true });
  tenancy.forgetParsedFile(tenancy.usersRegistryPath(dataDir));
  const configPath = path.join(dataDir, "config.json");
  // Edits from this process call forgetParsedFile (writeConfigFile does).
  const write = (text) => { fs.writeFileSync(configPath, text); tenancy.forgetParsedFile(configPath); };
  write(JSON.stringify({ username: "Alpha" }));
  assert.equal(tenancy.resolveAdminUserName(dataDir), "alpha");
  write(JSON.stringify({ username: "BravoUser" }));
  assert.equal(tenancy.resolveAdminUserName(dataDir), "bravouser");
  write("{ not json");
  assert.equal(tenancy.resolveAdminUserName(dataDir), "admin");
  fs.rmSync(configPath);
  tenancy.forgetParsedFile(configPath);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "admin");
});

test("another process's edit is picked up once the one-second recheck window passes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  fs.rmSync(tenancy.usersRegistryPath(dataDir), { force: true });
  tenancy.forgetParsedFile(tenancy.usersRegistryPath(dataDir));
  const configPath = path.join(dataDir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ username: "Charlie" }));
  tenancy.forgetParsedFile(configPath);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "charlie");
  // Written without forgetParsedFile, as another process would.
  fs.writeFileSync(configPath, JSON.stringify({ username: "DeltaUser" }));
  t.mock.timers.tick(500);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "charlie", "no file check inside the window");
  t.mock.timers.tick(600);
  assert.equal(tenancy.resolveAdminUserName(dataDir), "deltauser");
  fs.rmSync(configPath);
});
