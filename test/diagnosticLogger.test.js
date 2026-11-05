import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-diagnostic-logs-");
process.env.ROLE = "web";
const logger = await import("../server/src/utils/diagnosticLogger.js");
const { DATA_DIR } = await import("../server/src/paths.js");

test("archive retention preserves fourteen days even with more than twenty files", () => {
  const folder = path.join(DATA_DIR, "logs");
  const oldFile = path.join(folder, "diagnostic-old.jsonl");
  fs.writeFileSync(oldFile, "old");
  const old = new Date(Date.now() - 15 * 86400000);
  fs.utimesSync(oldFile, old, old);
  for (let i = 0; i < 25; i += 1) fs.writeFileSync(path.join(folder, `diagnostic-recent-${i}.jsonl`), "recent");
  logger.pruneLogArchive();
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.readdirSync(folder).filter((name) => name.startsWith("diagnostic-recent-")).length, 25);
});

test("diagnostic logs redact secrets and clear across the shared store", async () => {
  console.log("diagnostic-test token=super-secret-value");
  const before = logger.getLogs({ limit: 20 });
  assert.ok(before.logs.some((line) => line.includes("diagnostic-test token=[redacted]")));
  assert.ok(before.logs.every((line) => !line.includes("super-secret-value")));
  await new Promise((resolve) => setTimeout(resolve, 2));
  logger.clearLogs();
  assert.equal(logger.getLogs({ limit: 20 }).logs.length, 0);
});

test("diagnostic logs honour a since cutoff and a limit above 1000", async () => {
  logger.clearLogs();
  // Rows with ts <= the clear moment are hidden, so let the clock move on first.
  await new Promise((resolve) => setTimeout(resolve, 5));
  console.log("diagnostic-since-old");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cutoff = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 10));
  console.log("diagnostic-since-new");
  const windowed = logger.getLogs({ limit: 20, since: cutoff }).logs;
  assert.ok(windowed.some((line) => line.includes("diagnostic-since-new")));
  assert.ok(windowed.every((line) => !line.includes("diagnostic-since-old")));
  assert.ok(logger.getLogs({ limit: 5000 }).logs.some((line) => line.includes("diagnostic-since-old")));
  logger.clearLogs();
  // clearLogs() hides rows with ts <= now, so let the clock move on before the next test logs.
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("diagnostic log export returns every row even when the table runs past 20,000", async () => {
  const { db } = await import("../server/src/db.js");
  logger.clearLogs();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const base = Date.now();
  const insert = db.prepare("INSERT INTO diagnostic_log (ts, level, category, role, instance, message) VALUES (?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 20300; i++) insert.run(base + i, "info", "system", "web", "web:1", `bulk-${i}`);
  })();
  const lines = logger.getLogs({ limit: 21000 }).logs;
  assert.equal(lines.length, 20300);
  assert.ok(lines[0].includes("bulk-0"), "oldest row must not be dropped");
  logger.clearLogs();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

test("diagnostic logs classify messages into categories correctly", () => {
  assert.equal(logger.categorizeLog("Plex notification socket connected"), "plex-notifications");
  assert.equal(logger.categorizeLog("Sync playstate dispatch completed"), "sync");
  assert.equal(logger.categorizeLog("syncRecentlyWatchedFromPlex starting"), "scheduled-poll");
  assert.equal(logger.categorizeLog("Random server startup event"), "system");
});

test("diagnostic logs keep error messages without exposing stack traces", () => {
  const marker = "diagnostic-stack-redaction-test";
  console.error(new Error(marker));
  const result = logger.getLogs({ level: "error", limit: 20 });
  const line = result.logs.find((entry) => entry.includes(marker));

  assert.ok(line);
  assert.equal(line.includes("at diagnosticLogger.test.js"), false);
});
