import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { selectedPacing, fullSyncView } = await import("../public/modules/tracker-full-sync.js");
const { initialSyncDialogMarkup, renderInitialSync } = await import("../public/modules/initial-sync.js?v=2.1.1.0.8");
const { state } = await import("../public/modules/state.js?v=2.1.1.0.8");

const pacing = (overrides = {}) => ({
  quotaLimit: 1000,
  quotaRemaining: 177,
  normalReserve: 100,
  safetyReserve: 55,
  protectedQuota: 155,
  verificationRequests: 18,
  nextResetAt: "2026-10-25T00:00:00Z",
  estimatedDays: 1,
  pacingRequired: false,
  itemsToday: 100,
  itemsPerFullDay: 200,
  quotaKnown: true,
  ...overrides,
});

function preview(total = 0, metadata = pacing()) {
  const items = Array.from({ length: total }, (_, index) => ({
    id: `item-${index}`,
    side: index % 2 === 0 ? "tracker" : "plekt",
    operation: "add",
    selectable: true,
  }));
  return { items, requestEstimate: { pacing: metadata } };
}

test("Simkl pacing recalculates selected outbound requests for direction and selection", () => {
  const data = preview(240, pacing({ itemsToday: 100, itemsPerFullDay: 100, estimatedDays: 2, pacingRequired: true }));
  const chosen = new Set(data.items.map(item => item.id));
  const both = selectedPacing(data, chosen, "both");
  assert.equal(both.outboundCount, 120);
  assert.equal(both.batchRequests, 8);
  assert.equal(both.verificationRequests, 36);
  assert.equal(both.totalRequests, 44);
  assert.equal(both.estimatedDays, 2);

  chosen.delete("item-0");
  const reduced = selectedPacing(data, chosen, "both");
  assert.equal(reduced.outboundCount, 119);
  assert.equal(reduced.batchRequests, 8);
  assert.equal(selectedPacing(data, chosen, "import").outboundCount, 0);
  assert.equal(selectedPacing(data, chosen, "import").totalRequests, 0);
});

test("pacing reports large, small, and unknown quota estimates without invented allowances", () => {
  const data = preview(600, pacing({ itemsToday: 100, itemsPerFullDay: 100, estimatedDays: 3, pacingRequired: true }));
  const selected = new Set(data.items.map(item => item.id));
  assert.equal(selectedPacing(data, selected, "both").estimatedDays, 3);
  assert.equal(selectedPacing(data, new Set(["item-0"]), "both").totalRequests, 22);

  const unknown = preview(4, pacing({ quotaKnown: false, quotaRemaining: null, normalReserve: null, protectedQuota: null, estimatedDays: null, itemsToday: null, itemsPerFullDay: null }));
  const estimate = selectedPacing(unknown, new Set(unknown.items.map(item => item.id)), "both");
  assert.equal(estimate.totalRequests, 22);
  assert.equal(estimate.estimatedDays, null);
  assert.equal(estimate.quotaRemaining, null);
});

test("waiting quota remains active and reports its resume time and reserves", () => {
  const view = fullSyncView("simkl", {
    baselineComplete: true,
    fullSync: { status: "waiting_quota", runId: "r1", nextRunAt: "2026-10-25T10:30:00Z", pacing: pacing() },
  });
  assert.equal(view.running, true);
  assert.equal(view.waitingQuota, true);
  assert.match(view.text, /waiting for Simkl quota/);
  assert.match(view.text, /100.*55/);
  assert.match(view.text, /2026|25 Oct|Oct 25/);
});

test("onboarding shows escaped waiting-quota pacing and leaves remaining count intact", () => {
  const markup = initialSyncDialogMarkup({
    status: "running", remaining: 7, total: 20, destinations: [{
      provider: "simkl", label: "Simkl", status: "waiting_quota", remaining: 7, total: 20,
      nextRunAt: "<img src=x onerror=1>",
      pacing: pacing({ quotaKnown: false, quotaRemaining: null, normalReserve: null, protectedQuota: null, estimatedDays: null }),
    }], items: [],
  });
  assert.match(markup, /7 items remaining of 20/);
  assert.match(markup, /selected for sending/);
  assert.match(markup, /Quota estimate unavailable/);
  assert.doesNotMatch(markup, /<img src=x/);
});

test("waiting-quota onboarding chip is visible and includes local resume information", () => {
  const previousToken = state.token;
  const previousQuery = document.querySelector;
  const chip = { classList: { toggle(_name, hidden) { this.hidden = hidden; } }, dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const chipText = { textContent: "" };
  const dialog = { classList: { contains: () => true } };
  const body = { innerHTML: "" };
  const nodes = { "#initialSyncChip": chip, "#initialSyncChipText": chipText, "#initialSyncDialog": dialog, "#initialSyncDialogBody": body };
  state.token = "ui-test";
  document.querySelector = selector => nodes[selector] || null;
  try {
    renderInitialSync({ status: "waiting_quota", remaining: 7, destinations: [{ status: "waiting_quota", nextRunAt: "2026-10-25T10:30:00Z" }] });
    assert.equal(chip.classList.hidden, false);
    assert.match(chipText.textContent, /waiting for quota/);
    assert.match(chipText.textContent, /resumes/);
    assert.match(chip["aria-label"], /Next resume/);
  } finally {
    state.token = previousToken;
    document.querySelector = previousQuery;
  }
});

test("Settings waiting copy includes the start estimate and quota days", () => {
  const view = fullSyncView("simkl", {
    baselineComplete: true,
    fullSync: { status: "waiting_quota", runId: "r1", total: 600, done: 100, nextRunAt: "2026-10-25T10:30:00Z", pacing: pacing({ totalRequests: 60, estimatedDays: 3 }) },
  });
  assert.match(view.text, /500 of 600 items left/);
  assert.match(view.text, /Estimated at start: 60 requests including verification, about 3 quota days/);
  const unknown = fullSyncView("simkl", { baselineComplete: true, fullSync: { status: "waiting_quota", runId: "r1", pacing: pacing({ quotaKnown: false, protectedQuota: null, totalRequests: 22 }) } });
  assert.doesNotMatch(unknown.text, /Estimated at start/);
});

test("onboarding pacing pluralises watches and a cancelled destination drops the resume line", () => {
  const waiting = initialSyncDialogMarkup({ status: "waiting_quota", remaining: 1, total: 3, destinations: [
    { provider: "simkl", label: "Simkl", status: "waiting_quota", remaining: 3, total: 3, nextRunAt: "2026-10-25T10:30:00Z", pacing: pacing({ pacingRequired: true }) },
  ], items: [] });
  assert.match(waiting, /3 missing watches selected for sending/);
  assert.doesNotMatch(waiting, /watchs/);
  const cancelled = initialSyncDialogMarkup({ status: "partial", remaining: 3, total: 3, destinations: [
    { provider: "simkl", label: "Simkl", status: "cancelled", remaining: 3, total: 3, nextRunAt: null, pacing: pacing({ pacingRequired: true }) },
  ], items: [{ title: "Item", status: "cancelled", destination: "Simkl" }] });
  assert.match(cancelled, />Cancelled</);
  assert.doesNotMatch(cancelled, /Status unavailable|Waiting for quota|Next resume/);
});
