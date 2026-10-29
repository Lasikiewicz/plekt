import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-webhook-test-");
const {
  WEBHOOK_TEST_ECHO_MS,
  WEBHOOK_TEST_HOLD_MS,
  WEBHOOK_TEST_WINDOW_MS,
  cancelWebhookTest,
  discountEchoForWebhookTest,
  getWebhookTestStatus,
  captureWebhookTestMark,
  isHeldWebhookTestEvent,
  isWebhookTestHeldItem,
  markWebhookTestUnmarked,
  noteRejectedWebhookForTest,
  observeWebhookForTest,
  resetWebhookTestForTests,
  startWebhookTest,
} = await import("../server/src/utils/webhookTest.js");

const markPlayed = (overrides = {}) => ({
  source: "emby", event: "item.markplayed", phase: "completed", playedFlagOnly: true,
  itemId: "42", title: "Show - S01E01", type: "episode", season: 1, episode: 1, ...overrides,
});
const playbackStop = (overrides = {}) => ({
  source: "emby", event: "playback.stop", phase: "completed", playedFlagOnly: false, itemId: "42", ...overrides,
});

// Mirrors handleWebhook: the hold check runs first, capture runs later after the echo guards.
const interceptWebhookTestEvent = (media, now) => {
  if (isHeldWebhookTestEvent(media, now)) return { swallow: true, outcome: "held" };
  if (captureWebhookTestMark(media, now)) return { swallow: true, outcome: "captured" };
  return { swallow: false };
};

beforeEach(() => resetWebhookTestForTests());

test("nothing is swallowed when no test is running", () => {
  assert.equal(getWebhookTestStatus().status, "idle");
  assert.equal(interceptWebhookTestEvent(markPlayed()).swallow, false);
});

test("the first mark-played from the tested source is captured and swallowed", () => {
  startWebhookTest("emby", 1000);
  const result = interceptWebhookTestEvent(markPlayed(), 2000);
  assert.deepEqual(result, { swallow: true, outcome: "captured" });
  const view = getWebhookTestStatus(2000);
  assert.equal(view.status, "passed");
  assert.equal(view.capture.itemId, "42");
  assert.equal(view.capture.title, "Show - S01E01");
});

test("playback events and other sources are never swallowed", () => {
  startWebhookTest("emby", 1000);
  assert.equal(interceptWebhookTestEvent(playbackStop(), 1500).swallow, false);
  assert.equal(interceptWebhookTestEvent(markPlayed({ source: "jellyfin" }), 1500).swallow, false);
  assert.equal(interceptWebhookTestEvent(markPlayed({ phase: "unplayed", playedFlagOnly: false }), 1500).swallow, false);
  assert.equal(getWebhookTestStatus(1500).status, "waiting");
});

test("a duplicate mark-played and the unmark echo for the captured item are swallowed, other items are not", () => {
  startWebhookTest("emby", 1000);
  interceptWebhookTestEvent(markPlayed(), 2000);
  assert.deepEqual(interceptWebhookTestEvent(markPlayed(), 2100), { swallow: true, outcome: "held" });
  assert.equal(interceptWebhookTestEvent(markPlayed({ itemId: "99" }), 2200).swallow, false);
  assert.equal(interceptWebhookTestEvent(markPlayed({ itemId: "99", phase: "unplayed", playedFlagOnly: false }), 2200).swallow, false);
  assert.equal(interceptWebhookTestEvent({ source: "emby", phase: "unplayed", itemId: "42" }, 2300).swallow, true);
});

test("the scan hold covers only the captured item and ends after unmark echo time", () => {
  startWebhookTest("emby", 1000);
  assert.equal(isWebhookTestHeldItem("emby", "42", 1500), false);
  interceptWebhookTestEvent(markPlayed(), 2000);
  assert.equal(isWebhookTestHeldItem("emby", "42", 2500), true);
  assert.equal(isWebhookTestHeldItem("emby", "43", 2500), false);
  assert.equal(isWebhookTestHeldItem("jellyfin", "42", 2500), false);
  const unmarked = markWebhookTestUnmarked(3000);
  assert.equal(unmarked.unmarkedAt, 3000);
  assert.equal(isWebhookTestHeldItem("emby", "42", 3000 + WEBHOOK_TEST_ECHO_MS - 1), true);
  assert.equal(isWebhookTestHeldItem("emby", "42", 3000 + WEBHOOK_TEST_ECHO_MS + 1), false);
  assert.equal(getWebhookTestStatus(3000 + WEBHOOK_TEST_ECHO_MS + 1).status, "idle");
});

