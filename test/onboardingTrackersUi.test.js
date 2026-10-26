import test from "node:test";
import assert from "node:assert/strict";
import { createOnboardingTrackers } from "../public/modules/onboarding-trackers.js";

function fixture(trackers = []) {
  const requests = [];
  const errors = [];
  const status = { trackers, onboarding: { backgroundImports: { trackers: {} } } };
  const ui = createOnboardingTrackers({
    getStatus: () => status,
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return {}; },
    renderSetupPage() {}, loadSetupStatus: async () => {}, setMessage: (message) => errors.push(message),
  });
  return { ui, status, requests, errors };
}

test("onboarding tracker grid renders only registry status providers and escapes account names", () => {
  const { ui } = fixture([{ provider: "trakt", label: "Trakt", connected: true, username: '<script>bad</script>' }]);
  const html = ui.render();
  assert.match(html, /Connect any watch trackers you use, or skip this step/);
  // Connected cards do not echo the account name in this step; raw markup must never appear.
  assert.doesNotMatch(html, /Simkl|<script>|bad<\/script>/);
  assert.match(fixture().ui.render(), /No watch trackers are currently available/);
});

test("tracker import choices remain independent and selected imports start together", async () => {
  const { ui, requests } = fixture([
    { provider: "trakt", label: "Trakt", connected: true },
    { provider: "simkl", label: "Simkl", connected: true },
    { provider: "future", label: "Future", connected: false },
  ]);
  ui.setImportChoice("simkl", false);
  assert.equal(await ui.startImports(), true);
  assert.deepEqual(requests.map((entry) => entry.body), [
    { target: "trakt", action: "start" }, { target: "simkl", action: "cancel" },
  ]);
});

test("returning to tracker setup preserves an existing import and can cancel it", async () => {
  const { ui, status, requests } = fixture([{ provider: "trakt", label: "Trakt", connected: true }]);
  status.onboarding.backgroundImports.trackers.trakt = { enabled: true, status: "importing", itemCount: 12 };
  assert.match(ui.render(), /12 items so far/);
  assert.equal(await ui.startImports(), true);
  assert.equal(requests.length, 0);
  ui.setImportChoice("trakt", false);
  assert.equal(await ui.startImports(), true);
  assert.deepEqual(requests[0].body, { target: "trakt", action: "cancel" });
});

test("failed import submission prevents continuing past the tracker step", async () => {
  const errors = [];
  const ui = createOnboardingTrackers({
    getStatus: () => ({ trackers: [{ provider: "trakt", connected: true }], onboarding: { backgroundImports: { trackers: {} } } }),
    api: async () => { throw new Error("Import unavailable"); },
    renderSetupPage() {}, loadSetupStatus: async () => {}, setMessage: (message) => errors.push(message),
  });
  assert.equal(await ui.startImports(), false);
  assert.deepEqual(errors, ["Import unavailable"]);
});

test("selected tracker import starts through the normal lifecycle without preview approval", async () => {
  const requests = [];
  const status = { trackers: [{ provider: "trakt", label: "Trakt", connected: true }], onboarding: { backgroundImports: { trackers: {} } } };
  let statusRefreshes = 0;
  const ui = createOnboardingTrackers({
    getStatus: () => status,
    api: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { started: true, status: "importing" };
    },
    renderSetupPage() {},
    loadSetupStatus: async () => {
      statusRefreshes += 1;
      status.onboarding.backgroundImports.trackers.trakt = { enabled: true, status: "importing", itemCount: 0 };
    },
    setMessage() {},
  });
  assert.equal(await ui.startImports(), true);
  assert.deepEqual(requests, [{ url: "/api/setup/import", body: { target: "trakt", action: "start" } }]);
  assert.equal(statusRefreshes, 1);
  assert.match(ui.render(), /Importing/);
});

