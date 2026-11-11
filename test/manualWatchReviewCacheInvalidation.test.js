import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state } = await import("../public/modules/state.js");
const { initManualWatchReview, stopManualWatchReviewPolling } = await import("../public/modules/manual-watch-review.js");

function makeElement() {
  return {
    dataset: {},
    disabled: false,
    innerHTML: "",
    classList: { toggle() {} },
    addEventListener(type, handler) { this.handlers = this.handlers || {}; this.handlers[type] = handler; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  };
}

test("successful review decisions invalidate show detail cache, while failures and defer do not", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const rows = makeElement();
  const body = makeElement();
  globalThis.document = {
    body,
    visibilityState: "visible",
    querySelector(selector) { return selector === "#manualWatchReviewRows" ? rows : null; },
    querySelectorAll() { return []; },
  };
  globalThis.window = {
    addEventListener() {},
    setInterval() { return 1; },
    clearInterval() {},
  };
  t.after(() => {
    stopManualWatchReviewPolling();
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  let cacheClears = 0;
  let postCount = 0;
  let confirmCount = 0;
  let shouldFail = false;
  globalThis.fetch = async (_url, options = {}) => {
    assert.equal(options.method, "POST");
    postCount += 1;
    if (shouldFail) return { ok: false, status: 500, async json() { return { ok: false, error: "write failed" }; } };
    return { ok: true, status: 200, async json() { return { ok: true, status: "approved" }; } };
  };
  initManualWatchReview({
    openConfirmDialog: async () => { confirmCount += 1; return true; },
    setMessage() {},
    clearDerivedUiCaches() { cacheClears += 1; },
  });

  async function clickAction(id, action) {
    const review = { id, media_type: "movie", title: `Review ${id}`, source: "plex" };
    state.token = "test-token";
    state.activeView = "manualWatchReview";
    state.manualWatchReviews = [review];
    state.manualWatchReviewCount = 1;
    state.manualWatchReviewLoaded = true;
    state.manualWatchReviewLoading = false;
    state.manualWatchReviewError = "";
    const card = makeElement();
    card.dataset.manualWatchReviewId = id;
    const button = makeElement();
    button.dataset.manualWatchReviewAction = action;
    button.dataset.manualWatchReviewMode = "detected";
    button.closest = () => card;
    const target = { closest(selector) { return selector === "button" || selector.includes("data-manual-watch-review-action") ? button : null; } };
    rows.handlers.click({ target, button: 0 });
    for (let attempt = 0; attempt < 20; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await clickAction("approve-ok", "approve");
  assert.equal(confirmCount, 1, "approval click should ask for confirmation");
  assert.equal(postCount, 1, "approval should make its API request after confirmation");
  assert.equal(cacheClears, 1, "successful approval should invalidate show detail cache");

  await clickAction("dismiss-ok", "dismiss");
  assert.equal(cacheClears, 2, "successful dismissal should invalidate show detail cache");

  await clickAction("defer-ok", "defer");
  assert.equal(cacheClears, 2, "deferring a review must not invalidate watched show data");

  shouldFail = true;
  await clickAction("approve-failed", "approve");
  assert.equal(cacheClears, 2, "a failed approval must not invalidate show detail cache");
});
