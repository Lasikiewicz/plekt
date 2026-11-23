import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-step0b-recovery-");

// Minimal DOM harness sufficient for dialog, reconciliation, and up-next tests.
function createMockElement(tagName = "div") {
  const listeners = new Map();
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: String(tagName).toUpperCase(),
    className: "",
    textContent: "",
    _innerHTML: "",
    disabled: false,
    hidden: false,
    checked: false,
    value: "",
    dataset: {},
    parentNode: null,
    isConnected: true,
    focused: false,
    style: { removeProperty() {}, setProperty() {} },
    children,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    get innerHTML() { return this._innerHTML; },
    set innerHTML(html) {
      this._innerHTML = String(html || "");
      this._subElements = null;
    },
    get outerHTML() {
      const a = [...attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
      return `<${this.tagName.toLowerCase()}${a}>${this.textContent || this._innerHTML}</${this.tagName.toLowerCase()}>`;
    },
    cloneNode() {
      const copy = createMockElement(this.tagName);
      copy.className = this.className;
      copy.textContent = this.textContent;
      copy._innerHTML = this._innerHTML;
      for (const [k, v] of attrs.entries()) copy.setAttribute(k, v);
      return copy;
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    focus() {
      this.focused = true;
      globalThis.document.activeElement = this;
    },
    appendChild(child) {
      child.parentNode = this;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const existing = children.indexOf(child);
      if (existing >= 0) children.splice(existing, 1);
      child.parentNode = this;
      const idx = ref ? children.indexOf(ref) : -1;
      if (idx >= 0) children.splice(idx, 0, child);
      else children.push(child);
      return child;
    },
    remove() {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      }
      this.isConnected = false;
    },
    replaceWith(next) {
      if (!this.parentNode) return;
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) {
        next.parentNode = this.parentNode;
        this.parentNode.children.splice(idx, 1, next);
      }
      this.parentNode = null;
    },
    closest() { return null; },
    matches(sel) {
      const tokens = String(sel || "").split(",").map((s) => s.trim());
      for (const token of tokens) {
        if (token.startsWith("[") && token.endsWith("]")) {
          const name = token.slice(1, -1);
          if (attrs.has(name)) return true;
        } else if (token.startsWith(".")) {
          if (String(this.className || "").split(/\s+/).includes(token.slice(1))) return true;
        }
      }
      return false;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      if (this._queryOverride) return this._queryOverride(sel);
      const out = [];
      for (const child of children) {
        if (child.matches?.(sel)) out.push(child);
        if (child.querySelectorAll) out.push(...child.querySelectorAll(sel));
      }
      return out;
    },
  };
  return el;
}

const docListeners = new Map();
const bodyEl = createMockElement("body");
globalThis.document = {
  ...globalThis.document,
  body: bodyEl,
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement(tag) { return createMockElement(tag); },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type).add(fn);
  },
  removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
};

function dispatchDocKey(key, extra = {}) {
  let prevented = false;
  let stopped = false;
  const event = {
    key,
    shiftKey: false,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
    ...extra,
  };
  for (const fn of [...(docListeners.get("keydown") || [])]) fn(event);
  return { prevented, stopped };
}

const { mergeUpNextCandidates } = await import("../server/src/utils/upNextIdentity.js");
const { sessionMatchesCardArt } = await import("../public/modules/dashboard-modern.js");
const { reconcileDashboardCardRow } = await import("../public/modules/dashboard.js");
const { state } = await import("../public/modules/state.js");
const {
  UP_NEXT_DISMISSED_KEY,
  initUpNext,
  loadUpNext,
  resetUpNext,
  restoreDismissedUpNextItems,
} = await import("../public/modules/up-next.js");
const { openConfirmDialog } = await import("../public/modules/utils.js");
const { chooseUpNextAddOptions } = await import("../public/modules/up-next-shared.js");
const { handleConfig } = await import("../server/src/routes/admin.js");
const { signSession, sessionCookieName, resolveSessionTenantContext } = await import("../server/src/utils/auth.js");
const { addUserAccount, USER_ROLE } = await import("../server/src/utils/tenancy.js");
const { runWithUserContext } = await import("../server/src/utils/userContext.js");
const { closeAllTenantDatabases } = await import("../server/src/utils/tenantDatabase.js");
const { loadMediaConfig } = await import("../server/src/utils/configStore.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("mergeUpNextCandidates preserves up_next_lane when merging a rewatch row with a provider resume", () => {
  const merged = mergeUpNextCandidates([
    {
      media_type: "episode",
      queue_kind: "next_up",
      show_title: "Slow Horses",
      season: 1,
      episode: 3,
      show_tmdb_id: "95480",
      up_next_lane: "rewatch",
      source: "history",
      updated_at: 1000,
    },
    {
      media_type: "episode",
      queue_kind: "resume",
      show_title: "Slow Horses",
      season: 1,
      episode: 3,
      show_tmdb_id: "95480",
      position_ms: 120000,
      duration_ms: 3000000,
      playback_position_known: true,
      source: "plex",
      updated_at: 2000,
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].queue_kind, "resume");
  assert.equal(merged[0].up_next_lane, "rewatch");
});

