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
  getInlineReviewDecisionItem,
  handleBulkSelectionChange,
  handleBulkSelectionClick,
  isBulkSelectableReview,
  pruneBulkReviewSelection,
  renderBulkReviewBar,
  renderInlineReviewDecisionBarHtml,
  runSequentialReviewBatch,
  selectAllVisibleReviews,
  selectedBulkReviews,
  summarizeBulkConfirmItems,
  syncInlineReviewItems,
  toggleBulkReviewIds,
  triggerBulkSelectionWorkflow,
  validateInlineDecision,
} from "../public/modules/manual-watch-review-bulk.js";

function sampleMovie(id, release_date = "2024-03-01") {
  return { id, media_type: "movie", title: `Movie ${id}`, release_date, source: "emby" };
}

function sampleEpisode(id, { show = "Andor", season = 1, episode = 1, release_date = "2022-09-21", episode_title = "", watch_context = null } = {}) {
  return { id, media_type: "episode", show_title: show, title: `${show} - S0${season}E0${episode}`, episode_title, season, episode, release_date, source: "emby", ...(watch_context ? { watch_context } : {}) };
}

test("inline date pills render without dropdowns or duplicate unwatched options, and the bulk bar stays compact", () => {
  clearBulkReviewSelection({ clearDecisions: true });
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

  const epSummary = bulkSelectionSummary([ep]);
  assert.equal(epSummary.episodeTimingAllowed, true);
  assert.equal(effectiveBulkMode("episode_timing", epSummary), "episode_timing");

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
  syncInlineReviewItems(visibleReviews);

  // Screen 1 unified inline bar: facts + Will save + clickable option pills + Confirm watched all inline
  const movieBarHtml = renderInlineReviewDecisionBarHtml([movie]);
  assert.match(movieBarHtml, /manual-watch-review-inline-bar/);
  assert.match(movieBarHtml, /manual-watch-review-fact--will-save/);
  assert.match(movieBarHtml, /Will save/);
  assert.match(movieBarHtml, /2024.*\(release date\)/);
  assert.doesNotMatch(movieBarHtml, /<select\b/, "date options must not be in a dropdown");
  assert.doesNotMatch(movieBarHtml, /Mark unwatched and clear review/, "must not duplicate Dismiss (mark unwatched)");
  assert.match(movieBarHtml, /data-bulk-item-mode-choice="release_day"[^>]*aria-pressed="true"/);
  assert.match(movieBarHtml, /data-bulk-item-mode-choice="detected"/);
  assert.match(movieBarHtml, /data-bulk-item-mode-choice="now"/);
  assert.match(movieBarHtml, /data-bulk-item-mode-choice="custom"/);
  assert.match(movieBarHtml, />Confirm watched<\/button>/);
  assert.doesNotMatch(movieBarHtml, /Confirm watched…/);

  const epBarHtml = renderInlineReviewDecisionBarHtml([ep]);
  assert.match(epBarHtml, /2022.*\(before S01E02\)/);
  assert.match(epBarHtml, /data-bulk-item-mode-choice="episode_timing"[^>]*aria-pressed="true"/);
  assert.match(epBarHtml, /Same as other episodes/);

  // Bulk bar before selection
  const idleBarHtml = renderBulkReviewBar({ visibleReviews });
  assert.doesNotMatch(idleBarHtml, /Proposed watch decisions/);
  assert.doesNotMatch(idleBarHtml, /data-manual-watch-review-bulk-action/);

  // Bulk bar after Select all: pill buttons (no <select>, no duplicate unwatched option, no duplicate item rows)
  selectAllVisibleReviews(visibleReviews);
  const mixedBarHtml = renderBulkReviewBar({ visibleReviews });
  assert.doesNotMatch(mixedBarHtml, /<select\b/);
  assert.doesNotMatch(mixedBarHtml, /Proposed watch decisions/);
  assert.doesNotMatch(mixedBarHtml, /Mark unwatched and clear review/);
  assert.match(mixedBarHtml, /data-manual-watch-review-bulk-apply-mode="release_day"/);
  assert.match(mixedBarHtml, /Confirm selected \(2\)/);
  assert.doesNotMatch(mixedBarHtml, /Confirm selected \(2\)…/);
  assert.match(mixedBarHtml, /Dismiss selected \(2\)/);
  assert.match(mixedBarHtml, /Selected: 1 same as other episodes · 1 release\/air date/);

  clearBulkReviewSelection({ clearDecisions: true });
  const moviesSummary = bulkSelectionSummary([movie, movieNoDate]);
  assert.equal(moviesSummary.episodeTimingAllowed, false);
  assert.equal(effectiveBulkMode("episode_timing", moviesSummary), "release_day");
});

