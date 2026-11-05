import test from "node:test";
import assert from "node:assert/strict";

import {
  decodeHtmlEntities,
  buildPlexMediaFromMetadata,
  parseEmbyWebhook,
  parseJellyfinWebhook,
  parsePlexGuids,
  parsePlexWebhook,
} from "../server/src/utils/parsers.js";
import { applyTuningConfig, resetTuningForTests } from "../server/src/utils/tuning.js";

function plexForm(event, metadata = {}) {
  const form = new FormData();
  form.set("payload", JSON.stringify({ event, Metadata: { type: "movie", title: "Arrival", ...metadata } }));
  return form;
}

test("parsePlexWebhook derives completed, ended, active, and ignored phases", async () => {
  const scrobble = await parsePlexWebhook(plexForm("media.scrobble", { guid: "tmdb://329865", ratingKey: "plex-329865" }));
  assert.equal(scrobble.phase, "completed");
  assert.equal(scrobble.isValid, true);
  assert.equal(scrobble.watchProvenance.ingest_path, "plex_webhook");
  assert.equal(scrobble.watchProvenance.event, "media.scrobble");
  assert.equal(scrobble.watchProvenance.item_id, "plex-329865");

  const stopEarly = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 89_000 }));
  assert.equal(stopEarly.phase, "ended");

  const stopComplete = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 91_000 }));
  assert.equal(stopComplete.phase, "completed");

  const progress = await parsePlexWebhook(plexForm("media.progress", { duration: 100_000, viewOffset: 45_000 }));
  assert.equal(progress.phase, "active");

  const malformed = await parsePlexWebhook(new FormData());
  assert.equal(malformed.phase, "ignored");
  assert.equal(malformed.isValid, false);
});

test("parseEmbyWebhook derives phase boundaries", () => {
  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 89, ...base }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 91, ...base }).phase, "completed");
  assert.equal(parseEmbyWebhook({ Event: "item.markunplayed", ...base }).phase, "unplayed");
  assert.equal(parseEmbyWebhook({ Event: "playback.progress", ...base }).phase, "active");
  assert.equal(parseEmbyWebhook({ Event: "something.else", ...base }).phase, "ignored");
});

test("Emby and Jellyfin webhooks derive progress from position when a stale zero percentage is present", () => {
  const item = {
    Type: "Movie",
    Name: "Arrival",
    RunTimeTicks: 4_000_000_000,
    ProviderIds: { Tmdb: "329865" },
  };
  const emby = parseEmbyWebhook({
    Event: "playback.stop",
    Progress: 0,
    PlayState: { PositionTicks: 1_000_000_000 },
    Item: item,
  });
  const jellyfin = parseJellyfinWebhook({
    NotificationType: "PlaybackStop",
    PlayedPercentage: 0,
    PlayState: { PositionTicks: 1_000_000_000 },
    Item: item,
  });

  assert.equal(emby.progress, 25);
  assert.equal(emby.phase, "ended");
  assert.equal(jellyfin.progress, 25);
  assert.equal(jellyfin.phase, "ended");
});

test("Emby playback-stop payloads read completion position from nested PlaybackInfo", () => {
  const emby = parseEmbyWebhook({
    Event: "playback.stop",
    Item: {
      Type: "Episode",
      Name: "Richmond's Got Talent",
      RunTimeTicks: 27_897_870_000,
      ProviderIds: { Tvdb: "11767183" },
    },
    PlaybackInfo: {
      PlayedToCompletion: true,
      PositionTicks: 27_890_050_000,
      MediaSource: { RunTimeTicks: 27_897_870_000 },
    },
  });

  assert.equal(emby.phase, "completed");
  assert.ok(emby.progress >= 99.9);
  assert.ok(emby.offsetMs > 0);
});

test("parseJellyfinWebhook derives phase boundaries", () => {
  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 89, ...base }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 91, ...base }).phase, "completed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "ItemMarkUnplayed", ...base }).phase, "unplayed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackProgress", ...base }).phase, "active");
  assert.equal(parseJellyfinWebhook({ NotificationType: "SomethingElse", ...base }).phase, "ignored");
});

