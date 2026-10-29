import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import { isAuthoritativeRestoreActive, loadMediaConfig } from "../utils/configStore.js";
import { fetchEmbyWatchedItems, markEmbyUnplayedById } from "../utils/embyClient.js";
import { jellyfinAuthHeaders, jellyfinCredential } from "../utils/jellyfinAuth.js";
import { fetchWithTimeout } from "../utils/outbound.js";
import { fetchJellyfinWatchedItems, markJellyfinUnplayedById } from "../utils/jellyfinClient.js";
import {
  cancelWebhookTest,
  getWebhookTestSession,
  getWebhookTestStatus,
  markWebhookTestUnmarked,
  setWebhookTestEmbyCheck,
  startWebhookTest,
} from "../utils/webhookTest.js";

const NO_STORE = { "Cache-Control": "no-store" };

const PROVIDERS = {
  emby: { label: "Emby", fetchWatched: fetchEmbyWatchedItems, markUnplayed: markEmbyUnplayedById },
  jellyfin: { label: "Jellyfin", fetchWatched: fetchJellyfinWatchedItems, markUnplayed: markJellyfinUnplayedById },
};

function providerConfigured(providerConfig) {
  return Boolean(providerConfig?.baseUrl && jellyfinCredential(providerConfig) && providerConfig.userId);
}

// Asks the media server directly whether anything was marked played since the test started,
// so a failed test can tell "the server never sent it" from "nothing was marked".
async function checkProviderForMark(source, providerConfig, sinceMs) {
  try {
    const items = await PROVIDERS[source].fetchWatched(providerConfig, { limit: 5 });
    const hit = items.find((item) => {
      const playedAt = Date.parse(item.UserData?.LastPlayedDate || "");
      return Number.isFinite(playedAt) && playedAt >= sinceMs - 5000;
    });
    return { checked: true, marked: Boolean(hit), title: hit ? embyItemLabel(hit) : "" };
  } catch (error) {
    return { checked: false, marked: false, error: error.message || String(error) };
  }
}

function embyItemLabel(item) {
  if (item.Type === "Episode") {
    const season = String(item.ParentIndexNumber ?? "?").padStart(2, "0");
    const episode = String(item.IndexNumber ?? "?").padStart(2, "0");
    return `${item.SeriesName || "Episode"} - S${season}E${episode}`;
  }
  return item.Name || "";
}

async function statusWithDiagnosis() {
  const view = getWebhookTestStatus();
  if (view.status === "timeout" && !view.embyCheck && PROVIDERS[view.source]) {
    const config = await loadMediaConfig().catch(() => null);
    if (providerConfigured(config?.[view.source])) {
      setWebhookTestEmbyCheck(await checkProviderForMark(view.source, config[view.source], view.startedAt));
      return getWebhookTestStatus();
    }
  }
  return view;
}

const POSTER_PATH = /^\/Items\/[A-Za-z0-9-]+\/Images\/Primary$/;
const POSTER_MAX_BYTES = 4 * 1024 * 1024;

// Streams the captured item's poster from the media server it came from, so the pop-up can
// show it without exposing the server address or key to the browser.
async function sendCapturedPoster(res) {
  const session = getWebhookTestSession();
  const raw = String(session?.capture?.posterUrl || "");
  const [path, query = ""] = raw.split("?");
  const provider = PROVIDERS[session?.source];
  if (!provider || !POSTER_PATH.test(path)) return sendJson(res, { error: "No poster for this test item" }, 404);
  const config = (await loadMediaConfig())?.[session.source];
  if (!providerConfigured(config)) return sendJson(res, { error: "No poster for this test item" }, 404);
  const url = new URL(`${String(config.baseUrl).replace(/\/+$/, "")}${session.source === "emby" ? "/emby" : ""}${path}`);
  const tag = new URLSearchParams(query).get("tag");
  if (tag && /^[A-Za-z0-9]+$/.test(tag)) url.searchParams.set("tag", tag);
  url.searchParams.set("maxHeight", "450");
  const headers = session.source === "jellyfin" ? jellyfinAuthHeaders(config) : { "X-Emby-Token": config.apiKey };
  const response = await fetchWithTimeout(url, { headers, lane: "interactive" }).catch(() => null);
  const type = String(response?.headers?.get("content-type") || "");
  if (!response?.ok || !type.startsWith("image/")) return sendJson(res, { error: "Poster unavailable" }, 404);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > POSTER_MAX_BYTES) return sendJson(res, { error: "Poster unavailable" }, 404);
  return res.status(200).set({ "Content-Type": type, "Cache-Control": "private, max-age=600" }).send(bytes);
}

// POST webhook-test/start | cancel | unmark, GET webhook-test/status | poster.
export async function handleWebhookTest(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  const action = String(path || "").split("/")[1] || "";
  try {
    if (action === "poster") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return await sendCapturedPoster(res);
    }
    if (action === "status") {
      if (req.method !== "GET") return methodNotAllowed(res);
      return sendJson(res, { ok: true, ...(await statusWithDiagnosis()) }, 200, NO_STORE);
    }
    if (req.method !== "POST") return methodNotAllowed(res);

    if (action === "start") {
      const body = await readJson(req);
      const source = String(body?.source || "emby").toLowerCase();
      if (isAuthoritativeRestoreActive()) {
        return sendJson(res, { error: "A watch-history restore is running. Inbound events are paused until it finishes." }, 409);
      }
      const provider = PROVIDERS[source];
      if (provider) {
        const config = await loadMediaConfig();
        if (!providerConfigured(config?.[source])) {
          return sendJson(res, { error: `Connect ${provider.label} in Settings first.` }, 400);
        }
        if (config[source].disabled) return sendJson(res, { error: `${provider.label} is disabled in Settings.` }, 400);
      }
      return sendJson(res, { ok: true, ...startWebhookTest(source) }, 200, NO_STORE);
    }

    if (action === "cancel") {
      return sendJson(res, { ok: true, ...cancelWebhookTest() }, 200, NO_STORE);
    }

    if (action === "unmark") {
      const session = getWebhookTestSession();
      if (!session || session.status !== "passed" || !session.capture?.itemId) {
        return sendJson(res, { error: "There is no passed test item to unmark." }, 409);
      }
      if (session.unmarkedAt) return sendJson(res, { ok: true, ...getWebhookTestStatus() }, 200, NO_STORE);
      const provider = PROVIDERS[session.source];
      const config = await loadMediaConfig();
      try {
        await provider.markUnplayed(config[session.source], session.capture.itemId, { lane: "interactive" });
      } catch (error) {
        return sendJson(res, { error: `Could not unmark the item in ${provider.label}: ${error.message || error}` }, 502);
      }
      return sendJson(res, { ok: true, ...markWebhookTestUnmarked() }, 200, NO_STORE);
    }

    return sendJson(res, { error: "Unknown webhook test action" }, 404);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
