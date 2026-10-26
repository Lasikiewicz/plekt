import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class MiniClassList {
  constructor(node) { this.node = node; }
  _set() { return new Set(String(this.node.className || "").split(/\s+/).filter(Boolean)); }
  add(...names) { const set = this._set(); names.forEach((name) => set.add(name)); this.node.className = [...set].join(" "); }
  remove(...names) { const set = this._set(); names.forEach((name) => set.delete(name)); this.node.className = [...set].join(" "); }
  toggle(name, force) {
    const set = this._set();
    const enabled = force === undefined ? !set.has(name) : Boolean(force);
    enabled ? set.add(name) : set.delete(name);
    this.node.className = [...set].join(" ");
    return enabled;
  }
  contains(name) { return this._set().has(name); }
}

class MiniElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = {};
    this.className = "";
    this.classList = new MiniClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this._value = "";
    this._textContent = "";
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  add(option) { this.append(option); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async click() { if (this.disabled) return; for (const fn of this.listeners.click || []) await fn({ target: this }); }
  async change() { for (const fn of this.listeners.change || []) await fn({ target: this }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  get options() { return this.children; }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const match = (node) => {
      if (selector === "select") return node.tagName === "SELECT";
      if (selector === "button") return node.tagName === "BUTTON";
      if (selector === 'input[type="radio"]' || selector === 'input[type="radio"]:checked') return node.tagName === "INPUT" && node.type === "radio" && (selector.endsWith(":checked") ? Boolean(node.checked) : true);
      if (selector === "[data-review-rows]") return node.dataset.reviewRows !== undefined;
      if (selector === "details.netflix-review-group") return node.tagName === "DETAILS" && node.classList.contains("netflix-review-group");
      const data = selector.match(/^\[data-([a-z-]+)\]$/);
      if (data) return node.dataset[data[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] !== undefined;
      return false;
    };
    const found = [];
    const visit = (node) => { for (const child of node.children) { if (match(child)) found.push(child); visit(child); } };
    visit(this);
    return found;
  }
}

class MiniDocument {
  constructor() { this.ids = new Map(); }
  add(id) { const node = new MiniElement(); this.ids.set(id, node); return node; }
  getElementById(id) { return this.ids.get(id) || null; }
  createElement(tag) { return new MiniElement(tag); }
  querySelectorAll(selector) {
    const match = selector.match(/^#([^ ]+) (.+)$/);
    return match ? (this.getElementById(match[1])?.querySelectorAll(match[2]) || []) : [];
  }
}

class MiniOption extends MiniElement {
  constructor(text, value) { super("option"); this.textContent = text; this.value = value; }
}

test("Netflix selects the only usable CSV profile and leaves multiple profiles unselected", async () => {
  const previous = globalThis.document;
  const document = new MiniDocument();
  document.add("netflixProfileChoice");
  const list = document.add("netflixProfileList");
  globalThis.document = document;
  try {
    const source = (await readFile(new URL("../public/modules/netflix-import.js", import.meta.url), "utf8"))
      .replace(/^import .*;$/gm, "");
    const { profiles } = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport function profiles(csv) { activity = readActivity(csv); renderProfiles(); }`).toString("base64")}`);
    const header = "Profile Name,Start Time,Title,Duration,Supplemental Video Type\n";
    const king = "King,2026-01-01 12:00:00,Sample Film,01:00:00,\n";
    profiles(header + king + "Other,2026-01-01 12:00:00,Unknown Title (Episode 2),00:10:00,\n" + "Other,2026-01-01 12:00:00,: Episode 8,00:10:00,\n" + "Other,2026-01-01 12:00:00,Trailer,00:10:00,Trailer\n");
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].value, "King");
    assert.equal(list.children[0].children[0].checked, true);
    profiles(header + king + "Other,2026-01-01 12:00:00,Another Film,01:00:00,\n");
    assert.equal(list.children.length, 2);
    assert.ok(list.children.every((label) => !label.children[0].checked));
  } finally {
    globalThis.document = previous;
  }
});

function makePreview() {
  return {
    ok: true, previewId: "preview-1", total: 2, matched: 0, matchedByYear: 0, skipped: 0, needsReview: 2,
    reviews: [{
      type: "show", groupId: "show-1", show: "The Sample Show", showTmdbId: "", showCandidates: [
        { id: 100, title: "The Sample Show", year: 2020, mediaType: "tv", netflixEvidence: { kind: "paired_title" } },
        { id: 200, title: "The Sample Show (Other)", year: 2021, mediaType: "tv" },
      ],
      episodes: [
        { row: 1, title: "First Night", watchedAt: "2024-01-01T12:00:00.000Z", candidates: [
          { id: 100, title: "First Night", season: 1, episode: 1 },
          { id: 101, title: "Opening", season: 1, episode: 1 },
        ], seasonHint: 1, episodeHint: null, showTmdbId: "" },
        { row: 2, title: "Second Night", watchedAt: "2024-01-02T12:00:00.000Z", candidates: [
          { id: 102, title: "Second Night", season: 1, episode: 2 },
        ], seasonHint: 1, episodeHint: null, showTmdbId: "" },
      ],
    }],
  };
}

