const CONFIG_URL = "/analytics-config.json";

function privacySignalIsSet() {
  return navigator.doNotTrack === "1"
    || window.doNotTrack === "1"
    || navigator.globalPrivacyControl === true;
}

function loadTraks(config) {
  if (!config?.enabled || window.__plembfinTraksLoaded || window.__plembfinTraksLoading || privacySignalIsSet()) return;

  window.__plembfinTraksLoading = true;
  window.traks = window.traks || function () { (window.traks.q = window.traks.q || []).push(arguments); };
  const script = document.createElement("script");
  script.defer = true;
  script.src = config.scriptUrl;
  script.dataset.site = config.siteKey;
  script.onload = () => {
    window.__plembfinTraksLoaded = true;
    window.__plembfinTraksLoading = false;
  };
  script.onerror = () => {
    window.__plembfinTraksLoading = false;
  };
  document.head.appendChild(script);
}

function loadAnalytics(config) {
  loadTraks(config.traks);
}

function scheduleAnalyticsLoad(config) {
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(() => loadAnalytics(config), { timeout: 2000 });
  } else {
    window.setTimeout(() => loadAnalytics(config), 2000);
  }
}

async function boot() {
  if (privacySignalIsSet()) return;

  let response;
  try {
    response = await fetch(CONFIG_URL, { credentials: "same-origin", cache: "no-store" });
  } catch {
    return;
  }
  if (!response.ok) return;

  let config;
  try {
    config = await response.json();
  } catch {
    return;
  }
  if (!config?.enabled) return;

  const traksConfig = config.traks;
  const traksEnabled = traksConfig?.enabled
    && typeof traksConfig.scriptUrl === "string"
    && typeof traksConfig.siteKey === "string"
    && (() => {
      try {
        const scriptUrl = new URL(traksConfig.scriptUrl, window.location.href);
        return scriptUrl.href === "https://plembfin-traks-collect.lasikie.workers.dev/t.js";
      } catch {
        return false;
      }
    })();
  if (!traksEnabled) return;

  scheduleAnalyticsLoad(config);
}

void boot();
