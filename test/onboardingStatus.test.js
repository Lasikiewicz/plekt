import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-onboarding-status-");

const { db } = await import("../server/src/db.js");
const { AUTH } = await import("../server/src/appConfig.js");
const { handleSetupStatus, handleSetupStep } = await import("../server/src/routes/onboarding.js");
const { saveOnboardingState, getOnboardingState } = await import("../server/src/utils/onboardingStore.js");
const { saveTrackerConnection } = await import("../server/src/utils/trackerConnectionRepo.js");
const { trackerProviderIds, getTrackerAdapter } = await import("../server/src/utils/trackers/registry.js");

async function request(handler, { method = "GET", body = {}, authenticated = true } = {}) {
  const req = {
    method, body, cookies: {},
    headers: authenticated ? { "x-api-key": AUTH.apiKey } : {},
    get(name) { return this.headers[String(name).toLowerCase()] || ""; },
  };
  let status = 200;
  let payload;
  const res = {
    status(value) { status = value; return this; },
    set() { return this; },
    send(value) { payload = JSON.parse(value); return this; },
  };
  await handler(req, res);
  return { status, payload };
}

beforeEach(() => {
  db.prepare("DELETE FROM settings WHERE id = 'onboarding'").run();
  db.prepare("DELETE FROM tracker_connections").run();
  db.prepare("DELETE FROM tracker_item_state").run();
  saveOnboardingState({ accountClaimed: true, runState: "in_progress", currentStep: "trackers" });
});

test("setup status and step require administrator authentication", async () => {
  assert.equal((await request(handleSetupStatus, { authenticated: false })).status, 401);
  assert.equal((await request(handleSetupStep, { method: "POST", authenticated: false, body: { trackersSkipped: true } })).status, 401);
  assert.equal(getOnboardingState().acknowledgements.trackersSkipped, false);
});

test("setup status lists registry trackers and omits legacy Trakt singleton fields", async () => {
  // A connected Simkl account is a registered, sync-capable tracker.
  saveTrackerConnection({ provider: "simkl", remoteUserId: "auth-only", remoteUsername: "Test", accessToken: "test-token", refreshToken: "test-refresh" });
  const { status, payload } = await request(handleSetupStatus);
  assert.equal(status, 200);
  assert.deepEqual(payload.trackers.map(({ provider }) => provider), trackerProviderIds());
  assert.deepEqual(payload.trackers.map(({ label }) => label), trackerProviderIds().map((provider) => getTrackerAdapter(provider).label));
  assert.equal(payload.trackers.some(({ provider }) => provider === "simkl"), true);
  assert.equal("trakt" in payload, false);
  assert.equal("trakt" in payload.onboarding.backgroundImports, false);
  assert.equal("traktSkipped" in payload.onboarding.acknowledgements, false);
  assert.deepEqual(Object.keys(payload.onboarding.backgroundImports.trackers), trackerProviderIds());
});

test("setup status refreshes importing tracker counts from only that provider's saved items", async () => {
  saveOnboardingState({ backgroundImports: { servers: {}, trackers: { trakt: { enabled: true, status: "importing", itemCount: 999 } } } });
  const insert = db.prepare("INSERT INTO tracker_item_state (provider, media_key, media_json, last_seen_at) VALUES (?, ?, '{}', ?)");
  insert.run("trakt", "movie:1", Date.now());
  insert.run("simkl", "movie:2", Date.now());
  assert.equal((await request(handleSetupStatus)).payload.onboarding.backgroundImports.trackers.trakt.itemCount, 1);
  insert.run("trakt", "movie:3", Date.now());
  assert.equal((await request(handleSetupStatus)).payload.onboarding.backgroundImports.trackers.trakt.itemCount, 2);
  assert.equal(getOnboardingState().backgroundImports.trackers.trakt.itemCount, 999);
  saveOnboardingState({ backgroundImports: { servers: {}, trackers: { trakt: { enabled: true, status: "complete", itemCount: 17 } } } });
  assert.equal((await request(handleSetupStatus)).payload.onboarding.backgroundImports.trackers.trakt.itemCount, 17);
});

test("tracker skip choice persists through step posts and drives the generic checklist reminder", async () => {
  const skipped = await request(handleSetupStep, { method: "POST", body: { currentStep: "review", trackersSkipped: true } });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.payload.onboarding.acknowledgements.trackersSkipped, true);
  let payload = (await request(handleSetupStatus)).payload;
  assert.equal(payload.onboarding.currentStep, "review");
  assert.equal(payload.onboarding.acknowledgements.trackersSkipped, true);
  assert.deepEqual(payload.checklist.find(({ id }) => id === "connect_tracker"), { id: "connect_tracker", label: "Connect a watch tracker", href: "/settings/import" });
  assert.equal(payload.checklist.some(({ id }) => id === "connect_trakt"), false);

  await request(handleSetupStep, { method: "POST", body: { trackersSkipped: false } });
  payload = (await request(handleSetupStatus)).payload;
  assert.equal(payload.onboarding.acknowledgements.trackersSkipped, false);
  assert.equal(payload.checklist.some(({ id }) => id === "connect_tracker"), false);
});

test("a connected registered tracker clears the checklist reminder even after skipping", async () => {
  saveOnboardingState({ currentStep: "review", acknowledgements: { trackersSkipped: true, webhooks: {} } });
  saveTrackerConnection({ provider: "trakt", remoteUserId: "connected-user", accessToken: "test-token", refreshToken: "test-refresh", baselineComplete: true });
  const { payload } = await request(handleSetupStatus);
  assert.equal(payload.trackers.find(({ provider }) => provider === "trakt").connected, true);
  assert.equal(payload.trackers.find(({ provider }) => provider === "trakt").baselineComplete, true);
  assert.equal(payload.checklist.some(({ id }) => id === "connect_tracker"), false);
});

test("setup status exposes Seerr configuration for the dedicated wizard step", async () => {
  const { payload } = await request(handleSetupStatus);
  assert.equal(payload.seerr.configured, false);
  assert.deepEqual(payload.checklist.find(({ id }) => id === "configure_seerr"), {
    id: "configure_seerr",
    label: "Configure Seerr",
    href: "/settings/seerr",
  });
});
