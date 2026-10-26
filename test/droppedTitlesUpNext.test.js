import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-dropped-up-next-");
const { dropTitle, undropTitleForMedia } = await import("../server/src/utils/droppedTitles.js");
const { db } = await import("../server/src/db.js");
const { buildUpNextProjection } = await import("../server/src/utils/upNextService.js");

const now = Date.parse("2026-09-13T12:00:00.000Z");
const nextUp = (providerItemId, showTitle, tmdbId, episode) => ({
  provider: "jellyfin",
  feed_kind: "next_up",
  provider_item_id: providerItemId,
  media_type: "episode",
  title: `${showTitle} - S04E0${episode}`,
  show_title: showTitle,
  season: 4,
  episode,
  show_ids: { tmdb: tmdbId },
  air_date: "2026-09-08",
});
const showOptions = {
  now,
  shows: [
    { title: "Reacher", tmdb_id: "108978", latest_watched_at: "2026-08-01T12:00:00.000Z" },
    { title: "Scrubs", tmdb_id: "999001", latest_watched_at: "2026-08-02T12:00:00.000Z" },
  ],
  localFallback: false,
  progressRows: [],
  playstateRows: [],
  // The Scrubs here is the reboot; the 2001 show (another TMDB id) is dropped.
  providerItems: [nextUp("4774", "Reacher", "108978", 7), nextUp("5001", "Scrubs", "999001", 1)],
};
const showTitles = (projection) => projection.items.map((item) => item.show_title).sort();

function movieOptions(updatedAt) {
  return {
    now,
    localFallback: false,
    playstateRows: [],
    providerItems: [],
    progressRows: [
      { media_key: "movie:tmdb:77", media_type: "movie", title: "A Dropped Movie", tmdb_id: "77", position_ms: 300000, duration_ms: 1200000, progress: 25, updated_at: updatedAt, source: "local" },
      { media_key: "movie:tmdb:78", media_type: "movie", title: "A Kept Movie", tmdb_id: "78", position_ms: 300000, duration_ms: 1200000, progress: 25, updated_at: updatedAt, source: "local" },
    ],
  };
}

test("a dropped show leaves the projection that is shown and pushed, and returns when un-dropped", async () => {
  db.prepare("DELETE FROM dropped_titles").run();
  assert.deepEqual(showTitles(await buildUpNextProjection(showOptions)), ["Reacher", "Scrubs"]);

  // Dropped from the show page (a show record), matched against episode cards.
  dropTitle({ media_type: "tv", title: "Reacher", tmdb_id: "108978" });
  dropTitle({ media_type: "tv", title: "Scrubs", tmdb_id: "4556" });
  assert.deepEqual(showTitles(await buildUpNextProjection(showOptions)), ["Scrubs"], "a same-title show with another id stays");

  undropTitleForMedia({ media_type: "tv", title: "Reacher", tmdb_id: "108978" });
  assert.deepEqual(showTitles(await buildUpNextProjection(showOptions)), ["Reacher", "Scrubs"]);
});

test("a partly watched dropped movie stays out of Continue Watching, even with newer progress", async () => {
  db.prepare("DELETE FROM dropped_titles").run();
  const droppedAt = now - 3600000;
  dropTitle({ media_type: "movie", title: "A Dropped Movie", tmdb_id: "77" }, { now: droppedAt });
  for (const updatedAt of [droppedAt - 60000, droppedAt + 60000]) {
    const projection = await buildUpNextProjection(movieOptions(updatedAt));
    assert.deepEqual(projection.items.map((item) => item.title), ["A Kept Movie"]);
  }
});
