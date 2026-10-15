import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Exercise the renderer's actual initial-selection stage without mounting artwork,
// provider requests or unrelated media controls.
const source = fs.readFileSync(new URL("../public/modules/media-detail-show.js", import.meta.url), "utf8");
const start = source.indexOf("export function renderShowModalContent(");
const end = source.indexOf("  const episodeRows =", start);
const contextAssignment = source.match(/  state\.activeShowRenderContext = \{ show, activeSeasonNum, selectLatestSeason,[^\n]+/)[0];
function renderer() {
  const state = { savingUnwatchIds: new Set() };
  let token = 1;
  const context = vm.createContext({
    state, currentMediaRenderToken: () => token,
    mediaDetailRoot: () => ({}), mergeShowWithLoadedHistory: show => show,
    seasonsFromShowRecord: () => new Map(), sanitizeTitle: value => value,
    savingEpisodeKeysForShow: () => new Set(), hasSavingWatchActionForShow: () => false,
    isUnmatchedShowTitle: () => false, fallbackSeasonList: () => [],
    seasonLabel: number => `Season ${number}`,
    // No scrolling is available in this stage: any accidental request must fail.
    scrollSeasonAccordionIntoView: () => { throw new Error("unexpected scroll"); },
  });
  const render = vm.runInContext(`(${source.slice(start, end).replace("export function", "function")}\n${contextAssignment}\nreturn selectedSeason; })`, context);
  return { state, render, navigate: () => { token += 1; } };
}
const show = { title: "Ted Lasso" };
const metadata = { seasons: [0, 1, 4, 2, 3].map(season_number => ({ season_number })) };

test("plain show navigation opens the latest regular season without scrolling", () => {
  const { state, render } = renderer();
  assert.equal(render(show, { tmdbData: metadata }), 4);
  assert.equal(state.activeShowModalSeason, 4);
});

test("waits for metadata readiness before choosing the latest season", () => {
  const { render } = renderer();
  assert.equal(render(show, { loading: true }), null);
  assert.equal(render(show, { tmdbData: metadata }), 4);
});

test("explicit season and specials links take precedence", () => {
  for (const activeSeasonNum of [0, 2]) {
    const { render } = renderer();
    assert.equal(render(show, { tmdbData: metadata, activeSeasonNum }), activeSeasonNum);
  }
});

test("refresh preserves collapse but new navigation selects the latest again", () => {
  const { render, navigate } = renderer();
  render(show, { tmdbData: metadata });
  assert.equal(render(show, { tmdbData: metadata, activeSeasonNum: null }), null);
  navigate();
  assert.equal(render(show, { tmdbData: metadata }), 4);
});

test("handles no seasons and specials-only shows", () => {
  const { render } = renderer();
  assert.equal(render(show), null);
  assert.equal(render(show, { tmdbData: { seasons: [{ season_number: 0 }] } }), 0);
});

const scrollStart = source.indexOf('  if (!loading && !watchHistoryLoading && state.pendingSeasonScrollTarget');
const scrollEnd = source.indexOf('  // Refresh when', scrollStart);
const scrollStage = source.slice(scrollStart, scrollEnd);
function navigateSeason(season, { loading = false, watchHistoryLoading = false } = {}) {
  const state = { pendingSeasonScrollTarget: season };
  const container = { scrollTop: 700 };
  const calls = [];
  const context = vm.createContext({ state, selectedSeason: season, loading, watchHistoryLoading,
    document: { querySelector: () => container }, requestAnimationFrame: callback => callback(),
    scrollSeasonAccordionIntoView: target => calls.push(target),
  });
  vm.runInContext(scrollStage, context);
  return { state, container, calls, context };
}
test('Season 1 deep links reset to page top without a season scroll', () => {
  const { container, calls, state } = navigateSeason(1);
  assert.equal(container.scrollTop, 0);
  assert.deepEqual(calls, []);
  assert.equal(state.pendingSeasonScrollTarget, null);
});
test('other season links use the existing smooth scroll once', () => {
  for (const season of [0, 2, 4]) {
    const { calls, context } = navigateSeason(season);
    assert.deepEqual(calls, [season]);
    vm.runInContext(scrollStage, context);
    assert.deepEqual(calls, [season]);
  }
});
test('season navigation waits for metadata and history readiness', () => {
  for (const flags of [{ loading: true }, { watchHistoryLoading: true }]) {
    const { calls, state } = navigateSeason(2, flags);
    assert.deepEqual(calls, []);
    assert.equal(state.pendingSeasonScrollTarget, 2);
  }
});
