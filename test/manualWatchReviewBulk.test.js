import test from "node:test";
import assert from "node:assert/strict";
import {
  BULK_REVIEW_BATCH_CAP,
  DEFAULT_BULK_REVIEW_MODE,
  buildBulkConfirmItems,
  bulkDismissConfirmation,
  bulkItemDecision,
  bulkSelectionSummary,
  clearBulkReviewSelection,
  describeItemWatchDatePreview,
  effectiveBulkMode,
  effectiveModeForReview,
  executeBulkSelectionAction,
  handleBulkSelectionChange,
  isBulkSelectableReview,
  pruneBulkReviewSelection,
  renderBulkConfirmDialog,
  renderBulkReviewBar,
  runSequentialReviewBatch,
  selectAllVisibleReviews,
  selectedBulkReviews,
  summarizeBulkConfirmItems,
  toggleBulkReviewIds,
  triggerBulkSelectionWorkflow,
} from "../public/modules/manual-watch-review-bulk.js";

function sampleMovie(id, release_date = "2024-03-01") {
  return { id, media_type: "movie", title: `Movie ${id}`, release_date, source: "emby" };
}

function sampleEpisode(id, { show = "Andor", season = 1, episode = 1, release_date = "2022-09-21", episode_title = "", watch_context = null } = {}) {
  return { id, media_type: "episode", show_title: show, title: `${show} - S0${season}E0${episode}`, episode_title, season, episode, release_date, source: "emby", ...(watch_context ? { watch_context } : {}) };
}

test("bulk selection defaults to episode_timing on mixed selections, omits the bar dropdown, and falls back per item", () => {
  clearBulkReviewSelection();
  assert.equal(DEFAULT_BULK_REVIEW_MODE, "episode_timing");

  const movie = sampleMovie("m1", "2024-03-01");
  const movieNoDate = sampleMovie("m2", "");
  const ep = sampleEpisode("e1", { episode: 1, release_date: "2022-09-21" });
  ep.episode_timing = { watchedAt: "2022-10-01T18:30:00.000Z", direction: "before", anchorCode: "S01E02" };
  const mismatch = { id: "mm1", media_type: "episode", review_kind: "source_mismatch" };
  const conflict = { id: "cf1", media_type: "episode", review_kind: "episode_order_conflict" };

  assert.equal(isBulkSelectableReview(movie), true);
  assert.equal(isBulkSelectableReview(mismatch), false);
  assert.equal(isBulkSelectableReview(conflict), false);

  // Episode-only allows episode_timing
  const epSummary = bulkSelectionSummary([ep]);
  assert.equal(epSummary.episodeTimingAllowed, true);
  assert.equal(effectiveBulkMode("episode_timing", epSummary), "episode_timing");

  // Mixed movie + episode also allows episode_timing, mapping movies to release_day / detected
  const mixedSummary = bulkSelectionSummary([movie, movieNoDate, ep]);
  assert.equal(mixedSummary.isMixed, true);
  assert.equal(mixedSummary.episodeTimingAllowed, true);
  assert.equal(mixedSummary.missingReleaseDateCount, 1);
  assert.equal(effectiveBulkMode("episode_timing", mixedSummary), "episode_timing");

  assert.equal(effectiveModeForReview(movie, "release_day"), "release_day");
  assert.equal(effectiveModeForReview(ep, "release_day"), "release_day");
  assert.equal(effectiveModeForReview(movieNoDate, "release_day"), "detected");
  assert.equal(effectiveModeForReview(ep, "episode_timing"), "episode_timing");
  assert.equal(effectiveModeForReview(movie, "episode_timing"), "release_day");
  assert.equal(effectiveModeForReview(movieNoDate, "episode_timing"), "detected");

  const visibleReviews = [movie, ep, mismatch, conflict];
  assert.doesNotMatch(renderBulkReviewBar({ visibleReviews }), /Proposed watch decisions/);
  selectAllVisibleReviews(visibleReviews);
  const mixedBarHtml = renderBulkReviewBar({ visibleReviews });
  assert.match(mixedBarHtml, /Proposed watch decisions/);
  assert.match(mixedBarHtml, /Movie m1<\/strong>\s*<span data-bulk-item-preview[^>]*>.*2024.*\(release date\)/);
  assert.match(mixedBarHtml, /Andor S01E01<\/strong>\s*<span data-bulk-item-preview[^>]*>.*2022.*\(before S01E02\)/);
  assert.match(mixedBarHtml, /data-bulk-confirm-item-mode[^>]*aria-label="Watch decision for Movie m1"/);
  assert.doesNotMatch(mixedBarHtml, /data-manual-watch-review-bulk-mode/, "bulk bar should not duplicate the pop-up date dropdown");
  assert.match(mixedBarHtml, /Confirm selected \(2\)…/);
  assert.match(mixedBarHtml, /Dismiss selected \(2\)/);

  // Movies-only falls back to release_day
  clearBulkReviewSelection();
  const moviesSummary = bulkSelectionSummary([movie, movieNoDate]);
  assert.equal(moviesSummary.episodeTimingAllowed, false);
  assert.equal(effectiveBulkMode("episode_timing", moviesSummary), "release_day");
});

