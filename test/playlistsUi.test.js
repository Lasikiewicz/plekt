import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

// The Playlists page module (public/modules/playlists.js) run in Node with
// injected helpers: rendering of app icons, missing notes, reorder, held
// changes, Recently deleted, the app picker, and the requests its buttons send.
globalThis.Element ??= class Element {};

const { state } = await import("../public/modules/state.js");
const { bindPlaylistDragAndDrop, initPlaylists, renderPlaylists, openPlaylistDialog, openAddToListDialog, handlePlaylistClick, reorderedKeys, reorderedBlock, playlistStackRuns, toggleStack, playlistAcceptsItem, recentlyDeletedButtonHtml } = await import("../public/modules/playlists.js");

const requests = [];
let confirmAnswer = true;
let dialogBody = "";
// The last dialog's click listener, so a test can press its buttons.
let dialogClick = null;
function dialogFrame(title, body) {
  dialogBody = `${title}\n${body}`;
  dialogClick = null;
  return { querySelector: () => null, isConnected: true, addEventListener: (type, listener) => { if (type === "click") dialogClick = listener; } };
}
function clickInDialog(selectorName, dataset) {
  const button = Object.assign(new Element(), { dataset });
  const target = Object.assign(new Element(), { closest: (selector) => (selector === selectorName ? button : null) });
  dialogClick({ target, preventDefault: () => {} });
}

initPlaylists({
  normalizeItem: (item) => item,
  personalCard: (item, options) => `<card key="${item.media_key}" ${options.attributesHtml}>${options.hideOverview ? "<no-overview>" : ""}${options.posterBadgeHtml}${options.noteHtml}${options.actionsHtml}</card>`,
  emptyPersonalState: (title) => `<empty>${title}</empty>`,
  personalRequest: async (payload) => { requests.push(payload); return { ok: true, name: "Restored" }; },
  loadPersonalMedia: async () => {},
  setMessage: () => {},
  dialogFrame,
  closePersonalDialog: () => {},
  confirm: async () => confirmAnswer,
  addToCustomList: async () => {},
  customListsForPersonalItem: () => [],
});

function playlist(overrides = {}) {
  return {
    id: "p1",
    name: "Road trip",
    providers: [
      { provider: "plex", status: "synced" },
      { provider: "emby", status: "error", last_error: "HTTP 500" },
    ],
    held_changes: [],
    items: [
      { media_key: "movie:tmdb:1", title: "One", availability: { plex: { status: "available" }, emby: { status: "missing" }, jellyfin: { status: "missing" } } },
      { media_key: "movie:tmdb:2", title: "Two", availability: {} },
      { media_key: "movie:tmdb:3", title: "Three", availability: { plex: { status: "missing" }, emby: { status: "missing" } } },
    ],
    ...overrides,
  };
}

