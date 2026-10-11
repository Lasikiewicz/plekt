// Startup advisory for webhook ports (plan step 10). Inside Docker Plekt always
// listens on 5055; compose sets the host port (5056 since 6 October 2026). The
// host port is passed in as PLEKT_PUBLISHED_PORT, so a webhook still aimed at the
// old mapping can be reported. Jellyfin webhook destinations are read through its
// API; Emby and Plex are advice only (Emby's plugin config errors on the test
// server and Plex has no documented webhook-list endpoint). Webhook URLs carry a
// token, so only ports and plugin names are ever logged or returned.
import { getMediaConnection, resolveConnectedProviderConfig } from "./mediaConnectionRepo.js";
import { jellyfinAuthHeaders } from "./jellyfinAuth.js";
import { brandEnv } from "./brandEnv.js";
import { fetchWithTimeout } from "./outbound.js";

const STATUS_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const WEBHOOK_PLUGIN_NAME = /^webhook$/i;

let latest = null;

export function portFromUri(uri) {
  try {
    const url = new URL(String(uri));
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export function publishedPortFromEnv(env = process.env) {
  const raw = brandEnv("PUBLISHED_PORT", env);
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

// Pure: turns the port facts into advice. `jellyfinDestinations` is null when
// Jellyfin could not be read, so no false "fine" is reported for it.
export function buildWebhookPortFindings({ publishedPort, jellyfinDestinations = null, connected = {} }) {
  const findings = [];
  if (!publishedPort) {
    findings.push({
      provider: "plekt",
      kind: "port_unknown",
      message: "Plekt cannot check your webhook ports yet. Set PLEKT_PUBLISHED_PORT to 5056 (the port you open Plekt on) and restart Plekt.",
    });
  }
  if (publishedPort && Array.isArray(jellyfinDestinations)) {
    for (const destination of jellyfinDestinations) {
      const port = portFromUri(destination.uri);
      if (port && port !== publishedPort) {
        findings.push({
          provider: "jellyfin",
          kind: "wrong_port",
          webhookPort: port,
          expectedPort: publishedPort,
          message: `The Jellyfin webhook "${destination.name || "unnamed"}" uses port ${port}, but Plekt uses port ${publishedPort}. In Jellyfin, open the Webhook plugin settings and change the port to ${publishedPort}. If you keep port ${port} on purpose, set PLEKT_PUBLISHED_PORT to ${port} instead.`,
        });
      }
    }
  }
  const portText = publishedPort || 5056;
  const where = {
    emby: "In Emby, open the Webhooks plugin settings",
    plex: "In Plex, open your account's Webhooks settings",
  };
  for (const provider of ["emby", "plex"]) {
    if (!connected[provider]) continue;
    const label = provider === "emby" ? "Emby" : "Plex";
    findings.push({
      provider,
      kind: "advice",
      message: `Check that your ${label} webhook uses port ${portText}. ${where[provider]} and check the port. Plekt cannot read this for you.`,
    });
  }
  return findings;
}

async function fetchJson(url, headers) {
  const response = await fetchWithTimeout(url, { headers, lane: "sync" }, FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Reads the enabled Generic webhook destinations from Jellyfin's Webhook plugin.
// Returns null when no Jellyfin connection exists, and throws when the read fails.
export async function readJellyfinWebhookDestinations() {
  if (!getMediaConnection("jellyfin")) return null;
  const config = resolveConnectedProviderConfig("jellyfin");
  const headers = jellyfinAuthHeaders(config);
  const plugins = await fetchJson(`${config.baseUrl}/Plugins`, headers);
  const plugin = plugins.find((item) => WEBHOOK_PLUGIN_NAME.test(String(item.Name || "")));
  if (!plugin) return [];
  const settings = await fetchJson(`${config.baseUrl}/Plugins/${plugin.Id}/Configuration`, headers);
  return (settings.GenericOptions || [])
    .filter((option) => option.EnableWebhook !== false && option.WebhookUri)
    .map((option) => ({ name: option.WebhookName || "", uri: option.WebhookUri }));
}

export async function runWebhookPortCheck({ log = console } = {}) {
  const publishedPort = publishedPortFromEnv();
  let jellyfinDestinations = null;
  let readError = "";
  try {
    jellyfinDestinations = await readJellyfinWebhookDestinations();
  } catch (error) {
    readError = "Could not read Jellyfin webhook settings.";
    log.warn?.(`[webhook-port] ${readError} ${error?.message || ""}`.trim());
  }
  const connected = {
    emby: Boolean(getMediaConnection("emby")),
    plex: Boolean(getMediaConnection("plex")),
  };
  const findings = buildWebhookPortFindings({ publishedPort, jellyfinDestinations, connected });
  for (const finding of findings) log.warn?.(`[webhook-port] ${finding.message}`);
  latest = { checkedAt: Date.now(), publishedPort, findings, readError };
  return latest;
}

// Returns the last check, re-running it once it is older than the TTL so a fixed
// webhook clears the banner without a restart.
export async function getWebhookPortStatus({ now = Date.now() } = {}) {
  if (latest && now - latest.checkedAt < STATUS_TTL_MS) return latest;
  return runWebhookPortCheck({ log: { warn() {} } });
}
