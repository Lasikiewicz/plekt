import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDataDir } from "./helpers.js";

// db.js opens its SQLite file at import time, and several of the modules below
// pull it in transitively, so point DATA_DIR at a throwaway directory before
// any of them load.
makeTempDataDir("plembfin-historical-sync-policy-test-");

const {
  TARGET_DECISIONS,
  canonicalPlayedDateIso,
  formatProviderOutcomeSummary,
  isHistoricalWatchIntent,
  isRetryableTargetDecision,
  plexHistoricalWatchedAllowed,
  resolveWatchSyncIntent,
  summarizeProviderOutcomes,
  watchTargetPolicy,
} = await import("../server/src/utils/watchSyncPolicy.js");
const { applyTuningConfig, normalizePlexHistoricalWatchedSync, resetTuningForTests } = await import("../server/src/utils/tuning.js");
const { mergeEnvDefaults, normalizeStoredConfig, publicMediaConfig, validateConfig } = await import("../server/src/utils/configStore.js");
const { embyDatePlayedParam, markEmbyPlayed } = await import("../server/src/utils/embyClient.js");
const { markJellyfinPlayed } = await import("../server/src/utils/jellyfinClient.js");
const { markPlexPlayed } = await import("../server/src/utils/plexClient.js");
const { buildTautulliTelemetry, tautulliTargetPlan } = await import("../server/src/utils/tautulliImport.js");
const { selectTraktWatchedTransitions } = await import("../server/src/utils/trackerSync.js");
const { getTargetsForSource, syncMediaPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
const { manualWatchMediaFromRecord } = await import("../server/src/routes/sync.js");
const { db } = await import("../server/src/db.js");

test.after(() => {
  resetTuningForTests();
  db.close();
});

function withPlexHistoricalSync(enabled, run) {
  applyTuningConfig({ plexHistoricalWatchedSync: enabled });
  try {
    return run();
  } finally {
    resetTuningForTests();
  }
}

async function withPlexHistoricalSyncAsync(enabled, run) {
  applyTuningConfig({ plexHistoricalWatchedSync: enabled });
  try {
    return await run();
  } finally {
    resetTuningForTests();
  }
}

// ── Intent resolution ──────────────────────────────────────────────────────

test("sync intent is explicit and never inferred from how old the date looks", () => {
  // A live watch of something first released years ago is still a live watch.
  assert.equal(resolveWatchSyncIntent({ source: "emby", watched_at: "2011-04-17T20:00:00.000Z" }), "live");
  // An import can carry today's date and is still an import.
  assert.equal(resolveWatchSyncIntent({ source: "tautulli_import", watched_at: new Date().toISOString() }), "import");
  assert.equal(resolveWatchSyncIntent({ source: "netflix_import", watched_at: new Date().toISOString() }), "import");
  assert.equal(resolveWatchSyncIntent({ source: "trakt_import" }), "import");
  assert.equal(resolveWatchSyncIntent({ source: "emby_initial_sync" }), "import");
  assert.equal(resolveWatchSyncIntent({ source: "restore_replay" }), "restore");
  assert.equal(resolveWatchSyncIntent({ source: "manual" }), "manual");
  // An explicit field always beats the source table.
  assert.equal(resolveWatchSyncIntent({ source: "manual", syncIntent: "historical" }), "historical");
  assert.equal(resolveWatchSyncIntent({ source: "trakt", sync_intent: "import" }), "import");
  assert.equal(resolveWatchSyncIntent({ source: "plex", syncIntent: "nonsense" }), "live");

  assert.equal(isHistoricalWatchIntent("import"), true);
  assert.equal(isHistoricalWatchIntent("restore"), true);
  assert.equal(isHistoricalWatchIntent("historical"), true);
  assert.equal(isHistoricalWatchIntent("manual"), false);
  assert.equal(isHistoricalWatchIntent("live"), false);
});

test("Netflix history imports target all configured media servers", () => {
  assert.deepEqual(getTargetsForSource("netflix_import", {}), ["plex", "emby", "jellyfin"]);
});

// ── Provider matrix ────────────────────────────────────────────────────────

test("historical Plex watched intent is sent when the setting is on", () => {
  withPlexHistoricalSync(true, () => {
    for (const intent of ["live", "manual", "historical", "import", "restore"]) {
      assert.equal(watchTargetPolicy({ target: "plex", intent }).decision, TARGET_DECISIONS.SEND, intent);
    }
  });
});

test("historical Plex watched intent is classified as skipped_by_policy when the setting is off", () => {
  withPlexHistoricalSync(false, () => {
    for (const intent of ["historical", "import", "restore"]) {
      const policy = watchTargetPolicy({ target: "plex", intent });
      assert.equal(policy.decision, TARGET_DECISIONS.SKIPPED_BY_POLICY, intent);
      assert.equal(policy.retryable, false);
      assert.match(policy.detail, /Skipped by policy/);
    }
  });
});

test("live and mark-watched-now Plex intents are still sent when the setting is off", () => {
  withPlexHistoricalSync(false, () => {
    assert.equal(watchTargetPolicy({ target: "plex", intent: "live" }).decision, TARGET_DECISIONS.SEND);
    assert.equal(watchTargetPolicy({ target: "plex", intent: "manual" }).decision, TARGET_DECISIONS.SEND);
  });
});

test("the Plex policy never suppresses Emby, Jellyfin, or an unwatch", () => {
  withPlexHistoricalSync(false, () => {
    for (const target of ["emby", "jellyfin", "trakt"]) {
      assert.equal(watchTargetPolicy({ target, intent: "import" }).decision, TARGET_DECISIONS.SEND, target);
    }
    // Unwatch is a state change, not a historical backfill.
    assert.equal(watchTargetPolicy({ target: "plex", intent: "import", state: "unwatched" }).decision, TARGET_DECISIONS.SEND);
  });
});

test("policy skips and unsupported outcomes are not retryable; failures are", () => {
  assert.equal(isRetryableTargetDecision(TARGET_DECISIONS.SKIPPED_BY_POLICY), false);
  assert.equal(isRetryableTargetDecision(TARGET_DECISIONS.UNSUPPORTED), false);
  assert.equal(isRetryableTargetDecision(TARGET_DECISIONS.ALREADY_MATCHING), false);
  assert.equal(isRetryableTargetDecision(TARGET_DECISIONS.FAILED), true);
});

// ── Setting storage ────────────────────────────────────────────────────────

test("the Plex historical setting defaults to on and round-trips through the config store", () => {
  assert.equal(normalizePlexHistoricalWatchedSync(""), null);
  assert.equal(normalizePlexHistoricalWatchedSync("false"), false);
  assert.equal(normalizePlexHistoricalWatchedSync(true), true);
  assert.equal(normalizePlexHistoricalWatchedSync("maybe"), null);

  const untouched = publicMediaConfig(normalizeStoredConfig({}));
  assert.equal(untouched.tuning.plexHistoricalWatchedSync.value, true);
  assert.equal(untouched.tuning.plexHistoricalWatchedSync.default, true);
  assert.equal(untouched.tuning.plexHistoricalWatchedSync.overridden, false);

  const disabled = publicMediaConfig(normalizeStoredConfig({ tuning: { plexHistoricalWatchedSync: false } }));
  assert.equal(disabled.tuning.plexHistoricalWatchedSync.value, false);
  assert.equal(disabled.tuning.plexHistoricalWatchedSync.overridden, true);

  // Existing installations keep the recommended behaviour without a migration.
  assert.equal(mergeEnvDefaults({ tuning: { watchedThresholdPercent: 95 } }).tuning.plexHistoricalWatchedSync, null);
  assert.equal(validateConfig({ tuning: { plexHistoricalWatchedSync: false } }).length, 0);
  assert.ok(validateConfig({ tuning: { plexHistoricalWatchedSync: "sometimes" } })
    .some((error) => error.includes("plexHistoricalWatchedSync")));
});

// ── Canonical date ─────────────────────────────────────────────────────────

test("the canonical play date is read from the record, not substituted with now", () => {
  assert.equal(canonicalPlayedDateIso({ watched_at: "2024-03-02T21:15:00.000Z" }), "2024-03-02T21:15:00.000Z");
  assert.equal(canonicalPlayedDateIso({ playedAt: 1709413200000 }), new Date(1709413200000).toISOString());
  assert.equal(canonicalPlayedDateIso({}), "");
  assert.equal(canonicalPlayedDateIso({ watched_at: "" }), "");
  assert.equal(canonicalPlayedDateIso({ watched_at: "not a date" }), "");
  assert.equal(embyDatePlayedParam({ watched_at: "2024-03-02T21:15:00.000Z" }), "20240302211500");
  assert.equal(embyDatePlayedParam({}), "");
});

// ── Adapter behaviour ──────────────────────────────────────────────────────

const embyConfig = { baseUrl: "https://emby.example.test", apiKey: "api-key", userId: "emby-user" };
const jellyfinConfig = { baseUrl: "https://jellyfin.example.test", apiKey: "api-key", userId: "jellyfin-user" };
const plexConfig = { baseUrl: "https://plex.example.test", token: "plex-token" };

function stubFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("Emby mark-played carries the original play date", async (t) => {
  const calls = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.includes("/PlayedItems/")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [{ Id: "emby-item", Type: "Movie", Name: "Example" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await markEmbyPlayed(embyConfig, {
    title: "Example",
    type: "movie",
    ids: { tmdb: "123" },
    watched_at: "2019-08-11T19:30:00.000Z",
    providerItems: { emby: ["emby-item"] },
  });
  assert.equal(result.status, "fulfilled");
  const mark = calls.find((url) => url.pathname.includes("/PlayedItems/"));
  assert.equal(mark.searchParams.get("DatePlayed"), "20190811193000");
});

test("Emby falls back to a plain mark-played when the server rejects DatePlayed", async (t) => {
  const attempts = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/PlayedItems/")) {
      return new Response(JSON.stringify({ Items: [{ Id: "emby-item", Type: "Movie", Name: "Example" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    attempts.push(url.searchParams.get("DatePlayed"));
    return attempts.length === 1 ? new Response(null, { status: 400 }) : new Response(null, { status: 204 });
  });

  const result = await markEmbyPlayed(embyConfig, {
    title: "Example",
    type: "movie",
    ids: { tmdb: "123" },
    watched_at: "2019-08-11T19:30:00.000Z",
    providerItems: { emby: ["emby-item"] },
  });
  assert.equal(result.status, "fulfilled");
  assert.deepEqual(attempts, ["20190811193000", null]);
});

test("Jellyfin mark-played sends datePlayed", async (t) => {
  const calls = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.includes("/PlayedItems/")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ Items: [{ Id: "jellyfin-item", Type: "Movie", Name: "Example" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const result = await markJellyfinPlayed(jellyfinConfig, {
    title: "Example",
    type: "movie",
    ids: { tmdb: "123" },
    watched_at: "2019-08-11T19:30:00.000Z",
    providerItems: { jellyfin: ["jellyfin-item"] },
  });
  assert.equal(result.status, "fulfilled");
  const mark = calls.find((url) => url.pathname.includes("/PlayedItems/"));
  assert.equal(mark.searchParams.get("datePlayed"), "2019-08-11T19:30:00.000Z");
});

test("the Plex adapter refuses a historical watch when the policy is off, and sends a live one", async (t) => {
  const scrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/scrobble")) {
      scrobbles.push(url);
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await withPlexHistoricalSyncAsync(false, async () => {
    assert.equal(plexHistoricalWatchedAllowed({ syncIntent: "import" }), false);
    assert.equal(plexHistoricalWatchedAllowed({ syncIntent: "live" }), true);

    const skipped = await markPlexPlayed(plexConfig, {
      title: "Example",
      type: "movie",
      syncIntent: "import",
      providerItems: { plex: ["42"] },
    });
    assert.equal(skipped.status, "skipped_by_policy");
    assert.equal(scrobbles.length, 0);

    const sent = await markPlexPlayed(plexConfig, {
      title: "Example",
      type: "movie",
      syncIntent: "live",
      providerItems: { plex: ["42"] },
    });
    assert.equal(sent.status, "fulfilled");
    assert.equal(scrobbles.length, 1);
  });
});

test("an already-watched Plex item does not receive a redundant mark-played write", async (t) => {
  const scrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/scrobble")) {
      scrobbles.push(url);
      return new Response("", { status: 200 });
    }
    return new Response(JSON.stringify({
      MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example", viewCount: 1 }] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  await withPlexHistoricalSyncAsync(true, async () => {
    const result = await markPlexPlayed(plexConfig, {
      title: "Example",
      type: "movie",
      syncIntent: "import",
      providerItems: { plex: ["42"] },
    });
    assert.equal(result.status, "already_matching");
    assert.equal(scrobbles.length, 0);
  });
});

// ── Trakt baseline vs import ───────────────────────────────────────────────

test("a Trakt initial snapshot never creates watch transitions, even in legacy import mode", () => {
  const snapshot = [
    { mediaKey: "movie:tmdb:1", media: { title: "One" }, watchedAt: 1_600_000_000_000 },
    { mediaKey: "movie:tmdb:2", media: { title: "Two" }, watchedAt: 1_600_000_100_000 },
  ];
  assert.deepEqual(
    selectTraktWatchedTransitions({ snapshot, previous: [], baseline: false, initialSyncMode: "baseline" }),
    [],
  );
  assert.deepEqual(
    selectTraktWatchedTransitions({ snapshot, previous: [], baseline: false, initialSyncMode: "import" }),
    [],
  );
});

// ── Tautulli target selection composed with the Plex policy ────────────────

test("Tautulli target selection and the Plex policy compose without disabling the other providers", () => {
  withPlexHistoricalSync(false, () => {
    const plan = tautulliTargetPlan(["plex", "emby"], ["plex", "emby", "jellyfin"]);
    assert.deepEqual(plan.map((entry) => [entry.target, entry.decision]), [
      ["plex", TARGET_DECISIONS.SKIPPED_BY_POLICY],
      ["emby", TARGET_DECISIONS.SEND],
      ["jellyfin", "not_selected"],
    ]);

    const telemetry = buildTautulliTelemetry(["plex", "emby"], ["plex", "emby", "jellyfin"]);
    assert.match(telemetry, /Target plex status: skipped - Skipped by policy/);
    assert.match(telemetry, /Target emby status: pending/);
    assert.match(telemetry, /Target jellyfin status: skipped - Not selected/);
    assert.match(telemetry, /Dispatch status: pending/);
  });

  withPlexHistoricalSync(true, () => {
    const plan = tautulliTargetPlan(["plex"], ["plex", "emby", "jellyfin"]);
    assert.equal(plan.find((entry) => entry.target === "plex").decision, TARGET_DECISIONS.SEND);
  });
});

// ── Result reporting ───────────────────────────────────────────────────────

test("provider outcomes distinguish sent, already matching, skipped by policy, unsupported, and failed", () => {
  const targetStates = [
    { target: "plex", status: "success", decision: TARGET_DECISIONS.SENT },
    { target: "plex", status: "success", decision: TARGET_DECISIONS.ALREADY_MATCHING },
    { target: "plex", status: "skipped", decision: TARGET_DECISIONS.SKIPPED_BY_POLICY },
    { target: "plex", status: "skipped", decision: TARGET_DECISIONS.SKIPPED_BY_POLICY },
    { target: "emby", status: "success" },
    { target: "emby", status: "skipped", decision: TARGET_DECISIONS.UNSUPPORTED },
    { target: "jellyfin", status: "error" },
  ];

  assert.deepEqual(summarizeProviderOutcomes(targetStates), [
    { target: "plex", sent: 1, already_matching: 1, skipped_by_policy: 2, unsupported: 0, failed: 0 },
    { target: "emby", sent: 1, already_matching: 0, skipped_by_policy: 0, unsupported: 1, failed: 0 },
    { target: "jellyfin", sent: 0, already_matching: 0, skipped_by_policy: 0, unsupported: 0, failed: 1 },
  ]);

  assert.deepEqual(formatProviderOutcomeSummary(targetStates), [
    "Plex: 1 sent, 1 already matching, 2 skipped by policy",
    "Emby: 1 sent, 1 unsupported",
    "Jellyfin: 1 failed",
  ]);
});

test("the browser merges per-batch provider outcomes and reports a policy skip in plain words", async () => {
  const { mergeProviderOutcomes, providerOutcomeNotice, plexHistoricalSyncEnabled } =
    await import("../public/modules/plex-history-policy.js");

  const merged = mergeProviderOutcomes([
    [{ target: "plex", sent: 1, already_matching: 0, skipped_by_policy: 40, unsupported: 0, failed: 0 }],
    [{ target: "plex", sent: 0, already_matching: 3, skipped_by_policy: 20, unsupported: 0, failed: 0 },
      { target: "emby", sent: 60, already_matching: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 }],
  ]);
  assert.deepEqual(merged, [
    { target: "plex", sent: 1, already_matching: 3, skipped_by_policy: 60, unsupported: 0, failed: 0 },
    { target: "emby", sent: 60, already_matching: 0, skipped_by_policy: 0, unsupported: 0, failed: 0 },
  ]);

  assert.equal(
    providerOutcomeNotice(merged),
    " Plex skipped 60 by the historical sync policy; Plex already matched 3.",
  );
  // Nothing worth saying when every provider simply took the write.
  assert.equal(providerOutcomeNotice([{ target: "emby", sent: 3 }]), "");

  // The browser reads the published { value, ... } shape and defaults to on.
  assert.equal(plexHistoricalSyncEnabled({}), true);
  assert.equal(plexHistoricalSyncEnabled({ tuning: { plexHistoricalWatchedSync: { value: false } } }), false);
  assert.equal(plexHistoricalSyncEnabled({ tuning: { plexHistoricalWatchedSync: { value: true } } }), true);
});

// ── Orchestrator: a policy skip must not short-circuit the whole dispatch ──
//
// Regression. The first implementation of the target filter early-returned as
// soon as the policy emptied the media-server target list, which on a
// Plex-only installation with the setting off meant the function returned
// before reaching includeTrackerDispatch - so Trakt silently stopped receiving
// historical watches, the exact outcome the plan says the Plex setting must
// never cause. Nothing caught it; it was found by reading.
//
// `shouldDefer` is the observable. syncMediaPlaystate calls it once before
// computing targets and again after the dispatch jobs settle, so a second call
// proves execution continued past the early return into the dispatch and
// tracker section rather than bailing out at the target list.

const plexOnlyConfig = {
  plex: { baseUrl: "https://plex.example.test", token: "plex-token" },
  emby: {},
  jellyfin: {},
};

function historicalMovie() {
  return {
    isValid: true,
    source: "manual",
    syncIntent: "historical",
    type: "movie",
    title: "Example",
    watched_at: "2019-08-11T19:30:00.000Z",
    ids: { tmdb: "123" },
    providerItems: { plex: ["42"] },
  };
}

test("a Plex policy skip still falls through to the tracker dispatch instead of returning early", async () => {
  await withPlexHistoricalSyncAsync(false, async () => {
    let deferChecks = 0;
    const summary = await syncMediaPlaystate(historicalMovie(), plexOnlyConfig, null, {
      trackDispatch: false,
      shouldDefer: async () => {
        deferChecks += 1;
        return false;
      },
    });

    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.status, "skipped");
    assert.equal(plex?.decision, TARGET_DECISIONS.SKIPPED_BY_POLICY);
    assert.match(summary.details, /skipped by the historical sync policy/);
    // The wording matters: a deliberate policy skip must never be reported as
    // a missing library item.
    assert.doesNotMatch(summary.details, /no match on/);
    assert.doesNotMatch(summary.details, /No enabled sync destinations/);
    assert.ok(deferChecks > 1, `expected dispatch to continue past the target list, saw ${deferChecks} defer check(s)`);
  });
});

test("with the policy on, the same historical watch is dispatched to Plex", async (t) => {
  const scrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/scrobble")) {
      scrobbles.push(url);
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await withPlexHistoricalSyncAsync(true, async () => {
    const summary = await syncMediaPlaystate(historicalMovie(), plexOnlyConfig, null, { trackDispatch: false });
    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.status, "success");
    assert.equal(plex?.decision, TARGET_DECISIONS.SENT);
    assert.equal(scrobbles.length, 1);
  });
});

test("an unwatch reaches Plex even when historical watched sync is off", async (t) => {
  const { syncMediaUnplayedPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
  const unscrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/unscrobble")) {
      unscrobbles.push(url);
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith("/:/timeline")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  await withPlexHistoricalSyncAsync(false, async () => {
    const summary = await syncMediaUnplayedPlaystate(
      { ...historicalMovie(), syncIntent: "restore" },
      plexOnlyConfig,
      null,
      { trackDispatch: false },
    );
    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.status, "success", summary.details);
    assert.notEqual(plex?.decision, TARGET_DECISIONS.SKIPPED_BY_POLICY);
    // More than one unscrobble is expected and is not this feature's concern:
    // the unwatch path clears resume progress first, and setPlexProgress issues
    // its own unscrobble before writing the new position. All this test cares
    // about is that Plex was written to at all.
    assert.ok(unscrobbles.length >= 1, "expected the unwatch to reach Plex");
  });
});

// ── End-to-end intent plumbing ─────────────────────────────────────────────
//
// The browser decides whether a mark-watched is a current action or a
// backdated one, because the date alone cannot answer it - a user can pick
// today from the calendar. This walks that decision from the request body to
// the value the provider adapters actually see.

test("the manual-watch route carries the browser's intent through to the adapters", () => {
  const backdated = manualWatchMediaFromRecord({
    title: "Example",
    media_type: "movie",
    tmdb_id: "123",
    watched_at: "2019-08-11T19:30:00.000Z",
    sync_intent: "historical",
  });
  assert.equal(backdated.syncIntent, "historical");
  assert.equal(resolveWatchSyncIntent(backdated), "historical");

  // "Now" and an omitted field both mean a current manual action, which no
  // policy gates - including when the chosen date happens to be today.
  const now = manualWatchMediaFromRecord({
    title: "Example",
    media_type: "movie",
    tmdb_id: "123",
    watched_at: new Date().toISOString(),
    sync_intent: "manual",
  });
  assert.equal(resolveWatchSyncIntent(now), "manual");
  assert.equal(resolveWatchSyncIntent(manualWatchMediaFromRecord({ title: "Example", media_type: "movie" })), "manual");

  // A value the browser should never send must not become a historical intent
  // by accident.
  const bogus = manualWatchMediaFromRecord({ title: "Example", media_type: "movie", sync_intent: "whatever" });
  assert.equal(resolveWatchSyncIntent(bogus), "manual");

  withPlexHistoricalSync(false, () => {
    assert.equal(plexHistoricalWatchedAllowed(backdated), false);
    assert.equal(plexHistoricalWatchedAllowed(now), true);
  });
});

test("the adapter sees the same intent the orchestrator routed on", async (t) => {
  const scrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/scrobble")) {
      scrobbles.push(url);
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  // Source alone says "manual", which is not gated; the explicit intent says
  // historical, which is. The adapter must act on the explicit one, or the
  // orchestrator's routing and the adapter's own guard could disagree.
  await withPlexHistoricalSyncAsync(false, async () => {
    const media = manualWatchMediaFromRecord({
      title: "Example",
      media_type: "movie",
      tmdb_id: "123",
      watched_at: "2019-08-11T19:30:00.000Z",
      sync_intent: "historical",
    });
    const result = await markPlexPlayed(plexOnlyConfig.plex, { ...media, isValid: true, type: "movie" });
    assert.equal(result.status, "skipped_by_policy");
    assert.equal(scrobbles.length, 0);
  });
});

// ── "Off means off": no historical watch reaches Plex by any route ──────────
//
// The setting is a standing instruction, not a per-operation hint. Every way of
// projecting a watch Plembfin already holds - Force Sync, an availability
// repair, a webhook reconcile of an older watch - is historical and must be
// suppressed when it is off. Only a watch the user just created still goes.

test("a canonical replay is historical, so Force Sync cannot reach Plex when the policy is off", async () => {
  const { syncCanonicalPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
  await withPlexHistoricalSyncAsync(false, async () => {
    const summary = await syncCanonicalPlaystate(
      { ...historicalMovie(), source: "force_sync", syncIntent: undefined },
      plexOnlyConfig,
      null,
      "watched",
      { trackDispatch: false, includeTrackers: false },
    );
    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.decision, TARGET_DECISIONS.SKIPPED_BY_POLICY, summary.details);
  });
});

test("force_sync resolves to a historical intent rather than a manual one", () => {
  assert.equal(resolveWatchSyncIntent({ source: "force_sync" }), "historical");
  assert.equal(isHistoricalWatchIntent(resolveWatchSyncIntent({ source: "force_sync" })), true);
});

test("a caller restoring genuinely live state keeps its explicit intent", async (t) => {
  const scrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/scrobble")) {
      scrobbles.push(url);
      return new Response(null, { status: 200 });
    }
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const { syncCanonicalPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
  await withPlexHistoricalSyncAsync(false, async () => {
    // The Plex adaptive poller restoring a watch Plex itself just dropped after
    // threshold playback. Defaulting it to historical would leave Plex stuck
    // unwatched after its own glitch.
    const summary = await syncCanonicalPlaystate(
      { ...historicalMovie(), syncIntent: "live" },
      plexOnlyConfig,
      null,
      "watched",
      { trackDispatch: false, includeTrackers: false },
    );
    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.status, "success", summary.details);
    assert.equal(scrobbles.length, 1);
  });
});

test("a canonical unwatch still reaches Plex when the policy is off", async (t) => {
  const unscrobbles = [];
  stubFetch(t, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/:/unscrobble")) {
      unscrobbles.push(url);
      return new Response(null, { status: 200 });
    }
    if (url.pathname.endsWith("/:/progress")) return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [{ ratingKey: "42", type: "movie", title: "Example" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const { syncCanonicalPlaystate } = await import("../server/src/utils/syncOrchestrator.js");
  await withPlexHistoricalSyncAsync(false, async () => {
    const summary = await syncCanonicalPlaystate(historicalMovie(), plexOnlyConfig, null, "unwatched", {
      trackDispatch: false,
      includeTrackers: false,
    });
    const plex = (summary.targetStates || []).find((entry) => entry.target === "plex");
    assert.equal(plex?.status, "success", summary.details);
    assert.ok(unscrobbles.length >= 1);
  });
});
