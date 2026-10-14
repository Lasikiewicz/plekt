// Route-module registry for the deferred frontend graph.
//
// The core graph (auth, state, sync, settings shell, ...)
// is imported statically by app.js. Dashboard and Up Next are route modules;
// everything below is loaded on demand with
// native import(), so a route only downloads the modules it renders.
//
// Each entry lists the other registered modules it imports statically. They
// are loaded (and initialized) first, so a dependency's init callbacks are in
// place before the dependent module can call into it. Keep `deps` in step with
// the modules' own import lines; test/routeModules.test.js checks this.
const ROUTE_MODULES = {
  "app-events": { deps: [], load: () => import("./app-events.js?v=2.0.0.0.4") },
  "help-content": { deps: [], load: () => import("./help-content.js?v=2.0.0.0.4") },
  onboarding: { deps: ["settings-services"], load: () => import("./onboarding.js?v=2.0.0.0.4") },
  "changelog-channels": { deps: [], load: () => import("./changelog-channels.js?v=2.0.0.0.4") },
  "settings-services": { deps: ["help-content"], load: () => import("./settings-services.js?v=2.0.0.0.4") },
  "tracker-settings": { deps: [], load: () => import("./tracker-settings.js?v=2.0.0.0.4") },
  "rating-sync-settings": { deps: [], load: () => import("./rating-sync-settings.js?v=2.0.0.0.4") },
  "watchlist-sync-settings": { deps: [], load: () => import("./watchlist-sync-settings.js?v=2.0.0.0.4") },
  "tautulli-import": { deps: ["settings-services"], load: () => import("./tautulli-import.js?v=2.0.0.0.4") },
  // Settings-page handlers; initialized by app-events through onRouteModuleLoaded().
  "settings-events": { deps: [], load: () => import("./settings-events.js?v=2.0.0.0.4") },
  tmdb: { deps: [], load: () => import("./tmdb.js?v=2.0.0.0.4") },
  "media-detail-shared": { deps: ["tmdb"], load: () => import("./media-detail-shared.js?v=2.0.0.0.4") },
  "manual-watch-review": { deps: ["tmdb"], load: () => import("./manual-watch-review.js?v=2.0.0.0.4") },
  "sync-activity": { deps: [], load: () => import("./sync-activity.js?v=2.0.0.0.4") },
  "sync-preview": { deps: [], load: () => import("./sync-preview.js?v=2.0.0.0.4") },
  "tools-backups": { deps: [], load: () => import("./tools-backups.js?v=2.0.0.0.4") },
  dashboard: { deps: ["media-detail-shared"], load: () => import("./dashboard.js?v=2.0.0.0.4") },
  "up-next": { deps: ["dashboard", "media-detail-shared"], load: () => import("./up-next.js?v=2.0.0.0.4") },
  stats: { deps: [], load: () => import("./stats.js?v=2.0.0.0.4") },
  upcoming: { deps: [], load: () => import("./upcoming.js?v=2.0.0.0.4") },
  "personal-media": { deps: ["tmdb"], load: () => import("./personal-media.js?v=2.0.0.0.4") },
  discover: { deps: ["personal-media"], load: () => import("./discover.js?v=2.0.0.0.4") },
  "poster-menu": { deps: ["personal-media"], load: () => import("./poster-menu.js?v=2.0.0.0.4") },
  explorer: { deps: ["dashboard", "stats", "tmdb"], load: () => import("./explorer.js?v=2.0.0.0.4") },
  // media-detail-events wires the watch-date prompt's close and preset buttons;
  // without it the prompt opened from a dashboard card menu is dead.
  "watch-action": { deps: ["explorer", "media-detail-shared", "tmdb", "media-detail-events"], load: () => import("./watch-action.js?v=2.0.0.0.4") },
  "edit-dialogs": { deps: ["watch-action"], load: () => import("./edit-dialogs.js?v=2.0.0.0.4") },
  "media-detail-movie": { deps: ["watch-action", "personal-media", "media-detail-shared", "tmdb"], load: () => import("./media-detail-movie.js?v=2.0.0.0.4") },
  "media-detail": { deps: ["explorer", "watch-action", "personal-media", "media-detail-movie", "media-detail-shared", "tmdb"], load: () => import("./media-detail.js?v=2.0.0.0.4") },
  // Imports only core modules; its route calls go through lazyExport/ifLoaded.
  "media-detail-events": { deps: [], load: () => import("./media-detail-events.js?v=2.0.0.0.4") },
  "media-person": { deps: ["media-detail", "tmdb"], load: () => import("./media-person.js?v=2.0.0.0.4") },
  "media-lightbox": { deps: [], load: () => import("./media-lightbox.js?v=2.0.0.0.4") },
  tools: { deps: ["edit-dialogs", "tools-backups"], load: () => import("./tools.js?v=2.0.0.0.4") },
};

