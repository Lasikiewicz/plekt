import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");

function createMinimalDom() {
  const docListeners = new Map();
  const winListeners = new Map();
  const elementsById = new Map();

  class FakeElement {
    constructor(tag = "div") {
      this.tagName = tag.toUpperCase();
      this._id = "";
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this._innerHTML = "";
      this.isConnected = false;
      this._listeners = new Map();
      const self = this;
      this.classList = {
        _set: new Set(),
        add(...cls) { cls.forEach((c) => this._set.add(c)); self.className = [...this._set].join(" "); },
        remove(...cls) { cls.forEach((c) => this._set.delete(c)); self.className = [...this._set].join(" "); },
        toggle(c, force) {
          const on = force === undefined ? !this._set.has(c) : Boolean(force);
          if (on) this._set.add(c); else this._set.delete(c);
          self.className = [...this._set].join(" ");
        },
        contains(c) { return this._set.has(c); },
      };
    }
    get id() { return this._id; }
    set id(v) {
      if (this._id && elementsById.get(this._id) === this) elementsById.delete(this._id);
      this._id = String(v || "");
      if (this._id && this.isConnected) elementsById.set(this._id, this);
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
      this._innerHTML = String(html ?? "");
      this.children = [];
    }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = true;
      if (child.id) elementsById.set(child.id, child);
      this.children.push(child);
      return child;
    }
    remove() {
      this.isConnected = false;
      if (this.id && elementsById.get(this.id) === this) elementsById.delete(this.id);
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
    }
    contains(node) { return node === this || this.children.some((c) => c.contains?.(node)); }
    getBoundingClientRect() { return { left: 20, bottom: 40, top: 10, right: 120, width: 100, height: 30 }; }
    scrollIntoView() {}
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set());
      this._listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
    querySelector(sel) {
      if (sel === ".avail-issue-close") {
        const btn = new FakeElement("button");
        btn.classList.add("avail-issue-close");
        this.appendChild(btn);
        return btn;
      }
      return null;
    }
    querySelectorAll() { return []; }
  }

  const body = new FakeElement("body");
  body.isConnected = true;

  const doc = {
    body,
    visibilityState: "visible",
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => elementsById.get(id) || null,
    querySelector: (sel) => (sel.startsWith("#") ? elementsById.get(sel.slice(1)) || null : null),
    querySelectorAll: () => [],
    addEventListener: (type, fn, capture = false) => {
      const key = `${type}:${Boolean(capture)}`;
      if (!docListeners.has(key)) docListeners.set(key, new Set());
      docListeners.get(key).add(fn);
    },
    removeEventListener: (type, fn, capture = false) => {
      const key = `${type}:${Boolean(capture)}`;
      docListeners.get(key)?.delete(fn);
    },
  };

  const win = {
    location: { origin: "http://localhost:5055", pathname: "/", search: "", hash: "", hostname: "localhost", port: "5055", protocol: "http:" },
    innerWidth: 1280,
    scrollX: 0,
    scrollY: 0,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (type, fn) => {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { winListeners.get(type)?.delete(fn); },
  };

  const storageMap = new Map();
  const storage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => { storageMap.set(String(k), String(v)); },
    removeItem: (k) => { storageMap.delete(String(k)); },
    clear: () => { storageMap.clear(); },
  };
  const hist = { state: null, replaceState() {}, pushState() {} };

  return { FakeElement, doc, win, docListeners, winListeners, storage, hist };
}

function installDom(dom) {
  const prev = {
    document: globalThis.document,
    window: globalThis.window,
    history: globalThis.history,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
  };
  globalThis.document = dom.doc;
  globalThis.window = dom.win;
  globalThis.history = dom.hist;
  globalThis.localStorage = dom.storage;
  globalThis.location = dom.win.location;
  return () => {
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.history = prev.history;
    globalThis.localStorage = prev.localStorage;
    globalThis.location = prev.location;
  };
}

