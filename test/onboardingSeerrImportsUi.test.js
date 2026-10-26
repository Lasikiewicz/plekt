import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { createOnboardingSections } = await import("../public/modules/onboarding-sections.js");

function fixture(status = {}) {
  const base = {
    trackers: [],
    servers: [],
    metadata: { tmdbConfigured: false, builtInAvailable: { tvdb: false, fanart: false } },
    seerr: { configured: false },
    onboarding: { acknowledgements: { webhooks: {} }, backgroundImports: { servers: {}, trackers: {} } },
    options: {},
    ...status,
  };
  return createOnboardingSections({
    getStatus: () => base,
    getBackupData: () => null,
    MEDIA_SERVERS: ["plex", "emby", "jellyfin"],
    WATCH_IMPORT_MODES: [],
    isPreClaimSetup: () => false,
    serverImportPending: () => false,
    watchlistSyncPending: () => false,
    seasonSourcePending: () => "tmdb",
    setupWatchImportMode: () => "require_review",
    setupFastLocalPacing: () => false,
    setupUpNextSync: () => true,
    setupPlexHistoricalSync: () => true,
    currentStep: () => "imports",
    api: async () => ({}),
    setMessage() {},
    loadBackupSetupData: async () => {},
  });
}

test("Seerr setup step renders connect control and configured badge", () => {
  assert.match(fixture().renderSeerr(), /setup-seerr-grid/);
  assert.match(fixture().renderSeerr(), /data-setup-connect="seerr"/);
  assert.match(fixture().renderSeerr(), /Connect Seerr/);
  assert.match(fixture({ seerr: { configured: true } }).renderSeerr(), /Configured/);
  assert.match(fixture({ seerr: { configured: true } }).renderSeerr(), />Edit</);
});

test("media server toggles use the shared choice-box layout", () => {
  const html = fixture({
    servers: [
      { provider: "plex", tested: true, connected: true, serverName: "Home" },
      { provider: "emby", tested: false, connected: false },
      { provider: "jellyfin", tested: false, connected: false },
    ],
  }).renderServers();
  assert.match(html, /settings-choice-grid setup-server-toggles/);
  assert.match(html, /data-setup-watchlist-toggle/);
  assert.match(html, /data-setup-import-toggle="plex"/);
});

test("Import & sync hosts One Time Imports for Tautulli and Netflix", () => {
  const html = fixture().renderImports();
  assert.match(html, /setupOneTimeImportsHost/);
  assert.match(html, /One Time Imports/);
  assert.match(html, /Tautulli or Netflix/);
  assert.match(html, /Continue starts initial sync after your selected imports finish/);
});

test("review summarizes Seerr when configured or skipped", () => {
  assert.match(fixture().renderReview(false), /Seerr/);
  assert.match(fixture().renderReview(false), /Not configured/);
  assert.match(fixture({ seerr: { configured: true } }).renderReview(true), /Media requests from detail pages/);
});