test("Netflix show review supports show rematching, preserves valid row choices, and applies explicit season and skip actions", async () => {
  const previous = { document: globalThis.document, Option: globalThis.Option, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const document = new MiniDocument();
  const file = document.add("netflixCsvFile");
  file.files = [{ text: async () => "Title,Date\nThe Sample Show: First Night,1/1/24" }];
  const root = document.add("netflixReviewList");
  const summary = document.add("netflixImportSummary");
  const status = document.add("netflixImportStatus");
  document.add("netflixImportProgress");
  document.add("netflixImportProgressBar");
  const previewButton = document.add("netflixPreviewButton");
  const importButton = document.add("netflixImportButton");
  document.add("netflixImportFileStatus");
  globalThis.document = document;
  globalThis.Option = MiniOption;
  globalThis.setTimeout = (callback) => { callback(); return 0; };
  const requests = [];
  let rematchResolve;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith("/preview/start")) return { ok: true, status: 200, json: async () => ({ ok: true, jobId: "job-1" }) };
    if (url.includes("/preview/status")) return { ok: true, status: 200, json: async () => ({ ...makePreview(), status: "complete" }) };
    if (url.endsWith("/preview/review")) return await new Promise((resolve) => { rematchResolve = resolve; });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const source = await readFile(new URL("../public/modules/netflix-import.js", import.meta.url), "utf8");
    const testable = source
      .replace(/import \{ state \} from "\.\/state\.js\?v=[^"]+";/, "const state = { token: '' };")
      .replace(/import \{ buildAuthHeaders \} from "\.\/auth\.js\?v=[^"]+";/, "const buildAuthHeaders = () => ({});");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(testable).toString("base64")}`;
    const { initNetflixImport } = await import(moduleUrl);
    initNetflixImport();
    await previewButton.click();
    assert.match(summary.textContent, /2\s*require review/i);
    assert.equal(summary.children[0].className, "netflix-summary-counts");
    assert.equal(summary.children[0].children.length, 5, "preview counts have separate boxes");
    assert.ok(summary.children[0].children.every((box) => box.className === "netflix-summary-box"));
    assert.equal(summary.children[1].tagName, "P", "review instructions sit beneath the boxes");
    let showSelect = root.querySelector("[data-show-group-id]");
    assert.ok(showSelect, "show identity has one selector at group level");
    assert.ok(showSelect.options.some((option) => option.textContent.includes("Netflix title alias")), "report-backed suggestion explains its evidence");
    assert.equal(root.querySelectorAll("[data-show-group-id]").length, 1, "episodes do not repeat show choices");
    const rowOne = root.querySelectorAll("[data-review-rows]").find((select) => select.dataset.reviewRows === "1");
    const rowTwo = root.querySelectorAll("[data-review-rows]").find((select) => select.dataset.reviewRows === "2");
    const choose = (group, value) => {
      for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = input.value === value;
    };
    const selected = (group) => group.querySelector('input[type="radio"]:checked')?.value || "";
    choose(rowOne, "101|1|1");
    choose(rowTwo, "102|1|2");
    const showChoice = showSelect.querySelectorAll('input[type="radio"]').find((input) => input.value === "100");
    for (const input of showSelect.querySelectorAll('input[type="radio"]')) input.checked = input === showChoice;
    const matchButton = root.children[0].querySelector("button");
    assert.equal(matchButton.textContent, "Match episodes");
    const pending = matchButton.click();
    assert.equal(previewButton.disabled, true, "new preview is blocked while rematching");
    assert.equal(importButton.disabled, true, "import is blocked while rematching");
    const body = JSON.parse(requests.at(-1).init.body);
    assert.deepEqual(body, { previewId: "preview-1", groupId: "show-1", tmdbId: "100" });
    const updated = makePreview();
    updated.matched = 1;
    updated.needsReview = 1;
    updated.reviews[0].showTmdbId = "100";
    updated.reviews[0].episodes[0].candidates = [{ id: 101, title: "Opening", season: 1, episode: 1 }];
    updated.reviews[0].episodes[1].candidates = [{ id: 103, title: "Later Night", season: 1, episode: 3 }];
    rematchResolve({ ok: true, status: 200, json: async () => updated });
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(status.textContent, "Episode matches updated. No history has been written yet.");
    const refreshedRows = root.querySelectorAll("[data-review-rows]");
    assert.equal(selected(refreshedRows.find((select) => select.dataset.reviewRows === "1")), "101|1|1", "still-valid row choice survives rematch");
    assert.equal(selected(refreshedRows.find((select) => select.dataset.reviewRows === "2")), "skip", "removed episode candidate is not kept as an invalid choice");
    const seasonUse = root.querySelectorAll("button").find((button) => button.textContent === "Use suggested matches for season 1");
    assert.ok(seasonUse);
    const previewText = root.textContent;
    assert.match(previewText, /First Night → S01E01 Opening/);
    await seasonUse.click();
    assert.equal(selected(refreshedRows.find((select) => select.dataset.reviewRows === "1")), "101|1|1", "explicit season action applies its displayed proposal");
    assert.equal(selected(refreshedRows.find((select) => select.dataset.reviewRows === "2")), "skip");
    const currentShowSelect = root.querySelector("[data-show-group-id]");
    const skipShow = currentShowSelect.querySelectorAll('input[type="radio"]').find((input) => input.value === "skip");
    for (const input of currentShowSelect.querySelectorAll('input[type="radio"]')) input.checked = input === skipShow;
    await skipShow.change();
    assert.ok(root.querySelectorAll("[data-review-rows]").filter((select) => select.dataset.groupId === "show-1").every((select) => selected(select) === "skip"));
    const rematchAgain = root.querySelectorAll("button").find((button) => button.textContent === "Match episodes");
    const staleRequest = rematchAgain.click();
    await file.change();
    rematchResolve({ ok: true, status: 200, json: async () => updated });
    await staleRequest;
    assert.equal(root.children.length, 0, "changing CSV discards a stale rematch response");
    assert.equal(importButton.disabled, true);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("Netflix rows without a show name do not appear in the review UI", async () => {
  const previous = { document: globalThis.document, Option: globalThis.Option, fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
  const document = new MiniDocument();
  const file = document.add("netflixCsvFile");
  file.files = [{ text: async () => "Title,Date\n: Episode 8,6/7/21" }];
  const root = document.add("netflixReviewList");
  const summary = document.add("netflixImportSummary");
  const status = document.add("netflixImportStatus");
  document.add("netflixImportProgress");
  document.add("netflixImportProgressBar");
  const previewButton = document.add("netflixPreviewButton");
  document.add("netflixImportButton");
  document.add("netflixImportFileStatus");
  globalThis.document = document;
  globalThis.Option = MiniOption;
  globalThis.setTimeout = (callback) => { callback(); return 0; };
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.endsWith("/preview/start")) return { ok: true, status: 200, json: async () => ({ ok: true, jobId: "job-2" }) };
    if (url.includes("/preview/status")) return { ok: true, status: 200, json: async () => ({ ok: true, previewId: "preview-2", total: 0, matched: 0, matchedByYear: 0, skipped: 0, needsReview: 0, reviews: [], status: "complete" }) };
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const source = await readFile(new URL("../public/modules/netflix-import.js", import.meta.url), "utf8");
    const testable = source
      .replace(/import \{ state \} from "\.\/state\.js\?v=[^"]+";/, "const state = { token: '' };")
      .replace(/import \{ buildAuthHeaders \} from "\.\/auth\.js\?v=[^"]+";/, "const buildAuthHeaders = () => ({});");
    const { initNetflixImport } = await import(`data:text/javascript;base64,${Buffer.from(testable).toString("base64")}`);
    initNetflixImport();
    await previewButton.click();
    assert.equal(root.children.length, 0, "unnamed episode rows create no review cards");
    assert.doesNotMatch(root.textContent, /Unknown show|Episode 8/);
    assert.equal(requests.some((url) => url.endsWith("/preview/review")), false);
  } finally {
    Object.assign(globalThis, previous);
  }
});

test("Netflix section boxes and cards declare rounded corners matching the app theme", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /--radius-sm:\s*8px;/);
  const targets = [
    ".netflix-file-picker",
    ".netflix-profile-list label",
    ".netflix-review-group",
    ".netflix-review-card",
    ".netflix-match-option",
    ".netflix-summary-box",
  ];
  for (const selector of targets) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`, "m");
    const match = css.match(regex);
    assert.ok(match, `rule for ${selector} should exist in public/styles.css`);
    assert.match(match[1], /border-radius:\s*var\(--radius\);/, `${selector} should use border-radius: var(--radius)`);
  }
});
