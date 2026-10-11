import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watchlist-backup-");

const { db } = await import("../server/src/db.js");
const {
  applyWatchlistMutation,
  getCanonicalWatchlist,
  getWatchlistRestoreState,
  listWatchlistProviderItems,
  listWatchlistQueue,
  upsertProviderWatchlistItem,
} = await import("../server/src/utils/personalWatchlistRepository.js");
const { normalizePersonalWatchlistMedia } = await import("../server/src/utils/personalWatchlistIdentity.js");
const { exportCollectionPage, getFullBackup, importCollectionBatch } = await import("../server/src/utils/backup.js");

const config = {
  plex: { baseUrl: "https://plex.example", accountToken: "plex-secret" },
  watchlistSync: {
    enabled: true,
    providers: {
      plex: { enabled: true, representation: "native", writeEnabled: true, publishConfirmedAt: 1 },
    },
  },
};

test.after(() => db.close());

test("full watchlist export and staged restore preserve local state but require republish", () => {
  const browserSecret = "browser-export-secret";
  db.prepare("INSERT OR REPLACE INTO settings (id, data, updated_at) VALUES (?, ?, ?)").run("mediaConfig", JSON.stringify({ plex: { token: browserSecret }, watchlistSync: { enabled: true } }), Date.now());
  const browserSettings = exportCollectionPage("settings").documents.find((document) => document.id === "mediaConfig");
  assert.equal(browserSettings.data.plex.token, undefined);
  assert.equal(browserSettings.data.__plektRedactedSecrets, true);
  assert.equal(JSON.stringify(browserSettings.data).includes(browserSecret), false);
  assert.throws(() => exportCollectionPage("mediaConnections"), /not available in browser portable exports/);

  const fullSettings = getFullBackup().collections.settings.find((document) => document.id === "mediaConfig");
  assert.equal(fullSettings.data.plex.token, browserSecret);

  importCollectionBatch("settings", [browserSettings], { reset: true, portable: true });
  assert.equal(JSON.parse(db.prepare("SELECT data FROM settings WHERE id = 'mediaConfig'").get().data).plex.token, browserSecret);

  const media = normalizePersonalWatchlistMedia({ type: "movie", title: "Backup Watchlist Item", tmdb_id: "801" });
  applyWatchlistMutation(media, "present", {
    config,
    origin: "local",
    reason: "manual_add",
    eventId: "backup-add-801",
    timestamp: 1000,
  });
  upsertProviderWatchlistItem({
    provider: "plex",
    connectionId: "plex-backup",
    remoteScopeKey: "account:user-1",
    representation: "native",
    media,
    providerItemId: "plex-801",
    providerIds: { plex_rating_key: "plex-801" },
    managedByPlembfin: true,
    timestamp: 1100,
  });

  const backup = getFullBackup("watchlist-test");
  assert.ok(backup.collections.personalWatchlist.some((document) => document.data.media_type === "movie"));
  assert.ok(backup.collections.personalWatchlistMutations.length >= 1);
  assert.ok(backup.collections.personalWatchlistProviderItems.length >= 1);
  assert.ok(backup.collections.personalWatchlistSyncQueue.length >= 1);

  const page = exportCollectionPage("personalWatchlist", { limit: 1 });
  assert.equal(page.documents.length, 1);
  assert.equal(page.documents[0].id, media.media_key);

  importCollectionBatch("personalWatchlist", backup.collections.personalWatchlist, { reset: true });
  importCollectionBatch("personalWatchlistMutations", backup.collections.personalWatchlistMutations, { reset: true });
  importCollectionBatch("personalWatchlistProviderItems", backup.collections.personalWatchlistProviderItems, { reset: true });
  importCollectionBatch("personalWatchlistSyncQueue", backup.collections.personalWatchlistSyncQueue, { reset: true });
  importCollectionBatch("personalWatchlistSyncRuns", backup.collections.personalWatchlistSyncRuns, { reset: true });
  importCollectionBatch("personalWatchlistActivity", backup.collections.personalWatchlistActivity, { reset: true });

  assert.equal(getCanonicalWatchlist(media).media_key, media.media_key);
  assert.equal(getWatchlistRestoreState().pending, true);
  assert.ok(listWatchlistProviderItems({ provider: "plex" }).every((item) => item.remote_state === "unknown"));
  assert.ok(listWatchlistQueue().every((row) => row.status === "pending" && row.succeeded_at === null));
});