function clickOn(selectorName, dataset) {
  const button = Object.assign(new Element(), { dataset, disabled: false, isConnected: true });
  const target = Object.assign(new Element(), { closest: (selector) => (selector === selectorName ? button : null) });
  let prevented = false;
  const handled = handlePlaylistClick({ target, preventDefault: () => { prevented = true; } });
  return { handled, prevented, button };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("playlist headings show each selected app with its sync status, or Plembfin only", () => {
  const html = renderPlaylists([playlist(), playlist({ id: "p2", name: "Local", providers: [] })], []);
  assert.match(html, /playlist-provider-icon--synced" role="listitem" title="Plex: synced\."/);
  assert.match(html, /playlist-provider-icon--error"[^>]*title="Emby: the last sync failed \(HTTP 500\)\."/);
  assert.doesNotMatch(html, /jellyfin\.svg/, "an app the playlist does not target has no icon");
  assert.match(html, /<span class="playlist-provider-only">Plekt only<\/span>/);
  assert.match(html, /data-playlist-edit="p1"/);
});

test("missing notes name only the playlist's selected apps", () => {
  const html = renderPlaylists([playlist()], []);
  const cards = html.split("<card").slice(1);
  assert.match(cards[0], /Missing from Emby</, "Jellyfin is not selected, so it is not reported");
  assert.doesNotMatch(cards[1], /Missing from/);
  assert.match(cards[2], /Missing from Plex and Emby</);
});

test("posters carry a Missing badge naming the selected apps, for the posters-only view", () => {
  const cards = renderPlaylists([playlist()], []).split("<card").slice(1);
  assert.match(cards[0], /class="playlist-missing-badge" title="Missing from Emby"[^>]*>Missing</);
  assert.doesNotMatch(cards[1], /playlist-missing-badge/);
  assert.match(cards[2], /playlist-missing-badge" title="Missing from Plex and Emby"/);
});

test("drag and drop moves an item before or after the card it is dropped on", async () => {
  assert.deepEqual(reorderedKeys(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(reorderedKeys(["a", "b", "c"], "a", "c", true), ["b", "c", "a"]);
  assert.equal(reorderedKeys(["a", "b", "c"], "a", "b"), null, "dropping just before the next item changes nothing");
  assert.equal(reorderedKeys(["a", "b", "c"], "a", "a"), null);

  state.personalLists = [playlist()];
  const html = renderPlaylists(state.personalLists, []);
  assert.match(html, /data-playlist-rail="p1"/);
  assert.match(html, /<card key="movie:tmdb:1" draggable="true" data-playlist-drag-key="movie:tmdb:1">/);
  assert.doesNotMatch(renderPlaylists([playlist({ items: [playlist().items[0]] })], []), /draggable/, "a one-item playlist is not draggable");

  const handlers = {};
  const panel = { dataset: {}, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelectorAll: () => [] };
  bindPlaylistDragAndDrop(panel);
  bindPlaylistDragAndDrop(panel);
  const rail = { dataset: { playlistRail: "p1" } };
  const card = (key) => Object.assign(new Element(), {
    dataset: { playlistDragKey: key },
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    closest: (selector) => (selector === "[data-playlist-rail]" ? rail : selector === "[data-playlist-drag-key]" ? card.current : null),
  });
  const fire = (type, key, clientX = 10) => {
    card.current = card(key);
    let prevented = false;
    handlers[type]({ target: card.current, clientX, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  requests.length = 0;
  fire("dragstart", "movie:tmdb:3");
  assert.equal(fire("dragover", "movie:tmdb:1"), true, "a card of the same playlist accepts the drop");
  fire("drop", "movie:tmdb:1", 10);
  await settle();
  assert.deepEqual(requests, [{ action: "list-reorder", list_id: "p1", order: ["movie:tmdb:3", "movie:tmdb:1", "movie:tmdb:2"] }]);
  assert.equal(fire("dragover", "movie:tmdb:2"), false, "nothing is being dragged after the drop");

  // Live move: the dragged card is moved beside the card under the pointer,
  // and a drop on its own (now moved) slot uses that last target.
  state.personalLists = [playlist()];
  const moved = [];
  const reinserted = [];
  const parent = { insertBefore: (element) => reinserted.push(element.dataset.playlistDragKey) };
  const liveCard = (key) => Object.assign(card(key), {
    parentElement: parent,
    nextSibling: null,
    before: () => moved.push(["before", key]),
    after: () => moved.push(["after", key]),
  });
  const dragged = liveCard("movie:tmdb:3");
  card.current = dragged;
  handlers.dragstart({ target: dragged, preventDefault() {} });
  card.current = liveCard("movie:tmdb:1");
  handlers.dragover({ target: card.current, clientX: 10, preventDefault() {} });
  assert.deepEqual(moved, [["before", "movie:tmdb:1"]], "the dragged card is moved in front of it while held");
  card.current = dragged;
  requests.length = 0;
  handlers.drop({ target: dragged, clientX: 90, preventDefault() {} });
  await settle();
  assert.deepEqual(requests.map((request) => request.order), [["movie:tmdb:3", "movie:tmdb:1", "movie:tmdb:2"]]);

  handlers.dragstart({ target: dragged, preventDefault() {} });
  handlers.dragend({});
  assert.deepEqual(reinserted, ["movie:tmdb:3"], "a drag with no drop puts the card back");
});

const ep = (show, season, number, extra = {}) => ({
  media_key: `episode:tmdb:${show}:s${season}e${number}`, media_type: "episode", tmdb_id: String(show),
  show_title: `Show ${show}`, title: `Episode ${number}`, season, episode: number, availability: {}, ...extra,
});
const film = (id) => ({ media_key: `movie:tmdb:${id}`, media_type: "movie", title: `Film ${id}`, availability: {} });

test("poster stacks group neighbouring episodes of one show; a movie between splits them", () => {
  const items = [ep(7, 1, 1), ep(7, 1, 2), film(1), ep(7, 1, 3), ep(8, 1, 1), ep(8, 1, 2), ep(8, 1, 3)];
  const runs = (kind) => playlistStackRuns({ kind }, items).map((run) => [run.start, run.items.length]);
  assert.deepEqual(runs("mixed"), [[0, 2], [2, 1], [3, 1], [4, 3]], "a single episode stays a plain poster");
  assert.deepEqual(runs("tv"), [[0, 2], [2, 1], [3, 1], [4, 3]]);
  assert.deepEqual(runs("movie"), items.map((_, index) => [index, 1]), "Movies playlists never stack");
  assert.deepEqual(playlistStackRuns({ kind: "tv" }, [ep(7, 1, 1), ep(7, 2, 1, { tmdb_id: "", show_title: "show 7" }), ep(7, 3, 1, { tmdb_id: "", show_title: "Show 7 " })])
    .map((run) => run.items.length), [1, 2], "without a show id the show title groups, ignoring case and spaces");

  assert.deepEqual(reorderedBlock(["a", "b", "c", "d"], ["b", "c"], "d", true), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderedBlock(["a", "b", "c", "d"], ["c", "b"], "a"), ["b", "c", "a", "d"], "the block keeps its own order");
  assert.equal(reorderedBlock(["a", "b", "c"], ["a", "b"], "b"), null, "dropping on itself does nothing");
  assert.equal(reorderedBlock(["a", "b", "c"], ["a", "b"], "c"), null, "dropping just before the next item does nothing");
});

test("a stack renders as a poster card before its collapsed episodes, each keeping its Missing badge", () => {
  const list = playlist({
    kind: "mixed",
    providers: [{ provider: "plex", status: "synced" }],
    items: [ep(7, 1, 1, { availability: { plex: { status: "missing" } } }), ep(7, 1, 2), ep(7, 1, 3), film(1)],
  });
  const cards = renderPlaylists([list], []).split("<card").slice(1);
  assert.equal(cards.length, 5, "one stack card, three episodes, one film");
  assert.match(cards[0], /data-playlist-stack="episode:tmdb:7:s1e1" data-stack-expanded="0" aria-expanded="false"/);
  assert.match(cards[0], /aria-label="3 episodes of Show 7; expand"/);
  assert.match(cards[0], /data-playlist-drag-block="episode:tmdb:7:s1e1\nepisode:tmdb:7:s1e2\nepisode:tmdb:7:s1e3"/);
  assert.match(cards[0], /class="playlist-stack-count"[^>]*>3 episodes</);
  assert.match(cards[0], /playlist-missing-badge" title="1 of 3 missing from an app"/);
  assert.doesNotMatch(cards[0], /data-playlist-move/, "the stack has no Move arrows of its own");
  for (const card of cards.slice(1, 4)) {
    assert.match(card, /data-playlist-stack-member="episode:tmdb:7:s1e1" data-stack-collapsed="1"/);
  }
  assert.match(cards[1], /playlist-missing-badge" title="Missing from Plex"/);
  // Episode posters carry the History-style overlay (code and name); the badge
  // sits outside it, in the poster's top-left corner like every other poster.
  assert.match(cards[1], /Missing<\/span><div class="history-poster-overlay playlist-poster-overlay"><div class="history-poster-overlay-episode" title="S01E01 · Episode 1">S01E01 · Episode 1<\/div><\/div>/);
  assert.match(cards[2], /S01E02 · Episode 2<\/div><\/div>/);
  assert.doesNotMatch(cards[1], /history-poster-overlay-meta/, "no meta line on playlist overlays");
  assert.doesNotMatch(cards[0], /playlist-poster-overlay/, "the stack itself has no episode overlay");
  assert.doesNotMatch(cards[4], /playlist-poster-overlay/, "movies have no overlay");
  assert.doesNotMatch(cards[4], /data-playlist-stack/);
  // Move arrows keep counting real items, so the film is still last.
  assert.match(cards[4], /data-playlist-move="1"[^>]*disabled/);
});

test("clicking a stack expands and collapses it, and the state survives a re-render", () => {
  const list = playlist({ id: "st", kind: "tv", providers: [], items: [ep(9, 1, 1), ep(9, 1, 2)] });
  const members = [0, 1].map(() => ({ dataset: { playlistStackMember: "episode:tmdb:9:s1e1", stackCollapsed: "1" } }));
  const attributes = { "aria-label": "2 episodes of Show 9; expand" };
  const stack = {
    dataset: { playlistStack: "episode:tmdb:9:s1e1", stackExpanded: "0" },
    closest: (selector) => (selector === "[data-playlist-rail]" ? { dataset: { playlistRail: "st" } } : null),
    getAttribute: (name) => attributes[name],
    setAttribute: (name, value) => { attributes[name] = value; },
    parentElement: { querySelectorAll: () => members },
  };
  toggleStack(stack);
  assert.equal(stack.dataset.stackExpanded, "1");
  assert.equal(attributes["aria-expanded"], "true");
  assert.equal(attributes["aria-label"], "2 episodes of Show 9; collapse");
  assert.deepEqual(members.map((member) => member.dataset.stackCollapsed), ["0", "0"]);
  assert.match(renderPlaylists([list], []), /data-stack-expanded="1"[\s\S]*data-stack-collapsed="0"/, "a re-render keeps it open");
  toggleStack(stack);
  assert.deepEqual(members.map((member) => member.dataset.stackCollapsed), ["1", "1"]);
  assert.doesNotMatch(renderPlaylists([list], []), /data-stack-collapsed="0"/);
});

test("a collapsed stack drags as a block, and a drop onto a stack lands outside it", async () => {
  state.personalLists = [playlist({ id: "blk", kind: "mixed", items: [film(1), ep(7, 1, 1), ep(7, 1, 2), film(2)] })];
  const handlers = {};
  bindPlaylistDragAndDrop({ dataset: {}, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelectorAll: () => [] });
  const rail = { dataset: { playlistRail: "blk" } };
  const card = (dataset) => Object.assign(new Element(), {
    dataset,
    classList: { add() {}, remove() {}, toggle() {} },
    getBoundingClientRect: () => ({ left: 0, width: 100 }),
    closest: (selector) => (selector === "[data-playlist-rail]" ? rail : selector === "[data-playlist-drag-key]" ? card.current : null),
  });
  const stackData = { playlistDragKey: "episode:tmdb:7:s1e1", playlistDragBlock: "episode:tmdb:7:s1e1\nepisode:tmdb:7:s1e2" };
  const fire = (type, dataset, clientX = 10) => {
    card.current = card(dataset);
    handlers[type]({ target: card.current, clientX, preventDefault() {} });
  };
  requests.length = 0;
  fire("dragstart", stackData);
  fire("drop", { playlistDragKey: "movie:tmdb:2" }, 90);
  await settle();
  fire("dragstart", { playlistDragKey: "movie:tmdb:1" });
  fire("drop", stackData, 90);
  await settle();
  assert.deepEqual(requests.map((request) => request.order), [
    ["movie:tmdb:1", "movie:tmdb:2", "episode:tmdb:7:s1e1", "episode:tmdb:7:s1e2"],
    ["episode:tmdb:7:s1e1", "episode:tmdb:7:s1e2", "movie:tmdb:1", "movie:tmdb:2"],
  ]);
});

test("reorder buttons disable at the ends and send the full new order", async () => {
  state.personalLists = [playlist()];
  const html = renderPlaylists(state.personalLists, []);
  const cards = html.split("<card").slice(1);
  assert.match(cards[0], /data-playlist-move="-1"[^>]*disabled/);
  assert.doesNotMatch(cards[0], /data-playlist-move="1"[^>]*disabled/);
  assert.match(cards[2], /data-playlist-move="1"[^>]*disabled/);
  // One compact "Move" control with arrows, not Earlier/Later buttons, and no summaries.
  for (const card of cards) {
    assert.match(card, /class="playlist-move-control"[\s\S]*&lsaquo;<\/button>\s*<span class="playlist-move-label"[^>]*>Move<\/span>[\s\S]*&rsaquo;<\/button>/);
    assert.doesNotMatch(card, /Earlier|Later/);
    assert.match(card, /<no-overview>/);
  }

  requests.length = 0;
  const { handled, prevented } = clickOn("[data-playlist-move]", { playlistId: "p1", playlistKey: "movie:tmdb:3", playlistMove: "-1" });
  assert.equal(handled, true);
  assert.equal(prevented, true);
  await settle();
  assert.deepEqual(requests, [{ action: "list-reorder", list_id: "p1", order: ["movie:tmdb:1", "movie:tmdb:3", "movie:tmdb:2"] }]);

  const single = renderPlaylists([playlist({ items: [playlist().items[0]] })], []);
  assert.doesNotMatch(single, /data-playlist-move/, "a one-item playlist has nothing to reorder");
});

test("app entries Plembfin could not identify get a note per app", () => {
  const html = renderPlaylists([playlist({
    providers: [
      { provider: "plex", status: "synced", unidentified_count: 1 },
      { provider: "emby", status: "synced", unidentified_count: 3 },
      { provider: "jellyfin", status: "synced", unidentified_count: 0 },
    ],
  })], []);
  assert.match(html, /1 item in Plex was not identified\. It stays in Plex only\. 3 items in Emby were not identified\. They stay in Emby only\./);
  assert.doesNotMatch(html, /in Jellyfin (was|were) not identified/);
  assert.doesNotMatch(renderPlaylists([playlist()], []), /playlist-unidentified-note/);
});

test("held changes show Confirm and Discard until confirmed, and send the decision", async () => {
  const held = playlist({
    held_changes: [
      { provider: "plex", kind: "removals", change_count: 4, confirmed: false },
      { provider: "emby", kind: "delete", change_count: 1, confirmed: true },
    ],
  });
  const html = renderPlaylists([held], []);
  assert.match(html, /4 titles were removed from this playlist in Plex at once/);
  assert.match(html, /data-playlist-held="confirm" data-playlist-id="p1" data-playlist-provider="plex" data-playlist-held-kind="removals"/);
  assert.match(html, /Emby: confirmed\. It applies on the next sync\./);
  assert.doesNotMatch(html, /data-playlist-provider="emby"/, "a confirmed hold has no buttons");

  requests.length = 0;
  clickOn("[data-playlist-held]", { playlistId: "p1", playlistProvider: "plex", playlistHeldKind: "removals", playlistHeld: "discard" });
  await settle();
  assert.deepEqual(requests, [{ action: "list-held", list_id: "p1", provider: "plex", kind: "removals", decision: "discard" }]);
});

test("Recently deleted lists each playlist with Restore and Delete permanently", async () => {
  state.personalDeletedLists = [
    { id: "d1", name: "Old", deleted_at: Date.UTC(2026, 8, 20), deleted_origin: "jellyfin", item_count: 1, providers: ["plex", "jellyfin"], pending_app_deletes: ["plex"] },
    { id: "d2", name: "Local", deleted_at: Date.UTC(2026, 8, 21), deleted_origin: "local", item_count: 0, providers: [], pending_app_deletes: [] },
  ];
  assert.doesNotMatch(renderPlaylists([]), /Recently deleted/, "no longer on the page itself");
  assert.match(recentlyDeletedButtonHtml(), /data-playlist-recently-deleted[\s\S]*<span>Recently deleted \(2\)<\/span>/, "a toolbar button while something is there");
  dialogBody = "";
  assert.equal(clickOn("[data-playlist-recently-deleted]", {}).handled, true);
  assert.match(dialogBody, /^Recently deleted\n/);
  assert.match(dialogBody, /1 item · Deleted in Jellyfin on [^·]+· Restores to Plex and Jellyfin · Still removing from Plex/);
  assert.match(dialogBody, /0 items · Deleted in Plekt on [^·]+· Plekt only/);
  assert.match(dialogBody, /data-playlist-restore="d1"/);
  assert.match(dialogBody, /data-playlist-purge="d2"/);

  requests.length = 0;
  clickInDialog("[data-playlist-restore]", { playlistRestore: "d1" });
  await settle();
  assert.match(dialogBody, /^Recently deleted\n/, "it opens again with what is left");
  confirmAnswer = false;
  clickInDialog("[data-playlist-purge]", { playlistPurge: "d2" });
  await settle();
  confirmAnswer = true;
  clickInDialog("[data-playlist-purge]", { playlistPurge: "d2" });
  await settle();
  assert.deepEqual(requests, [
    { action: "list-restore", list_id: "d1" },
    { action: "list-purge", list_id: "d2" },
  ], "a cancelled permanent delete sends nothing");

  state.personalDeletedLists = [
    { id: "d1", name: "Old", deleted_at: Date.UTC(2026, 8, 20), item_count: 1, providers: [], pending_app_deletes: [] },
    { id: "d2", name: "Local", deleted_at: Date.UTC(2026, 8, 21), item_count: 0, providers: [], pending_app_deletes: [] },
  ];
  dialogBody = "";
  clickOn("[data-playlist-recently-deleted]", {});
  assert.match(dialogBody, /data-playlist-purge-all/, "Delete all shows when more than one is there");
  requests.length = 0;
  confirmAnswer = false;
  clickInDialog("[data-playlist-purge-all]", {});
  await settle();
  assert.deepEqual(requests, [], "a cancelled Delete all sends nothing");
  confirmAnswer = true;
  clickInDialog("[data-playlist-purge-all]", {});
  await settle();
  assert.deepEqual(requests, [
    { action: "list-purge", list_id: "d1" },
    { action: "list-purge", list_id: "d2" },
  ], "Delete all purges every playlist after one confirmation");

  state.personalDeletedLists = [{ id: "d3", name: "Solo", item_count: 0, providers: [], pending_app_deletes: [] }];
  dialogBody = "";
  clickOn("[data-playlist-recently-deleted]", {});
  assert.doesNotMatch(dialogBody, /data-playlist-purge-all/, "no Delete all for a single playlist");

  state.personalDeletedLists = [];
  assert.equal(recentlyDeletedButtonHtml(), "", "the button hides when nothing is there");
  dialogBody = "";
  clickOn("[data-playlist-recently-deleted]", {});
  assert.equal(dialogBody, "");
});

test("delete asks first and names the apps the playlist is deleted from", async () => {
  state.personalLists = [playlist()];
  let asked = null;
  initPlaylists({
    ...{ normalizeItem: (item) => item, loadPersonalMedia: async () => {}, setMessage: () => {} },
    personalRequest: async (payload) => { requests.push(payload); return {}; },
    confirm: async (options) => { asked = options; return true; },
  });
  requests.length = 0;
  clickOn("[data-personal-delete-list]", { personalDeleteList: "p1" });
  await settle();
  assert.match(asked.body, /Move "Road trip" to Recently deleted\? It is also deleted from Plex and Emby\./);
  assert.deepEqual(requests, [{ action: "list-delete", list_id: "p1" }]);
});

test("the app picker offers connected apps, keeps a disconnected selected app, and explains availability", () => {
  initPlaylists({
    dialogFrame: (title, body) => { dialogBody = `${title}\n${body}`; return { querySelector: () => null, isConnected: true }; },
  });
  state.playlistProviders = [
    { provider: "plex", configured: true },
    { provider: "emby", configured: false },
    { provider: "jellyfin", configured: false },
  ];
  openPlaylistDialog();
  assert.match(dialogBody, /^Create a playlist/);
  assert.match(dialogBody, /value="plex" \/>/);
  assert.match(dialogBody, /value="emby" disabled \/>[\s\S]*?Emby <small>Not connected<\/small>/);
  assert.match(dialogBody, /holds only titles that are in that app's library/);
  assert.match(dialogBody, /An app gets no playlist until at least one of its titles is in that app's library\./);

  openPlaylistDialog({ list: { id: "p1", name: "Road trip", providers: [{ provider: "jellyfin", status: "synced" }] } });
  assert.match(dialogBody, /^Edit Road trip/);
  assert.match(dialogBody, /value="jellyfin" checked \/>/, "an already selected app stays selectable while disconnected");
  assert.match(dialogBody, /Unticking an app deletes this playlist from that app\./);
  assert.match(dialogBody, /value="Road trip"/);
});

test("playlists accept only titles of their type; an untyped playlist takes either", () => {
  const movie = { media_type: "movie" };
  const show = { media_type: "tv" };
  const episode = { media_type: "episode" };
  assert.equal(playlistAcceptsItem({ kind: "movie" }, movie), true);
  assert.equal(playlistAcceptsItem({ kind: "movie" }, show), false);
  assert.equal(playlistAcceptsItem({ kind: "movie" }, episode), false);
  assert.equal(playlistAcceptsItem({ kind: "tv" }, show), true);
  assert.equal(playlistAcceptsItem({ kind: "tv" }, episode), true);
  assert.equal(playlistAcceptsItem({ kind: "tv" }, movie), false);
  assert.equal(playlistAcceptsItem({ kind: null }, movie), true);
  assert.equal(playlistAcceptsItem({ kind: null }, show), true);
  assert.equal(playlistAcceptsItem({ kind: "mixed" }, movie), true);
  assert.equal(playlistAcceptsItem({ kind: "mixed" }, show), true);
  assert.equal(playlistAcceptsItem({ kind: "mixed" }, episode), true);
});

test("the add-to dialog offers only playlists of the title's type", () => {
  initPlaylists({
    normalizeItem: (item) => item,
    customListsForPersonalItem: () => [],
    dialogFrame: (title, body) => { dialogBody = `${title}\n${body}`; return { querySelector: () => null, addEventListener: () => {}, isConnected: true }; },
  });
  state.personalLists = [
    { id: "m1", name: "Films", kind: "movie", items: [] },
    { id: "t1", name: "Shows", kind: "tv", items: [] },
    { id: "u1", name: "Old empty", kind: null, items: [] },
    { id: "x1", name: "Everything", kind: "mixed", items: [] },
  ];
  openAddToListDialog({ title: "Arrival", media_type: "movie" });
  assert.match(dialogBody, /data-dialog-list-id="m1"/);
  assert.match(dialogBody, /data-dialog-list-id="u1"/);
  assert.match(dialogBody, /data-dialog-list-id="x1"/);
  assert.doesNotMatch(dialogBody, /data-dialog-list-id="t1"/);

  openAddToListDialog({ title: "Severance", media_type: "tv" });
  assert.match(dialogBody, /data-dialog-list-id="t1"/);
  assert.match(dialogBody, /data-dialog-list-id="x1"/);
  assert.doesNotMatch(dialogBody, /data-dialog-list-id="m1"/);

  state.personalLists = [{ id: "m1", name: "Films", kind: "movie", items: [] }];
  openAddToListDialog({ title: "Severance", media_type: "tv" });
  assert.match(dialogBody, /You have no TV or Mixed playlist yet\./);
  assert.match(dialogBody, /data-dialog-create-list/);
});

test("the create dialog asks for Movies or TV, locked to the title's type when opened from a title", () => {
  initPlaylists({
    dialogFrame: (title, body) => { dialogBody = `${title}\n${body}`; return { querySelector: () => null, isConnected: true }; },
  });
  state.playlistProviders = [];
  openPlaylistDialog();
  assert.match(dialogBody, /name="kind" value="movie" required \/>/);
  assert.match(dialogBody, /name="kind" value="tv" required \/>/);
  assert.match(dialogBody, /name="kind" value="mixed" required \/>/);
  assert.doesNotMatch(dialogBody, /A TV show adds every episode/, "the retired series expansion is no longer described");

  openPlaylistDialog({ afterCreateItem: { title: "Severance", media_type: "tv" } });
  assert.match(dialogBody, /value="movie" required disabled \/>/);
  assert.match(dialogBody, /value="tv" required checked \/>/);
  assert.match(dialogBody, /value="mixed" required \/>/, "Mixed stays offered for any title");

  openPlaylistDialog({ list: { id: "p1", name: "Road trip", kind: "movie", providers: [] } });
  assert.doesNotMatch(dialogBody, /name="kind"/, "the type cannot be changed after creation");
});

test("each rail heading shows the playlist type, and an empty rail says what it takes", () => {
  const html = renderPlaylists([
    playlist({ id: "m", kind: "movie", items: [] }),
    playlist({ id: "t", kind: "tv", items: [] }),
    playlist({ id: "u", kind: null, items: [] }),
    playlist({ id: "x", kind: "mixed", items: [] }),
  ], []);
  const sections = html.split("<section").slice(1);
  assert.match(sections[3], /<span class="playlist-kind-label">Mixed<\/span>/);
  assert.match(sections[3], /Add a movie or episodes of a TV show from any media card\./);
  assert.doesNotMatch(sections[3], /first title sets/);
  assert.match(sections[0], /<span class="playlist-kind-label">Movies<\/span>/);
  assert.match(sections[0], /Add a movie from any media card\./);
  assert.match(sections[1], /<span class="playlist-kind-label">TV Shows<\/span>/);
  assert.match(sections[1], /Add episodes from any TV show&#39;s media card\./);
  assert.doesNotMatch(sections[2], /playlist-kind-label/);
  assert.match(sections[2], /The first title sets the playlist&#39;s type\./);
});

test("a restore refused for a taken name asks for a new name; other failures are reported", async () => {
  const messages = [];
  let answer = null;
  initPlaylists({
    loadPersonalMedia: async () => {},
    setMessage: (text, kind) => messages.push([kind, text]),
    personalRequest: async (payload) => { requests.push(payload); if (answer) throw answer; return { ok: true, name: payload.name }; },
    dialogFrame,
    closePersonalDialog: () => {},
  });
  state.personalDeletedLists = [{ id: "d1", name: "Old", providers: [], pending_app_deletes: [] }];
  clickOn("[data-playlist-recently-deleted]", {});
  requests.length = 0;
  answer = Object.assign(new Error('A playlist named "Old" already exists. Choose a new name to restore it.'), { code: "name_taken" });
  clickInDialog("[data-playlist-restore]", { playlistRestore: "d1" });
  await settle();
  assert.deepEqual(requests, [{ action: "list-restore", list_id: "d1" }]);
  assert.match(dialogBody, /^Restore Old/);
  assert.match(dialogBody, /already exists\. Choose a new name to restore it\./);
  assert.match(dialogBody, /New name<input id="playlistRestoreName"[^>]*value="Old"/);
  assert.deepEqual(messages, [], "the name prompt replaces the error message");

  clickOn("[data-playlist-recently-deleted]", {});
  dialogBody = "";
  answer = Object.assign(new Error("Deleted playlist not found"), { code: "" });
  clickInDialog("[data-playlist-restore]", { playlistRestore: "d1" });
  await settle();
  assert.equal(dialogBody, "");
  assert.deepEqual(messages, [["error", "Deleted playlist not found"]]);
});
