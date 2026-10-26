import { db } from "../db.js";

const SETTINGS_ID = "onboarding";

// Version 2 keys tracker imports by provider (backgroundImports.trackers) and
// records one "skipped the tracker step" flag; version 1 had a Trakt singleton.
export const CURRENT_ONBOARDING_VERSION = 2;

export const DEFAULT_TRACKER_IMPORT = Object.freeze({
  enabled: null,
  status: "not_started",
  startedAt: null,
  completedAt: null,
  itemCount: null,
  error: null,
});

const DEFAULT_STATE = {
  version: 0,
  accountClaimed: false,
  runState: "not_started",
  initialSyncEligible: false,
  startedAt: null,
  completedAt: null,
  currentStep: "overview",
  acknowledgements: {
    webhooks: {},
    trackersSkipped: false,
  },
  backgroundImports: {
    servers: {},
    trackers: {},
  },
  pushSync: {
    status: "not_started",
    startedAt: null,
    completedAt: null,
  },
  checklistDismissedAt: null,
  ctaDismissedAt: null,
};

const selectStmt = db.prepare("SELECT data FROM settings WHERE id = ?");
const upsertStmt = db.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

const INTERRUPTED_IMPORT_MESSAGE = "Import interrupted by a server restart; it will not restart automatically.";