test("zero-item tracker imports allow onboarding to continue", async () => {
  const ui = createOnboardingTrackers({
    getStatus: () => ({ trackers: [{ provider: "trakt", label: "Trakt", connected: true }], onboarding: { backgroundImports: { trackers: {} } } }),
    api: async () => ({ started: false, code: "NOTHING_TO_IMPORT" }),
    renderSetupPage() {}, loadSetupStatus: async () => {}, setMessage() {},
  });
  assert.equal(await ui.startImports(), true);
});

test("parallel authorization flows retain provider identity across transient failure and completion", async (t) => {
  t.mock.method(globalThis, "setTimeout", () => 1);
  t.mock.method(globalThis, "clearTimeout", () => {});
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => ({ value: "simkl-client" }) };
  t.after(() => { globalThis.document = previousDocument; });
  const requests = [];
  const errors = [];
  let failTrakt = true;
  const ui = createOnboardingTrackers({
    getStatus: () => ({ trackers: [
      { provider: "trakt", label: "Trakt" }, { provider: "simkl", label: "Simkl" },
    ] }),
    api: async (url, options) => {
      requests.push({ url, body: options?.body && JSON.parse(options.body) });
      if (url.endsWith("/start")) {
        const provider = url.includes("/simkl/") ? "simkl" : "trakt";
        return { flowId: `${provider}-flow`, verificationUrl: `https://${provider}.example/activate`, userCode: `${provider}-code`, expiresAt: Date.now() + 60000 };
      }
      if (url.includes("/trakt/") && failTrakt) { failTrakt = false; throw new Error("Temporary network error"); }
      return { status: "completed" };
    },
    renderSetupPage() {}, loadSetupStatus: async () => {}, setMessage: (message) => errors.push(message),
  });
  await Promise.all([ui.connect("trakt"), ui.connect("simkl")]);
  assert.match(ui.render(), /trakt-code/);
  assert.match(ui.render(), /simkl-code/);
  // The Simkl Client ID is bundled server-side; the browser never sends one.
  assert.equal("clientId" in (requests.find((entry) => entry.url.includes("/simkl/start")).body || {}), false);
  await ui.checkFlows();
  assert.match(ui.render(), /trakt-code/);
  assert.doesNotMatch(ui.render(), /simkl-code/);
  await ui.checkFlows();
  assert.doesNotMatch(ui.render(), /trakt-code/);
  assert.deepEqual(errors, []);
  assert.ok(requests.some((entry) => entry.url.endsWith("/simkl/simkl-flow/status")));
  assert.ok(requests.some((entry) => entry.url.endsWith("/trakt/trakt-flow/status")));
});

test("authorization polling honors retryAfter and clears a terminal flow", async (t) => {
  const delays = [];
  t.mock.method(globalThis, "setTimeout", (_callback, delay) => { delays.push(delay); return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const previousDocument = globalThis.document;
  globalThis.document = { querySelector: () => null };
  t.after(() => { globalThis.document = previousDocument; });
  let checks = 0;
  const errors = [];
  const ui = createOnboardingTrackers({
    getStatus: () => ({ trackers: [{ provider: "trakt", label: "Trakt" }] }),
    api: async (url) => {
      if (url.endsWith("/start")) return { flowId: "flow", verificationUrl: "https://trakt.example/activate", userCode: "test-code", intervalSeconds: 5, expiresAt: Date.now() + 60000 };
      return ++checks === 1 ? { status: "pending", retryAfter: 11 } : { status: "denied" };
    },
    renderSetupPage() {}, loadSetupStatus: async () => {}, setMessage: (message) => errors.push(message),
  });
  await ui.connect("trakt");
  await ui.checkFlows();
  assert.equal(delays.at(-1), 11000);
  assert.match(ui.render(), /test-code/);
  await ui.checkFlows();
  assert.doesNotMatch(ui.render(), /test-code/);
  assert.match(errors[0], /Trakt authorization expired or was denied/);
  await ui.checkFlows();
  assert.equal(checks, 2);
});
