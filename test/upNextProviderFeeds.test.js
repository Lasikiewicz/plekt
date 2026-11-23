import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-up-next-feeds-");

const {
  completeUpNextProviderFeed,
  failUpNextProviderFeed,
  getActiveUpNextProviderItemById,
  getUpNextFeedSourceVersion,
  listActiveUpNextProviderItems,
  listUpNextProviderFeedStates,
  recordUpNextProviderFeed,
  redactUpNextProviderError,
  startUpNextProviderFeed,
} = await import("../server/src/utils/upNextRepository.js");

test("provider feed generations keep the last good snapshot through partial failures", () => {
  const first = recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-episode-1",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-series-1",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    SeriesProviderIds: { Tmdb: "123" },
    ProviderIds: { Tmdb: "456" },
    PremiereDate: "2026-08-01",
    poster_url: "/media/posters/emby-episode-1.jpg",
  }], { now: 1_000 });

  assert.equal(first.changed, true);
  assert.equal(listActiveUpNextProviderItems().length, 1);
  assert.equal(listActiveUpNextProviderItems()[0].provider_item_id, "emby-episode-1");
  assert.equal(listActiveUpNextProviderItems()[0].poster_url, "/media/posters/emby-episode-1.jpg");
  const firstSourceVersion = getUpNextFeedSourceVersion();

  const acknowledgement = recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-episode-1",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-series-1",
    ParentIndexNumber: 1,
    IndexNumber: 2,
    SeriesProviderIds: { Tmdb: "123" },
    ProviderIds: { Tmdb: "456" },
    PremiereDate: "2026-08-01",
    poster_url: "/media/posters/emby-episode-1.jpg",
  }], { now: 1_500 });
  assert.equal(acknowledgement.changed, false);
  assert.equal(getUpNextFeedSourceVersion(), firstSourceVersion);
  assert.equal(listActiveUpNextProviderItems()[0].observed_at, 1_000);
  assert.equal(listActiveUpNextProviderItems()[0].last_seen_at, 1_500);

  const failedGeneration = startUpNextProviderFeed("emby", "next_up", { now: 2_000 });
  failUpNextProviderFeed("emby", "next_up", failedGeneration, new Error("GET /Shows/NextUp?api_key=secret-token failed"), {
    now: 2_100,
    partial: true,
  });

  const failedState = listUpNextProviderFeedStates().find(
    (feed) => feed.provider === "emby" && feed.feed_kind === "next_up",
  );
  assert.equal(failedState.status, "partial");
  assert.equal(failedState.active_generation, acknowledgement.generation);
  assert.equal(failedState.last_success_at, 1_500);
  assert.equal(listActiveUpNextProviderItems()[0].provider_item_id, "emby-episode-1");
  assert.match(failedState.last_error, /api_key=\[redacted\]/);
  assert.doesNotMatch(failedState.last_error, /secret-token/);

  const emptyGeneration = startUpNextProviderFeed("emby", "next_up", { now: 3_000 });
  const completed = completeUpNextProviderFeed("emby", "next_up", emptyGeneration, [], { now: 3_100 });
  assert.equal(completed.itemCount, 0);
  assert.equal(listActiveUpNextProviderItems().length, 0);
  const completedState = listUpNextProviderFeedStates().find(
    (feed) => feed.provider === "emby" && feed.feed_kind === "next_up",
  );
  assert.equal(completedState.status, "succeeded");
  assert.equal(completedState.active_generation, emptyGeneration);
  assert.equal(completedState.item_count, 0);
});

test("an unchanged feed in provider order is not a content change", () => {
  // Providers return Resume and Next Up by recency, not by id; the stored
  // snapshot reads back ordered by id. Order alone must not count as a change.
  const items = ["jf-b", "jf-a"].map((id, index) => ({
    Id: id,
    Type: "Episode",
    Name: `Episode ${index + 1}`,
    SeriesName: `Order Show ${id}`,
    SeriesId: `${id}-series`,
    ParentIndexNumber: 1,
    IndexNumber: index + 1,
    SeriesProviderIds: { Tmdb: `9${index}` },
  }));
  assert.equal(recordUpNextProviderFeed("jellyfin", "next_up", items, { now: 5_000 }).changed, true);
  const repeat = recordUpNextProviderFeed("jellyfin", "next_up", items, { now: 5_500 });
  assert.equal(repeat.changed, false);
});