test("changing a date inline updates just that row and carries it into confirmation", async () => {
  clearBulkReviewSelection();
  const reviews = [sampleMovie("m1"), sampleMovie("m2")];
  selectAllVisibleReviews(reviews);
  renderBulkReviewBar({ visibleReviews: reviews });

  const preview = { textContent: "" };
  const field = { hidden: true };
  const row = {
    querySelector(selector) {
      return selector === "[data-bulk-item-preview]" ? preview : field;
    },
  };
  const select = {
    value: "custom",
    dataset: { bulkItemKey: "movie:m1" },
    closest(selector) {
      if (selector === "[data-bulk-confirm-item-mode]") return this;
      if (selector === "[data-bulk-item-row]") return row;
      return null;
    },
  };
  assert.equal(handleBulkSelectionChange({ target: select }), true);
  assert.equal(field.hidden, false);

  const custom = {
    ...select,
    value: "2024-05-09T19:30",
    closest(selector) {
      if (selector === "[data-bulk-confirm-item-datetime]") return this;
      if (selector === "[data-bulk-item-row]") return row;
      return null;
    },
  };
  assert.equal(handleBulkSelectionChange({ target: custom }), true);
  assert.match(preview.textContent, /2024/);
  const html = renderBulkReviewBar({ visibleReviews: reviews });
  assert.match(html, /value="2024-05-09T19:30"/);

  let confirmation;
  await triggerBulkSelectionWorkflow("approve", {
    getAllReviews: () => reviews,
    openBulkConfirm: async ({ items }) => { confirmation = items.map(bulkItemDecision); return null; },
  });
  assert.deepEqual(confirmation, [
    { mode: "custom", watchedAt: new Date(custom.value).toISOString() },
    { mode: "release_day", watchedAt: "2024-03-01T00:00:00.000Z" },
  ]);
  clearBulkReviewSelection();
});

test("buildBulkConfirmItems and renderBulkConfirmDialog show exact server-computed episode timing dates and fall back to air date when season has no watched episodes", () => {
  const movie = sampleMovie("m1", "2000-07-06");
  const movieNoDate = { ...sampleMovie("m2", ""), updated_at: Date.parse("2026-10-02T15:45:00Z") };
  const epWithTimingEmby = sampleEpisode("e1-emby", {
    show: "Carrie",
    season: 1,
    episode: 5,
    release_date: "2026-10-07",
    episode_title: "Episode 5",
  });
  epWithTimingEmby.episode_timing = {
    watchedAt: "2026-10-14T22:57:22.458Z",
    direction: "after",
    anchorCode: "S01E02",
  };
  const epWithTimingPlex = sampleEpisode("e1-plex", { show: "Carrie", season: 1, episode: 5, release_date: "" });
  epWithTimingPlex.episode_timing = null;
  const epNoSeasonHistory = sampleEpisode("e2", {
    show: "Paradise PD",
    season: 1,
    episode: 2,
    release_date: "2018-08-30",
  });
  epNoSeasonHistory.episode_timing = null;

  const items = buildBulkConfirmItems([movie, movieNoDate, epWithTimingEmby, epWithTimingPlex, epNoSeasonHistory], "episode_timing");
  assert.equal(items.length, 4, "duplicate provider reviews for the same episode should merge into one row");
  assert.equal(items[0].mode, "release_day");
  assert.equal(items[1].mode, "detected");
  assert.equal(items[2].mode, "episode_timing");
  assert.deepEqual(items[2].reviewIds, ["e1-emby", "e1-plex"]);
  assert.equal(items[2].hasEpisodeTiming, true);
  assert.equal(items[3].mode, "release_day", "episodes with no watched episodes in the season should fall back to air date");
  assert.equal(items[3].hasEpisodeTiming, false);

  assert.match(describeItemWatchDatePreview(items[0]), /2000.*release date/);
  assert.match(describeItemWatchDatePreview(items[2]), /2026.*after S01E02/);
  assert.match(describeItemWatchDatePreview(items[3]), /2018.*air date/);
  assert.equal(summarizeBulkConfirmItems(items), "1 same as other episodes · 2 release/air date · 1 detection time");

  const html = renderBulkConfirmDialog({ items, activeMode: "episode_timing" });
  assert.match(html, /Review watch decisions/);
  assert.match(html, /1 same as other episodes · 2 release\/air date · 1 detection time/);
  assert.match(html, /Same as other episodes \(no watched episodes in season\)/);
  assert.match(html, /Release date \(unavailable\)/);
  assert.match(html, /Mark 4 items watched/);
});

