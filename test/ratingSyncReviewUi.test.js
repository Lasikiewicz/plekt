import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state } = await import("../public/modules/state.js?v=2.0.0.4.0");
const ui = await import("../public/modules/rating-sync-settings.js");

test("held scan stays visible on refresh, escapes titles, and sends the reviewed run token", async () => {
  const originalFetch = globalThis.fetch;
  const originalQuery = document.querySelector;
  const originalInterval = window.setInterval;
  const originalClear = window.clearInterval;
  const widgets = new Map();
  for (const name of ["Panel", "Enabled", "ProviderRows", "Status", "Help", "Now"]) {
    widgets.set(`#ratingSync${name}`, {
      dataset: {}, innerHTML: "", textContent: "", listeners: {}, busy: false,
      addEventListener(name, callback) { this.listeners[name] = callback; },
      toggleAttribute(_name, on) { this.busy = on; },
      hasAttribute() { return this.busy; },
    });
  }
  document.querySelector = selector => widgets.get(selector);
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  state.token = "test-token";
  const config = { enabled: true };
  state.savedConfig = { ratingSync: config };
  let hold = { status: "held", run_id: "review-token", cursor: { ratingHold: {
    missingCount: 2, baselineCount: 7, items: [{ title: '<img src=x onerror="bad">' }, { title: "Second Movie" }],
  } } };
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.method === "POST") {
      requests.push(JSON.parse(options.body));
      hold = null;
      return new Response(JSON.stringify({ status: "dismissed" }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ config, providers: [{ provider: "emby", configured: true, run: hold, queue: {} }, { provider: "simkl", configured: true, queue: { held: 1 }, issues: [{ title: "<unsafe title>", status: "held", reason: "Held: would add watched history" }, { title: "Readback", status: "conflict", reason: "Watch date changed" }] }], queue: { held: 1 } }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    ui.initRatingSyncSettings({ authHeaders: () => ({ Authorization: "Bearer test-token" }) });
    await ui.refreshRatingSyncStatus();
    await ui.refreshRatingSyncStatus();
    const rows = widgets.get("#ratingSyncProviderRows");
    assert.match(rows.innerHTML, /Rating scan held for review/);
    assert.match(rows.innerHTML, /Approve these removals/);
    assert.match(rows.innerHTML, /Dismiss and keep ratings/);
    assert.match(rows.innerHTML, /&lt;img/);
    assert.doesNotMatch(rows.innerHTML, /<img/);
    assert.match(rows.innerHTML, /Simkl/);
    assert.match(rows.innerHTML, /Held: would add watched history/);
    assert.match(rows.innerHTML, /Watch date changed/);
    assert.match(rows.innerHTML, /&lt;unsafe title&gt;/);
    assert.match(widgets.get("#ratingSyncStatus").textContent, /sync issue/);
    await rows.listeners.click({ target: { closest: (selector) => selector === "[data-rating-hold]" ? ({ dataset: {
      ratingHold: "dismiss", provider: "emby", runId: "review-token",
    } }) : null } });
    assert.deepEqual(requests, [{ action: "dismiss-held", provider: "emby", runId: "review-token" }]);
    assert.doesNotMatch(rows.innerHTML, /Rating scan held for review/);
    await rows.listeners.click({ target: { closest: selector => selector === "[data-rating-retry]" ? { dataset: { ratingRetry: "simkl" } } : null } });
    assert.deepEqual(requests[1], { providers: ["simkl"] });
  } finally {
    ui.stopRatingSyncSettings();
    globalThis.fetch = originalFetch;
    document.querySelector = originalQuery;
    window.setInterval = originalInterval;
    window.clearInterval = originalClear;
  }
});