test("Step 1: showAvailIssuePopup splits on real newlines and cleans up prior document listeners", async () => {
  const dom = createMinimalDom();
  const restoreDom = installDom(dom);
  const { FakeElement, doc, docListeners } = dom;
  try {
    const { showAvailIssuePopup } = await import("../public/modules/sync.js?v=2.3.0.0.1");
    const anchor = new FakeElement("button");
    anchor.dataset.availIssue = "Show missing on Emby\n1. Open Emby\n2. Scan library";

    showAvailIssuePopup(anchor);
    const firstPopup = doc.getElementById("avail-issue-popup");
    assert.ok(firstPopup);
    assert.match(firstPopup.innerHTML, /Show missing on Emby/);
    assert.match(firstPopup.innerHTML, /<li>Open Emby<\/li>/);
    assert.match(firstPopup.innerHTML, /<li>Scan library<\/li>/);

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(docListeners.get("click:true")?.size, 1);
    assert.equal(docListeners.get("keydown:false")?.size, 1);

    // Reopening must tear down the prior popup's document listeners instead of leaking them
    showAvailIssuePopup(anchor);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(docListeners.get("click:true")?.size, 1);
    assert.equal(docListeners.get("keydown:false")?.size, 1);
  } finally {
    restoreDom();
  }
});

test("Step 1: live-updates stops reconnecting on 401 and applies exponential backoff on 500", async () => {
  const prevFetch = globalThis.fetch;
  const dom = createMinimalDom();
  const restoreDom = installDom(dom);
  const { win } = dom;
  const scheduledDelays = [];
  win.setTimeout = (fn, delay) => {
    scheduledDelays.push(delay);
    return setTimeout(fn, 5);
  };
  try {
    const { startLiveUpdates, stopLiveUpdates } = await import("../public/modules/live-updates.js?v=2.3.0.0.1");

    // 401 must immediately stop without scheduling a reconnect
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { status: 401, ok: false, body: null };
    };
    startLiveUpdates({ authHeaders: () => ({}), reconnectMs: 1000, maxReconnectMs: 8000 });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(calls, 1);
    assert.deepEqual(scheduledDelays, []);

    // 500 errors must back off exponentially (1000, 2000, 4000)
    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls >= 4) stopLiveUpdates();
      return { status: 500, ok: false, body: null };
    };
    startLiveUpdates({ authHeaders: () => ({}), reconnectMs: 1000, maxReconnectMs: 8000 });
    await new Promise((r) => setTimeout(r, 80));
    stopLiveUpdates();
    assert.deepEqual(scheduledDelays.slice(0, 3), [1000, 2000, 4000]);
  } finally {
    globalThis.fetch = prevFetch;
    restoreDom();
  }
});

test("Step 1 & 2: prepareInlineMediaDetail unhides explorerPanel and clearMediaDetailState runs registered cleanups", async () => {
  const dom = createMinimalDom();
  const restoreDom = installDom(dom);
  const { FakeElement, doc } = dom;
  try {
    const { state, elements } = await import("../public/modules/state.js?v=2.3.0.0.1");
    const {
      initMediaDetail,
      prepareInlineMediaDetail,
      registerMediaDetailCleanup,
      clearMediaDetailState,
    } = await import("../public/modules/media-detail-context.js?v=2.3.0.0.1");

    const explorerPanel = new FakeElement("div");
    explorerPanel.id = "explorerPanel";
    explorerPanel.hidden = true;
    doc.body.appendChild(explorerPanel);

    const droppedPanel = new FakeElement("div");
    droppedPanel.id = "explorerDroppedPanel";
    droppedPanel.hidden = false;
    doc.body.appendChild(droppedPanel);

    elements.explorerPanel = explorerPanel;
    elements.explorerTopbarControls = new FakeElement("div");
    elements.alphaFilterNav = new FakeElement("div");
    initMediaDetail({
      selectView: () => {},
      syncPageTopbar: () => {},
    });

    state.mediaDetailInline = false;
    prepareInlineMediaDetail("shows");
    assert.equal(explorerPanel.hidden, false);
    assert.equal(droppedPanel.hidden, true);

    let cleaned = 0;
    registerMediaDetailCleanup(() => { cleaned += 1; });
    clearMediaDetailState();
    clearMediaDetailState();
    assert.equal(cleaned, 1, "Cleanup callback should run once on clearMediaDetailState()");
  } finally {
    restoreDom();
  }
});

