import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";
const { handleDroppedTitleAction, loadDroppedTitleStates, isDroppedUnDropBusy } = await import("../public/modules/dropped-titles.js");

function button(tmdb = "42") {
  const attrs = new Map([["aria-pressed", "false"]]);
  const label = { textContent: "Drop" };
  return {
    dataset: { droppedType: "show", droppedTitle: "Example", droppedTmdb: tmdb },
    isConnected: true, disabled: false, classList: { toggle() {} },
    setAttribute: (key, value) => attrs.set(key, value),
    getAttribute: key => attrs.get(key), removeAttribute: key => attrs.delete(key),
    querySelector: selector => selector === "[data-dropped-label]" ? label : null,
  };
}
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("action refreshes dropped state before toggling and refreshes queue after persistence", async () => {
  const original = globalThis.fetch;
  const target = button();
  let refreshed = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      if (options.method !== "POST") return response({ items: [{ media_type: "show", title: "Example", tmdb_id: "42" }] });
      assert.equal(JSON.parse(options.body).dropped, false, "stale Drop button must un-drop current server state");
      return response({ ok: true, dropped: false });
    };
    assert.equal(await handleDroppedTitleAction(target, { onSuccess: () => refreshed++ }), true);
    assert.equal(target.getAttribute("aria-pressed"), "false");
    assert.equal(refreshed, 1);
    assert.equal(target.disabled, false);
  } finally { globalThis.fetch = original; }
});

test("partial failure preserves confirmed local state and makes provider failure visible", async () => {
  const original = globalThis.fetch;
  const target = button();
  let refreshed = false;
  try {
    globalThis.fetch = async (_url, options) => options.method === "POST"
      ? response({ dropped: true, error: "Refresh failed", providerDismissals: [{ target: "plex", status: "failed", details: "Offline" }] }, false)
      : response({ items: [] });
    assert.equal(await handleDroppedTitleAction(target, { onSuccess: () => { refreshed = true; } }), false);
    assert.equal(target.getAttribute("aria-pressed"), "true");
    assert.match(target.title, /plex: Offline/);
    assert.equal(refreshed, true);
  } finally { globalThis.fetch = original; }
});

test("initial card reads coalesce and conflicting IDs do not mark another title dropped", async () => {
  const original = globalThis.fetch;
  const targets = [button(), button("99")];
  let reads = 0;
  try {
    globalThis.fetch = async () => { reads++; return response({ items: [{ media_type: "show", title: "Example", tmdb_id: "42" }] }); };
    assert.deepEqual(await loadDroppedTitleStates(targets), [true, false]);
    assert.equal(reads, 1);
  } finally { globalThis.fetch = original; }
});

test("loading Un-drop state while another Un-drop is saving keeps the menu action disabled", async () => {
  const original = globalThis.fetch;
  const first = button("42");
  const second = button("99");
  first.setAttribute("aria-pressed", "true");
  second.setAttribute("aria-pressed", "true");
  let releaseFirstPost;
  const firstPost = new Promise((resolve) => { releaseFirstPost = resolve; });
  try {
    globalThis.fetch = async (_url, options) => {
      if (options?.method === "POST") {
        await firstPost;
        return response({ ok: true, dropped: false });
      }
      return response({
        items: [
          { media_type: "show", title: "Example", tmdb_id: "42" },
          { media_type: "show", title: "Example", tmdb_id: "99" },
        ],
      });
    };
    const firstAction = handleDroppedTitleAction(first);
    await Promise.resolve();
    assert.equal(isDroppedUnDropBusy(), true);
    assert.deepEqual(await loadDroppedTitleStates([second]), [true]);
    assert.equal(second.disabled, true, "second Un-drop must stay busy until the first save finishes");
    assert.match(second.querySelector("[data-dropped-label]").textContent, /Un-dropping/);
    releaseFirstPost();
    assert.equal(await firstAction, true);
    assert.equal(isDroppedUnDropBusy(), false);
    assert.deepEqual(await loadDroppedTitleStates([second]), [true]);
    assert.equal(second.disabled, false, "Un-drop becomes available again after the save finishes");
  } finally { globalThis.fetch = original; }
});
