import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-config-tuning-test-");

const { loadMediaConfig, saveMediaConfig, validateConfig, mergeIncomingConfig, publicMediaConfig, mediaAccountAuthEnabled } = await import("../server/src/utils/configStore.js");
const { applyTuningConfig, watchedThresholdPercent, watchImportMode, resetTuningForTests } = await import("../server/src/utils/tuning.js");
const { listActiveSessions, upsertActiveSession } = await import("../server/src/utils/activeSessions.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  resetTuningForTests();
  db.close();
});

test("saveMediaConfig persists a tuning override and refreshes the effective getters", async () => {
  await saveMediaConfig({ tuning: { watchedThresholdPercent: 75 } });
  assert.equal(watchedThresholdPercent(), 75);

  const reloaded = await loadMediaConfig();
  assert.equal(reloaded.tuning.watchedThresholdPercent, 75);
  assert.equal(reloaded.tuning.minResumePositionSec, null);
  // loadMediaConfig() itself calls applyTuningConfig(), so the getter reflects
  // the round-tripped value too, not just the value set by saveMediaConfig().
  assert.equal(watchedThresholdPercent(), 75);
});

test("saveMediaConfig persists the watched-flag policy and exposes its browser-safe options", async () => {
  await saveMediaConfig({ tuning: { watchImportMode: "release_day" } });
  assert.equal(watchImportMode(), "release_day");
  const config = await loadMediaConfig();
  assert.equal(config.tuning.watchImportMode, "release_day");

  const publicConfig = publicMediaConfig(config);
  assert.equal(publicConfig.tuning.watchImportMode.value, "release_day");
  assert.equal(publicConfig.tuning.watchImportMode.overridden, true);
  assert.deepEqual(publicConfig.tuning.watchImportMode.options, ["now", "release_day", "episode_timing", "review"]);
});

test("Up Next provider sync defaults on and persists an explicit opt-out", async () => {
  const initial = await loadMediaConfig();
  assert.equal(initial.upNextSync.enabled, true);
  assert.equal(publicMediaConfig(initial).upNextSync.enabled, true);

  await saveMediaConfig({ upNextSync: { enabled: false } });
  const disabled = await loadMediaConfig();
  assert.equal(disabled.upNextSync.enabled, false);
  assert.equal(publicMediaConfig(disabled).upNextSync.enabled, false);

  await saveMediaConfig({ upNextSync: { enabled: true } });
});

test("validateConfig rejects a non-boolean Up Next sync setting", () => {
  const errors = validateConfig({ upNextSync: { enabled: "false" } });
  assert.ok(errors.some((message) => message.includes("upNextSync.enabled")));
});

test("partial Now Playing saves preserve the other panel options", async () => {
  await saveMediaConfig({ nowPlaying: { allowPartWatched: false, allowUpNext: true, itemCount: 2 } });
  await saveMediaConfig({ nowPlaying: { allowUpNext: false } });
  const config = await loadMediaConfig();
  assert.deepEqual(config.nowPlaying, { allowPartWatched: false, allowUpNext: false, itemCount: 2 });
});

test("publicMediaConfig reports overridden vs default tuning fields", async () => {
  const config = await loadMediaConfig();
  const pub = publicMediaConfig(config);
  assert.equal(pub.tuning.watchedThresholdPercent.overridden, true);
  assert.equal(pub.tuning.watchedThresholdPercent.value, 75);
  assert.equal(pub.tuning.outboundTimeoutSec.overridden, false);
  assert.equal(pub.tuning.outboundTimeoutSec.value, 10);
  assert.equal(pub.tuning.outboundTimeoutSec.default, 10);
  assert.deepEqual([pub.tuning.outboundTimeoutSec.min, pub.tuning.outboundTimeoutSec.max], [2, 120]);
});

test("media account setup defaults on and supports an explicit manual-only opt-out", () => {
  const previous = process.env.PLEMBFIN_MEDIA_AUTH_ENABLED;
  try {
    delete process.env.PLEMBFIN_MEDIA_AUTH_ENABLED;
    assert.equal(mediaAccountAuthEnabled(), true);
    process.env.PLEMBFIN_MEDIA_AUTH_ENABLED = "false";
    assert.equal(mediaAccountAuthEnabled(), false);
    process.env.PLEMBFIN_MEDIA_AUTH_ENABLED = "true";
    assert.equal(mediaAccountAuthEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.PLEMBFIN_MEDIA_AUTH_ENABLED;
    else process.env.PLEMBFIN_MEDIA_AUTH_ENABLED = previous;
  }
});

test("validateConfig rejects out-of-range tuning fields", async () => {
  const merged = await mergeIncomingConfig({ tuning: { watchedThresholdPercent: 10 } });
  const errors = validateConfig({ tuning: merged.tuning });
  assert.ok(errors.some((message) => message.includes("tuning.watchedThresholdPercent")));
});

test("validateConfig accepts in-range tuning fields", async () => {
  const merged = await mergeIncomingConfig({ tuning: { outboundTimeoutSec: 30 } });
  const errors = validateConfig({ tuning: merged.tuning });
  assert.deepEqual(errors, []);
});

test("validateConfig rejects an unknown watched-flag policy", async () => {
  const merged = await mergeIncomingConfig({ tuning: { watchImportMode: "later" } });
  const errors = validateConfig({ tuning: { ...merged.tuning, watchImportMode: "later" } });
  assert.ok(errors.some((message) => message.includes("tuning.watchImportMode")));
});

test("an explicit null override clears back to the default on the next save", async () => {
  await saveMediaConfig({ tuning: { watchedThresholdPercent: null } });
  assert.equal(watchedThresholdPercent(), 90);
  const reloaded = await loadMediaConfig();
  assert.equal(reloaded.tuning.watchedThresholdPercent, null);
});

test("active session TTL honors the configured activeSessionTtlMin", async () => {
  await upsertActiveSession({
    title: "TTL Test Session",
    type: "movie",
    source: "plex",
    progress: 10,
    offsetMs: 1000,
    durationMs: 100_000,
    ids: { tmdb: "999" },
  });
  const row = db.prepare("SELECT id FROM active_sessions WHERE title = ?").get("TTL Test Session");
  assert.ok(row);
  // Backdate the session 90s so it falls outside a 1-minute TTL but inside a
  // 120-minute TTL, without a real 90-second wait.
  db.prepare("UPDATE active_sessions SET updated_at = ? WHERE id = ?").run(Date.now() - 90_000, row.id);

  applyTuningConfig({ activeSessionTtlMin: 120 });
  let sessions = await listActiveSessions();
  assert.ok(sessions.some((session) => session.title === "TTL Test Session"));

  applyTuningConfig({ activeSessionTtlMin: 1 });
  sessions = await listActiveSessions();
  assert.ok(!sessions.some((session) => session.title === "TTL Test Session"));
});