// The Jellyfin webhook plugin sends a flat body: the item is ItemId and the
// top-level Id is the playback session (seen live 29 September 2026).
test("parseJellyfinWebhook reads ItemId, not the session Id, from a flat body", () => {
  const flat = {
    NotificationType: "PlaybackStop",
    Id: "34211a9cc89027b2f98dbff0e5d04a31",
    ItemId: "24da5e42bb7ede9d6ebd79eb144f5104",
    ItemType: "Movie",
    Name: "Anuvahood",
    Provider_imdb: "tt1658797",
    PlayedToCompletion: true,
  };
  const parsed = parseJellyfinWebhook(flat);
  assert.equal(parsed.watchProvenance.item_id, "24da5e42bb7ede9d6ebd79eb144f5104");
  assert.equal(parsed.watchProvenance.session_id, "34211a9cc89027b2f98dbff0e5d04a31");

  const userData = parseJellyfinWebhook({ NotificationType: "UserDataSaved", ItemId: "24da5e42", ItemType: "Movie", Name: "Anuvahood", Played: true });
  assert.equal(userData.watchProvenance.item_id, "24da5e42");
  assert.equal(userData.watchProvenance.session_id, "");
});

test("Emby and Jellyfin UserData Played=false with positive progress is partial playback, not an unwatch", () => {
  const item = {
    Type: "Episode",
    Name: "Episode 1",
    SeriesName: "Ted Lasso",
    ParentIndexNumber: 4,
    IndexNumber: 1,
    RunTimeTicks: 24_924_900_000,
    ProviderIds: { Tvdb: "11766070" },
    UserData: {
      Played: false,
      PlaybackPositionTicks: 9_870_000_000,
    },
  };

  const emby = parseEmbyWebhook({ Event: "user.dataSaved", Item: item });
  const jellyfin = parseJellyfinWebhook({ NotificationType: "UserDataSaved", Item: item });

  for (const parsed of [emby, jellyfin]) {
    assert.equal(parsed.phase, "ended");
    assert.equal(parsed.offsetMs, 987_000);
    assert.ok(parsed.progress > 39 && parsed.progress < 40);
  }
});

test("explicit Emby and Jellyfin unwatch events remain authoritative even if stale progress is present", () => {
  const item = {
    Type: "Episode",
    Name: "Episode 1",
    SeriesName: "Ted Lasso",
    ParentIndexNumber: 4,
    IndexNumber: 1,
    RunTimeTicks: 24_924_900_000,
    ProviderIds: { Tvdb: "11766070" },
    UserData: { Played: false, PlaybackPositionTicks: 9_870_000_000 },
  };

  assert.equal(parseEmbyWebhook({ Event: "item.markUnplayed", Item: item }).phase, "unplayed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "ItemMarkUnplayed", Item: item }).phase, "unplayed");
});

test("zero-position UserData Played=false remains an unwatch", () => {
  const item = {
    Type: "Episode",
    Name: "Episode 1",
    SeriesName: "Ted Lasso",
    ParentIndexNumber: 4,
    IndexNumber: 1,
    ProviderIds: { Tvdb: "11766070" },
    UserData: { Played: false, PlaybackPositionTicks: 0 },
  };

  assert.equal(parseEmbyWebhook({ Event: "user.dataSaved", Item: item }).phase, "unplayed");
  assert.equal(parseJellyfinWebhook({ NotificationType: "UserDataSaved", Item: item }).phase, "unplayed");
});

test("Jellyfin play-start UserData Played=false at position 0 is not an unwatch", () => {
  // Flat webhook-plugin payload as Jellyfin 12 sent it when a play started
  // (Up Next matrix step 6 repeat, defect Q).
  const payload = (saveReason) => ({
    NotificationType: "UserDataSaved",
    ItemType: "Episode",
    Name: "Episode 2",
    SeriesName: "Scot Squad",
    SeasonNumber: 1,
    EpisodeNumber: 2,
    Provider_tvdb: "264603",
    ItemId: "689a470f5e81f5a1ed01c7fe09354925",
    Played: false,
    PlayCount: 1,
    PlaybackPositionTicks: 0,
    LastPlayedDate: "2026-09-23T08:15:47.5987763Z",
    SaveReason: saveReason,
  });

  for (const reason of ["PlaybackStart", "PlaybackProgress", "PlaybackFinished"]) {
    assert.equal(parseJellyfinWebhook(payload(reason)).phase, "ignored", reason);
  }
  // A user unplay in Jellyfin, and a UserData write through the API, stay unwatches.
  assert.equal(parseJellyfinWebhook({ ...payload("TogglePlayed"), PlayCount: 0, LastPlayedDate: undefined }).phase, "unplayed");
  assert.equal(parseJellyfinWebhook(payload("UpdateUserData")).phase, "unplayed");
  // Positive progress saved at play start is still partial playback.
  assert.equal(parseJellyfinWebhook({ ...payload("PlaybackStart"), PlaybackPositionTicks: 3_000_000_000 }).phase, "ended");
});

test("episode webhooks prefer series provider ids for cross-app matching", async () => {
  const plex = await parsePlexWebhook(plexForm("media.scrobble", {
    type: "episode",
    title: "Picture Says a Thousand Words",
    grandparentTitle: "Reacher",
    parentIndex: 2,
    index: 3,
    guid: "tmdb://999999",
    grandparentGuid: "tmdb://108978",
  }));
  assert.equal(plex.ids.tmdb, "108978");

  const item = {
    Type: "Episode",
    Name: "Picture Says a Thousand Words",
    SeriesName: "Reacher",
    ParentIndexNumber: 2,
    IndexNumber: 3,
    ProviderIds: { Tvdb: "episode-123" },
    SeriesProviderIds: { Tmdb: "108978", Tvdb: "366924" },
  };
  const emby = parseEmbyWebhook({ Event: "playback.stop", Progress: 100, Item: item });
  const jellyfin = parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 100, Item: item });

  for (const parsed of [emby, jellyfin]) {
    assert.equal(parsed.ids.tmdb, "108978");
    assert.equal(parsed.ids.tvdb, "366924");
    assert.equal(parsed.season, 2);
    assert.equal(parsed.episode, 3);
  }
});