function readRaw() {
  const row = selectStmt.get(SETTINGS_ID);
  if (!row?.data) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function writeRaw(state) {
  upsertStmt.run(SETTINGS_ID, JSON.stringify(state), Date.now());
}

// Folds version 1 keys forward so an in-progress first run survives the
// upgrade: the backgroundImports.trakt singleton becomes trackers.trakt, the
// traktSkipped flag becomes trackersSkipped, and a saved "trakt" step becomes
// the "trackers" step.
function mergeState(stored) {
  const { trakt: legacyTrakt, ...storedImports } = stored?.backgroundImports || {};
  const trackers = { ...(storedImports.trackers || {}) };
  if (legacyTrakt && typeof legacyTrakt === "object" && !trackers.trakt) trackers.trakt = legacyTrakt;
  const { traktSkipped, ...storedAcknowledgements } = stored?.acknowledgements || {};
  const acknowledgements = { ...DEFAULT_STATE.acknowledgements, ...storedAcknowledgements };
  if (traktSkipped === true && storedAcknowledgements.trackersSkipped === undefined) acknowledgements.trackersSkipped = true;
  const merged = {
    ...DEFAULT_STATE,
    ...stored,
    acknowledgements,
    backgroundImports: {
      ...storedImports,
      servers: { ...(storedImports.servers || {}) },
      trackers,
    },
    pushSync: { ...DEFAULT_STATE.pushSync, ...(stored?.pushSync || {}) },
  };
  if(stored?.initialSyncEligible===undefined)merged.initialSyncEligible=stored?.accountClaimed===true&&stored?.runState==='in_progress'&&!stored?.completedAt&&!stored?.version;
  if (merged.currentStep === "trakt") merged.currentStep = "trackers";
  return merged;
}

export function trackerImportState(state, provider) {
  return { ...DEFAULT_TRACKER_IMPORT, ...(state?.backgroundImports?.trackers?.[provider] || {}) };
}

export function getOnboardingState() {
  return mergeState(readRaw());
}

export function saveOnboardingState(patch = {}) {
  const next = mergeState({ ...readRaw(), ...patch });
  writeRaw(next);
  return next;
}

// Background imports are deliberately in-process operations rather than
// durable jobs. Their progress is persisted for the UI, but the operation
// itself cannot survive a process restart safely. Clear any stale importing
// markers at web-process startup instead of leaving the dashboard reporting
// work that no longer exists or allowing onboarding to wait on it forever.
export function recoverInterruptedBackgroundImports() {
  const state = getOnboardingState();
  const recoveredAt = Date.now();
  const recovered = [];
  const servers = { ...state.backgroundImports.servers };
  const trackers = { ...state.backgroundImports.trackers };

  for (const group of [servers, trackers]) {
    for (const [provider, entry] of Object.entries(group)) {
      if (entry?.status !== "importing") continue;
      group[provider] = {
        ...entry,
        enabled: false,
        status: "cancelled",
        completedAt: recoveredAt,
        error: INTERRUPTED_IMPORT_MESSAGE,
      };
      recovered.push(provider);
    }
  }

  if (!recovered.length) return { state, recovered };
  return {
    state: saveOnboardingState({
      backgroundImports: { ...state.backgroundImports, servers, trackers },
    }),
    recovered,
  };
}

export function isAccountClaimed() {
  return getOnboardingState().accountClaimed === true;
}

// Atomically claims the account inside an IMMEDIATE transaction so concurrent
// claim requests can't both win: the loser observes accountClaimed already
// true within the same transaction and returns false without writing.
export function claimAccount() {
  const txn = db.transaction(() => {
    const state = mergeState(readRaw());
    if (state.accountClaimed) return false;
    const next = {
      ...state,
      accountClaimed: true,
      runState: "in_progress",
      initialSyncEligible: true,
      startedAt: state.startedAt || Date.now(),
      currentStep: "trackers",
    };
    writeRaw(next);
    return true;
  });
  return txn.immediate();
}

// Marks onboarding as already-complete for an upgraded/pre-existing install
// so it never sees the guided setup flow uninvited. Idempotent.
export function markPristineDetectionComplete() {
  const state = getOnboardingState();
  if (state.accountClaimed && state.runState === "completed") return state;
  return saveOnboardingState({
    accountClaimed: true,
    runState: "completed",
    version: CURRENT_ONBOARDING_VERSION,
    completedAt: state.completedAt || Date.now(),
  });
}

// Distinguishes a genuinely pristine install from an existing/upgraded one so
// upgraded installs never see the account-claim or guided-setup screens.
// Marks onboarding complete (and the account claimed) the first time any of
// these durable signals is found: in-app managed credentials, a media-server
// connection, watch history, or a configured metadata key beyond env
// defaults. Idempotent - safe to call on every boot.
export function detectAndMarkPristineInstall({ authManagedInApp = false } = {}) {
  const state = getOnboardingState();
  if (state.accountClaimed) return state;
  if (authManagedInApp) return markPristineDetectionComplete();

  const hasMediaConnection = Boolean(db.prepare("SELECT 1 FROM media_connections LIMIT 1").get());
  const hasWatchHistory = Boolean(db.prepare("SELECT 1 FROM watch_history LIMIT 1").get());

  let hasCustomMetadataKeys = false;
  const mediaConfigRow = db.prepare("SELECT data FROM settings WHERE id = 'mediaConfig'").get();
  if (mediaConfigRow?.data) {
    try {
      const stored = JSON.parse(mediaConfigRow.data);
      hasCustomMetadataKeys = Boolean(
        stored?.tmdb?.apiKey || stored?.fanart?.apiKey || stored?.tvdb?.apiKey || stored?.omdb?.apiKey,
      );
    } catch {
      // Malformed row - ignore rather than misclassify an install as pristine.
    }
  }

  if (hasMediaConnection || hasWatchHistory || hasCustomMetadataKeys) {
    return markPristineDetectionComplete();
  }
  return state;
}

export function completeOnboarding(patch = {}) {
  return saveOnboardingState({
    runState: "completed",
    initialSyncEligible: false,
    completedAt: Date.now(),
    version: CURRENT_ONBOARDING_VERSION,
    ...patch,
  });
}

export function restartOnboarding() {
  return saveOnboardingState({
    runState: "in_progress",
    currentStep: "overview",
    acknowledgements: { webhooks: {}, trackersSkipped: false },
    checklistDismissedAt: null,
    ctaDismissedAt: null,
  });
}
