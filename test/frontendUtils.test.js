import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRestInChunks,
  escapeHtml,
  escapeAttribute,
  formatDuration,
  formatPlaybackClock,
  computeProgress,
  normalizePlatformSource,
  platformSourceValues,
  platformIconUrl,
  platformIconMarkup,
  sourceBadgeHtml,
  platformName,
  showName,
  episodeCode,
  seasonLabel,
  formatSeasonTitle,
} from "../public/modules/utils.js";

test("frontend escaping utilities encode markup and attribute delimiters", () => {
  assert.equal(escapeHtml(`<a title="Tom & Jerry's">`), "&lt;a title=&quot;Tom &amp; Jerry&#39;s&quot;&gt;");
  assert.equal(escapeAttribute("value` onclick='x'"), "value&#96; onclick=&#39;x&#39;");
});

test("frontend playback formatting clamps progress and renders clocks", () => {
  assert.equal(computeProgress(45_000, 60_000), 75);
  assert.equal(computeProgress(90_000, 60_000), 100);
  assert.equal(computeProgress(-1_000, 60_000), 0);
  assert.equal(formatDuration(3_661_000), "01:01:01");
  assert.equal(formatPlaybackClock(65_000, 3_600_000), "00:01:05 / 01:00:00");
});

test("frontend platform and title helpers normalize user-facing labels", () => {
  assert.equal(normalizePlatformSource("Emby webhook"), "emby");
  assert.equal(normalizePlatformSource("Jellyfin_scheduler"), "jellyfin");
  assert.equal(normalizePlatformSource("force_sync"), "plembfin");
  assert.equal(normalizePlatformSource("plembfin"), "plembfin");
  assert.equal(normalizePlatformSource("unknown"), "plex");
  assert.deepEqual(
    platformSourceValues({ sources: ["jellyfin", "plex"], source: "manual", playHistory: [{ source: "plex_webhook" }] }),
    ["plembfin"],
  );
  assert.deepEqual(
    platformSourceValues({ sources: ["manual"], source: "force_sync", playHistory: [{ source: "plembfin" }] }),
    ["plembfin"],
  );
  assert.match(sourceBadgeHtml("plembfin"), /source-plembfin/);
  assert.match(platformIconMarkup("plembfin"), /source-badge-icon-set/);
  assert.match(platformIconMarkup("plembfin"), /plekt-light\.png\?v=[A-Za-z0-9._-]+/);
  assert.match(platformIconMarkup("plembfin"), /plekt\.png\?v=[A-Za-z0-9._-]+/);
  assert.match(sourceBadgeHtml("plembfin"), />Plekt<\/span>/);
  // The asset version tracks the build (see scripts/asset-versions.js), so it
  // changes on every alpha promotion. Assert that the icon is versioned, not
  // which version it happens to carry today.
  assert.match(platformIconUrl("manual"), /^\/icons\/plekt\.png\?v=.+$/);
  assert.equal(platformName("jellyfin_webhook"), "Jellyfin");
  assert.equal(showName("Harbor Nine - S02E03 - Low Tide"), "Harbor Nine");
  assert.equal(episodeCode(2, 3), "S02E03");
  assert.equal(seasonLabel(1), "Season 1");
});

test("formatSeasonTitle preserves season numbers even when custom season titles exist", () => {
  assert.equal(formatSeasonTitle(1, "Fantasy High"), "Season 1 - Fantasy High");
  assert.equal(formatSeasonTitle(2, "Escape from the Bloodkeep"), "Season 2 - Escape from the Bloodkeep");
  assert.equal(formatSeasonTitle(7, "Fantasy High 2: Sophomore Year"), "Season 7 - Fantasy High 2: Sophomore Year");
  assert.equal(formatSeasonTitle(28, "City Council of Darkness"), "Season 28 - City Council of Darkness");
  assert.equal(formatSeasonTitle(29, "Season 29"), "Season 29");
  assert.equal(formatSeasonTitle(1, "Season 1"), "Season 1");
  assert.equal(formatSeasonTitle(1, ""), "Season 1");
  assert.equal(formatSeasonTitle(0, "Specials"), "Specials");
  assert.equal(formatSeasonTitle(0, "Trailers & Extras"), "Specials - Trailers & Extras");
  assert.equal(formatSeasonTitle(3, "Season 3: The Unsleeping City"), "Season 3 - The Unsleeping City");
});

function manualScheduler() {
  const queue = [];
  return { schedule: (step) => queue.push(step), runNext: () => queue.shift()?.(), pending: () => queue.length };
}

test("appendRestInChunks appends the rest in order, one chunk per idle step, then completes once", () => {
  const scheduler = manualScheduler();
  const appended = [];
  let completed = 0;
  appendRestInChunks("list", [1, 2, 3, 4, 5], {
    chunkSize: 2,
    schedule: scheduler.schedule,
    append: (items) => { appended.push(items); },
    onComplete: () => { completed += 1; },
  });
  assert.deepEqual(appended, [], "nothing is appended in the same task as the first paint");
  while (scheduler.pending()) scheduler.runNext();
  assert.deepEqual(appended, [[1, 2], [3, 4], [5]]);
  assert.equal(completed, 1);
});

test("appendRestInChunks completes immediately when nothing is left", () => {
  let completed = 0;
  appendRestInChunks("empty", [], { append: () => assert.fail("no append"), onComplete: () => { completed += 1; } });
  assert.equal(completed, 1);
});

test("appendRestInChunks: a newer run for the same key cancels the older one", () => {
  const scheduler = manualScheduler();
  const appended = [];
  let completed = 0;
  const options = { chunkSize: 1, schedule: scheduler.schedule, append: (items) => { appended.push(...items); }, onComplete: () => { completed += 1; } };
  appendRestInChunks("panel", ["old-1", "old-2"], options);
  scheduler.runNext();
  appendRestInChunks("panel", [], options);
  while (scheduler.pending()) scheduler.runNext();
  assert.deepEqual(appended, ["old-1"], "the stale run adds nothing after the re-render");
  assert.equal(completed, 1, "only the newer run completes");
});

test("appendRestInChunks stops without completing when the list has gone", () => {
  const scheduler = manualScheduler();
  let calls = 0;
  let completed = 0;
  appendRestInChunks("gone", [1, 2, 3], { chunkSize: 1, schedule: scheduler.schedule, append: () => { calls += 1; return false; }, onComplete: () => { completed += 1; } });
  while (scheduler.pending()) scheduler.runNext();
  assert.equal(calls, 1);
  assert.equal(completed, 0);
});
