import test from "node:test";
import assert from "node:assert/strict";
import { createLogsViewer, filterLogLines } from "../public/modules/logs-viewer.js";

function fixture(fetchLogs) {
  const controls = new Map();
  function element() {
    return { attrs: {}, handlers: {}, children: [], scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
      setAttribute(key, value) { this.attrs[key] = value; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      fire(name, value) { this.handlers[name]?.({ target: { value } }); },
    };
  }
  for (const id of ["logsPauseButton", "logsFollowButton", "logsLiveStatus", "logsTextFilter"]) controls.set(id, element());
  const categories = [element(), element()];
  const terminal = element();
  const state = { token: "session", activeLogCategory: "sync" };
  const viewer = createLogsViewer({ state, elements: { logsTerminal: terminal }, authHeaders: () => ({}),
    logsText: () => "browser trail", fetchLogs,
    root: { getElementById: (id) => controls.get(id), querySelectorAll: () => categories } });
  return { ...viewer, state, terminal, controls, categories };
}

test("text filtering is literal, case-insensitive and trims the query", () => {
  assert.deepEqual(filterLogLines(["Emby [start]", "plex end"], " EMBY [ "), ["Emby [start]"]);
});

test("pause freezes the snapshot and rejects an already-running response; filtering still works", async () => {
  let finish;
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? ["Emby start", "Plex end"] : new Promise((resolve) => { finish = resolve; }));
  await f.renderLogs();
  const request = f.renderLogs();
  f.controls.get("logsPauseButton").fire("click");
  const frozen = f.terminal.innerHTML;
  finish(["new response"]);
  await request;
  await f.renderLogs();
  assert.equal(calls, 2);
  assert.equal(f.terminal.innerHTML, frozen);
  assert.ok(f.categories.every((button) => button.disabled));
  f.controls.get("logsTextFilter").fire("input", "EMBY");
  assert.match(f.state.renderedLogsText, /Emby start/);
  assert.doesNotMatch(f.state.renderedLogsText, /Plex end|browser trail/);
  assert.equal(f.terminal.attrs["aria-live"], "off");
});

test("late category responses cannot overwrite the selected category", async () => {
  let finish;
  const f = fixture(async (_headers, category) => category === "sync"
    ? new Promise((resolve) => { finish = resolve; }) : ["system only"]);
  const first = f.renderLogs();
  f.state.activeLogCategory = "system";
  await f.renderLogs(true);
  finish(["stale sync"]);
  await first;
  assert.match(f.state.renderedLogsText, /SYSTEM/);
  assert.doesNotMatch(f.state.renderedLogsText, /stale sync/);
});

test("scrolling up disables follow, preserves position and Follow latest returns to bottom", async () => {
  const f = fixture(async () => ["<unsafe> & diagnostic"]);
  await f.renderLogs();
  f.terminal.scrollTop = 150;
  f.terminal.fire("scroll");
  await f.renderLogs();
  assert.equal(f.terminal.scrollTop, 150);
  assert.equal(f.controls.get("logsFollowButton").attrs["aria-pressed"], "false");
  assert.match(f.terminal.innerHTML, /&lt;unsafe&gt; &amp;/);
  f.controls.get("logsFollowButton").fire("click");
  assert.equal(f.terminal.scrollTop, 1000);
});

test("resume fetches fresh data and re-enables category selection", async () => {
  let calls = 0;
  const f = fixture(async () => [`entry ${++calls}`]);
  await f.renderLogs();
  f.controls.get("logsPauseButton").fire("click");
  f.controls.get("logsPauseButton").fire("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(f.state.renderedLogsText, /entry 2/);
  assert.ok(f.categories.every((button) => !button.disabled));
});

test("a retained visible entry stays at the same height when the bounded log window rolls", async () => {
  const f = fixture(async () => ["retained"]);
  await f.renderLogs();
  f.terminal.scrollTop = 400;
  f.terminal.fire("scroll");
  let rolled = false;
  const anchor = { dataset: { logEntry: "retained" },
    getBoundingClientRect: () => ({ top: (rolled ? 480 : 500) - f.terminal.scrollTop, bottom: 130 }) };
  f.terminal.children = [anchor];
  Object.defineProperty(f.terminal, "innerHTML", { set() { rolled = true; } });
  await f.renderLogs();
  assert.equal(anchor.getBoundingClientRect().top, 100);
  assert.equal(f.terminal.scrollTop, 380);
});

test("leaving Logs stops refreshing and discards its unfinished response", async () => {
  let finish;
  let calls = 0;
  const f = fixture(async () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  f.syncLogsRefresh();
  assert.equal(calls, 0);
  f.state.activeView = "settings";
  f.state.activeSettingsRoute = { panel: "logs" };
  f.syncLogsRefresh();
  assert.equal(calls, 1);
  assert.ok(f.state.logsRefreshInterval);
  f.state.activeView = "dashboard";
  f.syncLogsRefresh();
  assert.equal(f.state.logsRefreshInterval, undefined);
  finish(["late private logs"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.renderedLogsText, undefined);
});
