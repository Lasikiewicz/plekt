import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { attentionIssueMarkup, clientAttentionItemMarkup, recordClientAttention, renderSyncActivityStatus, renderSyncAttention, retryClientAttention } = await import("../public/modules/sync-activity.js");
const { elements, state } = await import("../public/modules/state.js");
const { renderTrackerWriteReview } = await import("../public/modules/sync-attention-cards.js");

test("tracker review groups episodes across providers under one show", () => {
  const items = ["simkl", "trakt"].map((provider, index) => ({
    id: provider, provider, source: "tracker_write", title: "Example", groupTitle: "Example",
    groupKey: "example-show", episodeCode: `S01E0${index + 1}`, competing: true,
  }));
  const html = renderTrackerWriteReview(items, (item) => `<p>${item.id}</p>`);
  assert.equal((html.match(/data-tracker-review-group=/g) || []).length, 1);
  assert.match(html, /2 episodes · 2 held writes · Simkl, Trakt/);
  assert.match(html, /<h4>S01E01<\/h4>/);
  assert.match(html, /<h4>S01E02<\/h4>/);
  assert.match(html, /Cancel pending updates/);
  assert.match(html, /held Simkl and Trakt watch updates for the movies and shows you check/);
  assert.match(html, /Recheck all/);
  assert.match(html, /Your local watch history and tracker history stay intact/);
  assert.match(html, /data-tracker-review-status role="status"/);
});

test("sync status reflects current activity issues after an otherwise idle run", () => {
  const previous = {
    progress: state.syncActivityProgress,
    issueCount: state.syncActivityCurrentIssueCount,
    attention: state.syncAttention,
    attentionCount: state.syncAttentionCount,
    attentionError: state.syncAttentionError,
    indicator: elements.syncProgressIndicator,
    indicatorText: elements.syncProgressText,
    pageStatus: elements.syncActivityStatus,
    pageStatusText: elements.syncActivityStatusText,
  };
  const indicator = { dataset: {}, title: "" };
  const indicatorText = { textContent: "" };
  const pageStatus = { dataset: {} };
  const pageStatusText = { textContent: "" };
  elements.syncProgressIndicator = indicator;
  elements.syncProgressText = indicatorText;
  elements.syncActivityStatus = pageStatus;
  elements.syncActivityStatusText = pageStatusText;
  state.syncActivityProgress = { total: 0, completed: 0, active: false, label: "" };
  state.syncActivityCurrentIssueCount = 21;
  state.syncAttention = [];
  state.syncAttentionCount = 0;
  state.syncAttentionError = null;

  try {
    renderSyncActivityStatus();
    assert.equal(indicatorText.textContent, "Sync - Attention Needed");
    assert.equal(pageStatusText.textContent, "Sync - Attention Needed");
    assert.equal(indicator.dataset.syncState, "attention");
    assert.equal(indicator.dataset.attentionTone, "error");
  } finally {
    state.syncActivityProgress = previous.progress;
    state.syncActivityCurrentIssueCount = previous.issueCount;
    state.syncAttention = previous.attention;
    state.syncAttentionCount = previous.attentionCount;
    state.syncAttentionError = previous.attentionError;
    elements.syncProgressIndicator = previous.indicator;
    elements.syncProgressText = previous.indicatorText;
    elements.syncActivityStatus = previous.pageStatus;
    elements.syncActivityStatusText = previous.pageStatusText;
  }
});