test("parsePlexGuids supports modern and legacy agent formats", () => {
  assert.deepEqual(parsePlexGuids({
    guid: "plex://movie/abc",
    Guid: [
      { id: "imdb://tt2543164" },
      { id: "tmdb://329865" },
      { id: "tvdb://12345" },
    ],
  }), { imdb: "tt2543164", tmdb: "329865", tvdb: "12345" });

  assert.deepEqual(parsePlexGuids({
    Guid: [
      { id: "com.plexapp.agents.imdb://tt0068646?lang=en" },
      { id: "com.plexapp.agents.themoviedb://238?lang=en" },
      { id: "com.plexapp.agents.thetvdb://81189?lang=en" },
    ],
  }), { imdb: "tt0068646", tmdb: "238", tvdb: "81189" });
});

test("decodeHtmlEntities decodes once without double-unescaping", () => {
  assert.equal(decodeHtmlEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeHtmlEntities("Tom &#38;amp; Jerry"), "Tom &amp; Jerry");
});

test("phase boundaries follow the configured watched threshold", async (t) => {
  t.after(() => resetTuningForTests());

  applyTuningConfig({ watchedThresholdPercent: 70 });

  const stopBelow = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 69_000 }));
  assert.equal(stopBelow.phase, "ended");
  const stopAtThreshold = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 70_000 }));
  assert.equal(stopAtThreshold.phase, "completed");

  const embyBase = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 69, ...embyBase }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 70, ...embyBase }).phase, "completed");

  const jellyfinBase = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 69, ...jellyfinBase }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 70, ...jellyfinBase }).phase, "completed");

  applyTuningConfig({ watchedThresholdPercent: 95 });

  const stopBelowHigh = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 94_000 }));
  assert.equal(stopBelowHigh.phase, "ended");
  const stopAtHighThreshold = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 95_000 }));
  assert.equal(stopAtHighThreshold.phase, "completed");

  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 94, ...embyBase }).phase, "ended");
  assert.equal(parseEmbyWebhook({ Event: "playback.stop", Progress: 95, ...embyBase }).phase, "completed");

  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 94, ...jellyfinBase }).phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 95, ...jellyfinBase }).phase, "completed");
});