test("a passed item left marked is released after the hold window", () => {
  startWebhookTest("emby", 1000);
  interceptWebhookTestEvent(markPlayed(), 2000);
  assert.equal(isWebhookTestHeldItem("emby", "42", 2000 + WEBHOOK_TEST_HOLD_MS - 1), true);
  assert.equal(isWebhookTestHeldItem("emby", "42", 2000 + WEBHOOK_TEST_HOLD_MS + 1), false);
});

test("cancelling releases the hold at once", () => {
  startWebhookTest("emby", 1000);
  interceptWebhookTestEvent(markPlayed(), 2000);
  cancelWebhookTest();
  assert.equal(isWebhookTestHeldItem("emby", "42", 2100), false);
  assert.equal(interceptWebhookTestEvent(markPlayed(), 2100).swallow, false);
});

test("an unanswered test times out and stops swallowing", () => {
  startWebhookTest("emby", 1000);
  const late = 1000 + WEBHOOK_TEST_WINDOW_MS + 1;
  assert.equal(getWebhookTestStatus(late).status, "timeout");
  assert.equal(interceptWebhookTestEvent(markPlayed(), late).swallow, false);
});

test("what arrived while waiting is recorded for the failure advice", () => {
  startWebhookTest("emby", 1000);
  observeWebhookForTest(playbackStop(), 1100);
  observeWebhookForTest(playbackStop(), 1200);
  observeWebhookForTest({ source: "jellyfin", event: "x", phase: "completed" }, 1300);
  noteRejectedWebhookForTest(1400);
  const view = getWebhookTestStatus(1500);
  assert.equal(view.rejectedCount, 1);
  assert.equal(view.seen.length, 1);
  assert.equal(view.seen[0].event, "playback.stop");
  assert.equal(view.seen[0].count, 2);
  assert.equal(view.seen[0].markPlayed, false);
  observeWebhookForTest(markPlayed({ itemId: "7" }), 1600);
  assert.equal(getWebhookTestStatus(1700).seen.find((entry) => entry.event === "item.markplayed").markPlayed, true);
});

test("a new test cannot start while a passed item is still marked, and unsupported sources are refused", () => {
  assert.throws(() => startWebhookTest("plex"), /not available/);
  startWebhookTest("emby", 1000);
  interceptWebhookTestEvent(markPlayed(), 2000);
  assert.throws(() => startWebhookTest("emby", 2100), (error) => error.status === 409);
  markWebhookTestUnmarked(2200);
  assert.equal(startWebhookTest("emby", 2300).status, "waiting");
});

test("capture is a separate step so Plekt echo guards can run before it", () => {
  startWebhookTest("emby", 1000);
  // handleWebhook drops Plekt's own Up Next rail refresh toggle before reaching capture,
  // so a marked-then-unmarked pair that never calls capture leaves the test waiting.
  assert.equal(isHeldWebhookTestEvent(markPlayed(), 1100), false);
  assert.equal(isHeldWebhookTestEvent({ source: "emby", phase: "unplayed", itemId: "42" }, 1100), false);
  assert.equal(getWebhookTestStatus(1200).status, "waiting");
  assert.equal(captureWebhookTestMark(playbackStop(), 1300), false);
  assert.equal(captureWebhookTestMark(markPlayed(), 1400), true);
  assert.equal(captureWebhookTestMark(markPlayed({ itemId: "9" }), 1500), false);
});

test("an event the echo guards identify as Plekt's own is discounted from what was seen", () => {
  startWebhookTest("emby", 1000);
  observeWebhookForTest(markPlayed({ itemId: "5" }), 1100);
  observeWebhookForTest(markPlayed({ itemId: "6" }), 1200);
  discountEchoForWebhookTest(markPlayed({ itemId: "5" }), 1300);
  assert.equal(getWebhookTestStatus(1400).seen[0].markPlayed, true);
  discountEchoForWebhookTest(markPlayed({ itemId: "6" }), 1500);
  assert.deepEqual(getWebhookTestStatus(1600).seen, []);
});

const jellyfinMark = (overrides = {}) => ({
  source: "jellyfin", event: "UserDataSaved", phase: "completed", playedFlagOnly: true,
  itemId: "jf-1", title: "Show - S01E01", type: "episode", season: 1, episode: 1, ...overrides,
});