test("triggerBulkSelectionWorkflow opens the per-item popup for approve with episode_timing default and forwards per-item decisions", async () => {
  clearBulkReviewSelection();
  const movie = sampleMovie("m1", "2024-03-01");
  const ep = sampleEpisode("e1", { show: "Paradise PD", season: 1, episode: 2, release_date: "2018-08-31" });
  ep.episode_timing = { watchedAt: "2018-09-01T19:32:00.000Z", direction: "after", anchorCode: "S01E01" };
  toggleBulkReviewIds(["m1", "e1"], true);

  let popupReceived = null;
  let actionArgs = null;
  const decisions = new Map([
    ["m1", { mode: "detected", watchedAt: "" }],
    ["e1", { mode: "episode_timing", watchedAt: "" }],
  ]);

  await triggerBulkSelectionWorkflow("approve", {
    getAllReviews: () => [movie, ep],
    openBulkConfirm: async (payload) => {
      popupReceived = payload;
      return { mode: "episode_timing", watchedAt: "", itemDecisions: decisions };
    },
    runSelectionAction: async (...args) => {
      actionArgs = args;
    },
  });

  assert.equal(popupReceived.reviews.length, 2);
  assert.equal(popupReceived.initialMode, "episode_timing");
  assert.equal(actionArgs[1], "approve");
  assert.equal(actionArgs[4], decisions);
  clearBulkReviewSelection();
});

test("a batch can save a watch date and clear another review as unwatched", async () => {
  const reviews = [sampleMovie("watched"), sampleMovie("unwatched")];
  const items = buildBulkConfirmItems(reviews);
  items[1].mode = "unwatched";
  assert.match(renderBulkConfirmDialog({ items }), /Save watch decisions/);
  assert.match(describeItemWatchDatePreview(items[1]), /Mark unwatched and clear review/);
  const itemDecisions = new Map(items.map((item) => [item.reviewIds[0], bulkItemDecision(item)]));
  const calls = [];
  const result = await executeBulkSelectionAction(reviews, {
    itemDecisions, postAction: async (...args) => { calls.push(args); },
  });
  assert.equal(result.completed, 2);
  assert.deepEqual(calls, [
    ["watched", "approve", "release_day", "2024-03-01T00:00:00.000Z"],
    ["unwatched", "dismiss", "", ""],
  ]);
});

test("executeBulkSelectionAction submits the dates previewed for each item, including grouped provider reviews", async () => {
  clearBulkReviewSelection();
  const movie = sampleMovie("m1", "2024-03-01");
  const ep = sampleEpisode("e1", { show: "Paradise PD", season: 1, episode: 1 });
  ep.episode_timing = { watchedAt: "2026-11-20T17:45:00.123Z", direction: "before", anchorCode: "S01E02" };
  const epAlias = { ...ep, id: "e1-plex", source: "plex", episode_timing: null };
  const customMovie = sampleMovie("m2", "2024-04-01");
  const items = [movie, ep, epAlias, customMovie];
  const customIso = "2026-11-20T18:30:00.000Z";
  const plan = buildBulkConfirmItems(items, "episode_timing");
  plan[2].mode = "custom";
  plan[2].customValue = customIso;
  const itemDecisions = new Map(plan.flatMap((item) => item.reviewIds.map((id) => [id, bulkItemDecision(item)])));

  const calls = [];
  const messages = [];
  const result = await executeBulkSelectionAction(items, {
    action: "approve",
    mode: "release_day",
    itemDecisions,
    postAction: async (id, action, mode, watchedAt) => {
      calls.push({ id, action, mode, watchedAt });
    },
    optimisticallyRemove: (list) => list,
    completeOptimistic: () => {},
    restoreOptimistic: () => {},
    onRender: () => {},
    setMessage: (text, tone) => messages.push({ text, tone }),
  });

  assert.equal(result.completed, 4);
  assert.deepEqual(calls, [
    { id: "m1", action: "approve", mode: "release_day", watchedAt: "2024-03-01T00:00:00.000Z" },
    { id: "e1", action: "approve", mode: "episode_timing", watchedAt: ep.episode_timing.watchedAt },
    { id: "e1-plex", action: "approve", mode: "episode_timing", watchedAt: ep.episode_timing.watchedAt },
    { id: "m2", action: "approve", mode: "custom", watchedAt: customIso },
  ]);
  assert.match(messages.at(-1)?.text || "", /Confirmed 4 review records \(per-item dates\)/);
});