test("Step 2: loadStats({ force: true }) supersedes in-flight request so newer period wins", async () => {
  const prevFetch = globalThis.fetch;
  const dom = createMinimalDom();
  const restoreDom = installDom(dom);
  try {
    const { state } = await import("../public/modules/state.js?v=2.3.0.0.1");
    const { loadStats } = await import("../public/modules/stats.js?v=2.3.0.0.1");
    state.token = "test-session";
    state.statsLoaded = false;
    state.statsLoading = false;
    state.statsPeriodType = "year";
    state.statsPeriodValue = "2025";

    const resolvers = [];
    globalThis.fetch = (url) => new Promise((resolve) => {
      resolvers.push({ url: String(url), resolve });
    });

    const p1 = loadStats({ force: true });
    state.statsPeriodValue = "2026";
    const p2 = loadStats({ force: true });
    assert.equal(resolvers.length, 2, "Second forced loadStats must not be dropped while first is in flight");

    // Resolve newer request first, then stale first request
    resolvers[1].resolve({ ok: true, json: async () => ({ stats: { period: "2026", totalPlays: 20 } }) });
    await p2;
    assert.equal(state.stats.period, "2026");

    resolvers[0].resolve({ ok: true, json: async () => ({ stats: { period: "2025", totalPlays: 10 } }) });
    await p1;
    assert.equal(state.stats.period, "2026", "Stale first response must not overwrite newer period stats");
    assert.equal(state.statsLoading, false);
  } finally {
    globalThis.fetch = prevFetch;
    restoreDom();
  }
});

test("Step 2: loadPersonalMedia({ force: true }) during an in-flight load queues a fresh reload", async () => {
  const prevFetch = globalThis.fetch;
  const dom = createMinimalDom();
  const restoreDom = installDom(dom);
  try {
    const { state } = await import("../public/modules/state.js?v=2.3.0.0.1");
    const { loadPersonalMedia } = await import("../public/modules/personal-media.js?v=2.3.0.0.1");
    state.token = "test-session";
    state.personalMediaLoadedAt = 0;

    let fetchCount = 0;
    let resolveFirst;
    globalThis.fetch = () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, json: async () => ({ ratings: [], watchlist: [{ media_type: "movie", title: "Old" }], lists: [] }) });
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ ratings: [], watchlist: [{ media_type: "movie", title: "Fresh" }], lists: [] }) });
    };

    const first = loadPersonalMedia();
    const forced = loadPersonalMedia({ force: true });
    resolveFirst();
    await Promise.all([first, forced]);

    assert.equal(fetchCount, 2, "Forced reload while initial load was in flight must perform a second fetch");
    assert.equal(state.personalWatchlist[0]?.title, "Fresh");
  } finally {
    globalThis.fetch = prevFetch;
    restoreDom();
  }
});