test("provider feed error redaction removes credentials without hiding the useful message", () => {
  const message = redactUpNextProviderError(new Error("request api_key=abc123 for Next Up failed"));
  assert.equal(message, "request api_key=[redacted] for Next Up failed");
});

test("Emby image tags become show poster paths in the provider snapshot", () => {
  recordUpNextProviderFeed("emby", "next_up", [{
    Id: "emby-poster-episode",
    Type: "Episode",
    Name: "Pilot",
    SeriesName: "Example Show",
    SeriesId: "emby-poster-series",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    SeriesPrimaryImageTag: "series-tag",
    ImageTags: { Primary: "episode-tag" },
  }], { now: 4_000 });

  const item = listActiveUpNextProviderItems().find((entry) => entry.provider_item_id === "emby-poster-episode");
  assert.equal(item.show_poster_url, "/Items/emby-poster-series/Images/Primary?tag=series-tag");
  assert.equal(item.poster_url, "/Items/emby-poster-series/Images/Primary?tag=series-tag");
  assert.equal(getActiveUpNextProviderItemById("emby", "emby-poster-episode").provider_item_id, "emby-poster-episode");
});

function jellyfinFeedItem(id) {
  return {
    Id: id,
    Type: "Episode",
    Name: `Episode ${id}`,
    SeriesName: `Generation Show ${id}`,
    SeriesId: `${id}-series`,
    ParentIndexNumber: 1,
    IndexNumber: 1,
    SeriesProviderIds: { Tmdb: `77${id.length}` },
  };
}

function feedState(provider, feedKind) {
  return listUpNextProviderFeedStates().find((feed) => feed.provider === provider && feed.feed_kind === feedKind);
}

test("a superseded feed generation completing late is discarded and generation 2 stays", () => {
  const generation1 = startUpNextProviderFeed("jellyfin", "resume", { now: 10_000 });
  const generation2 = startUpNextProviderFeed("jellyfin", "resume", { now: 10_100 });
  assert.equal(generation2, generation1 + 1);

  const second = completeUpNextProviderFeed("jellyfin", "resume", generation2, [jellyfinFeedItem("gen-two")], {
    now: 10_200,
    triggerAutoSync: false,
  });
  assert.equal(second.ignored, false);

  const late = completeUpNextProviderFeed("jellyfin", "resume", generation1, [jellyfinFeedItem("gen-one-late")], {
    now: 10_300,
    triggerAutoSync: false,
  });
  assert.equal(late.ignored, true);
  assert.equal(late.changed, false);

  const ids = listActiveUpNextProviderItems()
    .map((item) => item.provider_item_id)
    .filter((id) => id.startsWith("gen-"));
  assert.deepEqual(ids, ["gen-two"]);
  const state = feedState("jellyfin", "resume");
  assert.equal(state.active_generation, generation2);
  assert.equal(state.current_generation, generation2);
  assert.equal(state.status, "succeeded");
  assert.equal(state.completed_at, 10_200);
});

test("a superseded feed generation failing late does not overwrite generation 2 or the last good snapshot", () => {
  const generation1 = startUpNextProviderFeed("jellyfin", "next_up", { now: 20_000 });
  const generation2 = startUpNextProviderFeed("jellyfin", "next_up", { now: 20_100 });
  completeUpNextProviderFeed("jellyfin", "next_up", generation2, [jellyfinFeedItem("nu-two-good")], {
    now: 20_200,
    triggerAutoSync: false,
  });

  const late = failUpNextProviderFeed("jellyfin", "next_up", generation1, new Error("late failure of generation one"), { now: 20_300 });
  assert.equal(late.ignored, true);

  const state = feedState("jellyfin", "next_up");
  assert.equal(state.status, "succeeded");
  assert.equal(state.active_generation, generation2);
  assert.equal(state.last_error, null);
  assert.deepEqual(
    listActiveUpNextProviderItems()
      .map((item) => item.provider_item_id)
      .filter((id) => id.startsWith("nu-")),
    ["nu-two-good"],
  );

  // A generation that began after the last good snapshot and was then
  // superseded must not leave the feed marked failed either.
  const generation3 = startUpNextProviderFeed("jellyfin", "next_up", { now: 20_400 });
  const generation4 = startUpNextProviderFeed("jellyfin", "next_up", { now: 20_500 });
  assert.equal(failUpNextProviderFeed("jellyfin", "next_up", generation3, new Error("stale"), { now: 20_600 }).ignored, true);
  assert.equal(feedState("jellyfin", "next_up").status, "running");
  assert.equal(feedState("jellyfin", "next_up").current_generation, generation4);
});