// Loaded right after the first paint on every page: only document-wide event
// wiring. Changelog helpers are Settings-scoped; detail event wiring is route-scoped;
// Settings loads it explicitly for the library force-sync panel. Settings-
// specific status modules stay off the global graph until that route is visible.
export const SHELL_ROUTE_MODULES = Object.freeze([
  "app-events",
]);
export const SETTINGS_ROUTE_MODULES = Object.freeze([
  "settings-services", "changelog-channels", "tracker-settings", "rating-sync-settings", "watchlist-sync-settings", "tautulli-import", "settings-events",
]);
// Full status pages load on demand. The compact sidebar indicators live in
// status-indicators.js so opening About/Settings does not pull these pages in.
export const STATUS_ROUTE_MODULES = Object.freeze(["sync-activity", "manual-watch-review"]);
// A watch/unwatch prompt. Its click and change handlers (close, date presets,
// include-specials/unreleased toggles) live in media-detail-events, which
// watch-action therefore loads as a dependency on every route.
export const WATCH_ROUTE_MODULES = Object.freeze(["watch-action"]);
export const DETAIL_ROUTE_MODULES = Object.freeze([
  "media-detail", "media-detail-movie", "media-person", "media-lightbox", "media-detail-events",
]);

const loaded = new Map();
const inflight = new Map();
const initializers = new Map();
const listeners = new Set();

export function routeModuleKeys() {
  return Object.keys(ROUTE_MODULES);
}

export function routeModuleDeps(key) {
  return [...(ROUTE_MODULES[key]?.deps || [])];
}

// app.js registers how each module is bound and initialized. The initializer
// runs once, before the module is reported as loaded to anyone else.
export function registerRouteModuleInitializer(key, initializer) {
  if (!ROUTE_MODULES[key]) throw new Error(`Unknown route module: ${key}`);
  initializers.set(key, initializer);
}

// Runs for every module as it finishes loading, and immediately for modules
// that already have. Used by modules that attach behavior to another module.
export function onRouteModuleLoaded(listener) {
  listeners.add(listener);
  for (const [key, namespace] of loaded) listener(key, namespace);
  return () => listeners.delete(listener);
}

// The namespace of a loaded module, or null. Never triggers a load.
export function loadedRouteModule(key) {
  return loaded.get(key) || null;
}

export function isRouteModuleLoaded(key) {
  return loaded.has(key);
}

export function routeModulesLoaded(keys = []) {
  return keys.every((key) => loaded.has(key));
}

export function loadRouteModule(key) {
  if (loaded.has(key)) return Promise.resolve(loaded.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const entry = ROUTE_MODULES[key];
  if (!entry) return Promise.reject(new Error(`Unknown route module: ${key}`));
  const promise = Promise.all(entry.deps.map(loadRouteModule))
    .then(() => entry.load())
    .then((namespace) => {
      if (!loaded.has(key)) {
        initializers.get(key)?.(namespace);
        loaded.set(key, namespace);
        for (const listener of listeners) listener(key, namespace);
      }
      return loaded.get(key);
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function loadRouteModules(keys = []) {
  return Promise.all([...new Set(keys)].map(loadRouteModule));
}

// Shell modules (document-wide event wiring) load right after the first paint
// on every page. Settings-specific status modules load with that route.
let shellModulesReady = false;
export function ensureShellModules() {
  return loadRouteModules(SHELL_ROUTE_MODULES).then(() => {
    shellModulesReady = true;
    return true;
  });
}

// Most click and submit handlers live in app-events.js, a shell module. Until
// it is ready, hold the user's last activation and replay it afterwards instead of
// letting it silently do nothing, or letting a form fall back to a native GET
// submission that would put its fields (including a password) in the URL.
const EARLY_ACTIVATION_SELECTOR = "a[href], button, [role='button'], summary, input[type='checkbox'], input[type='radio'], input[type='submit']";
let pendingEarlyActivation = null;
function captureEarlyActivation(event) {
  if (shellModulesReady) return;
  if (event.type === "submit") {
    event.preventDefault();
    event.stopImmediatePropagation();
    pendingEarlyActivation = { type: "submit", target: event.target };
    return;
  }
  // Activation may be delivered without a pointer button while the shell is
  // still loading. Capture the activation so it can be replayed once the
  // delegated handlers are ready; modified clicks remain untouched.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target.closest(EARLY_ACTIVATION_SELECTOR) : null;
  if (!target) return;
  if (target.matches("a[href]")) {
    const href = target.getAttribute("href") || "";
    // External and new-tab links do not depend on the deferred handlers.
    if (target.target === "_blank" || target.hasAttribute("download") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  pendingEarlyActivation = { type: "click", target };
}

export function installEarlyActivationCapture() {
  document.addEventListener("click", captureEarlyActivation, true);
  document.addEventListener("submit", captureEarlyActivation, true);
}

export function replayEarlyActivation() {
  document.removeEventListener("click", captureEarlyActivation, true);
  document.removeEventListener("submit", captureEarlyActivation, true);
  const pending = pendingEarlyActivation;
  pendingEarlyActivation = null;
  if (!pending?.target?.isConnected) return;
  if (pending.type === "submit") {
    if (typeof pending.target.requestSubmit === "function") pending.target.requestSubmit();
    return;
  }
  pending.target.click();
}

// An action that should always happen: loads the module (plus any extra
// modules it needs) on first use, then calls the export. Returns the export's
// result synchronously when everything is already loaded.
export function lazyExport(key, name, extraKeys = []) {
  const keys = [key, ...extraKeys];
  return (...args) => {
    if (routeModulesLoaded(keys)) return loaded.get(key)[name](...args);
    return loadRouteModules(keys).then(() => loaded.get(key)[name](...args));
  };
}

// A render or cleanup call that only matters when the module is already on
// the page (it owns what would be rendered or closed). Never triggers a load.
export function ifLoaded(key, name, fallback = undefined) {
  return (...args) => {
    const namespace = loaded.get(key);
    return namespace ? namespace[name](...args) : fallback;
  };
}
