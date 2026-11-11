import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) { listeners.set(type, callback); },
    click(target) { listeners.get("click")?.({ target, preventDefault() {}, stopPropagation() {} }); },
  };
}

test("a slow Up Next lookup cannot replace a newer watch prompt", async () => {
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousHref = window.location.href;
  window.open = () => {};
  window.location.href = "http://localhost:5055/";
  let promptOpened;
  globalThis.document = {
    ...previousDocument,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: { insertAdjacentHTML() { promptOpened?.(); } },
  };
  const pendingFetches = [];
  let fetchStarted;
  globalThis.fetch = (url) => {
    assert.equal(new URL(url).pathname, "/api/show");
    return new Promise((resolve) => { pendingFetches.push(resolve); fetchStarted?.(); });
  };
  const panel = eventTarget();
  const { state, elements } = await import("../public/modules/state.js");
  Object.assign(elements, {
    authForm: eventTarget(), tabButtons: [], lockButton: eventTarget(),
    closeModalButton: eventTarget(), debugModal: eventTarget(), upNextPanel: panel,
  });
  const { initAppEvents } = await import("../public/modules/app-events.js");
  const { loadRouteModules, WATCH_ROUTE_MODULES } = await import("../public/modules/route-modules.js?v=2.2.4.2.5");
  const { openWatchDatePrompt } = await import("../public/modules/watch-action.js?v=2.2.4.2.5");
  const button = (dataset) => ({ dataset, closest(selector) { return selector === "[data-up-next-watch]" ? this : null; } });
  const episode = (name, id) => button({ upNextWatch: id, upNextMediaType: "episode", showTitle: name, season: "1", episode: "2" });
  const movie = button({ upNextWatch: "movie-b", upNextTitle: "Movie B" });
  const startLookup = (name, id) => new Promise((resolve) => { fetchStarted = resolve; panel.click(episode(name, id)); });
  const opened = () => new Promise((resolve) => { promptOpened = resolve; });
  try {
    await loadRouteModules(WATCH_ROUTE_MODULES);
    initAppEvents();
    await startLookup("Slow Show A", "episode-a");
    const movieOpened = opened();
    panel.click(movie);
    await movieOpened;
    assert.equal(state.pendingWatchAction.title, "Movie B");
    pendingFetches[0]({ ok: true, json: async () => ({ show: { title: "Slow Show A", episodes: [] } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pendingWatchAction.title, "Movie B");

    await startLookup("Slow Show C", "episode-c");
    const otherAction = { scope: "movie", title: "Other movie", movie: {}, countLabel: "1 movie" };
    openWatchDatePrompt(otherAction);
    pendingFetches[1]({ ok: true, json: async () => ({ show: { title: "Slow Show C", episodes: [] } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pendingWatchAction, otherAction);

    await startLookup("Slow Show D", "episode-d");
    window.location.href = "http://localhost:5055/movies";
    pendingFetches[2]({ ok: true, json: async () => ({ show: { title: "Slow Show D", episodes: [] } }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.pendingWatchAction, otherAction);
  } finally {
    globalThis.document = previousDocument;
    globalThis.fetch = previousFetch;
    window.location.href = previousHref;
  }
});
