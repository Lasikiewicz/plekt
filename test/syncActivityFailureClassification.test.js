import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
const { handleSyncActivityRetryClick } = await import("../public/modules/sync-attention-cards.js");

test("retry explains the failed destination and dispatches only after confirmation", async () => {
  const button = { disabled: false, dataset: {
    syncActivityRetry: "42",
    retryInfo: JSON.stringify({ title: "Black Sails", action: "Marked Unwatched", failures: [["Trakt", "HTTP 503"]] }),
  } };
  const event = { target: { closest: () => button } };
  const calls = [];
  for (const confirmed of [false, true]) {
    assert.equal(handleSyncActivityRetryClick(event, {
      openConfirmDialog: async ({ body, confirmLabel, cancelLabel, runOnConfirm, pendingLabel }) => {
        assert.match(body, /Black Sails.*Marked Unwatched/);
        assert.match(body, /only for Trakt/);
        assert.match(body, /HTTP 503/);
        assert.equal(confirmLabel, "Retry now");
        assert.equal(cancelLabel, "Not now");
        assert.match(pendingLabel, /Retrying/);
        if (confirmed) {
          const result = await runOnConfirm();
          assert.match(result, /Retry result/);
          assert.match(result, /Trakt: Connection timed out/);
        }
        return confirmed;
      },
      retrySyncActivity: async (id) => {
        calls.push(id);
        return { status: "error", targetStates: [{ target: "trakt", status: "error", detail: "Connection timed out" }] };
      },
    }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(button.disabled, false);
    assert.deepEqual(calls, confirmed ? ["42"] : []);
  }
});

const {
  hasRetryableActivityTarget,
  isFailedSyncActivityEntry,
  isRetryableActivity,
  isTraktNotFoundMatchIssue,
  syncActivityIssueMarkup,
  targetResults,
} = await import("../public/modules/sync-activity.js");

test("library no-match skips are not failures or retryable activity", () => {
  const entry = {
    status: "partial",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "emby", status: "not_found", detail: "No matching item found" },
    ],
  };

  assert.equal(hasRetryableActivityTarget(entry), false);
  assert.equal(isFailedSyncActivityEntry(entry), false);
  assert.equal(isRetryableActivity(entry), false);
  assert.match(targetResults(entry, { failedOnly: true }), /No failed target response/);
});

test("a real Trakt failure remains visible when another target has no match", () => {
  const entry = {
    status: "partial",
    targetStates: [
      { target: "plex", status: "skipped", detail: "No matching item found" },
      { target: "trakt", status: "error", detail: "HTTP 503" },
    ],
  };

  assert.equal(hasRetryableActivityTarget(entry), true);
  assert.equal(isFailedSyncActivityEntry(entry), true);
  assert.equal(isRetryableActivity(entry), true);
  const failedMarkup = targetResults(entry, { failedOnly: true });
  assert.match(failedMarkup, /Trakt/);
  assert.doesNotMatch(failedMarkup, /Plex/);
});

test("a Simkl-only failure is retryable, matching the server's retry targets", () => {
  const entry = {
    status: "partial",
    targetStates: [
      { target: "emby", status: "success" },
      { target: "simkl", status: "error", detail: "Simkl needs a verified media identity" },
      { target: "trakt", status: "skipped", detail: "Trakt needs a Trakt, IMDb, TMDB, or TVDB ID for this item" },
    ],
  };
  assert.equal(isRetryableActivity(entry), true);
  assert.equal(hasRetryableActivityTarget({ status: "error", targetStates: [{ target: "unknown", status: "error" }] }), false);
});

test("Trakt not_found episode failures offer a show-match repair", () => {
  const entry = {
    mediaType: "episode",
    isLatestForItem: true,
    targetStates: [
      { target: "plex", status: "success" },
      { target: "trakt", status: "error", detail: "Trakt could not match this item (not_found)" },
    ],
  };

  assert.equal(isTraktNotFoundMatchIssue(entry), true);
  assert.equal(isTraktNotFoundMatchIssue({ ...entry, isLatestForItem: false }), false);
  assert.equal(isTraktNotFoundMatchIssue({ ...entry, mediaType: "movie" }), false);
  assert.equal(isTraktNotFoundMatchIssue({
    ...entry,
    targetStates: [{ target: "trakt", status: "error", detail: "HTTP 503" }],
  }), false);
});

test("current issue markup shows every destination response and targeted Trakt actions", () => {
  const markup = syncActivityIssueMarkup({
    id: "activity-1",
    mediaType: "episode",
    title: "Black Sails - S04E02",
    status: "partial",
    action: "unwatched",
    timestamp: Date.parse("2026-09-17T18:30:00.000Z"),
    isLatestForItem: true,
    rawPayloadDebug: { ids: { tvdb: "5944779" }, season: 4, episode: 2 },
    targetStates: [
      { target: "plex", status: "success", detail: "200 OK" },
      { target: "emby", status: "success", detail: "200 OK" },
      { target: "jellyfin", status: "success", detail: "200 OK" },
      { target: "trakt", status: "error", detail: 'Trakt could not match this item to mark it unwatched (not_found: {"shows":[]})' },
    ],
  }, "show:black-sails");

  assert.match(markup, /Marked Unwatched Failed/);
  assert.match(markup, /Black Sails - S04E02/);
  assert.match(markup, /Plex:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Emby:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Jellyfin:<\/span><\/span><span class="sync-activity-target-status">success/);
  assert.match(markup, /Trakt:<\/span><\/span><span class="sync-activity-target-status">error/);
  assert.match(markup, /Trakt could not match this item to mark it unwatched/);
  assert.match(markup, /Fix show match/);
  assert.match(markup, /Dismiss Trakt error/);
  assert.doesNotMatch(markup, /data-sync-activity-retry/);
});
