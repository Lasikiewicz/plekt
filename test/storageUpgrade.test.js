import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-storage-upgrade-");

const { db } = await import("../server/src/db.js");
const { getSharedMetadataDb } = await import("../server/src/utils/sharedMetadataStore.js");
const {
  getPublicUpgradeStatus,
  getStorageStatus,
  hasPendingDatabaseUpgrade,
  isDatabaseUpgradeActive,
  markArtworkOptimizationComplete,
  resetStorageUpgradeForTests,
  runDatabaseCompactionTask,
  startArtworkOptimizationTask,
  startStartupDatabaseUpgrade,
} = await import("../server/src/utils/storageUpgrade.js");
const { renderUpgradeScreenHtml } = await import("../server/src/utils/upgradeScreenHtml.js");
const { isGzipBuffer } = await import("../server/src/utils/jsonCompression.js");

test("fresh or already-compacted databases skip the startup upgrading screen", () => {
  resetStorageUpgradeForTests();
  assert.equal(hasPendingDatabaseUpgrade(), false);
  assert.equal(startStartupDatabaseUpgrade(), null);
  assert.equal(isDatabaseUpgradeActive(), false);
});

test("startup database upgrade detects pending uncompressed rows, compacts in yielded batches, and clears active state", async () => {
  resetStorageUpgradeForTests();
  const shared = getSharedMetadataDb(dataDir);
  const big = JSON.stringify({
    id: 9001,
    name: "Upgrade Test Show",
    original_language: "en",
    external_ids: { tvdb_id: 12345 },
    overview: "Repeating overview text for upgrade test. ".repeat(40),
  });
  shared.prepare(
    "INSERT OR REPLACE INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, updated_at_ms) VALUES ('tv_9001', '9001', 'tv', 'Upgrade Test Show', ?, ?)",
  ).run(big, Date.now());

  assert.equal(hasPendingDatabaseUpgrade(), true);

  const result = await runDatabaseCompactionTask({ showUpgradeScreen: true });
  assert.equal(result.ok, true);
  assert.equal(isDatabaseUpgradeActive(), false);
  assert.equal(getPublicUpgradeStatus().stage, "complete");
  assert.equal(getPublicUpgradeStatus().percent, 100);

  const row = shared.prepare("SELECT details, tvdb_id FROM tmdb_metadata_cache WHERE id = 'tv_9001'").get();
  assert.ok(isGzipBuffer(row.details));
  assert.equal(row.tvdb_id, "12345");
  assert.equal(hasPendingDatabaseUpgrade(), false);
});

test("background artwork optimization runs once automatically and records its completion marker", async () => {
  resetStorageUpgradeForTests();
  const statusBefore = getStorageStatus();
  assert.equal(statusBefore.artworkOptimizedVersion, 0);

  const first = await startArtworkOptimizationTask({ throttleMs: 0, background: true });
  assert.ok(first);
  const statusAfter = getStorageStatus();
  assert.equal(statusAfter.artworkOptimizedVersion, 1);

  // A second background attempt sees the version marker and skips immediately.
  assert.equal(startArtworkOptimizationTask({ throttleMs: 0, background: true }), null);

  // Explicit CLI marker (used by scripts/compact-storage.js) also prevents redundant background passes.
  db.prepare("DELETE FROM runtime_state WHERE id = 'storageUpgradeState'").run();
  assert.equal(getStorageStatus().artworkOptimizedVersion, 0);
  markArtworkOptimizationComplete();
  assert.equal(getStorageStatus().artworkOptimizedVersion, 1);
  assert.equal(startArtworkOptimizationTask({ throttleMs: 0, background: true }), null);
});

test("renderUpgradeScreenHtml uses external CSP-compliant scripts and reflects progress safely", () => {
  const html = renderUpgradeScreenHtml({ percent: 42, label: "Compressing <metadata> & cache…" });
  assert.match(html, /Upgrading Plekt/);
  assert.match(html, /src="\/theme-boot\.js"/);
  assert.match(html, /src="\/upgrade-status\.js"/);
  assert.match(html, /Compressing &lt;metadata&gt; &amp; cache…/);
  assert.match(html, /aria-valuenow="42"/);
  // Ensure no inline <script> blocks that CSP script-src 'self' would reject.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.ok(fs.existsSync(path.resolve(import.meta.dirname, "../public/upgrade-status.js")));
});

test("tools-storage calls showConfirmModal with (message, onApprove, options)", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/tools-storage.js"), "utf8");
  assert.match(
    source,
    /_showConfirmModal\(\s*`[^`]+`,\s*\(\)\s*=>\s*\{[\s\S]*?\/api\/storage\/recompress-backups[\s\S]*?\},\s*\{\s*title:\s*"Recompress Legacy Backups\?",\s*approveLabel:\s*"Recompress"\s*\},?\s*\);/,
  );
});
