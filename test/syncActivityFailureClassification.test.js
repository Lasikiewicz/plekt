import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
const { handleSimklEpisodeOrderReviewClick, handleSyncActivityRetryClick, simklEpisodeOrderGuidance, syncActivityResultSummary } = await import("../public/modules/sync-attention-cards.js");

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

test("alternate numbering skips offer a single watched-only review for the group", () => {
  const entry = {
    action: "watched",
    status: "partial",
    details: "Synced to Emby; Simkl skipped by the historical sync policy",
    targetStates: [
      { target: "emby", status: "success" },
      { target: "simkl", status: "skipped", detail: "Simkl does not support alternate episode orders; this show's watches are not sent to Simkl" },
    ],
  };
  assert.equal(isRetryableActivity(entry), false);
  assert.equal(syncActivityResultSummary(entry), "Synced to Emby; Simkl skipped because of episode numbering");
  assert.equal(syncActivityResultSummary({ ...entry, details: "Synced to Emby; Plex & Simkl skipped by the historical sync policy" }),
    "Synced to Emby; Plex skipped by the historical sync policy. Simkl skipped because of episode numbering");
  const markup = simklEpisodeOrderGuidance([entry, entry], "show|title:futurama");
  assert.match(markup, /data-simkl-episode-order-review="show\|title:futurama"/);
  assert.equal((markup.match(/Review Simkl updates/g) || []).length, 1);
  assert.equal(simklEpisodeOrderGuidance([{ ...entry, action: "unwatched" }], "show|title:futurama"), "");
  const unverified = { ...entry, targetStates: [{ target: "simkl", status: "skipped", detail: "Simkl could not verify this episode's alternate numbering" }] };
  assert.match(simklEpisodeOrderGuidance([unverified], "show|title:futurama"), /Review Simkl updates/);
  const otherSkip = { ...entry, targetStates: [{ target: "plex", status: "skipped", detail: "Historical Plex sync disabled" }] };
  assert.equal(simklEpisodeOrderGuidance([otherSkip], "show|title:futurama"), "");
  assert.equal(syncActivityResultSummary(otherSkip), otherSkip.details);
});

test("Simkl review queues only the selected watches after confirmation", async () => {
  const groupKey = "show|title:futurama";
  const preview = { id: "preview-id", items: [
    { id: "selected", title: "Futurama - S02E06", side: "tracker", season: 2, episode: 6, selectable: true },
    { id: "deselected", title: "Futurama - S02E07", side: "tracker", selectable: true },
    { id: "held", title: "<Episode>", side: "tracker", reason: "Episode match is ambiguous", selectable: false },
    { id: "inbound", title: "Unrelated inbound watch", side: "plekt", selectable: true },
  ] };
  const button = {
    disabled: false,
    textContent: "Review Simkl updates",
    dataset: { simklEpisodeOrderReview: groupKey },
    setAttribute() {},
    removeAttribute() {},
  };
  const inputs = [{ value: "selected", checked: true }, { value: "deselected", checked: false }, { value: "held", disabled: true }];
  const list = { querySelectorAll: (selector) => selector === "input" ? inputs : inputs.filter((input) => input.checked && !input.disabled), closest() {}, querySelector() {} };
  const oldFetch = globalThis.fetch;
  const oldDocument = globalThis.document;
  const calls = [];
  const errors = [];
  globalThis.document = { getElementById: () => list };
  globalThis.fetch = async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => url.endsWith("/compare") ? { fullSync: { preview } } : { fullSync: { status: "queued", runId: "run-id" } } };
  };
  try {
    for (const confirmed of [false, true]) {
      calls.length = 0;
      const event = { target: { closest: () => button } };
      assert.equal(handleSimklEpisodeOrderReviewClick(event, {
        setMessage: (message) => errors.push(message),
        openConfirmDialog: async ({ mediaHtml, runOnConfirm }) => {
          assert.match(mediaHtml, /Futurama - S02E06/);
          assert.match(mediaHtml, /&lt;Episode&gt;/);
          assert.match(mediaHtml, /Episode match is ambiguous/);
          assert.doesNotMatch(mediaHtml, /Unrelated inbound watch/);
          if (confirmed) assert.match(await runOnConfirm(), /Queued 1 watch for Simkl/);
        },
      }), true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(button.disabled, false);
      assert.deepEqual(errors, []);
      assert.deepEqual(calls, [
        ["/api/tracker-connections/simkl/full-sync/compare", { activityGroupKey: groupKey }],
        ...(confirmed ? [["/api/tracker-connections/simkl/full-sync", { direction: "push", planId: preview.id, selectedIds: ["selected"] }]] : []),
      ]);
    }
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.document = oldDocument;
  }
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