test("phase boundaries fall back to the default 90% threshold once tuning is reset", async () => {
  resetTuningForTests();
  const stopBelow = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 89_000 }));
  assert.equal(stopBelow.phase, "ended");
  const stopAt = await parsePlexWebhook(plexForm("media.stop", { duration: 100_000, viewOffset: 90_000 }));
  assert.equal(stopAt.phase, "completed");
});

test("played-flag events are tagged and dated from the server's own played timestamp", () => {
  const embyMarkPlayed = parseEmbyWebhook({
    Event: "item.markplayed",
    Item: {
      Type: "Movie",
      Name: "Arrival",
      ProviderIds: { Tmdb: "329865" },
      UserData: { Played: true, LastPlayedDate: "2026-07-25T20:15:47.000Z" },
    },
  });
  assert.equal(embyMarkPlayed.phase, "completed");
  assert.equal(embyMarkPlayed.playedFlagOnly, true);
  assert.equal(embyMarkPlayed.playedAt, "2026-07-25T20:15:47.000Z");
  assert.equal(embyMarkPlayed.watchProvenance.ingest_path, "emby_webhook");
  assert.equal(embyMarkPlayed.watchProvenance.event, "item.markplayed");

  const embyUserData = parseEmbyWebhook({
    Event: "user.datasaved",
    Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" }, UserData: { Played: true } },
  });
  assert.equal(embyUserData.playedFlagOnly, true);

  const jellyfinMarkPlayed = parseJellyfinWebhook({
    NotificationType: "ItemMarkPlayed",
    Item: {
      Type: "Movie",
      Name: "Arrival",
      ProviderIds: { Tmdb: "329865" },
      UserData: { Played: true, LastPlayedDate: "2026-07-25T20:15:47.000Z" },
    },
  });
  assert.equal(jellyfinMarkPlayed.playedFlagOnly, true);
  assert.equal(jellyfinMarkPlayed.playedAt, "2026-07-25T20:15:47.000Z");
  assert.equal(jellyfinMarkPlayed.watchProvenance.ingest_path, "jellyfin_webhook");
  assert.equal(jellyfinMarkPlayed.watchProvenance.event, "ItemMarkPlayed");
});

test("played-flag history uses release date metadata instead of the manual click timestamp", () => {
  const embyMarkPlayed = parseEmbyWebhook({
    Event: "item.markplayed",
    Item: {
      Type: "Movie",
      Name: "Toy Story 5",
      PremiereDate: "2026-06-19T00:00:00Z",
      ProviderIds: {},
      UserData: { Played: true, LastPlayedDate: "2026-08-22T08:22:00Z" },
    },
  });
  assert.equal(embyMarkPlayed.playedFlagOnly, true);
  assert.equal(embyMarkPlayed.releaseDate, "2026-06-19T00:00:00.000Z");
  assert.equal(embyMarkPlayed.watchProvenance.source_timestamp, "");
  assert.match(embyMarkPlayed.watchProvenance.note, /release date will be used/);

  const plexNotification = buildPlexMediaFromMetadata({
    type: "movie",
    title: "Toy Story 5",
    ratingKey: "toy-story-5",
    originallyAvailableAt: "2026-06-19",
    lastViewedAt: 1787424000,
  }, { phase: "completed" });
  assert.equal(plexNotification.playedFlagOnly, true);
  assert.equal(plexNotification.releaseDate, "2026-06-19T00:00:00.000Z");
  assert.equal(plexNotification.watchProvenance.source_timestamp, "");
});

test("real playback events are not treated as bare played-flag events", async () => {
  const embyStop = parseEmbyWebhook({
    Event: "playback.stop",
    Progress: 95,
    Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } },
  });
  assert.equal(embyStop.phase, "completed");
  assert.equal(embyStop.playedFlagOnly, false);

  const scrobble = await parsePlexWebhook(plexForm("media.scrobble", { guid: "tmdb://329865" }));
  assert.equal(scrobble.phase, "completed");
  assert.equal(scrobble.playedFlagOnly, false);
});