test("clicking an item's date pill updates its Will save preview immediately and Confirm selected saves directly without a popup", async () => {
  clearBulkReviewSelection({ clearDecisions: true });
  const reviews = [sampleMovie("m1"), sampleMovie("m2")];
  selectAllVisibleReviews(reviews);
  renderBulkReviewBar({ visibleReviews: reviews });

  const preview = { textContent: "" };
  const field = { hidden: true, value: "", focused: false, focus() { this.focused = true; } };
  const pills = ["release_day", "custom"].map((mode) => ({
    dataset: { bulkItemModeChoice: mode, bulkItemKey: "movie:m1" },
    selected: mode === "release_day",
    pressed: mode === "release_day" ? "true" : "false",
    classList: {
      toggle(_cls, force) { this.selected = force; },
    },
    setAttribute(name, val) { if (name === "aria-pressed") this.pressed = val; },
  }));
  pills[0].classList.toggle = (_c, f) => { pills[0].selected = f; };
  pills[1].classList.toggle = (_c, f) => { pills[1].selected = f; };

  const card = {
    querySelector(selector) {
      if (selector.includes("data-bulk-item-preview")) return preview;
      if (selector.includes("data-bulk-confirm-item-datetime")) return field;
      if (selector.includes("data-bulk-item-row")) return card;
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-bulk-item-mode-choice]" ? pills : [];
    },
  };
  const customPill = {
    disabled: false,
    dataset: { bulkItemModeChoice: "custom", bulkItemKey: "movie:m1" },
    closest(selector) {
      if (selector === "[data-bulk-item-mode-choice]") return this;
      if (selector.includes("data-manual-watch-review-id")) return card;
      return null;
    },
  };
  assert.equal(handleBulkSelectionClick({ target: customPill }, { getAllReviews: () => reviews }), true);
  assert.equal(field.hidden, false);
  assert.equal(field.focused, true);
  assert.equal(pills[0].selected, false);
  assert.equal(pills[1].selected, true);

  const customInput = {
    value: "2024-05-09T19:30",
    dataset: { bulkItemKey: "movie:m1" },
    closest(selector) {
      if (selector === "[data-bulk-confirm-item-datetime]") return this;
      if (selector.includes("data-manual-watch-review-id")) return card;
      return null;
    },
  };
  assert.equal(handleBulkSelectionChange({ target: customInput }, { getAllReviews: () => reviews }), true);
  assert.match(preview.textContent, /2024/);
  const inlineHtml = renderInlineReviewDecisionBarHtml([reviews[0]]);
  assert.match(inlineHtml, /value="2024-05-09T19:30"/);

  let savedArgs = null;
  let dialogCalled = false;
  await triggerBulkSelectionWorkflow("approve", {
    getAllReviews: () => reviews,
    openConfirmDialog: async () => { dialogCalled = true; return true; },
    runSelectionAction: async (...args) => { savedArgs = args; },
  });
  assert.equal(dialogCalled, false, "Confirm selected must save directly without opening a popup");
  assert.equal(savedArgs[1], "approve");
  assert.deepEqual([...savedArgs[4].entries()], [
    ["m1", { mode: "custom", watchedAt: new Date(customInput.value).toISOString() }],
    ["m2", { mode: "release_day", watchedAt: "2024-03-01T00:00:00.000Z" }],
  ]);
  clearBulkReviewSelection({ clearDecisions: true });
});

