import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import "./domStubs.js";
import { chooseUpNextRemovalScope } from "../public/modules/up-next-shared.js";

// up-next-shared.js imports utils.js with the current build stamp. Import the same
// specifier, or the test gets a second copy of utils.js with its own dialog state.
const sharedSource = fs.readFileSync(new URL("../public/modules/up-next-shared.js", import.meta.url), "utf8");
const utilsStamp = sharedSource.match(/from ["']\.\/utils\.js(\?v=[^"']+)?["']/)?.[1] || "";
const { openConfirmDialog } = await import(`../public/modules/utils.js${utilsStamp}`);

function dialogDocument() {
  const listeners = new Map();
  const overlays = [];
  const doc = {
    activeElement: null,
    overlays,
    addEventListener(type, callback, capture = false) {
      listeners.set(type, [...(listeners.get(type) || []), { callback, capture }]);
    },
    removeEventListener(type, callback, capture = false) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
    },
    dispatchKey(key) {
      const event = { key, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
      for (const entry of [...(listeners.get("keydown") || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
        if (!event.stopped) entry.callback(event);
      }
    },
    createElement() {
      const overlay = {
        removed: false,
        handlers: {},
        addEventListener(type, callback) { this.handlers[type] = callback; },
        remove() { this.removed = true; },
        querySelector(selector) { return selector.includes("confirm-dialog-confirm") ? this.confirm : this.cancel; },
        querySelectorAll() { return [this.season, this.show]; },
      };
      const button = () => ({
        addEventListener(type, callback) { this[type] = callback; },
        focus() { doc.activeElement = this; },
      });
      overlay.confirm = button();
      overlay.cancel = button();
      overlay.season = Object.assign(button(), { dataset: { scope: "season" } });
      overlay.show = Object.assign(button(), { dataset: { scope: "show" } });
      return overlay;
    },
    body: { appendChild(overlay) { overlays.push(overlay); } },
  };
  return doc;
}

test("destructive confirmation focuses Cancel and Escape cancels it", async () => {
  const previous = globalThis.document;
  const doc = globalThis.document = dialogDocument();
  try {
    let underlyingClosed = false;
    doc.addEventListener("keydown", () => { underlyingClosed = true; });
    const result = openConfirmDialog({ danger: true });
    const overlay = doc.overlays[0];
    assert.equal(doc.activeElement, overlay.cancel);
    doc.dispatchKey("Escape");
    assert.equal(await result, false);
    assert.equal(overlay.removed, true);
    assert.equal(underlyingClosed, false);
  } finally { globalThis.document = previous; }
});

test("Up Next scope and ordinary confirmations cancel each other when replaced", async () => {
  const previous = globalThis.document;
  const doc = globalThis.document = dialogDocument();
  try {
    const first = openConfirmDialog();
    const scope = chooseUpNextRemovalScope({ title: "Example", season: 1 });
    assert.equal(await first, false);
    assert.equal(doc.activeElement, doc.overlays[1].cancel);
    const last = openConfirmDialog();
    assert.equal(await scope, null);
    doc.overlays[2].confirm.click();
    assert.equal(await last, true);
  } finally { globalThis.document = previous; }
});

test("opening a new confirmation cancels the previous caller and ignores its stale buttons", async () => {
  const previous = globalThis.document;
  const doc = globalThis.document = dialogDocument();
  try {
    const first = openConfirmDialog();
    const firstOverlay = doc.overlays[0];
    const second = openConfirmDialog();
    const secondOverlay = doc.overlays[1];
    assert.equal(await first, false);
    assert.equal(firstOverlay.removed, true);
    assert.equal(doc.activeElement, secondOverlay.confirm);
    firstOverlay.confirm.click();
    secondOverlay.cancel.click();
    assert.equal(await second, false);
    assert.equal(secondOverlay.removed, true);
  } finally { globalThis.document = previous; }
});

test("clicking outside the dialog cancels without confirming", async () => {
  const previous = globalThis.document;
  const doc = globalThis.document = dialogDocument();
  try {
    const result = openConfirmDialog();
    const overlay = doc.overlays[0];
    overlay.handlers.click({ target: overlay });
    assert.equal(await result, false);
  } finally { globalThis.document = previous; }
});