test("a Jellyfin test captures only Jellyfin marks, holds the item, and leaves Emby alone", () => {
  assert.equal(startWebhookTest("jellyfin", 1000).source, "jellyfin");
  assert.equal(interceptWebhookTestEvent(markPlayed(), 1100).swallow, false);
  assert.equal(interceptWebhookTestEvent(jellyfinMark({ phase: "unplayed", playedFlagOnly: true }), 1200).swallow, false);
  assert.deepEqual(interceptWebhookTestEvent(jellyfinMark(), 1300), { swallow: true, outcome: "captured" });
  assert.equal(isWebhookTestHeldItem("jellyfin", "jf-1", 1400), true);
  assert.equal(isWebhookTestHeldItem("emby", "jf-1", 1400), false);
  assert.deepEqual(interceptWebhookTestEvent(jellyfinMark(), 1500), { swallow: true, outcome: "held" });
  assert.equal(interceptWebhookTestEvent({ source: "jellyfin", phase: "unplayed", itemId: "jf-1" }, 1600).swallow, true);
  assert.equal(interceptWebhookTestEvent(jellyfinMark({ itemId: "jf-2" }), 1700).swallow, false);
});

test("Jellyfin events Plekt identifies as its own are discounted like Emby's", () => {
  startWebhookTest("jellyfin", 1000);
  observeWebhookForTest(jellyfinMark({ itemId: "n1" }), 1100);
  assert.equal(getWebhookTestStatus(1200).seen[0].markPlayed, true);
  discountEchoForWebhookTest(jellyfinMark({ itemId: "n1" }), 1300);
  assert.deepEqual(getWebhookTestStatus(1400).seen, []);
});

test("Jellyfin mark-played payloads parse to a flag-only completed event", async () => {
  const { parseJellyfinWebhook } = await import("../server/src/utils/parsers.js");
  for (const body of [
    { NotificationType: "UserDataSaved", SaveReason: "TogglePlayed", Played: true, ItemId: "jf-9", ItemType: "Episode", SeriesName: "Show", SeasonNumber: 1, EpisodeNumber: 2, Provider_tvdb: "123" },
    { NotificationType: "ItemMarkedPlayed", Item: { Id: "jf-9", Type: "Episode", SeriesName: "Show", ParentIndexNumber: 1, IndexNumber: 2, ProviderIds: { Tvdb: "123" } } },
  ]) {
    const media = parseJellyfinWebhook(body);
    assert.equal(media.source, "jellyfin");
    assert.equal(media.phase, "completed");
    assert.equal(media.playedFlagOnly, true);
    assert.equal(media.itemId, "jf-9");
  }
});

test("the hold matches the captured item whether Jellyfin renders its id with or without dashes", () => {
  startWebhookTest("jellyfin", 1000);
  interceptWebhookTestEvent(jellyfinMark({ itemId: "c5b3d95dd08c567338791201b58771d8" }), 1100);
  assert.equal(isWebhookTestHeldItem("jellyfin", "C5B3D95D-D08C-5673-3879-1201B58771D8", 1200), true);
  assert.equal(interceptWebhookTestEvent(jellyfinMark({ itemId: "c5b3d95d-d08c-5673-3879-1201b58771d8" }), 1300).outcome, "held");
  assert.equal(interceptWebhookTestEvent({ source: "jellyfin", phase: "unplayed", itemId: "c5b3d95d-d08c-5673-3879-1201b58771d8" }, 1400).swallow, true);
  assert.equal(isWebhookTestHeldItem("jellyfin", "c5b3d95d-d08c-5673-3879-1201b58771d9", 1500), false);
  assert.equal(isWebhookTestHeldItem("jellyfin", "", 1500), false);
});

test("Plekt's own playback churn (Up Next rail seed start/progress/stop) leaves nothing in the received list", () => {
  startWebhookTest("emby", 1000);
  const churn = (event, phase) => ({ source: "emby", event, phase, itemId: "77", type: "episode" });
  for (const [event, phase] of [["playback.start", "active"], ["playback.progress", "active"], ["playback.stop", "ended"]]) {
    observeWebhookForTest(churn(event, phase), 1100);
    discountEchoForWebhookTest(churn(event, phase), 1100);
  }
  assert.deepEqual(getWebhookTestStatus(1200).seen, []);
});

test("the capture keeps the poster path Plekt resolved for the item", () => {
  startWebhookTest("emby", 1000);
  captureWebhookTestMark(markPlayed({ posterUrl: "/api/image?path=%2FItems%2F42%2FImages%2FPrimary" }), 1100);
  assert.equal(getWebhookTestStatus(1200).capture.posterUrl, "/api/image?path=%2FItems%2F42%2FImages%2FPrimary");
  cancelWebhookTest();
  startWebhookTest("emby", 2000);
  captureWebhookTestMark(markPlayed(), 2100);
  assert.equal(getWebhookTestStatus(2200).capture.posterUrl, "");
});
