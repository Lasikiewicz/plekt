import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { initialSyncDialogMarkup, loadInitialSyncSummary, renderInitialSync } = await import("../public/modules/initial-sync.js?v=2.1.1.0.8");
const { state } = await import("../public/modules/state.js?v=2.1.1.0.8");

function classListStub(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      if (force === undefined ? !values.has(name) : force) values.add(name);
      else values.delete(name);
    },
  };
}

test("initial sync screen escapes user text in destination and item markup", () => {
  const markup = initialSyncDialogMarkup({
    status: "partial",
    remaining: 1,
    total: 3,
    error: "<script>alert('bad')</script>",
    destinations: [{ provider: "jellyfin", label: "<img src=x onerror=1>", status: "failed", remaining: 1, total: 3, error: "<b>offline</b>" }],
    items: [{ id: "x", title: "<svg onload=1>", showTitle: "A & B", type: "episode", season: "<2>", episode: 4, destination: "<plex>", status: "held", detail: "<i>hold reason</i>" }],
    truncated: true,
  });

  assert.match(markup, /&lt;script&gt;alert\(&#39;bad&#39;\)&lt;\/script&gt;/);
  assert.match(markup, /&lt;img src=x onerror=1&gt;/);
  assert.match(markup, /&lt;svg onload=1&gt;/);
  assert.match(markup, /&lt;2&gt;/);
  assert.match(markup, /&lt;plex&gt;/);
  assert.match(markup, /A &amp; B/);
  assert.match(markup, /&lt;i&gt;hold reason&lt;\/i&gt;/);
  assert.doesNotMatch(markup, /<script>|<img |<svg |<b>|<i>/i);
  assert.match(markup, /more items may be pending/);
});

test("initial sync chip is visible for honest active and interrupted outcomes only", () => {
  const previousToken = state.token;
  const previousQuery = document.querySelector;
  const chip = { classList: classListStub(["hidden"]), dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const chipText = { textContent: "" };
  const dialog = { classList: classListStub(["hidden"]) };
  const body = { innerHTML: "" };
  const nodes = { "#initialSyncChip": chip, "#initialSyncChipText": chipText, "#initialSyncDialog": dialog, "#initialSyncDialogBody": body };
  state.token = "test-key";
  document.querySelector = (selector) => nodes[selector] || null;

  try {
    renderInitialSync({ status: "running", remaining: 4, total: 9 });
    assert.equal(chip.classList.contains("hidden"), false);
    assert.match(chipText.textContent, /Initial sync · 4 left/);
    for (const [status, label] of [["interrupted", "Interrupted"], ["partial", "Partially completed"], ["failed", "Failed"]]) {
      renderInitialSync({ status, remaining: 2, total: 9 });
      assert.equal(chip.classList.contains("hidden"), false);
      assert.match(chipText.textContent, new RegExp(label));
    }
    for (const status of ["skipped", "completed", "not_started"]) {
      renderInitialSync({ status, remaining: 0, total: 9 });
      assert.equal(chip.classList.contains("hidden"), true);
    }
  } finally {
    state.token = previousToken;
    document.querySelector = previousQuery;
  }
});

test("initial sync summary uses an authenticated read-only request", async () => {
  const previousToken = state.token;
  const previousFetch = globalThis.fetch;
  const previousQuery = document.querySelector;
  const calls = [];
  const chip = { classList: classListStub(["hidden"]), dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const chipText = { textContent: "" };
  const dialog = { classList: classListStub(["hidden"]) };
  const bodyElement = { innerHTML: "" };
  const nodes = { "#initialSyncChip": chip, "#initialSyncChipText": chipText, "#initialSyncDialog": dialog, "#initialSyncDialogBody": bodyElement };
  state.token = "initial-sync-test-key";
  document.querySelector = (selector) => nodes[selector] || null;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ status: "planning", remaining: 2, total: 5, destinations: [], items: [] }) };
  };

  try {
    const result = await loadInitialSyncSummary();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/setup/initial-sync");
    assert.equal(calls[0].options.method, undefined);
    assert.equal(calls[0].options.cache, "no-store");
    assert.equal(calls[0].options.headers["X-Api-Key"], "initial-sync-test-key");
    assert.equal(result.status, "planning");
    assert.equal(chip.classList.contains("hidden"), false);
  } finally {
    state.token = previousToken;
    globalThis.fetch = previousFetch;
    document.querySelector = previousQuery;
  }
});