test("selectAllVisibleReviews caps at 50 items and over-cap selections disable bulk buttons", () => {
  clearBulkReviewSelection();
  const many = Array.from({ length: 60 }, (_, idx) => sampleMovie(`m-${idx + 1}`));
  const result = selectAllVisibleReviews(many, true);
  assert.equal(result.selectedUnits, BULK_REVIEW_BATCH_CAP);
  assert.equal(result.capped, true);
  assert.equal(selectedBulkReviews(many).length, BULK_REVIEW_BATCH_CAP);

  // Manually adding one more triggers overCap warning and disables buttons
  toggleBulkReviewIds(["m-51"], true);
  const summary = bulkSelectionSummary(selectedBulkReviews(many));
  assert.equal(summary.overCap, true);
  const barHtml = renderBulkReviewBar({ visibleReviews: many });
  assert.match(barHtml, /Select at most 50 items per batch/);
  assert.match(barHtml, /data-manual-watch-review-bulk-action="approve" disabled/);
  assert.match(barHtml, /data-manual-watch-review-bulk-action="dismiss" disabled/);

  pruneBulkReviewSelection(many.slice(0, 5));
  assert.equal(selectedBulkReviews(many).length, 5);
  clearBulkReviewSelection();
});

test("runSequentialReviewBatch skips failed items and continues when continueOnError is true, restoring only failures", async () => {
  const items = [sampleMovie("a", "2024-01-01"), sampleMovie("b", ""), sampleEpisode("c", { episode: 2 })];
  const calls = [];
  const completedIds = [];
  let restored = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const result = await runSequentialReviewBatch(items, {
    action: "approve",
    mode: "release_day",
    continueOnError: true,
    resolveItemMode: effectiveModeForReview,
    onOptimisticRemove: (list) => list,
    onItemComplete: (id) => completedIds.push(id),
    onRestoreFailed: (list) => { restored = list; },
    postAction: async (id, action, mode) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      calls.push({ id, action, mode });
      inFlight -= 1;
      if (id === "b") throw new Error("Already resolved");
    },
  });

  assert.equal(maxConcurrent, 1, "Bulk calls must run strictly sequentially");
  assert.deepEqual(calls, [
    { id: "a", action: "approve", mode: "release_day" },
    { id: "b", action: "approve", mode: "detected" },
    { id: "c", action: "approve", mode: "release_day" },
  ]);
  assert.equal(result.completed, 2);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(completedIds, ["a", "c"]);
  assert.deepEqual(restored.map((item) => item.id), ["b"]);
});

test("runSequentialReviewBatch stops on first failure when continueOnError is false (show/season behavior)", async () => {
  const items = [sampleEpisode("e1", { episode: 1 }), sampleEpisode("e2", { episode: 2 }), sampleEpisode("e3", { episode: 3 })];
  const called = [];
  let restored = [];

  const result = await runSequentialReviewBatch(items, {
    action: "approve",
    mode: "detected",
    continueOnError: false,
    onOptimisticRemove: (list) => list,
    onRestoreFailed: (list) => { restored = list; },
    postAction: async (id) => {
      called.push(id);
      if (id === "e2") throw new Error("Verification failed");
    },
  });

  assert.deepEqual(called, ["e1", "e2"]);
  assert.equal(result.completed, 1);
  assert.deepEqual(restored.map((item) => item.id), ["e2", "e3"]);
});

test("executeBulkSelectionAction dismisses sequentially, clears selection, and reports summary", async () => {
  clearBulkReviewSelection();
  const items = [sampleMovie("d1"), sampleEpisode("d2")];
  toggleBulkReviewIds(["d1", "d2"], true);
  const confirmDialog = bulkDismissConfirmation(bulkSelectionSummary(items));
  assert.equal(confirmDialog.danger, true);
  assert.match(confirmDialog.body, /Trakt/i);

  const dismissed = [];
  const messages = [];
  const result = await executeBulkSelectionAction(items, {
    action: "dismiss",
    mode: "release_day",
    postAction: async (id, action) => { dismissed.push(`${id}:${action}`); },
    optimisticallyRemove: (list) => list,
    completeOptimistic: () => {},
    restoreOptimistic: () => {},
    onRender: () => {},
    setMessage: (text, tone) => messages.push({ text, tone }),
  });

  assert.equal(result.completed, 2);
  assert.deepEqual(dismissed, ["d1:dismiss", "d2:dismiss"]);
  assert.equal(selectedBulkReviews(items).length, 0);
  assert.equal(messages.at(-1)?.tone, "success");
  assert.match(messages.at(-1)?.text || "", /Dismissed 2 review records/);
});
