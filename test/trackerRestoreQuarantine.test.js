import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-tracker-restore-quarantine-");
const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/trackerConnectionRepo.js");
const ledger = await import("../server/src/utils/trackerWriteIntents.js");
const { exportCollectionPage, importCollectionBatch } = await import("../server/src/utils/backup.js");
const { syncAttentionState } = await import("../server/src/utils/syncAttention.js");

const media = { type: "movie", title: "Quarantine test", ids: { tmdb: "77" }, source: "plex", watched_at: "2026-10-01T12:00:00.000Z" };
const snapshot = () => Object.fromEntries(["tracker_connections", "tracker_item_state", "tracker_play_history", "tracker_write_intents"]
  .map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE provider='letterboxd' ORDER BY 1`).all()]));
test.beforeEach(() => {
  for (const table of ["tracker_write_intents", "tracker_item_state", "tracker_play_history", "tracker_connections", "watch_history"]) db.prepare(`DELETE FROM ${table}`).run();
});

// A backup (or a downgrade) carrying rows for a tracker this version does not
// register. "letterboxd" stands in for a tracker added by a newer version.
function restoreUnknownTracker() {
  const trakt = repo.saveTrackerConnection({ provider: "trakt", remoteUserId: "account-a", accessToken: "test", refreshToken: "test", accessTokenExpiresAt: Date.now() + 3600000 });
  const [document] = exportCollectionPage("trackerConnections", { browserSafe: false }).documents;
  importCollectionBatch("trackerConnections", [{ id: "letterboxd-connection", data: { ...document.data, provider: "letterboxd", remote_user_id: "letterboxd-user" } }]);
  importCollectionBatch("trackerItemState", [{ id: "movie:tmdb:77", data: { provider: "letterboxd", media_json: JSON.stringify(media), last_seen_at: 1 } }]);
  db.prepare("INSERT INTO tracker_play_history (provider,history_id,media_key,watched_at,created_at) VALUES ('letterboxd','s-1','movie:tmdb:77',?,1)").run(media.watched_at);
  // Downgrade case: an old unresolved write queued by the newer version.
  const intent = ledger.createTrackerWriteIntent({ provider: "trakt", connection: trakt, media, action: "watched", now: 1 });
  db.prepare("UPDATE tracker_write_intents SET provider='letterboxd',connection_id='letterboxd-connection',account_id='letterboxd-user' WHERE id=?").run(intent.id);
  db.prepare("DELETE FROM tracker_item_state WHERE provider='trakt'").run();
  return intent.id;
}

test("restored rows for an unknown tracker stay inert and untouched", () => {
  const intentId = restoreUnknownTracker();
  const before = snapshot();
  assert.deepEqual(repo.listTrackerConnections().map((connection) => connection.provider), ["trakt"]);
  // A new local watch still captures only the registered tracker instead of throwing.
  assert.deepEqual(ledger.captureTrackerDestinations(media, "new-play").map((intent) => intent.provider), ["trakt"]);
  assert.equal(ledger.listDueTrackerWriteIntents(Date.now(), 50).some((intent) => intent.id === intentId), false);
  assert.equal(ledger.trackerRetryRecordIds().size, 0);
  // 30-day maintenance would otherwise move the old write to review.
  assert.deepEqual(snapshot(), before);
});

test("unknown tracker data shows one non-blocking message that Skip hides without deleting", () => {
  restoreUnknownTracker();
  const before = snapshot();
  const items = ledger.trackerWriteAttentionItems();
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.id, "unknown-tracker:letterboxd");
  assert.equal(item.severity, "warning");
  assert.equal(item.canSkip, true);
  assert.equal(item.title, "Letterboxd isn't supported in this version");
  assert.deepEqual(item.context.tables, { tracker_connections: 1, tracker_item_state: 1, tracker_play_history: 1, tracker_write_intents: 1 });

  assert.equal(syncAttentionState({ trackerWriteAttention: items }).count, 1);
  assert.equal(syncAttentionState({ trackerWriteAttention: items, syncAttentionSkips: { [item.id]: { skippedAt: 1 } } }).count, 0);
  assert.deepEqual(snapshot(), before);
});

