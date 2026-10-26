import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-watch-transition-atomicity-");

const { db } = await import("../server/src/db.js");
const repo = await import("../server/src/utils/dataRepo.js");
const { createLoopStore } = await import("../server/src/utils/loopStore.js");
const { applyWatchedTransition } = await import("../server/src/utils/watchStateTransitions.js");

const config = {
  plex: { disabled: true },
  emby: { disabled: true },
  jellyfin: { disabled: true },
};

test("a synchronous local mutation failure rolls back the entire watched transition", async () => {
  const media = {
    title: "Atomic Show - S01E01",
    showTitle: "Atomic Show",
    type: "episode",
    mediaType: "episode",
    ids: { tmdb: "atomic-transition" },
    season: 1,
    episode: 1,
    source: "trakt",
    watched_at: "2026-08-23T10:00:00.000Z",
  };
  const mediaKey = repo.mediaKeyFor(media);

  db.prepare(`
    INSERT INTO playback_progress (
      media_key, title, media_type, source, tmdb_id, season, episode,
      position_ms, duration_ms, progress, updated_at
    ) VALUES (?, ?, 'episode', 'plex', ?, 1, 1, 120000, 240000, 50, ?)
  `).run(mediaKey, media.title, media.ids.tmdb, Date.now());

  db.exec(`
    CREATE TRIGGER reject_atomic_transition_playstate
    BEFORE INSERT ON playstate
    WHEN NEW.tmdb_id = 'atomic-transition'
    BEGIN
      SELECT RAISE(ABORT, 'forced playstate failure');
    END
  `);

  try {
    await assert.rejects(
      applyWatchedTransition(media, config, createLoopStore(), { trackDispatch: false }),
      /forced playstate failure/,
    );

    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM watch_history WHERE tmdb_id = ?").get(media.ids.tmdb).c,
      0,
      "the history insert before the failure must roll back",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM playback_progress WHERE media_key = ?").get(mediaKey).c,
      1,
      "the progress delete before the failure must roll back",
    );
    assert.equal(await repo.getPlaystateForMedia(media), null);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM watch_audit_events WHERE tmdb_id = ?").get(media.ids.tmdb).c,
      0,
      "audit rows written by the failed transition must roll back with it",
    );
  } finally {
    db.exec("DROP TRIGGER IF EXISTS reject_atomic_transition_playstate");
  }
});

test("a watched tracker transition supersedes a newer unwatched provider-id alias", async () => {
  const media = {
    title: "Silo - S03E03",
    showTitle: "Silo",
    type: "episode",
    mediaType: "episode",
    ids: { tmdb: "125988", tvdb: "403245" },
    season: 3,
    episode: 3,
    source: "trakt",
    watched_at: "2026-07-17T12:00:00.000Z",
  };
  const insert = db.prepare(`INSERT INTO watch_history
    (id, title, title_lower, media_type, watched_at, source, tmdb_id, tvdb_id,
     season, episode, sync_action, media_key, show_title, show_title_lower,
     created_at, updated_at)
    VALUES (@id, @title, @title_lower, 'episode', @watched_at, @source,
            @tmdb_id, @tvdb_id, 3, 3, @sync_action, @media_key,
            'Silo', 'silo', @created_at, @updated_at)`);
  insert.run({
    id: "silo-old-watched-alias",
    title: media.title,
    title_lower: media.title.toLowerCase(),
    watched_at: media.watched_at,
    source: "manual",
    tmdb_id: "legacy-silo-id",
    tvdb_id: null,
    sync_action: "watched",
    media_key: "episode:3:3:tmdb:legacy-silo-id",
    created_at: 1_000,
    updated_at: 1_000,
  });
  insert.run({
    id: "silo-newer-unwatched-alias",
    title: media.title,
    title_lower: media.title.toLowerCase(),
    watched_at: "2026-08-24T06:43:33.000Z",
    source: "trakt",
    tmdb_id: media.ids.tmdb,
    tvdb_id: media.ids.tvdb,
    sync_action: "unwatched",
    media_key: repo.mediaKeyFor(media),
    created_at: 2_000,
    updated_at: 2_000,
  });
  await repo.upsertPlaystateForMedia(media, "unwatched", "2026-08-24T06:43:33.000Z");

  const before = await repo.queryShowDetail({ title: "Silo" });
  assert.equal(before.episodes[0].sync_action, "watched", "the earlier Plembfin decision outranks a provider alias echo");

  const transition = await applyWatchedTransition(media, config, createLoopStore(), { trackDispatch: false });

  assert.equal(transition.inserted, true, "the watched fact must be recorded instead of short-circuiting on the older alias");
  assert.equal((await repo.getPlaystateForMedia(media)).state, "watched");
  await repo.invalidateHistoryDerivedCaches();
  const after = await repo.queryShowDetail({ title: "Silo" });
  assert.equal(after.episodes[0].sync_action, "watched");
});

test("a Trakt date that differs only by its minute rounding is not a correction", async () => {
  const media = {
    title: "Rounded Movie", type: "movie", mediaType: "movie", ids: { tmdb: "rounded-trakt-date" },
    source: "trakt", watched_at: "2020-04-23T23:32:51.000Z",
  };
  assert.equal((await applyWatchedTransition(media, config, createLoopStore(), { trackDispatch: false })).inserted, true);
  const stored = () => db.prepare("SELECT watched_at FROM watch_history WHERE tmdb_id=?").get(media.ids.tmdb).watched_at;

  const rounded = await applyWatchedTransition({ ...media, watched_at: "2020-04-23T23:32:00.000Z" }, config, createLoopStore(), { trackDispatch: false });
  assert.equal(rounded.alreadyWatched, true, "Trakt reading back Plekt's own play without seconds changes nothing");
  assert.equal(rounded.dateCorrected, undefined);
  assert.equal(new Date(stored()).toISOString(), "2020-04-23T23:32:51.000Z");

  const corrected = await applyWatchedTransition({ ...media, watched_at: "2020-04-24T20:00:00.000Z" }, config, createLoopStore(), { trackDispatch: false });
  assert.equal(corrected.dateCorrected, true, "a real date change on Trakt is still applied");
  assert.equal(new Date(stored()).toISOString(), "2020-04-24T20:00:00.000Z");
});