test("Step 1 & 2: static UI lifecycle and leak regression checks", () => {
  const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const demoIdx = appJs.indexOf('isDemoMode() && (');
  const syncActIdx = appJs.indexOf('pathname === "/sync-activity")');
  assert.ok(demoIdx > 0 && syncActIdx > 0 && demoIdx < syncActIdx, "Demo mode route guard must precede /sync-activity");
  assert.match(appJs, /async function lockDashboard\(\)[\s\S]{0,250}stopLiveUpdates\(\);/);
  assert.match(appJs, /async function lockDashboard\(\)[\s\S]{0,250}deferredStatusToken = "";/);

  const appEventsJs = fs.readFileSync(path.join(root, "public/modules/app-events.js"), "utf8");
  assert.doesNotMatch(appEventsJs, /elements\.syncAttention\?\./);
  assert.match(appEventsJs, /elements\.syncActivityAttention\?\.addEventListener\("keydown"/);

  const settingsUiJs = fs.readFileSync(path.join(root, "public/modules/settings-ui.js"), "utf8");
  assert.match(settingsUiJs, /await onSave\(collectValues\(dialog\), ui\);[\s\S]{0,160}finally\s*\{\s*setBusy\(false\);\s*\}/);
});

test("Step 3: check-worker-health probes HTTP liveness for ROLE=web and supports legacy tenant DB path", async (t) => {
  const { runHealthCheck } = await import("../scripts/check-worker-health.js");
  const { legacyDbFileName } = await import("../server/src/paths.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plekt-health-step3-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const rootDb = new Database(path.join(dir, "plekt.db"));
  rootDb.exec("CREATE TABLE scheduler_lease (id TEXT PRIMARY KEY, holder_id TEXT, expires_at INTEGER)");
  rootDb.prepare("INSERT INTO scheduler_lease (id, holder_id, expires_at) VALUES ('scheduler', NULL, NULL)").run();
  rootDb.close();

  // ROLE=web must fail if local HTTP server is not answering
  const deadWebOk = await runHealthCheck({
    dataDir: dir,
    role: "web",
    demoMode: false,
    port: 1,
    probeWeb: async () => false,
  });
  assert.equal(deadWebOk, false);

  // ROLE=web passes against a live HTTP /api/ping endpoint
  const server = http.createServer((req, res) => {
    if (req.url === "/api/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();

  const liveWebOk = await runHealthCheck({ dataDir: dir, role: "web", demoMode: false, port });
  assert.equal(liveWebOk, true);

  // Legacy tenant DB file is checked (invalid schema fails, valid schema passes)
  const tenantDir = path.join(dir, "users", "legacyuser");
  const legacyDb = path.join(tenantDir, legacyDbFileName());
  fs.mkdirSync(tenantDir, { recursive: true });
  fs.writeFileSync(path.join(dir, "users.json"), JSON.stringify({ users: [{ name: "legacyuser", role: "user" }] }));
  const brokenLegacyDb = new Database(legacyDb);
  brokenLegacyDb.exec("CREATE TABLE dummy (id INTEGER)");
  brokenLegacyDb.close();

  const badTenantOk = await runHealthCheck({ dataDir: dir, role: "web", demoMode: false, port });
  assert.equal(badTenantOk, false, "Corrupt/missing-schema legacy tenant DB must fail healthcheck");

  const fixedLegacyDb = new Database(legacyDb);
  fixedLegacyDb.exec("CREATE TABLE scheduler_lease (id TEXT PRIMARY KEY, holder_id TEXT, expires_at INTEGER)");
  fixedLegacyDb.close();
  const goodTenantOk = await runHealthCheck({ dataDir: dir, role: "web", demoMode: false, port });
  assert.equal(goodTenantOk, true);
});

test("Step 3: docker-publish.yml builds linux/amd64,linux/arm64 with QEMU and .dockerignore scopes scripts/*", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/docker-publish.yml"), "utf8");
  assert.match(workflow, /uses:\s*docker\/setup-qemu-action@v4/);
  const buildPushCount = (workflow.match(/uses:\s*docker\/build-push-action@v7/g) || []).length;
  const multiArchCount = (workflow.match(/platforms:\s*linux\/amd64,linux\/arm64/g) || []).length;
  assert.equal(buildPushCount, 3);
  assert.equal(multiArchCount, 3, "All three docker/build-push-action steps must specify linux/amd64,linux/arm64");

  const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^scripts\/\*$/m);
  assert.doesNotMatch(dockerignore, /^!scripts\/$/m);
  assert.match(dockerignore, /^!scripts\/seed-demo-catalog\.js$/m);
  assert.match(dockerignore, /^!scripts\/check-worker-health\.js$/m);
});