test("cross-platform match issues render in the Sync Activity attention panel", () => {
  const previous = {
    attentionElement: elements.syncActivityAttention,
    matchReport: state.syncActivityMatchReport,
    matchIssueCount: state.syncActivityMatchIssueCount,
    syncAttention: state.syncAttention,
    clientAttention: state.clientAttention,
    attentionError: state.syncAttentionError,
    attentionLoading: state.syncAttentionLoading,
    attentionLoaded: state.syncAttentionLoaded,
    attentionSeverity: state.syncAttentionSeverity,
  };
  const classes = new Set(["hidden"]);
  const container = {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
    },
    dataset: {},
    innerHTML: "",
    removeAttribute() {},
  };
  elements.syncActivityAttention = container;
  state.syncActivityMatchReport = {
    platforms: {
      plex: {
        samples: [{ id: "match-1", title: "The Missing Episode", media_type: "episode", show_title: "The Missing Show", season: 1, episode: 2 }],
      },
    },
  };
  state.syncActivityMatchIssueCount = 1;
  state.syncAttention = [];
  state.clientAttention = [];
  state.syncAttentionError = "";
  state.syncAttentionLoading = false;
  state.syncAttentionLoaded = true;
  state.syncAttentionSeverity = "clear";

  try {
    renderSyncAttention();
    assert.match(container.innerHTML, /Cross-Platform Match Issues/);
    assert.match(container.innerHTML, /The Missing Episode/);
    assert.match(container.innerHTML, /Fix match/);
    assert.equal(classes.has("hidden"), false);
  } finally {
    elements.syncActivityAttention = previous.attentionElement;
    state.syncActivityMatchReport = previous.matchReport;
    state.syncActivityMatchIssueCount = previous.matchIssueCount;
    state.syncAttention = previous.syncAttention;
    state.clientAttention = previous.clientAttention;
    state.syncAttentionError = previous.attentionError;
    state.syncAttentionLoading = previous.attentionLoading;
    state.syncAttentionLoaded = previous.attentionLoaded;
    state.syncAttentionSeverity = previous.attentionSeverity;
  }
});

test("restore attention rows expose a target-specific retry action alongside skip", () => {
  const markup = attentionIssueMarkup("restore:run-123:projection-failed", {
    key: "restore-target:jellyfin:episode-key:1:1",
    provider: "jellyfin",
    title: "A Thousand Blows - S01E01",
    type: "episode",
    sourceMediaKey: "episode:1:1:imdb:tt21974956",
    watchedAt: "2026-08-22T01:21:00.000Z",
    reason: "timed out after 30000ms: jellyfin: A Thousand Blows - S01E01",
    localHref: "/tvshow/a-thousand-blows/season/1/episode/1?historyId=watch-1",
    canRepair: true,
    repairLabel: "Retry on Jellyfin",
  });

  assert.match(markup, /data-sync-attention-retry-item="restore:run-123:projection-failed"/);
  assert.match(markup, /data-sync-attention-item-key="restore-target:jellyfin:episode-key:1:1"/);
  assert.match(markup, />Retry on Jellyfin<\/button>/);
  assert.match(markup, /data-sync-attention-skip-item/);
});

test("client attention keeps the affected media and a safe retry payload", async () => {
  const previousAttention = state.clientAttention;
  const previousRetrying = state.clientAttentionRetrying;
  const previousFetch = globalThis.fetch;
  const calls = [];
  state.clientAttention = [];
  state.clientAttentionRetrying = "";
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, inserted: 1, propagated: 1 }) };
  };

  try {
    const item = recordClientAttention("Manual watch update failed with 502", "error", {
      title: "Watch update failed",
      summary: "Could not mark The Walking Dead · S07E12 watched. Server response: Manual watch update failed with 502",
      context: {
        actionLabel: "Manual watch update",
        affectedMedia: "The Walking Dead · S07E12",
        provider: "Jellyfin",
        failureReason: "Jellyfin: Upstream request failed (connection refused)",
      },
      retry: { endpoint: "/api/manual-watch", method: "POST", body: { records: [{ title: "The Walking Dead - S07E12", resync_only: true }] }, label: "Retry watch update" },
    });

    assert.equal(item.context.affectedMedia, "The Walking Dead · S07E12");
    assert.equal(item.context.retry.label, "Retry watch update");
    const markup = clientAttentionItemMarkup(item);
    assert.match(markup, /The Walking Dead · S07E12/);
    assert.match(markup, /data-sync-client-retry=/);
    assert.match(markup, />Retry watch update<\/button>/);
    assert.match(markup, />Open affected page<\/a>/);
    assert.match(markup, /Failure reason/);
    assert.match(markup, /Jellyfin: Upstream request failed \(connection refused\)/);
    assert.match(markup, />Open logs<\/a>/);
    const result = await retryClientAttention(item.id);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/manual-watch");
    assert.deepEqual(JSON.parse(calls[0].options.body), { records: [{ title: "The Walking Dead - S07E12", resync_only: true }] });
    assert.equal(state.clientAttention.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    state.clientAttention = previousAttention;
    state.clientAttentionRetrying = previousRetrying;
  }
});
test("media-server rows with retained source data stay retryable when the capability flag is stale", () => {
  const markup = attentionIssueMarkup("restore:run-789:projection-failed", {
    key: "restore-target:jellyfin:episode-key:1:1",
    provider: "jellyfin",
    title: "A Thousand Blows - S01E01",
    type: "episode",
    sourceMediaKey: "episode:1:1:imdb:tt21974956",
    canRepair: false,
    repairLabel: "Retry on Jellyfin",
  });

  assert.match(markup, /data-sync-attention-retry-item/);
  assert.match(markup, />Retry on Jellyfin<\/button>/);
  assert.match(markup, /data-sync-attention-skip-item/);
});

