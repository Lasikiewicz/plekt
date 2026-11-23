import { createHash, randomUUID } from "node:crypto";
import { createUpNextDismissalFilter } from "./upNextDismissals.js";
import { createDroppedTitleFilter } from "./droppedTitles.js";
import { getCachedShows, getPlaystateForMediaSync } from "./dataRepo.js";
import { normalizeUpNextCandidate, upNextIdentityAliases } from "./upNextIdentity.js";
import { hidePlexFromContinueWatching } from "./plexClient.js";
import { hideEmbyFromResume } from "./embyClient.js";
import { writeAuditLog } from "../db.js";
import { loadMediaConfig, loadRuntimeState, setRuntimeState } from "./configStore.js";
import { isPlektPrimaryUpNextFeed, listActiveUpNextProviderItems, listUpNextProviderFeedStates } from "./upNextRepository.js";

const GRACE_MS = 30 * 60_000;
const PREVIEW_MS = 5 * 60_000;
const PROVIDERS = ["plex", "emby", "jellyfin"];

export function upNextMirrorDestination(config, provider) {
  const section = config[provider] || {};
  const account = section.remoteUserId || section.userId || (provider === "plex" && !section.connectionId && section.token
    ? createHash("sha256").update(section.token).digest("hex") : "");
  return JSON.stringify([section.baseUrl, section.connectionId, account]);
}
const destination = upNextMirrorDestination;

// A push plans against the config it loaded at its start. Checked just before
// each provider write, this stops a write reaching an account or server the
// user has since switched away from or disabled.
export function createUpNextDestinationCheck(config, loadConfig = loadMediaConfig) {
  return async (provider) => {
    const current = await loadConfig();
    const section = current?.[provider];
    return Boolean(section?.baseUrl && !section.disabled)
      && destination(current, provider) === destination(config, provider);
  };
}

export async function previewUpNextMirror(config, provider, snapshot) {
  if (!PROVIDERS.includes(provider) || !config[provider]?.baseUrl || config[provider]?.disabled) return null;
  const feeds = listUpNextProviderFeedStates().filter((feed) => feed.provider === provider);
  const primary = feeds.find((feed) => isPlektPrimaryUpNextFeed(provider, feed.feed_kind));
  const complete = Boolean(primary && feeds.every((feed) => feed.status === "succeeded"));
  const visible = complete
    ? listActiveUpNextProviderItems().filter((item) => item.provider === provider && item.feed_kind === primary.feed_kind) : [];
  const ids = new Set(visible.map((item) => item.provider_item_id));
  const order = snapshot.items.filter((item) => item.provider_items?.[provider]?.some((id) => ids.has(id))
    && item.media_type === "episode" && item.queue_kind === "next_up" && item.up_next_lane !== "new");
  const finished = provider === "jellyfin" ? [] : await finishedMirrorShows();
  const hides = planUpNextMirrorHides({ provider, visible, prior: visible, desired: snapshot.items, builtAt: snapshot.builtAt, finished });
  const token = randomUUID();
  await setRuntimeState({ [`upNextMirrorPreview:${provider}`]: complete ? { token, destination: destination(config, provider), expiresAt: Date.now() + PREVIEW_MS } : null });
  return { provider, token, complete,
    order: order.map((item) => item.title), hides: hides.map(({ title, reason }) => ({ title, reason })) };
}

export async function checkUpNextMirrorEnable(incoming = {}) {
  const next = incoming.upNextSync?.mirror;
  if (!next) return { ok: true, enabling: [], current: null };
  const [current, runtime] = await Promise.all([loadMediaConfig(), loadRuntimeState()]);
  const enabling = PROVIDERS.filter((provider) => next[provider] === true && !current.upNextSync?.mirror?.[provider]);
  const accepted = enabling.every((provider) => {
    const preview = runtime[`upNextMirrorPreview:${provider}`];
    return !incoming[provider] && preview?.token && preview.token === incoming.upNextMirrorPreview?.[provider]
      && preview.expiresAt > Date.now() && preview.destination === destination(current, provider);
  });
  return { ok: accepted, enabling: accepted ? enabling : [], current };
}

