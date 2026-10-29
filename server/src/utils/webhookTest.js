import { getActiveUserName } from "./userContext.js";

// Guided webhook delivery test. The person starts a test in Settings, marks one
// item played in their media app, and Plekt shows whether the mark arrived.
//
// While a test is waiting, the first played-flag event from the tested source that
// is not an echo of Plekt's own writes is captured and swallowed: it writes no watch history, queues no Manual Watch
// review and is never sent to another app or tracker. The captured item is then
// held (the scheduled library scan skips it, and a duplicate mark-played or the
// echo of the unmark is swallowed) until the person unmarks it or leaves it
// marked. State is in memory, per signed-in user, because it only has to live for
// a few minutes inside the one API process.

export const WEBHOOK_TEST_SOURCES = Object.freeze(["emby", "jellyfin"]);
export const WEBHOOK_TEST_WINDOW_MS = 5 * 60 * 1000;
export const WEBHOOK_TEST_HOLD_MS = 10 * 60 * 1000;
export const WEBHOOK_TEST_ECHO_MS = 60 * 1000;

const sessions = new Map();

function tenantKey() {
  return String(getActiveUserName?.() || "admin");
}

function liveSession(now = Date.now()) {
  const session = sessions.get(tenantKey());
  if (!session) return null;
  if (session.status === "waiting" && now > session.expiresAt) session.status = "timeout";
  if (session.status === "passed" && now > session.holdUntil) {
    sessions.delete(tenantKey());
    return null;
  }
  return session;
}

// Jellyfin renders the same item id with or without dashes depending on the sender (the
// library API and scan use the 32 character form), so compare ids in one form.
function sameItemId(a, b) {
  const plain = (value) => String(value || "").replace(/-/g, "").toLowerCase();
  return Boolean(plain(a)) && plain(a) === plain(b);
}

function isMarkPlayedEvent(media = {}) {
  return Boolean(media.playedFlagOnly) && media.phase === "completed";
}

function publicView(session) {
  if (!session) return { status: "idle" };
  return {
    status: session.status,
    source: session.source,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
    capture: session.capture,
    unmarkedAt: session.unmarkedAt || null,
    seen: Object.values(session.seen).sort((a, b) => b.lastAt - a.lastAt),
    rejectedCount: session.rejectedCount,
    embyCheck: session.embyCheck || null,
  };
}

export function startWebhookTest(source, now = Date.now()) {
  if (!WEBHOOK_TEST_SOURCES.includes(source)) {
    const error = new Error(`Webhook test is not available for ${source || "this source"}`);
    error.status = 400;
    throw error;
  }
  const existing = liveSession(now);
  if (existing?.status === "passed" && !existing.unmarkedAt) {
    const error = new Error("A passed test still has its item marked. Unmark it or leave it marked before starting another test.");
    error.status = 409;
    throw error;
  }
  const session = {
    source,
    status: "waiting",
    startedAt: now,
    expiresAt: now + WEBHOOK_TEST_WINDOW_MS,
    holdUntil: 0,
    seen: {},
    rejectedCount: 0,
    capture: null,
    unmarkedAt: null,
    embyCheck: null,
  };
  sessions.set(tenantKey(), session);
  return publicView(session);
}

export function getWebhookTestSession(now = Date.now()) {
  return liveSession(now);
}

export function getWebhookTestStatus(now = Date.now()) {
  return publicView(liveSession(now));
}

// Holds the provider's own answer to "was anything marked played since the test started"
// (stored as `embyCheck` in the public view for both Emby and Jellyfin).
export function setWebhookTestEmbyCheck(check) {
  const session = sessions.get(tenantKey());
  if (session) session.embyCheck = check;
}

export function cancelWebhookTest() {
  sessions.delete(tenantKey());
  return { status: "idle" };
}

export function markWebhookTestUnmarked(now = Date.now()) {
  const session = sessions.get(tenantKey());
  if (!session || session.status !== "passed") return null;
  session.unmarkedAt = now;
  // Keep swallowing for a short while so Emby's echo of the unmark is dropped too.
  session.holdUntil = now + WEBHOOK_TEST_ECHO_MS;
  return publicView(session);
}

// Records what arrived while a test waits, so a failed test can say what Plekt
// did and did not see. Never changes how the event is processed.
export function observeWebhookForTest(media = {}, now = Date.now()) {
  const session = liveSession(now);
  if (!session || session.status !== "waiting" || media.source !== session.source) return;
  const key = String(media.event || media.phase || "unknown");
  const entry = session.seen[key] || { event: key, count: 0, lastAt: 0, markPlayed: false, markCount: 0 };
  entry.count += 1;
  entry.lastAt = now;
  if (isMarkPlayedEvent(media)) entry.markCount += 1;
  entry.markPlayed = entry.markCount > 0;
  session.seen[key] = entry;
}

// Plekt's own writes echo back as webhooks (Up Next rail refresh, outbound marks). The echo
// guards call this so those events do not count as something the person's app sent.
export function discountEchoForWebhookTest(media = {}, now = Date.now()) {
  const session = liveSession(now);
  if (!session || session.status !== "waiting" || media.source !== session.source) return;
  const key = String(media.event || media.phase || "unknown");
  const entry = session.seen[key];
  if (!entry) return;
  entry.count -= 1;
  if (isMarkPlayedEvent(media)) entry.markCount = Math.max(0, entry.markCount - 1);
  entry.markPlayed = entry.markCount > 0;
  if (entry.count <= 0) delete session.seen[key];
}

export function noteRejectedWebhookForTest(now = Date.now()) {
  const session = liveSession(now);
  if (session?.status === "waiting") session.rejectedCount += 1;
}

// Capture point. handleWebhook calls this only after every Plekt-echo guard (native
// Up Next rail refresh, outbound mark and progress echoes) has had its say, so Plekt's
// own writes to Emby never count as the person's mark. Returns true when the event was
// taken as the test mark and the caller must answer the request and do nothing else.
export function captureWebhookTestMark(media = {}, now = Date.now()) {
  const session = liveSession(now);
  if (!session || media.source !== session.source || session.status !== "waiting" || !isMarkPlayedEvent(media)) return false;
  session.status = "passed";
  session.holdUntil = now + WEBHOOK_TEST_HOLD_MS;
  session.capture = {
    itemId: String(media.itemId || ""),
    title: media.title || "",
    type: media.type || "",
    season: media.season ?? null,
    episode: media.episode ?? null,
    event: media.event || "",
    posterUrl: String(media.posterUrl || ""),
    capturedAt: now,
  };
  return true;
}

// Hold point, early in handleWebhook: after a pass, a duplicate mark-played or an
// unplayed event for the captured item (the echo of the unmark) is swallowed. Nothing
// else is, so this cannot hide events for any other item.
export function isHeldWebhookTestEvent(media = {}, now = Date.now()) {
  const session = liveSession(now);
  return Boolean(session?.status === "passed"
    && media.source === session.source
    && sameItemId(media.itemId, session.capture?.itemId)
    && (isMarkPlayedEvent(media) || media.phase === "unplayed"));
}

// The scheduled library scan asks this before importing a played item, so the
// test item is not recorded as a normal manual mark while the person decides.
export function isWebhookTestHeldItem(source, itemId, now = Date.now()) {
  const session = liveSession(now);
  return Boolean(session?.status === "passed"
    && session.source === source
    && sameItemId(itemId, session.capture?.itemId));
}

export function resetWebhookTestForTests() {
  sessions.clear();
}