test("restore attention rows without repair data do not advertise a retry", () => {
  const markup = attentionIssueMarkup("restore:run-456:projection-failed", {
    key: "restore-example:missing-row",
    provider: "jellyfin",
    title: "Unknown media",
    candidate: true,
    canRepair: false,
  });

  assert.doesNotMatch(markup, /data-sync-attention-retry-item/);
  assert.doesNotMatch(markup, /data-sync-attention-skip-item/);
});

test("groupAttentionIssues groups episodes by show and separates movies", async () => {
  const { groupAttentionIssues } = await import("../public/modules/sync-activity.js");
  const issues = [
    { key: "item-1", title: "Risky Rewards - S01E01", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 1 },
    { key: "item-2", title: "Risky Rewards - S01E02", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 2 },
    { key: "item-3", title: "Inception", type: "movie" },
  ];

  const groups = groupAttentionIssues(issues);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].kind, "show");
  assert.equal(groups[0].title, "Risky Rewards");
  assert.equal(groups[0].issues.length, 2);
  assert.equal(groups[1].kind, "movie");
  assert.equal(groups[1].title, "Inception");
  assert.equal(groups[1].issues.length, 1);
});

test("attentionIssueList groups multiple show episodes under an expandable show group", async () => {
  const syncActivity = await import("../public/modules/sync-activity.js");
  const { state } = await import("../public/modules/state.js");

  const item = {
    id: "restore:run-123:trakt-rejected",
    context: {
      issueItems: [
        { key: "row-1", sourceRowId: "watch-1", title: "Risky Rewards - S01E01", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 1, provider: "trakt", canRepair: true },
        { key: "row-2", sourceRowId: "watch-2", title: "Risky Rewards - S01E02", showTitle: "Risky Rewards", type: "episode", season: 1, episode: 2, provider: "trakt", canRepair: true },
      ],
      issueCount: 2,
      issueItemsComplete: true,
    },
  };

  // When collapsed (default)
  state.syncAttentionExpandedShows.clear();
  const collapsedMarkup = syncActivity.syncAttentionItemMarkup(item);
  assert.match(collapsedMarkup, /data-sync-attention-toggle-show/);
  assert.match(collapsedMarkup, /data-sync-attention-retry-show/);
  assert.match(collapsedMarkup, /data-sync-attention-skip-show/);
  assert.match(collapsedMarkup, />Risky Rewards<\/h4>/);
  assert.match(collapsedMarkup, /2 affected plays/);
  // Episodes should not be rendered when collapsed
  assert.doesNotMatch(collapsedMarkup, /data-sync-attention-retry-item/);

  // When expanded
  const actionKey = `${item.id}:riskyrewards`;
  state.syncAttentionExpandedShows.add(actionKey);
  const expandedMarkup = syncActivity.syncAttentionItemMarkup(item);
  assert.match(expandedMarkup, /sync-attention-show-episodes/);
  assert.match(expandedMarkup, /Risky Rewards - S01E01/);
  assert.match(expandedMarkup, /Risky Rewards - S01E02/);
  assert.match(expandedMarkup, /data-sync-attention-retry-item="restore:run-123:trakt-rejected"/);
  assert.match(expandedMarkup, /data-sync-attention-skip-item/);
});
