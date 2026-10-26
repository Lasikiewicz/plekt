import { traktAdapter } from "./trakt.js";
import { simklAdapter } from "./simkl.js";
import { executeTrackerOperation } from "./contract.js";

// Inventory only: this registry does not read connections or create work.
// Built on first use: simkl.js reaches this module through trackerWriteIntents.js,
// so its adapter binding is not initialised yet while this module evaluates.
let inventory = null;
const adapters = {
  get map() { return (inventory ||= new Map([[traktAdapter.id, traktAdapter], [simklAdapter.id, simklAdapter]])); },
  has: (id) => adapters.map.has(id),
  get: (id) => adapters.map.get(id),
  keys: () => adapters.map.keys(),
  values: () => adapters.map.values(),
};

export function isTrackerProvider(provider) {
  return adapters.has(String(provider || "").trim().toLowerCase());
}

export function trackerProviderForSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return [...adapters.values()].find((adapter) => adapter.sources.includes(normalized) || adapter.ownsSource?.(normalized))?.id || "";
}

export function trackerProviderIds() {
  return [...adapters.keys()];
}

export function trackerRatingProviderIds() {
  return [...adapters.values()].filter((adapter) => adapter.capabilities.ratingSnapshot?.supported).map((adapter) => adapter.id);
}

export function trackerImportSource(provider) {
  const adapter = getTrackerAdapter(provider);
  const source = adapter.sources.find((value) => value === `${adapter.id}_import`);
  if (!source) throw new Error(`Tracker has no history import source: ${provider}`);
  return source;
}

export function assertTrackerEnabled(provider) {
  const adapter = getTrackerAdapter(provider);
  return assertTrackerSafetyGate(adapter);
}

// Only the registered adapter object is active. A look-alike or unregistered
// adapter stays fenced; unsupported operations stay disabled per capability.
export function assertTrackerSafetyGate(adapter) {
  if (!adapter || adapters.get(adapter.id) !== adapter) throw Object.assign(new Error("Additional trackers require the Phase 1c/1d safety gates"), { code: "TRACKER_SAFETY_GATE" });
  return adapter;
}

// Scheduled polling is opt-in per adapter: Simkl only reads on user actions
// and media-server events.
export function trackerSupportsTrigger(provider, trigger) {
  return Boolean(adapters.get(provider)?.capabilities.watchedSnapshot?.triggers?.includes(trigger));
}

export function getTrackerAdapter(provider) {
  const adapter = adapters.get(provider);
  if (!adapter) throw Object.assign(new Error(`Unsupported tracker: ${provider}`), { code: "TRACKER_UNSUPPORTED_PROVIDER" });
  return adapter;
}

export function getTrackerProtocolAdapter(provider) {
  return getTrackerAdapter(provider);
}

export function listTrackerCapabilities() {
  return [...adapters.values()].map(({ id, sources, capabilities }) => ({ id, sources, capabilities }));
}

export function runTrackerOperation(provider, operation, context, ...args) {
  return executeTrackerOperation(getTrackerAdapter(provider), operation, context, ...args);
}
