import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

const { state, elements } = await import("../public/modules/state.js");
const { initMediaDetail, mediaToolsActionHtml, prepareInlineMediaDetail, syncMediaActionsMenuState } = await import("../public/modules/media-detail-context.js");
const { renderMediaFacts } = await import("../public/modules/media-detail-shared.js");

function classListStub() {
  return {
    add() {},
    remove() {},
    contains() { return false; },
  };
}

function installMediaDetailDomStubs() {
  globalThis.document.getElementById = () => null;
  globalThis.document.querySelector = () => null;
  elements.explorerPanel = {
    innerHTML: "",
    scrollIntoView() {},
  };
  elements.explorerTopbarControls = { classList: classListStub() };
  elements.alphaFilterNav = { classList: classListStub() };
}

test("media options action includes an accessible decorative sliders icon", () => {
  const html = mediaToolsActionHtml();

  assert.match(html, /<summary class="action-pill actions-tools-trigger"[^>]*aria-label="Open media options"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false">[\s\S]*?<\/svg>/);
  assert.match(html, /<span>Options<\/span>/);
});

test("TV detail facts can stay open on mobile without changing movie defaults", () => {
  const previousWidth = window.innerWidth;
  window.innerWidth = 390;

  try {
    const collapsedMovieFacts = renderMediaFacts({}, "movie", "sidebar", { ratingsHtml: "<span>Ratings</span>" });
    const openShowFacts = renderMediaFacts({}, "tv", "sidebar", { ratingsHtml: "<span>Ratings</span>", openOnMobile: true });

    assert.match(collapsedMovieFacts, /<details class="media-facts-details">/);
    assert.match(openShowFacts, /<details class="media-facts-details" open>/);
  } finally {
    window.innerWidth = previousWidth;
  }
});

test("availability, Watch Now links, and ratings use rows in the media facts table", () => {
  const html = renderMediaFacts({
    original_language: "en",
    "watch/providers": {
      results: {
        GB: {
          flatrate: [{ provider_name: "Prime Video", logo_path: "/prime-video.png" }],
          link: "https://www.themoviedb.org/tv/1/watch",
        },
      },
    },
  }, "tv", "sidebar", {
    appLinksHtml: '<div class="media-app-links">Emby</div>',
    ratingsHtml: '<span class="rating-pill">IMDb 83%</span>',
  });

  assert.match(html, /media-fact-table-row media-fact-table-row--available[\s\S]*?media-fact-table-label">Available on[\s\S]*?media-provider-list/);
  assert.match(html, /media-fact-table-row media-fact-table-row--watch-now[\s\S]*?media-fact-table-label">Watch Now[\s\S]*?media-app-links/);
  assert.match(html, /media-fact-table-row media-fact-table-row--ratings[\s\S]*?media-fact-table-label">Ratings[\s\S]*?media-ratings-row/);
  assert.equal((html.match(/class="media-fact-table-row(?: media-fact-table-row--[\w-]+)?"/g) || []).length, 4);
  assert.doesNotMatch(html, /media-facts-bottom-group/);
});

test("mobile media actions move into Options beside the title and restore on desktop", () => {
  class StubNode {
    constructor(name, { nodeType = 1, classes = [] } = {}) {
      this.name = name;
      this.nodeType = nodeType;
      this.childNodes = [];
      this.parentNode = null;
      this.classes = new Set(classes);
      this.classList = {
        add: (value) => this.classes.add(value),
        remove: (value) => this.classes.delete(value),
        contains: (value) => this.classes.has(value),
      };
    }

    get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }

    appendChild(node) { return this.insertBefore(node, null); }

    insertBefore(node, referenceNode) {
      if (node.parentNode) node.parentNode.removeChild(node);
      const referenceIndex = referenceNode ? this.childNodes.indexOf(referenceNode) : -1;
      const insertIndex = referenceIndex < 0 ? this.childNodes.length : referenceIndex;
      this.childNodes.splice(insertIndex, 0, node);
      node.parentNode = this;
      return node;
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index >= 0) this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }

    replaceWith(node) {
      const parent = this.parentNode;
      if (!parent) return;
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = parent.childNodes.indexOf(this);
      parent.childNodes.splice(index, 1, node);
      node.parentNode = parent;
      this.parentNode = null;
    }

    remove() { this.parentNode?.removeChild(this); }

    contains(node) {
      return this.childNodes.some((child) => child === node || child.contains?.(node));
    }

    querySelector(selector) {
      const className = selector.replace(/^\./, "");
      for (const child of this.children) {
        if (child.classes.has(className)) return child;
        const match = child.querySelector(selector);
        if (match) return match;
      }
      return null;
    }
  }

  const originalWidth = window.innerWidth;
  const originalGetById = document.getElementById;
  const originalQuerySelector = document.querySelector;
  const originalCreateComment = document.createComment;
  const source = new StubNode("pageTopbarActions", { classes: ["page-topbar-actions"] });
  const title = new StubNode("pageTopbarTitle", { classes: ["page-topbar-title"] });
  const toolbar = new StubNode("mediaDetailActions");
  const actions = ["watchlist", "playlist", "up-next", "spoilers"].map((name) => new StubNode(name));
  const dropdown = new StubNode("options", { classes: ["actions-tools-dropdown"] });
  const panel = new StubNode("panel", { classes: ["actions-tools-panel"] });
  const existingOption = new StubNode("mark-watched");
  panel.appendChild(existingOption);
  dropdown.appendChild(new StubNode("options-trigger"));
  dropdown.appendChild(panel);
  actions.forEach((action) => toolbar.appendChild(action));
  toolbar.appendChild(dropdown);
  source.appendChild(toolbar);

  document.getElementById = (id) => id === "mediaDetailActions" ? toolbar : null;
  document.querySelector = (selector) => selector === ".page-topbar-title" ? title : null;
  document.createComment = () => new StubNode("comment", { nodeType: 8 });

  try {
    window.innerWidth = 390;
    syncMediaActionsMenuState();
    assert.equal(toolbar.parentElement, title);
    assert.deepEqual(panel.children, [...actions, existingOption]);
    assert.equal(source.classList.contains("media-actions-inline-source"), true);

    window.innerWidth = 1024;
    syncMediaActionsMenuState();
    assert.equal(toolbar.parentElement, source);
    assert.deepEqual(toolbar.children, [...actions, dropdown]);
    assert.deepEqual(panel.children, [existingOption]);
    assert.equal(source.classList.contains("media-actions-inline-source"), false);
  } finally {
    window.innerWidth = originalWidth;
    document.getElementById = originalGetById;
    document.querySelector = originalQuerySelector;
    if (originalCreateComment) document.createComment = originalCreateComment;
    else delete document.createComment;
  }
});

test("preparing an already-routed inline detail does not re-enter the route", () => {
  installMediaDetailDomStubs();
  let selectViewCalls = 0;
  initMediaDetail({ selectView: () => { selectViewCalls += 1; } });

  state.activeView = "explorer";
  state.explorerMode = "shows";
  state.mediaDetailInline = true;
  prepareInlineMediaDetail("shows");

  assert.equal(selectViewCalls, 0);
});

test("preparing a detail from a normal view still selects Explorer", () => {
  installMediaDetailDomStubs();
  let selectViewCalls = 0;
  initMediaDetail({ selectView: () => { selectViewCalls += 1; } });

  state.activeView = "dashboard";
  state.explorerMode = "movies";
  state.mediaDetailInline = false;
  prepareInlineMediaDetail("movies");

  assert.equal(selectViewCalls, 1);
});
