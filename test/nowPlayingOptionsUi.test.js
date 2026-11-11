import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

function target() {
  const listeners = new Map();
  return {
    checked: false,
    value: "",
    addEventListener(type, callback) { listeners.set(type, callback); },
    change(value) {
      if (typeof value === "boolean") this.checked = value;
      else this.value = String(value);
      return listeners.get("change")?.({ target: this });
    },
    setAttribute() {},
  };
}

test("options saves are serialized and failures only roll back the affected confirmed value", async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousCustomEvent = globalThis.CustomEvent;
  const part = target();
  const upNext = target();
  const count = target();
  const sync = target();
  const button = target();
  const errorLine = { textContent: "", classList: { toggle() {} } };
  const controls = { allowPartWatched: part, allowUpNext: upNext, itemCount: count };
  const menu = {
    classList: { contains: () => true, toggle() {} },
    querySelector(selector) {
      if (selector === ".now-playing-option-error") return errorLine;
      if (selector.includes("data-up-next-sync-option")) return sync;
      return controls[selector.match(/data-now-playing-option="([^"]+)"/)?.[1]];
    },
  };
  const listeners = new Map();
  globalThis.document = {
    activeElement: null,
    body: { append() {} },
    querySelector(selector) { return selector === "#nowPlayingOptionsButton" ? button : selector === "#nowPlayingOptionsMenu" ? menu : null; },
    addEventListener(type, callback) { const list = listeners.get(type) || []; list.push(callback); listeners.set(type, list); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
  };
  globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
  const requests = [];
  globalThis.fetch = (_url, options) => new Promise((resolve) => {
    requests.push({ body: JSON.parse(options.body), resolve });
  });
  const success = (section, values) => ({ ok: true, json: async () => ({ config: { [section]: values } }) });
  const failure = { ok: false, status: 500, json: async () => ({ error: "Save failed" }) };
  const { state } = await import("../public/modules/state.js");
  const previousConfig = state.savedConfig;
  const previousUser = state.currentUser;
  const previousToken = state.token;
  try {
    state.savedConfig = { nowPlaying: { allowPartWatched: true, allowUpNext: true, itemCount: 3 }, upNextSync: { enabled: true } };
    await import("../public/modules/now-playing-options.js?ui-test");

    const first = part.change(false);
    const second = upNext.change(false);
    await Promise.resolve();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, { nowPlaying: { allowPartWatched: false } });
    assert.equal(state.savedConfig.nowPlaying.allowUpNext, false);
    requests[0].resolve(failure);
    await first;
    assert.equal(state.savedConfig.nowPlaying.allowPartWatched, true);
    assert.equal(state.savedConfig.nowPlaying.allowUpNext, false);
    assert.deepEqual(requests[1].body, { nowPlaying: { allowUpNext: false } });
    requests[1].resolve(success("nowPlaying", { allowPartWatched: true, allowUpNext: false, itemCount: 3 }));
    await second;

    const third = part.change(false);
    const fourth = part.change(true);
    await Promise.resolve();
    requests[2].resolve(success("nowPlaying", { allowPartWatched: false, allowUpNext: false, itemCount: 3 }));
    await third;
    assert.equal(state.savedConfig.nowPlaying.allowPartWatched, true);
    requests[3].resolve(failure);
    await fourth;
    assert.equal(state.savedConfig.nowPlaying.allowPartWatched, false);

    // A later config reload must become the rollback baseline for a new save.
    state.savedConfig = { ...state.savedConfig, nowPlaying: { allowPartWatched: true, allowUpNext: true, itemCount: 2 } };
    const fifth = part.change(false);
    await Promise.resolve();
    requests[4].resolve(failure);
    await fifth;
    assert.deepEqual(state.savedConfig.nowPlaying, { allowPartWatched: true, allowUpNext: true, itemCount: 2 });
    assert.equal(errorLine.textContent, "Save failed");

    // Queued work from a signed-out account must not run under the next user.
    state.currentUser = { uid: "first" };
    state.token = "first-session";
    const oldFirst = part.change(false);
    const oldSecond = upNext.change(false);
    await Promise.resolve();
    assert.equal(requests.length, 6);
    state.currentUser = { uid: "second" };
    state.token = "second-session";
    state.savedConfig = { nowPlaying: { allowPartWatched: true, allowUpNext: true, itemCount: 1 }, upNextSync: { enabled: true } };
    const newSave = part.change(false);
    requests[5].resolve(failure);
    await oldFirst;
    await oldSecond;
    assert.equal(state.savedConfig.nowPlaying.allowUpNext, true);
    assert.deepEqual(requests[6].body, { nowPlaying: { allowPartWatched: false } });
    requests[6].resolve(success("nowPlaying", { allowPartWatched: false, allowUpNext: true, itemCount: 1 }));
    await newSave;
    assert.equal(requests.length, 7);
    assert.deepEqual(state.savedConfig.nowPlaying, { allowPartWatched: false, allowUpNext: true, itemCount: 1 });

    const superseded = part.change(true);
    const latest = part.change(false);
    await Promise.resolve();
    requests[7].resolve(failure);
    await superseded;
    assert.equal(errorLine.textContent, "");
    assert.equal(state.savedConfig.nowPlaying.allowPartWatched, false);
    requests[8].resolve(success("nowPlaying", { allowPartWatched: false, allowUpNext: true, itemCount: 1 }));
    await latest;
    assert.equal(errorLine.textContent, "");
  } finally {
    state.savedConfig = previousConfig;
    state.currentUser = previousUser;
    state.token = previousToken;
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    globalThis.CustomEvent = previousCustomEvent;
  }
});