// A server announcing new content is not a play. It is routed to its own phase
// so the webhook handler can apply an existing watch to that server without the
// event ever being mistaken for someone watching something.
test("library-add events from every server resolve to the added phase", async () => {
  const plexAdded = await parsePlexWebhook(plexForm("library.new", { guid: "tmdb://329865" }));
  assert.equal(plexAdded.phase, "added");
  // isValid gates every event before the handler sees it. An added event that
  // parses correctly but is not marked valid is discarded silently, which is
  // exactly how this shipped broken once.
  assert.equal(plexAdded.isValid, true);

  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  for (const parsed of [
    parseEmbyWebhook({ Event: "library.new", ...base }),
    parseEmbyWebhook({ Event: "item.added", ...base }),
    parseJellyfinWebhook({ NotificationType: "ItemAdded", ...base }),
  ]) {
    assert.equal(parsed.phase, "added");
    assert.equal(parsed.isValid, true);
  }

  // Jellyfin sends ItemAdded without provider ids; it still has to be actionable
  // so the title fallback can find the watch record.
  const noIds = parseJellyfinWebhook({ NotificationType: "ItemAdded", Item: { Type: "Movie", Name: "Arrival" } });
  assert.equal(noIds.phase, "added");
  assert.equal(noIds.isValid, true);
});

test("an added event still carries the ids and title needed to find the watch record", async () => {
  const added = parseEmbyWebhook({
    Event: "library.new",
    Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865", Imdb: "tt2543164" } },
  });
  assert.equal(added.title, "Arrival");
  assert.equal(added.type, "movie");
  assert.equal(added.ids.tmdb, "329865");
  assert.equal(added.ids.imdb, "tt2543164");
});

// core-sync-health step 2, item 1: a rating is not a play.
test("a Plex rating event is ignored, not recorded as a completed play", async () => {
  const rated = await parsePlexWebhook(plexForm("user.playrate", { guid: "tmdb://329865", ratingKey: "plex-329865", type: "movie", title: "Arrival" }));
  assert.equal(rated.phase, "ignored");
});

// Item 2: percentage fields are 0-100; a small value is never scaled up.
test("a small direct progress percentage is not read as a fraction", () => {
  const base = { Item: { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } } };
  const jellyfin = parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 0.95, ...base });
  assert.equal(jellyfin.phase, "ended");
  assert.ok(jellyfin.progress < 1);
  const emby = parseEmbyWebhook({ Event: "playback.stop", PlayedPercentage: 1, ...base });
  assert.equal(emby.phase, "ended");
  assert.equal(parseJellyfinWebhook({ NotificationType: "PlaybackStop", Progress: 150, ...base }).progress, 100);
});

// Item 3: the stop event's own PlayedToCompletion is playback evidence.
test("an Emby or Jellyfin stop that says PlayedToCompletion counts as completed without a position", () => {
  const item = { Type: "Movie", Name: "Arrival", ProviderIds: { Tmdb: "329865" } };
  const emby = parseEmbyWebhook({ Event: "playback.stop", Item: item, PlaybackInfo: { PlayedToCompletion: true } });
  assert.equal(emby.phase, "completed");
  const jellyfin = parseJellyfinWebhook({ NotificationType: "PlaybackStop", PlayedToCompletion: true, Item: item });
  assert.equal(jellyfin.phase, "completed");
  const notFinished = parseEmbyWebhook({ Event: "playback.stop", Item: item, PlaybackInfo: { PlayedToCompletion: false } });
  assert.equal(notFinished.phase, "ended");
});

// Item 7: the stop position wins over the resume point saved in UserData.
test("the stop event position is preferred over a stale UserData resume point", () => {
  const emby = parseEmbyWebhook({
    Event: "playback.stop",
    Item: {
      Type: "Movie",
      Name: "Arrival",
      ProviderIds: { Tmdb: "329865" },
      RunTimeTicks: 100_000_000_000,
      UserData: { PlaybackPositionTicks: 20_000_000_000 },
    },
    PlaybackInfo: { PositionTicks: 95_000_000_000 },
  });
  assert.equal(emby.phase, "completed");
  assert.ok(emby.progress >= 94.9);
  assert.ok(emby.offsetMs >= 9_400_000);
});