test("clicking a Set selected dates pill updates every selected item's inline mode at once", () => {
  clearBulkReviewSelection({ clearDecisions: true });
  const m1 = sampleMovie("m1", "2024-03-01");
  const e1 = sampleEpisode("e1", { release_date: "2022-09-21" });
  const reviews = [m1, e1];
  selectAllVisibleReviews(reviews);
  renderBulkReviewBar({ visibleReviews: reviews });

  let rendered = 0;
  const applyNowBtn = {
    disabled: false,
    dataset: { manualWatchReviewBulkApplyMode: "now" },
    closest(selector) {
      return selector === "[data-manual-watch-review-bulk-apply-mode]" ? this : null;
    },
  };
  assert.equal(
    handleBulkSelectionClick(
      { target: applyNowBtn },
      { getAllReviews: () => reviews, onRender: () => { rendered += 1; } },
    ),
    true,
  );
  assert.equal(rendered, 1);
  assert.equal(getInlineReviewDecisionItem([m1]).mode, "now");
  assert.equal(getInlineReviewDecisionItem([e1]).mode, "now");
  clearBulkReviewSelection({ clearDecisions: true });
});

test("Confirm selected blocks future custom dates with a clear error instead of submitting", async () => {
  clearBulkReviewSelection({ clearDecisions: true });
  const movie = sampleMovie("m1", "2024-03-01");
  selectAllVisibleReviews([movie]);
  const item = getInlineReviewDecisionItem([movie]);
  item.mode = "custom";
  item.customValue = "2099-01-01T12:00";
  item.edited = true;

  const check = validateInlineDecision(item, { now: Date.parse("2026-11-23T20:00:00Z") });
  assert.equal(check.ok, false);
  assert.match(check.error, /in the future/i);

  let ran = false;
  let errMsg = "";
  await triggerBulkSelectionWorkflow("approve", {
    getAllReviews: () => [movie],
    runSelectionAction: async () => { ran = true; },
    setMessage: (msg, tone) => { if (tone === "error") errMsg = msg; },
  });
  assert.equal(ran, false);
  assert.match(errMsg, /in the future/i);
  clearBulkReviewSelection({ clearDecisions: true });
});

test("buildBulkConfirmItems computes episode timing dates and falls back to air date when season has no watched episodes", () => {
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
});

test("executeBulkSelectionAction submits the dates previewed for each item, including grouped provider reviews", async () => {
  clearBulkReviewSelection({ clearDecisions: true });
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
  clearBulkReviewSelection({ clearDecisions: true });
  const many = Array.from({ length: 60 }, (_, idx) => sampleMovie(`m-${idx + 1}`));
  const result = selectAllVisibleReviews(many, true);
  assert.equal(result.selectedUnits, BULK_REVIEW_BATCH_CAP);
  assert.equal(result.capped, true);
  assert.equal(selectedBulkReviews(many).length, BULK_REVIEW_BATCH_CAP);

  toggleBulkReviewIds(["m-51"], true);
  const summary = bulkSelectionSummary(selectedBulkReviews(many));
  assert.equal(summary.overCap, true);
  const barHtml = renderBulkReviewBar({ visibleReviews: many });
  assert.match(barHtml, /Select at most 50 items per batch/);
  assert.match(barHtml, /data-manual-watch-review-bulk-action="approve" disabled/);
  assert.match(barHtml, /data-manual-watch-review-bulk-action="dismiss" disabled/);

  pruneBulkReviewSelection(many.slice(0, 5));
  assert.equal(selectedBulkReviews(many).length, 5);
  clearBulkReviewSelection({ clearDecisions: true });
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

test("runSequentialReviewBatch stops on first failure when continueOnError is false", async () => {
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
  clearBulkReviewSelection({ clearDecisions: true });
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