test("sessionMatchesCardArt rejects same-title shows whose canonical ids conflict", () => {
  const scrubs2001Session = {
    mediaType: "episode",
    showTitle: "Scrubs",
    season: 1,
    episode: 2,
    ids: { tmdb: "4556", tvdb: "76156", imdb: "tt0285403" },
  };
  const scrubs2001Card = "episode|4556|76156|tt0285403|1x2 scrubs";
  const scrubs2026Card = "episode|295778|465690|tt40197357|1x2 scrubs";
  assert.equal(sessionMatchesCardArt(scrubs2001Session, scrubs2001Card), true);
  assert.equal(sessionMatchesCardArt(scrubs2001Session, scrubs2026Card), false);
});

test("reconcileDashboardCardRow renders non-card error alert alongside cards and removes it on recovery", () => {
  const prevCreate = globalThis.document.createElement;
  const makeNode = (tag, attrs = {}, className = "", text = "") => {
    const node = createMockElement(tag);
    node.className = className;
    node.textContent = text;
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  // Simple template parser for alert + keyed cards.
  globalThis.document.createElement = (tag) => {
    if (tag !== "template") return createMockElement(tag);
    const tpl = { content: { children: [] } };
    Object.defineProperty(tpl, "innerHTML", {
      set(html) {
        const nodes = [];
        if (String(html).includes('role="alert"')) {
          nodes.push(makeNode("div", { role: "alert" }, "empty-log up-next-empty-state", "Showing the last loaded queue."));
        }
        const cardMatches = [...String(html).matchAll(/data-up-next-card-id="([^"]+)"/g)];
        for (const match of cardMatches) {
          nodes.push(makeNode("article", { "data-up-next-card-id": match[1] }, "dashboard-up-next-card", match[1]));
        }
        tpl.content.children = nodes;
      },
    });
    return tpl;
  };
  try {
    const row = createMockElement("div");
    row.appendChild(makeNode("article", { "data-up-next-card-id": "card-1" }, "dashboard-up-next-card", "card-1"));
    assert.equal(row.children.length, 1);
    assert.equal(row.children[0].getAttribute("data-up-next-card-id"), "card-1");

    // Reconcile with alert + existing card: alert must appear before card.
    reconcileDashboardCardRow(
      row,
      '<div role="alert">error</div><article data-up-next-card-id="card-1"></article>',
    );
    assert.equal(row.children.length, 2);
    assert.equal(row.children[0].getAttribute("role"), "alert");
    assert.equal(row.children[1].getAttribute("data-up-next-card-id"), "card-1");

    // Recovery: alert must be cleared while card remains.
    reconcileDashboardCardRow(row, '<article data-up-next-card-id="card-1"></article>');
    assert.equal(row.children.length, 1);
    assert.equal(row.children[0].getAttribute("data-up-next-card-id"), "card-1");
  } finally {
    globalThis.document.createElement = prevCreate;
  }
});

test("cross-account switch mid-fetch rejects late Up Next and dismissed responses even when token is unchanged", async () => {
  const prevFetch = globalThis.fetch;
  let resolveUpNext;
  let resolveDismissed;
  globalThis.fetch = (url) => {
    const path = String(url);
    if (path.startsWith("/api/up-next?")) {
      return new Promise((resolve) => { resolveUpNext = resolve; });
    }
    if (path === "/api/up-next/dismissed") {
      return new Promise((resolve) => { resolveDismissed = resolve; });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ items: [] }) });
  };
  try {
    state.token = "cookie-session";
    state.currentUser = { uid: "u1", activeUser: "alice", username: "alice" };
    state.activeView = "dashboard";
    resetUpNext();

    const loading = loadUpNext({ force: true });
    // Cookie-session user switches to Bob without changing state.token.
    state.currentUser = { uid: "u2", activeUser: "bob", username: "bob" };
    resolveUpNext({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: "alice-card", media_type: "movie", title: "Alice Movie" }] }),
    });
    await loading;
    assert.deepEqual(state.upNextItems, [], "late Up Next response from Alice must not populate Bob's rail");

    // Now test late dismissed response rejection after account switch.
    state.currentUser = { uid: "u1", activeUser: "alice", username: "alice" };
    resetUpNext();
    const loading2 = loadUpNext({ force: true });
    resolveUpNext({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: "alice-card", media_type: "movie", title: "Alice Movie" }] }),
    });
    await loading2;
    assert.equal(state.upNextItems.length, 1);
    // Switch account before dismissed fetch finishes.
    state.currentUser = { uid: "u2", activeUser: "bob", username: "bob" };
    state.upNextDismissed = [];
    resolveDismissed?.({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: "alice-dismissed", title: "Alice Hidden" }] }),
    });
    await settle();
    assert.deepEqual(state.upNextDismissed, [], "late dismissed response from Alice must be discarded for Bob");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("restoreDismissedUpNextItems handles bulk all, zero, partial, and mid-flight account switches", async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  let mode = "bulk";
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path === "/api/up-next/restore") {
      if (mode === "zero") return { ok: true, status: 200, json: async () => ({ ok: true, restored: 0 }) };
      if (mode === "partial") return { ok: true, status: 200, json: async () => ({ ok: true, restored: body.id === "d1" ? 1 : 0 }) };
      if (mode === "switch") {
        state.currentUser = { uid: "u2", activeUser: "bob", username: "bob" };
        return { ok: true, status: 200, json: async () => ({ ok: true, restored: 1 }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, restored: 3 }) };
    }
    if (path === "/api/up-next/dismissed") return { ok: true, status: 200, json: async () => ({ items: [] }) };
    return { ok: true, status: 200, json: async () => ({ items: [], upNextVersion: 4 }) };
  };
  try {
    state.token = "cookie-session";
    state.currentUser = { uid: "u1", activeUser: "alice", username: "alice" };
    state.activeView = "dashboard";
    resetUpNext();

    // Bulk all sends a single { all: true } request and awaits committed server reload.
    mode = "bulk";
    calls.length = 0;
    const bulkCount = await restoreDismissedUpNextItems([{ id: "d1" }, { id: "d2" }, { id: "d3" }], { all: true });
    assert.equal(bulkCount, 3);
    const restoreCalls = calls.filter((c) => c.path === "/api/up-next/restore");
    assert.equal(restoreCalls.length, 1);
    assert.deepEqual(restoreCalls[0].body, { all: true });
    assert.ok(calls.some((c) => c.path.startsWith("/api/up-next?refresh=1")), "waits for committed server queue reload");

    // Zero restore skips refresh.
    mode = "zero";
    calls.length = 0;
    const zeroCount = await restoreDismissedUpNextItems([{ id: "d1" }]);
    assert.equal(zeroCount, 0);
    assert.equal(calls.filter((c) => c.path.startsWith("/api/up-next?")).length, 0);

    // Partial restore reports actual server count.
    mode = "partial";
    calls.length = 0;
    const partialCount = await restoreDismissedUpNextItems([{ id: "d1" }, { id: "d2" }]);
    assert.equal(partialCount, 1);

    // Account switch mid-restore cancels follow-up refresh and returns 0.
    mode = "switch";
    calls.length = 0;
    const switchedCount = await restoreDismissedUpNextItems([{ id: "d1" }]);
    assert.equal(switchedCount, 0);
    assert.equal(calls.filter((c) => c.path.startsWith("/api/up-next?")).length, 0);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("stalled Up Next read preserves remembered cards with an error and recovers on retry", async () => {
  const prevFetch = globalThis.fetch;
  let failNext = true;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/api/up-next?")) {
      if (failNext) throw Object.assign(new Error("timed out"), { name: "AbortError" });
      return { ok: true, status: 200, json: async () => ({ items: [{ id: "fresh-1", media_type: "movie", title: "Fresh Movie" }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  try {
    state.token = "cookie-session";
    state.currentUser = { uid: "u1", activeUser: "alice", username: "alice" };
    state.activeView = "dashboard";
    resetUpNext();
    state.upNextItems = [{ id: "cached-1", media_type: "movie", title: "Remembered Movie" }];

    await loadUpNext({ force: true });
    assert.equal(state.upNextErrorCode, "TIMEOUT");
    assert.equal(state.upNextItems.length, 1, "remembered cards stay visible when revalidation stalls");
    assert.equal(state.upNextItems[0].id, "cached-1");

    // Subsequent retry recovers cleanly.
    failNext = false;
    await loadUpNext({ force: true });
    assert.equal(state.upNextError, "");
    assert.equal(state.upNextErrorCode, "");
    assert.equal(state.upNextItems[0].id, "fresh-1");
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("legacy dismissal migration prompts before importing and retains failed keys for retry", async () => {
  const prevFetch = globalThis.fetch;
  const prevCreate = globalThis.document.createElement;
  const messages = [];
  initUpNext({ setMessage: (msg, tone) => messages.push({ msg, tone }) });

  // Intercept openConfirmDialog overlay so we can simulate cancel then confirm.
  let dialogChoice = "cancel";
  globalThis.document.createElement = (tag) => {
    const el = createMockElement(tag);
    if (tag === "div") {
      const confirmBtn = createMockElement("button");
      const cancelBtn = createMockElement("button");
      el._queryOverride = (sel) => {
        if (sel === ".confirm-dialog-confirm") return [confirmBtn];
        if (sel === ".confirm-dialog-cancel") return [cancelBtn];
        return [];
      };
      const origAppend = bodyEl.appendChild.bind(bodyEl);
      bodyEl.appendChild = (child) => {
        const res = origAppend(child);
        queueMicrotask(() => {
          if (dialogChoice === "confirm") confirmBtn.dispatch("click");
          else cancelBtn.dispatch("click");
        });
        return res;
      };
    }
    return el;
  };

  const removePosts = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.startsWith("/api/up-next?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            { id: "m1", media_type: "movie", title: "Movie One", tmdb_id: "101" },
            { id: "m2", media_type: "movie", title: "Movie Two", tmdb_id: "202" },
          ],
        }),
      };
    }
    if (path === "/api/up-next/remove") {
      const body = JSON.parse(init.body);
      removePosts.push(body);
      // Succeed on Movie One, fail on Movie Two.
      if (body.tmdb_id === "101") return { ok: true, status: 200, json: async () => ({ ok: true, imported: true }) };
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };

  try {
    const legacyKey1 = "m1";
    const legacyKey2 = "m2";
    globalThis.localStorage.setItem(UP_NEXT_DISMISSED_KEY, JSON.stringify({ [legacyKey1]: 1000, [legacyKey2]: 1000 }));

    // Account 1 cancels: keys stay intact and zero POSTs sent.
    dialogChoice = "cancel";
    state.token = "tok";
    state.currentUser = { uid: "cancel-user", activeUser: "cancel-user", username: "cancel-user" };
    state.activeView = "dashboard";
    resetUpNext();
    await loadUpNext({ force: true });
    await settle();
    await settle();
    assert.equal(removePosts.length, 0);
    const afterCancel = JSON.parse(globalThis.localStorage.getItem(UP_NEXT_DISMISSED_KEY));
    assert.equal(afterCancel[legacyKey1], 1000);
    assert.equal(afterCancel[legacyKey2], 1000);

    // Account 2 confirms: Movie One imported & deleted; failed Movie Two retained with retry message.
    dialogChoice = "confirm";
    state.currentUser = { uid: "confirm-user", activeUser: "confirm-user", username: "confirm-user" };
    resetUpNext();
    await loadUpNext({ force: true });
    await settle();
    await settle();
    assert.equal(removePosts.length, 2);
    const afterPartial = JSON.parse(globalThis.localStorage.getItem(UP_NEXT_DISMISSED_KEY));
    assert.equal(afterPartial[legacyKey1], undefined, "imported key removed");
    assert.equal(afterPartial[legacyKey2], 1000, "failed key retained for retry");
    assert.ok(messages.some((m) => m.msg.includes("Some old dismissals could not be imported")));
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.document.createElement = prevCreate;
    bodyEl.appendChild = createMockElement("body").appendChild;
  }
});

test("openConfirmDialog and chooseUpNextAddOptions enforce ARIA dialog role, Escape, Tab trap, focus return, and keyboard-safe season select", async () => {
  const prevCreate = globalThis.document.createElement;
  const opener = createMockElement("button");
  opener.focus();

  let lastOverlay = null;
  let lastControls = {};
  globalThis.document.createElement = (tag) => {
    const el = createMockElement(tag);
    if (tag === "div") {
      const confirmBtn = createMockElement("button");
      const cancelBtn = createMockElement("button");
      const earliestRadio = createMockElement("input");
      earliestRadio.checked = true;
      const seasonRadio = createMockElement("input");
      seasonRadio.checked = false;
      const seasonSelect = createMockElement("select");
      seasonSelect.value = "2";
      lastControls = { confirmBtn, cancelBtn, earliestRadio, seasonRadio, seasonSelect };
      el._queryOverride = (sel) => {
        if (sel === ".confirm-dialog-confirm") return [confirmBtn];
        if (sel === ".confirm-dialog-cancel") return [cancelBtn];
        if (sel === 'input[name="upNextAddMode"][value="earliest"]') return [earliestRadio];
        if (sel === 'input[name="upNextAddMode"][value="season"]') return [seasonRadio];
        if (sel === ".up-next-add-season-select") return [seasonSelect];
        if (sel.includes("button:not(:disabled)")) return [earliestRadio, seasonRadio, seasonSelect, confirmBtn, cancelBtn];
        return [];
      };
      lastOverlay = el;
    }
    return el;
  };

  try {
    // 1) openConfirmDialog sets dialog ARIA, traps Tab, closes on Escape, and returns focus to opener.
    const confirmPromise = openConfirmDialog({ title: "Confirm Action", body: "Check details", danger: true });
    assert.match(lastOverlay.innerHTML, /role="dialog" aria-modal="true" aria-label="Confirm Action"/);
    assert.equal(globalThis.document.activeElement, lastControls.cancelBtn);
    // Tab on last control wraps to first control.
    const tabRes = dispatchDocKey("Tab");
    assert.equal(tabRes.prevented, true);
    assert.equal(globalThis.document.activeElement, lastControls.earliestRadio);
    // Escape cancels and restores focus to opener.
    dispatchDocKey("Escape");
    assert.equal(await confirmPromise, false);
    assert.equal(globalThis.document.activeElement, opener);

    // 2) chooseUpNextAddOptions surfaces seasonLookupFailed warning and never switches radio on focus alone.
    const addPromise = chooseUpNextAddOptions(
      { title: "Test Show" },
      {
        seasonLookupFailed: true,
        warning: "Season options could not be loaded in full.",
        seasons: [
          { season_number: 1, episode_count: 10, watched_count: 1, has_unwatched: true },
          { season_number: 2, episode_count: 10, watched_count: 0, has_unwatched: true },
        ],
      },
    );
    assert.match(lastOverlay.innerHTML, /Season options could not be loaded in full\./);
    // Focus alone on seasonSelect must not check seasonRadio.
    lastControls.seasonSelect.focus();
    lastControls.seasonSelect.dispatch("focus");
    assert.equal(lastControls.seasonRadio.checked, false, "focus alone must not switch episode selection");
    // Explicit change selects seasonRadio.
    lastControls.seasonSelect.dispatch("change");
    assert.equal(lastControls.seasonRadio.checked, true);
    lastControls.confirmBtn.dispatch("click");
    assert.deepEqual(await addPromise, { targetSeason: 2 });
    assert.equal(globalThis.document.activeElement, opener);
  } finally {
    globalThis.document.createElement = prevCreate;
  }
});

test("non-admin users can save per-account nowPlaying and upNextSync config sections but not admin sections", async () => {
  const created = addUserAccount({ name: "regularuser", password: "regular-user-pass-123" });
  assert.ok(!created.status || created.status < 300, JSON.stringify(created.body || created));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cookieToken = signSession("regularuser", { role: USER_ROLE, activeUser: "regularuser" });
  const cookieName = sessionCookieName();
  const callConfig = async (payload) => {
    const req = {
      method: "POST",
      url: "/api/config",
      headers: { "content-type": "application/json", cookie: `${cookieName}=${cookieToken}` },
      cookies: { [cookieName]: cookieToken },
      get(name) { return this.headers[String(name).toLowerCase()] || ""; },
      body: payload,
      resume() {},
      ip: "127.0.0.1",
    };
    const res = { statusCode: 200, payload: null, headers: {} };
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (values) => { Object.assign(res.headers, values); return res; };
    res.send = (text) => { res.payload = text ? JSON.parse(text) : null; return res; };
    const tenant = resolveSessionTenantContext(req);
    assert.ok(tenant, "session resolves to non-admin tenant context");
    await runWithUserContext(tenant, () => handleConfig(req, res));
    const saved = await runWithUserContext(tenant, () => loadMediaConfig());
    return { status: res.statusCode, body: res.payload, saved };
  };

  try {
    // Allowed per-account sections succeed.
    const allowed = await callConfig({
      nowPlaying: { itemCount: 2 },
      upNextSync: { sort: "newly_aired", partWatchedFirst: true },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.saved.upNextSync?.sort, "newly_aired");

    // Admin-only section is rejected with 403.
    const blocked = await callConfig({
      tuning: { maxConcurrent: 5 },
    });
    assert.equal(blocked.status, 403);
  } finally {
    closeAllTenantDatabases();
  }
});
