// Browser route benchmark for plan/active/application-speed-remediation/plan.md (Phase A/B/G).
//
// Paste into the DevTools console of a signed-in Plembfin tab, or inject it
// with a browser automation tool. It adds a "Start route benchmark" button;
// click it (a real click is required to open the measurement window), or call
// window.plembfinBench.start(options) from a click handler. Options:
//
//   { mode: "document" | "spa", populations: 2, runs: 6, routes: [...] }
//
// The app sends X-Frame-Options: DENY, so samples run in one same-origin popup
// window rather than an iframe; the popup uses the tab's existing session and
// the harness never handles credentials. "document" samples are full document
// loads with a unique query string; whether they are cold or warm is decided by
// how the server caches assets (PLEMBFIN_DEV_NO_CACHE_ASSETS=1 re-downloads the
// shell on every load; =0 serves the immutable, versioned assets a release
// serves). "spa" samples load /about once per population and then move between
// routes with history.pushState + popstate, the path the app's own navigation
// uses. The first round of each population is a warm-up and is excluded from
// the summary. Samples are paced so the API rate limiter is not what gets
// measured; any 429 is counted, and so is any sample taken while the
// controlling tab was hidden (its timers are then throttled).
//
// Progress: window.plembfinBench.progress. Result: window.plembfinBench.last.
(() => {
  const DEFAULT_ROUTES = [
    "/", "/movies", "/tvshows", "/upcoming", "/discover", "/watchlist", "/ratings", "/custom-lists",
    "/history", "/stats", "/settings", "/about",
    "/tvshow/tvdb/435298-ludwig", "/tvshow/tmdb/108978-reacher",
    "/movie/jackass-presents-bad-grandpa", "/movie/a-quiet-place",
  ];
  const DETAIL = /^\/(tvshow|movie)\//;
  const QUIET_MS = 800;
  const SETTLE_LIMIT_MS = 12000;
  const LOAD_LIMIT_MS = 20000;
  const PACE_MS = 1200;

  // Plain timers: the app's Content-Security-Policy blocks blob: workers. With the
  // measurement window open the controlling tab normally stays visible; every
  // sample records whether it was hidden, so throttled pacing shows in the data.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const now = () => performance.now();

  const kindOf = (entry) => {
    if (entry.initiatorType === "img" || /\.(png|jpe?g|webp|svg|ico|gif)(\?|$)/.test(entry.name) || /tmdb-poster|tmdb-profile|artwork|image-proxy/.test(entry.name)) return "image";
    if (/\/api\//.test(entry.name)) return "api";
    return "asset";
  };

  function metrics(win, since = 0) {
    const resources = win.performance.getEntriesByType("resource").filter((entry) => entry.startTime >= since);
    const totals = { requests: 0, transfer: 0, decoded: 0, api: 0, image: 0, asset: 0, status429: 0, failed: 0 };
    const inventory = {};
    for (const entry of resources) {
      totals.requests += 1;
      totals.transfer += entry.transferSize || 0;
      totals.decoded += entry.decodedBodySize || 0;
      totals[kindOf(entry)] += 1;
      if (entry.responseStatus === 429) totals.status429 += 1;
      if (entry.responseStatus >= 500) totals.failed += 1;
      let key = entry.name;
      try { key = new URL(entry.name).pathname; } catch { /* keep the raw name */ }
      inventory[key] = (inventory[key] || 0) + 1;
    }
    return { resources, totals, inventory };
  }

  async function until(check, limitMs) {
    const begin = now();
    while (now() - begin < limitMs) {
      try { if (check()) return true; } catch { /* navigation in progress */ }
      await sleep(50);
    }
    return false;
  }

  async function waitForQuiet(win, since, { needMark = false } = {}) {
    const begin = now();
    let lastCount = -1;
    let lastChange = now();
    while (now() - begin < SETTLE_LIMIT_MS) {
      const count = win.performance.getEntriesByType("resource").filter((entry) => entry.startTime >= since).length;
      if (count !== lastCount) { lastCount = count; lastChange = now(); }
      const markReady = !needMark || win.performance.getEntriesByName("plembfin:detail-primary-ready").some((mark) => mark.startTime >= since);
      if (markReady && now() - lastChange >= QUIET_MS) return { timedOut: false };
      await sleep(100);
    }
    return { timedOut: true };
  }

  async function lcpOf(win) {
    let value = null;
    try {
      const observer = new win.PerformanceObserver((list) => { for (const entry of list.getEntries()) value = entry.startTime; });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
      await sleep(50);
      observer.disconnect();
    } catch { /* not supported */ }
    return value;
  }

  let host = null;
  // The app tidies its address bar after routing, so the new document is
  // recognized by its navigation entry, which keeps the requested URL.
  async function navigateHost(url) {
    host.location.href = url;
    const loaded = await until(() => (host.performance.getEntriesByType("navigation")[0]?.name || "").endsWith(url)
      && host.document.readyState === "complete", LOAD_LIMIT_MS);
    // The default 250-entry Resource Timing buffer fills within a few SPA
    // transitions, after which requests silently go unrecorded.
    if (loaded) host.performance.setResourceTimingBufferSize(100000);
    return loaded;
  }

  async function documentSample(route, label) {
    const url = `${route}${route.includes("?") ? "&" : "?"}bench=${label}-${Date.now()}`;
    const loaded = await navigateHost(url);
    const settle = loaded ? await waitForQuiet(host, 0, { needMark: DETAIL.test(route) }) : { timedOut: true };
    const nav = host.performance.getEntriesByType("navigation")[0] || {};
    const fcp = host.performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
    const primary = host.performance.getEntriesByName("plembfin:detail-primary-ready")[0]?.startTime ?? null;
    const lcp = loaded ? await lcpOf(host) : null;
    const { totals, inventory } = metrics(host);
    const shell = { requests: 1, transfer: nav.transferSize || 0, decoded: nav.decodedBodySize || 0 };
    for (const entry of host.performance.getEntriesByType("resource")) {
      if (kindOf(entry) !== "asset") continue;
      shell.requests += 1;
      shell.transfer += entry.transferSize || 0;
      shell.decoded += entry.decodedBodySize || 0;
    }
    return {
      route, loaded, timedOut: settle.timedOut,
      ttfb: nav.responseStart ?? null, dcl: nav.domContentLoadedEventEnd ?? null, load: nav.loadEventEnd || null,
      fcp, lcp, primaryReady: primary,
      requests: totals.requests + 1, transfer: totals.transfer + (nav.transferSize || 0), decoded: totals.decoded + (nav.decodedBodySize || 0),
      api: totals.api, images: totals.image, status429: totals.status429, failed: totals.failed, shell, inventory,
    };
  }

  async function spaSample(route) {
    const since = host.performance.now();
    host.history.pushState({}, "", route);
    host.dispatchEvent(new host.PopStateEvent("popstate", { state: {} }));
    const settle = await waitForQuiet(host, since, { needMark: DETAIL.test(route) });
    const { resources, totals, inventory } = metrics(host, since);
    const lastEnd = resources.reduce((max, entry) => Math.max(max, entry.responseEnd), since);
    const primary = host.performance.getEntriesByName("plembfin:detail-primary-ready").filter((mark) => mark.startTime >= since).at(-1)?.startTime;
    return {
      route, loaded: true, timedOut: settle.timedOut,
      settled: Math.round(lastEnd - since), primaryReady: primary != null ? primary - since : null,
      requests: totals.requests, transfer: totals.transfer, decoded: totals.decoded,
      api: totals.api, images: totals.image, status429: totals.status429, failed: totals.failed, inventory,
    };
  }

  const pct = (values, p) => {
    const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, index)] * 10) / 10;
  };

  function summarize(samples, mode) {
    const byRoute = {};
    for (const sample of samples) (byRoute[sample.route] ||= []).push(sample);
    const doc = mode !== "spa";
    const out = {};
    for (const [route, list] of Object.entries(byRoute)) {
      const measured = list.slice(1);
      const time = doc ? "load" : "settled";
      const med = (key) => pct(measured.map((s) => (typeof key === "function" ? key(s) : s[key])), 50);
      out[route] = {
        samples: measured.length,
        incomplete: measured.filter((s) => !s.loaded || s.timedOut).length,
        status429: measured.reduce((sum, s) => sum + s.status429, 0),
        controllerHidden: measured.filter((s) => s.controllerHidden).length,
        medianTime: med(time), p95Time: pct(measured.map((s) => s[time]), 95), maxTime: pct(measured.map((s) => s[time]), 100),
        medianTtfb: doc ? med("ttfb") : null, p95Ttfb: doc ? pct(measured.map((s) => s.ttfb), 95) : null,
        medianFcp: doc ? med("fcp") : null, medianLcp: doc ? med("lcp") : null,
        medianPrimaryReady: med("primaryReady"),
        medianRequests: med("requests"), medianApi: med("api"), medianImages: med("images"),
        medianTransfer: med("transfer"), medianDecoded: med("decoded"),
        medianShellRequests: doc ? med((s) => s.shell.requests) : null,
        medianShellTransfer: doc ? med((s) => s.shell.transfer) : null,
        medianShellDecoded: doc ? med((s) => s.shell.decoded) : null,
        inventory: measured.at(-1)?.inventory || {},
      };
    }
    return out;
  }

  async function run({ mode = "document", populations = 2, runs = 6, routes = DEFAULT_ROUTES } = {}) {
    if (!host || host.closed) throw new Error("Open the measurement window with start() from a click first.");
    const report = { mode, runs, startedAt: new Date().toISOString(), userAgent: navigator.userAgent, populations: [] };
    window.plektBench.progress = { mode, done: 0, total: populations * runs * routes.length, error: null };
    for (let p = 0; p < populations; p += 1) {
      const samples = [];
      if (mode === "spa") {
        await navigateHost(`/about?bench=spa-${p}-${Date.now()}`);
        await waitForQuiet(host, 0);
        await sleep(2500);
      }
      for (let i = 0; i < runs; i += 1) {
        for (const route of routes) {
          const hiddenBefore = document.hidden;
          const sample = mode === "spa" ? await spaSample(route) : await documentSample(route, `${mode}-${p}-${i}`);
          sample.controllerHidden = hiddenBefore || document.hidden;
          samples.push(sample);
          window.plektBench.progress.done += 1;
          await sleep(PACE_MS);
        }
      }
      const ordered = [];
      for (const route of routes) ordered.push(...samples.filter((s) => s.route === route));
      report.populations.push({
        index: p,
        summary: summarize(ordered, mode),
        stalls: samples.filter((s) => (s.load || s.settled || 0) > 5000).map((s) => ({ route: s.route, time: s.load || s.settled })),
        raw: samples.map(({ inventory, ...rest }) => rest),
      });
    }
    report.finishedAt = new Date().toISOString();
    window.plektBench.last = report;
    return report;
  }

  function start(options = {}) {
    host = window.open("about:blank", "plembfin-bench", "width=1280,height=800");
    if (!host) throw new Error("The measurement window was blocked; start it from a click.");
    window.plektBench.last = null;
    return run(options).catch((error) => {
      window.plektBench.progress = { ...(window.plektBench.progress || {}), error: String(error?.message || error) };
    });
  }

  const button = document.createElement("button");
  button.id = "plembfinBenchStart";
  button.type = "button";
  button.textContent = "Start route benchmark";
  button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 14px;font:600 14px sans-serif";
  button.addEventListener("click", () => start(window.plektBench.nextOptions || {}));
  document.getElementById("plembfinBenchStart")?.remove();
  document.body.appendChild(button);

  window.plektBench = { start, run, routes: DEFAULT_ROUTES, nextOptions: null, progress: null, last: null };
})();
