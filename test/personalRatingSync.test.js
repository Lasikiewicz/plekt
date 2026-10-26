import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-personal-rating-sync-");

const { db } = await import("../server/src/db.js");
const {
  DEFAULT_RATING_SYNC,
  normalizeRatingSyncSection,
  validateConfig,
} = await import("../server/src/utils/configStore.js");
const {
  normalizePersonalRatingMedia,
  personalRatingMediaKey,
} = await import("../server/src/utils/personalRatingIdentity.js");
const {
  acknowledgePersonalRatingQueue,
  claimPersonalRatingQueue,
  enqueuePersonalRatingMutation,
  getRatingSourceRow,
  listPersonalRatingQueue,
  ratingQueueCounts,
  failPersonalRatingQueue,
  retryPersonalRatingQueue,
  supersedePersonalRatingIntent,
  upsertCanonicalPersonalRating,
} = await import("../server/src/utils/personalRatingRepository.js");
const { queuePersonalRatingMutation } = await import("../server/src/utils/personalRatingSync.js");

test.after(() => db.close());

test("rating sync is one on/off policy across every provider", () => {
  assert.equal(DEFAULT_RATING_SYNC.enabled, false);
  assert.deepEqual(
    normalizeRatingSyncSection({
      enabled: true,
      intervalMinutes: 2,
      initialSyncMode: "import",
      conflictPolicy: "local_wins",
      providers: { plex: "send", trakt: "bidirectional", emby: "invalid" },
    }),
    {
      enabled: true,
      intervalMinutes: 5,
      initialSyncMode: "import",
      conflictPolicy: "local_wins",
      providers: { plex: "bidirectional", emby: "bidirectional", jellyfin: "bidirectional", trakt: "bidirectional", simkl: "bidirectional" },
    },
  );
  assert.deepEqual(
    normalizeRatingSyncSection({ enabled: true }),
    {
      enabled: true,
      intervalMinutes: 5,
      initialSyncMode: "import",
      conflictPolicy: "local_wins",
      providers: { plex: "bidirectional", emby: "bidirectional", jellyfin: "bidirectional", trakt: "bidirectional", simkl: "bidirectional" },
    },
  );
  assert.deepEqual(validateConfig({ ratingSync: normalizeRatingSyncSection({}) }), []);
});

test("episode rating identity uses the show identity and coordinate, not the leaf id", () => {
  const first = personalRatingMediaKey({
    media_type: "episode",
    show_tmdb_id: "100",
    episode_tmdb_id: "200",
    show_title: "Example Show",
    season: 2,
    episode: 3,
  });
  const second = personalRatingMediaKey({
    media_type: "episode",
    show_tmdb_id: "100",
    episode_tmdb_id: "999",
    show_title: "Example Show",
    season: 2,
    episode: 3,
  });
  assert.equal(first, "episode:tmdb:100:s2e3");
  assert.equal(second, first);
});

test("local rating mutations queue independently and collapse to the latest intent", () => {
  const media = normalizePersonalRatingMedia({
    media_type: "movie",
    title: "Queue Isolation",
    tmdb_id: "901",
  });
  const config = {
    plex: { baseUrl: "https://plex.example", token: "plex-token" },
    ratingSync: {
      enabled: true,
      providers: { plex: "send", emby: "off", jellyfin: "off", trakt: "off" },
    },
  };

  const queued = queuePersonalRatingMutation(media, 8, { config, timestamp: 1000 });
  assert.deepEqual(queued, { queued: 1, providers: ["plex"] });
  assert.equal(ratingQueueCounts().pending, 1);

  queuePersonalRatingMutation(media, null, { config, timestamp: 2000 });
  const rows = listPersonalRatingQueue({ provider: "plex" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].desired_state, "unrated");
  assert.equal(rows[0].desired_rating, null);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].source, "manual");
});

test("a claimed rating queue item records outbound markers without touching watched-state tables", () => {
  const media = normalizePersonalRatingMedia({
    media_type: "tv",
    title: "Outbound Marker",
    tmdb_id: "902",
  });
  upsertCanonicalPersonalRating(media, 7, { timestamp: 3000 });
  const queue = enqueuePersonalRatingMutation({
    provider: "trakt",
    media,
    desiredState: "rated",
    desiredRating: 7,
    source: "push",
    canonicalVersion: 3000,
    timestamp: 3000,
  });
  const claimed = claimPersonalRatingQueue({ provider: "trakt", owner: "rating-test", now: 3001, leaseMs: 10_000 });
  assert.equal(claimed.rows.length, 1);
  assert.equal(claimed.rows[0].intent_id, queue.intent_id);
  assert.equal(acknowledgePersonalRatingQueue({
    provider: "trakt",
    mediaKey: media.media_key,
    media,
    intentId: queue.intent_id,
    desiredState: "rated",
    desiredRating: 7,
    timestamp: 3002,
  }), true);
  assert.equal(getRatingSourceRow("trakt", media.media_key).last_outbound_state, "rated");
  assert.equal(getRatingSourceRow("trakt", media.media_key).last_outbound_rating, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playstate").get().count, 0);
});

test("held rating writes stay terminal until explicitly retried, then can be superseded", () => {
  const media = normalizePersonalRatingMedia({ media_type: "movie", title: "Held rating", tmdb_id: "903" });
  const held = enqueuePersonalRatingMutation({ provider: "simkl", media, desiredState: "rated", desiredRating: 8, intentId: "held-1", timestamp: 4000 });
  const firstClaim = claimPersonalRatingQueue({ provider: "simkl", owner: "held-initial", now: 4000 });
  assert.equal(firstClaim.rows[0].intent_id, held.intent_id);
  assert.equal(failPersonalRatingQueue({ provider: "simkl", mediaKey: media.media_key, intentId: held.intent_id, status: "held", error: "unsafe", timestamp: 4001 }), true);
  assert.equal(claimPersonalRatingQueue({ provider: "simkl", now: 5000 }).rows.length, 0);
  assert.equal(retryPersonalRatingQueue({ provider: "simkl", mediaKey: media.media_key, now: 5000 }), 1);
  const claimed = claimPersonalRatingQueue({ provider: "simkl", owner: "held-retry", now: 5000 });
  assert.equal(claimed.rows[0].intent_id, held.intent_id);
  assert.equal(failPersonalRatingQueue({ provider: "simkl", mediaKey: media.media_key, intentId: held.intent_id, status: "held", error: "unsafe", timestamp: 5001 }), true);
  assert.equal(claimPersonalRatingQueue({ provider: "simkl", now: 9000 }).rows.length, 0);
  assert.equal(retryPersonalRatingQueue({ provider: "simkl", mediaKey: media.media_key, now: 10_000 }), 1);
  assert.equal(supersedePersonalRatingIntent("simkl", [media.media_key]), 1);
  assert.equal(listPersonalRatingQueue({ provider: "simkl" }).length, 0);
});