export async function commitUpNextMirrorEnable(enabling = [], current = null) {
  if (!enabling.length) return;
  const resolved = current || await loadMediaConfig();
  await setRuntimeState(Object.fromEntries(enabling.flatMap((provider) => [
    [`upNextMirrorApproved:${provider}`, destination(resolved, provider)],
    [`upNextMirrorPreview:${provider}`, null],
    [`upNextMirrorOrder:${provider}`, null],
  ])));
}

export async function validateUpNextMirrorEnable(incoming = {}) {
  const result = await checkUpNextMirrorEnable(incoming);
  if (!result.ok) return false;
  await commitUpNextMirrorEnable(result.enabling, result.current);
  return true;
}

export function upNextMirrorDestinationApproved(config, runtime, provider) {
  return runtime[`upNextMirrorApproved:${provider}`] === destination(config, provider);
}

function sameShow(left, right) {
  const shared = ["imdb", "tmdb", "tvdb"].map((kind) => [left[`show_${kind}_id`], right[`show_${kind}_id`]])
    .filter(([a, b]) => a && b);
  return shared.length > 0 && shared.every(([a, b]) => String(a) === String(b));
}

export async function finishedMirrorShows() {
  const shows = await getCachedShows().catch(() => []);
  return shows.filter((show) => Number(show.total_episodes) > 0 && Number(show.episode_count) >= Number(show.total_episodes))
    .map((show) => ({ show_tmdb_id: show.tmdb_id, show_tvdb_id: show.tvdb_id, show_imdb_id: show.imdb_id }));
}

export function planUpNextMirrorHides({ provider, visible = [], prior = [], desired = [], finished = [], builtAt, now = Date.now() }) {
  if (!["plex", "emby"].includes(provider) || !builtAt) return [];
  const seen = new Map(prior.map((item) => [item.provider_item_id, item]));
  const wanted = new Set(desired.flatMap(upNextIdentityAliases));
  const dismissals = createUpNextDismissalFilter();
  const dropped = createDroppedTitleFilter();
  const hides = [];
  for (const row of visible) {
    const item = normalizeUpNextCandidate(row);
    const previous = seen.get(item.provider_item_id);
    if (!previous?.observed_at || previous.observed_at > Math.min(builtAt, now - GRACE_MS)
      || previous.canonical_key !== item.canonical_key || item.updated_at > builtAt
      || previous.position_ms !== item.position_ms
      || upNextIdentityAliases(item).some((alias) => wanted.has(alias))) continue;
    const wasDismissed = dismissals.dismissedAt(item);
    const wasDropped = dropped.isDropped(item);
    const watched = item.media_type === "movie" && item.position_ms === 0 && getPlaystateForMediaSync({
      ...item, type: item.media_type, itemId: item.provider_item_id,
      ids: { tmdb: item.tmdb_id, tvdb: item.tvdb_id, imdb: item.imdb_id },
    })?.state === "watched";
    const superseded = item.media_type === "episode" && item.position_ms === 0
      && desired.some((candidate) => candidate.media_type === "episode" && sameShow(candidate, item))
      && !desired.some((candidate) => candidate.up_next_lane && sameShow(candidate, item));
    const finishedShow = item.media_type === "episode" && item.position_ms === 0 && finished.some((show) => sameShow(show, item));
    const reason = wasDismissed ? "Dismissed" : wasDropped ? "Dropped" : watched || finishedShow ? "Finished" : superseded ? "Superseded" : "";
    if (reason) hides.push({ providerItemId: item.provider_item_id, title: item.title, reason });
  }
  return hides;
}

export async function applyUpNextMirrorHides(provider, config, hides, isStale) {
  const hide = provider === "plex" ? hidePlexFromContinueWatching : hideEmbyFromResume;
  const results = [];
  for (const item of hides) {
    if (isStale?.()) break;
    const at = Date.now();
    try {
      const response = await hide(config[provider], item.providerItemId);
      const status = response?.status === "fulfilled"
        ? "hidden"
        : response?.status === "skipped"
          ? "skipped"
          : "failed";
      const record = { ...item, provider, status, at };
      results.push(record);
      writeAuditLog("up-next.mirror-hide", { detail: record });
    } catch {
      const record = { ...item, provider, status: "failed", at };
      results.push(record);
      writeAuditLog("up-next.mirror-hide", { detail: record });
    }
  }
  return results;
}
