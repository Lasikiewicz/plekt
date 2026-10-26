// Playlists page (the /playlists route; stored as personal_lists on the server).
// Owns the playlist rails, the create/edit dialog with the app picker, reorder,
// "Missing from <app>" notes, held-change banners, and Recently deleted.
// personal-media.js imports this module one way and injects its helpers
// through initPlaylists(), so there is no import cycle.
import { state } from "./state.js?v=2.1.1.0.9";
import { episodeCode, escapeAttribute, escapeHtml, platformIconUrl } from "./utils.js?v=2.1.1.0.9";
import { openEpisodePicker } from "./playlist-episode-picker.js?v=2.1.1.0.9";
import { openPlaylistImportDialog } from "./playlist-import.js?v=2.1.1.0.9";
import { bindRuleEditor, choiceCardHtml, handleRuleClick, isAutomaticPlaylist, playlistRefreshIndicatorHtml, playlistRuleHeadingHtml, playlistRuleMenuItemsHtml, playlistRulePanelHtml, readRuleFromForm, ruleEditorHtml } from "./playlist-rules.js?v=2.1.1.0.9";

export const PLAYLIST_PROVIDER_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const PLAYLIST_KIND_LABELS = { movie: "Movies", tv: "TV Shows", mixed: "Mixed" };
const KIND_DESCRIPTIONS = {
  movie: "Films only.",
  tv: "Episodes you pick from each show.",
  mixed: "Films and episodes together.",
};

export function playlistItemKind(item = {}) {
  const type = String(item.media_type || "").toLowerCase();
  return type === "tv" || type === "episode" ? "tv" : "movie";
}

// Movies playlists take movies, TV playlists take episodes (a show opens the
// episode picker), Mixed playlists take both. An untyped playlist, empty from
// before playlists had a type, takes either. An automatic playlist takes
// nothing by hand: its rule picks the items.
export function playlistAcceptsItem(list = {}, item = {}) {
  if (isAutomaticPlaylist(list)) return false;
  return !list.kind || list.kind === "mixed" || list.kind === playlistItemKind(item);
}

// Adding a show to a TV playlist means picking its episodes.
export function openShowEpisodePicker(item, listId) {
  const list = listById(listId);
  if (!list) throw new Error("That playlist no longer exists.");
  return openEpisodePicker({ show: item, list, helpers });
}
const PLAYLIST_PROVIDER_ORDER = ["plex", "emby", "jellyfin"];
const VISIBLE_RAILS = 4;

let helpers = {};

export function initPlaylists(injected = {}) {
  helpers = injected;
  bindOptionsMenuClosing();
}

// A playlist's Options menu closes on a click outside it or on Escape, and
// only one is open at a time.
let optionsClosingBound = false;
function closeOptionsMenus(except = null) {
  document.querySelectorAll("details.playlist-options[open]").forEach((menu) => {
    if (menu !== except) menu.removeAttribute("open");
  });
}
function bindOptionsMenuClosing() {
  if (optionsClosingBound || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  optionsClosingBound = true;
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    closeOptionsMenus(target?.closest("details.playlist-options") || null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeOptionsMenus();
  });
}

function providerLabel(provider) {
  return PLAYLIST_PROVIDER_LABELS[provider] || provider;
}

function listById(listId) {
  return (state.personalLists || []).find((entry) => String(entry.id) === String(listId)) || null;
}

function selectedProviders(list = {}) {
  return (Array.isArray(list.providers) ? list.providers : [])
    .map((entry) => (typeof entry === "string" ? { provider: entry, status: "pending" } : entry))
    .filter((entry) => PLAYLIST_PROVIDER_ORDER.includes(entry.provider));
}

function joinNames(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function providerStatusText(entry) {
  const label = providerLabel(entry.provider);
  if (entry.status === "error") return `${label}: the last sync failed${entry.last_error ? ` (${entry.last_error})` : ""}.`;
  if (entry.status === "missing") return `${label}: the playlist was not found in ${label}. Plekt checks again before treating it as deleted.`;
  if (entry.status === "pending") return `${label}: waiting for the first sync. The playlist appears in ${label} once one of its titles is in that library.`;
  return `${label}: synced.`;
}

export function playlistProviderIconsHtml(list = {}) {
  const providers = selectedProviders(list);
  if (!providers.length) return `<span class="playlist-provider-only">Plekt only</span>`;
  return `<span class="playlist-provider-icons" role="list" aria-label="Synced apps">${providers.map((entry) => {
    const text = providerStatusText(entry);
    // Icon and app name, like the app badges elsewhere; a dot marks trouble.
    return `<span class="source-badge source-badge--icon playlist-provider-icon playlist-provider-icon--${escapeAttribute(entry.status || "pending")}" role="listitem" title="${escapeAttribute(text)}" aria-label="${escapeAttribute(text)}"><img class="source-badge-icon" src="${escapeAttribute(platformIconUrl(entry.provider))}" alt="" loading="lazy" decoding="async" /><span>${escapeHtml(providerLabel(entry.provider))}</span></span>`;
  }).join("")}</span>`;
}

function missingProviders(list, item) {
  const availability = item?.availability || {};
  return selectedProviders(list)
    .filter((entry) => availability[entry.provider]?.status === "missing")
    .map((entry) => providerLabel(entry.provider));
}

function itemNoteHtml(list, item) {
  const missing = missingProviders(list, item);
  if (!missing.length) return "";
  return `<p class="playlist-item-missing">Missing from ${escapeHtml(joinNames(missing))}</p>`;
}

// Shown on the poster; the stylesheet hides it unless the page shows posters only.
function itemPosterBadgeHtml(list, item) {
  const missing = missingProviders(list, item);
  const text = `Missing from ${joinNames(missing)}`;
  const badge = missing.length
    ? `<span class="playlist-missing-badge" title="${escapeAttribute(text)}" aria-label="${escapeAttribute(text)}">Missing</span>`
    : "";
  if (String(item.media_type || "").toLowerCase() !== "episode") return badge;
  // An episode poster is its show's poster, so it carries the History poster
  // overlay (history-poster-overlay.js) with its episode code and name; the
  // badge stays in the top-left corner like on every other poster.
  const name = [episodeCode(item.season, item.episode), item.title].filter(Boolean).join(" · ");
  return `${badge}<div class="history-poster-overlay playlist-poster-overlay"><div class="history-poster-overlay-episode" title="${escapeAttribute(name)}">${escapeHtml(name)}</div></div>`;
}

// Moves `fromKey` before or after `toKey`. Returns null when nothing moves.
export function reorderedKeys(order, fromKey, toKey, after = false) {
  return reorderedBlock(order, [fromKey], toKey, after);
}

// Moves a block of keys (a dragged stack), kept in its own order, before or
// after `toKey`. Returns null when nothing moves.
export function reorderedBlock(order, fromKeys, toKey, after = false) {
  const moving = new Set(fromKeys);
  if (!fromKeys.length || moving.has(toKey) || !order.includes(toKey) || fromKeys.some((key) => !order.includes(key))) return null;
  const block = order.filter((key) => moving.has(key));
  const next = order.filter((key) => !moving.has(key));
  next.splice(next.indexOf(toKey) + (after ? 1 : 0), 0, ...block);
  return next.every((key, index) => key === order[index]) ? null : next;
}

function episodeShowKey(item = {}) {
  if (String(item.media_type || "").toLowerCase() !== "episode") return "";
  if (item.tmdb_id) return `tmdb:${item.tmdb_id}`;
  if (item.tvdb_id) return `tvdb:${item.tvdb_id}`;
  return item.show_title ? `title:${String(item.show_title).trim().toLowerCase()}` : "";
}

// Poster mode groups neighbouring episodes of one show in TV and Mixed
// playlists (decision 26); a show split by another title makes two stacks,
// so the posters keep the playing order. Returns [{ items, start }] runs;
// a run of one is a plain poster.
export function playlistStackRuns(list = {}, items = []) {
  const stacking = list.kind === "tv" || list.kind === "mixed";
  const runs = [];
  items.forEach((item, index) => {
    const show = stacking ? episodeShowKey(item) : "";
    const last = runs[runs.length - 1];
    if (show && last?.show === show) last.items.push(item);
    else runs.push({ show, items: [item], start: index });
  });
  return runs;
}

// Stacks the user opened stay open across re-renders, keyed by playlist and
// the stack's first episode, until the page is entered again (including a
// menu click on the page already open).
const expandedStacks = new Set();
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("plembfin:page-entry", () => expandedStacks.clear());
}
const stackId = (listId, firstKey) => `${listId}\n${firstKey}`;

function stackCardHtml(list, run, expanded) {
  const [first] = run.items;
  const keys = run.items.map((item) => item.media_key);
  const showTitle = first.show_title || first.title || "this show";
  const count = run.items.length;
  const missing = run.items.filter((item) => missingProviders(list, item).length).length;
  const label = `${count} episodes of ${showTitle}`;
  const badges = `<span class="playlist-stack-count" aria-hidden="true">${count} episodes</span>${missing
    ? `<span class="playlist-missing-badge" title="${escapeAttribute(`${missing} of ${count} missing from an app`)}">Missing</span>`
    : ""}`;
  // The stack is a poster of the show that stands for its episodes; it only
  // shows in poster mode (styles.css), and drags as a block (decision 29).
  const attributes = [
    `data-playlist-stack="${escapeAttribute(first.media_key)}"`,
    `data-stack-expanded="${expanded ? "1" : "0"}"`,
    `aria-expanded="${expanded ? "true" : "false"}"`,
    `aria-label="${escapeAttribute(`${label}; ${expanded ? "collapse" : "expand"}`)}"`,
    isAutomaticPlaylist(list) ? "" : `draggable="true" data-playlist-drag-key="${escapeAttribute(first.media_key)}" data-playlist-drag-block="${escapeAttribute(keys.join("\n"))}"`,
  ].filter(Boolean).join(" ");
  return helpers.personalCard({ ...first, title: showTitle, media_type: "tv", season: null, episode: null }, {
    section: "list",
    listId: list.id,
    removable: true,
    hideOverview: true,
    posterBadgeHtml: badges,
    attributesHtml: attributes,
  });
}

function playlistRailHtml(list, items) {
  // An automatic playlist's rule sets the items and their order.
  const automatic = isAutomaticPlaylist(list);
  const canMove = items.length > 1 && !automatic;
  const itemCard = (item, index, member = null) => helpers.personalCard(item, {
    section: "list",
    listId: list.id,
    // Removing from an automatic playlist keeps the title out for good (decision 65).
    removable: true,
    hideOverview: true,
    actionsHtml: canMove ? reorderActionsHtml(list, item, index, items.length) : "",
    noteHtml: itemNoteHtml(list, item),
    posterBadgeHtml: itemPosterBadgeHtml(list, item),
    // Drag and drop reorders on desktop; the Move arrows cover touch.
    attributesHtml: [
      canMove ? `draggable="true" data-playlist-drag-key="${escapeAttribute(item.media_key)}"` : "",
      member ? `data-playlist-stack-member="${escapeAttribute(member.first)}" data-stack-collapsed="${member.expanded ? "0" : "1"}"` : "",
    ].filter(Boolean).join(" "),
  });
  return playlistStackRuns(list, items).map((run) => {
    if (run.items.length < 2) return itemCard(run.items[0], run.start);
    const first = run.items[0].media_key;
    const expanded = expandedStacks.has(stackId(list.id, first));
    return stackCardHtml(list, run, expanded)
      + run.items.map((item, offset) => itemCard(item, run.start + offset, { first, expanded })).join("");
  }).join("");
}

function reorderActionsHtml(list, item, index, count) {
  const key = escapeAttribute(item.media_key);
  const listId = escapeAttribute(list.id);
  const title = item.title || "this title";
  return `
    <div class="playlist-move-control" role="group" aria-label="${escapeAttribute(`Move ${title}`)}">
      <button class="button-ghost playlist-move" type="button" data-playlist-move="-1" data-playlist-id="${listId}" data-playlist-key="${key}" aria-label="${escapeAttribute(`Move ${title} left`)}" title="Move left"${index === 0 ? " disabled" : ""}>&lsaquo;</button>
      <span class="playlist-move-label" aria-hidden="true">Move</span>
      <button class="button-ghost playlist-move" type="button" data-playlist-move="1" data-playlist-id="${listId}" data-playlist-key="${key}" aria-label="${escapeAttribute(`Move ${title} right`)}" title="Move right"${index === count - 1 ? " disabled" : ""}>&rsaquo;</button>
    </div>
  `;
}

function heldChangeText(hold) {
  const label = providerLabel(hold.provider);
  if (hold.confirmed) return `${label}: confirmed. It applies on the next sync.`;
  if (hold.kind === "delete") {
    return `${label} reports this playlist was deleted there. Confirm to delete it everywhere, or discard to recreate it in ${label}.`;
  }
  const count = Number(hold.change_count || 0);
  return `${count} title${count === 1 ? " was" : "s were"} removed from this playlist in ${label} at once. Confirm to remove ${count === 1 ? "it" : "them"} here too, or discard to put ${count === 1 ? "it" : "them"} back in ${label}.`;
}

function heldChangesHtml(list) {
  const holds = Array.isArray(list.held_changes) ? list.held_changes : [];
  if (!holds.length) return "";
  return holds.map((hold) => `
    <div class="playlist-held-change" role="status">
      <span>${escapeHtml(heldChangeText(hold))}</span>
      ${hold.confirmed ? "" : `<div class="playlist-held-actions">
        <button class="button-primary" type="button" data-playlist-held="confirm" data-playlist-id="${escapeAttribute(list.id)}" data-playlist-provider="${escapeAttribute(hold.provider)}" data-playlist-held-kind="${escapeAttribute(hold.kind)}">Confirm</button>
        <button class="button-ghost" type="button" data-playlist-held="discard" data-playlist-id="${escapeAttribute(list.id)}" data-playlist-provider="${escapeAttribute(hold.provider)}" data-playlist-held-kind="${escapeAttribute(hold.kind)}">Discard</button>
      </div>`}
    </div>
  `).join("");
}

// App entries Plekt could not identify stay in the app untouched
// (plan decision 24); the note says how many, per app.
function unidentifiedNoteHtml(list) {
  const notes = (list.providers || [])
    .filter((entry) => Number(entry.unidentified_count) > 0)
    .map((entry) => {
      const count = Number(entry.unidentified_count);
      return `${count} item${count === 1 ? "" : "s"} in ${providerLabel(entry.provider)} ${count === 1 ? "was" : "were"} not identified. ${count === 1 ? "It stays" : "They stay"} in ${providerLabel(entry.provider)} only.`;
    });
  if (!notes.length) return "";
  return `<p class="playlist-unidentified-note" role="note">${escapeHtml(notes.join(" "))}</p>`;
}

function emptyRailText(list = {}) {
  if (isAutomaticPlaylist(list)) {
    return list.rule_checked_at ? "No titles match the rule right now. Edit the rule or wait for the next check." : "Checking the rule, this can take a minute or two.";
  }
  if (list.kind === "movie") return "Add a movie from any media card.";
  if (list.kind === "tv") return "Add episodes from any TV show's media card.";
  if (list.kind === "mixed") return "Add a movie or episodes of a TV show from any media card.";
  return "Add a movie or episodes of a TV show from any media card. The first title sets the playlist's type.";
}

function renderPlaylistSection(list, index) {
  const name = list?.name || "Untitled playlist";
  const items = Array.isArray(list?.items) ? list.items : [];
  const headingId = `personal-list-${index}-title`;
  return `
    <section class="personal-media-list-section" aria-labelledby="${headingId}">
      <div class="personal-media-list-heading">
        ${playlistRefreshIndicatorHtml(list)}
        <h2 id="${headingId}">${escapeHtml(name)}</h2>
        ${list?.kind ? `<span class="playlist-kind-label">${PLAYLIST_KIND_LABELS[list.kind] || ""}</span>` : ""}
        ${playlistProviderIconsHtml(list)}
        <span>${items.length} item${items.length === 1 ? "" : "s"}</span>
        <div class="playlist-heading-actions">
          ${playlistRuleHeadingHtml(list)}
          <details class="playlist-options">
            <summary class="button-ghost" aria-label="Options for ${escapeAttribute(name)}">Options</summary>
            <div class="playlist-options-menu" role="menu">
              ${playlistRuleMenuItemsHtml(list)}
              <button class="playlist-options-item personal-media-edit-list" type="button" role="menuitem" data-playlist-edit="${escapeAttribute(list.id)}" title="${isAutomaticPlaylist(list) ? "Rename, change the rule, or choose apps" : "Rename or choose apps"}">Edit</button>
              <button class="playlist-options-item playlist-options-item--danger personal-media-delete-list" type="button" role="menuitem" data-personal-delete-list="${escapeAttribute(list.id)}" title="Delete ${escapeAttribute(name)}">Delete</button>
            </div>
          </details>
        </div>
      </div>
      ${playlistRulePanelHtml(list)}
      ${heldChangesHtml(list)}
      ${unidentifiedNoteHtml(list)}
      <div class="personal-media-list-row horizontal-scroll-row${items.length ? "" : " is-empty"}" data-personal-list-rail data-playlist-rail="${escapeAttribute(list.id)}">
        ${items.length
          ? playlistRailHtml(list, items)
          : `<div class="empty-log personal-media-list-empty"><b>No items yet</b><span>${escapeHtml(emptyRailText(list))}</span></div>`}
      </div>
    </section>
  `;
}

function formatDeletedAt(value) {
  const date = new Date(Number(value || 0));
  if (Number.isNaN(date.getTime()) || !Number(value)) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function renderRecentlyDeleted(deletedLists) {
  if (!deletedLists.length) return "";
  const rows = deletedLists.map((list) => {
    const origin = list.deleted_origin && list.deleted_origin !== "local"
      ? `Deleted in ${providerLabel(list.deleted_origin)}`
      : "Deleted in Plekt";
    const when = formatDeletedAt(list.deleted_at);
    const count = Number(list.item_count || 0);
    const pending = (list.pending_app_deletes || []).map(providerLabel);
    const apps = (list.providers || []).map(providerLabel);
    const details = [
      `${count} item${count === 1 ? "" : "s"}`,
      `${origin}${when ? ` on ${when}` : ""}`,
      apps.length ? `Restores to ${joinNames(apps)}` : "Plekt only",
      pending.length ? `Still removing from ${joinNames(pending)}` : "",
    ].filter(Boolean).join(" · ");
    return `
      <li class="playlist-deleted-row">
        <div class="playlist-deleted-copy"><b>${escapeHtml(list.name || "Untitled playlist")}</b><span>${escapeHtml(details)}</span></div>
        <div class="playlist-deleted-actions">
          <button class="button-ghost" type="button" data-playlist-restore="${escapeAttribute(list.id)}">Restore</button>
          <button class="button-danger" type="button" data-playlist-purge="${escapeAttribute(list.id)}">Delete permanently</button>
        </div>
      </li>
    `;
  }).join("");
  return `
    <div class="playlist-recently-deleted">
      <div class="playlist-recently-deleted-head">
        <p class="playlist-recently-deleted-copy">Restore puts a playlist back in Plekt and in every app it was synced to. Delete permanently removes it for good.</p>
        ${deletedLists.length > 1 ? `<button class="button-danger" type="button" data-playlist-purge-all>Delete all permanently</button>` : ""}
      </div>
      <ul class="playlist-deleted-list">${rows}</ul>
    </div>
  `;
}

// The toolbar's Recently deleted button, shown only while something is there.
export function recentlyDeletedButtonHtml() {
  const count = (state.personalDeletedLists || []).length;
  if (!count) return "";
  return `<button class="action-pill page-action-pill playlist-recently-deleted-button" type="button" data-playlist-recently-deleted title="Restore or permanently delete removed playlists">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M6.5 1h3a1 1 0 0 1 1 1v1h3a.75.75 0 0 1 0 1.5h-.6l-.7 9.1A1.5 1.5 0 0 1 10.7 15H5.3a1.5 1.5 0 0 1-1.5-1.4L3.1 4.5h-.6a.75.75 0 0 1 0-1.5h3V2a1 1 0 0 1 1-1zm.5 2h2v-.5H7zM4.6 4.5l.7 9h5.4l.7-9z"/></svg>
      <span>Recently deleted (${count})</span>
    </button>`;
}

// Restore and Delete permanently close the dialog while they run (Delete asks
// first), then it opens again with what is left.
export function openRecentlyDeletedDialog() {
  const deletedLists = state.personalDeletedLists || [];
  if (!deletedLists.length) return;
  const overlay = helpers.dialogFrame("Recently deleted", renderRecentlyDeleted(deletedLists));
  overlay.addEventListener?.("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const restore = target?.closest("[data-playlist-restore]");
    const purge = target?.closest("[data-playlist-purge]");
    const purgeAll = target?.closest("[data-playlist-purge-all]");
    if (!restore && !purge && !purgeAll) return;
    event.preventDefault();
    helpers.closePersonalDialog(overlay);
    const task = restore
      ? restorePlaylist(restore.dataset.playlistRestore)
      : (purgeAll ? purgeAllPlaylists() : purgePlaylist(purge.dataset.playlistPurge)).then(() => true);
    task
      .then((reopen) => { if (reopen) openRecentlyDeletedDialog(); })
      .catch((error) => helpers.setMessage(error.message, "error"));
  });
}

export function renderPlaylists(lists = []) {
  if (!lists.length) {
    return helpers.emptyPersonalState("No playlists yet", "Create a playlist to collect films and shows your way, and sync it to Plex, Emby, or Jellyfin.");
  }
  const sections = (entries, offset) => entries.map((list, index) => renderPlaylistSection(list, offset + index)).join("");
  const visible = lists.slice(0, VISIBLE_RAILS);
  const additional = lists.slice(VISIBLE_RAILS);
  return `
    <div class="personal-media-list-viewport">
      ${sections(visible, 0)}
    </div>
    ${additional.length ? `<div class="personal-media-list-overflow">${sections(additional, VISIBLE_RAILS)}</div>` : ""}
  `;
}

// While an automatic playlist has never been checked, or a check is running,
// reload the playlists every 10 s so its titles appear without a manual
// refresh (decisions 58 and 63). Otherwise ask every 30 s whether a scheduled
// pass changed anything (a small fingerprint, not the whole page) and reload
// only when it did (decision 67).
// Only while the Playlists tab is on screen and the browser tab is visible.
const RULE_CHECK_POLL_MS = 10_000;
const PLAYLIST_CHANGE_POLL_MS = 30_000;
let ruleCheckTimer = null;

export function watchUncheckedPlaylistRules(panel) {
  if (ruleCheckTimer) return;
  const waiting = () => (state.personalLists || []).some((list) => isAutomaticPlaylist(list) && (!list.rule_checked_at || list.rule_checking));
  const onScreen = () => state.personalMediaTab === "lists" && panel?.isConnected && panel.offsetParent !== null;
  if (state.personalMediaTab !== "lists") return;
  ruleCheckTimer = setTimeout(async () => {
    ruleCheckTimer = null;
    if (!onScreen()) return;
    // A drag in progress would be cut short by a redraw; try again next time.
    if (document.visibilityState === "visible" && !panel.querySelector(".is-dragging")) {
      try {
        const changed = waiting() || (await helpers.personalRequest({ action: "list-stamp" })).stamp !== state.personalListsStamp;
        if (changed) await helpers.loadPersonalMedia({ force: true });
      } catch {
        // The next round tries again.
      }
    }
    watchUncheckedPlaylistRules(panel);
  }, waiting() ? RULE_CHECK_POLL_MS : PLAYLIST_CHANGE_POLL_MS);
}

function providerPickerHtml(current = []) {
  const connected = new Map((state.playlistProviders || []).map((entry) => [entry.provider, Boolean(entry.configured)]));
  const options = PLAYLIST_PROVIDER_ORDER.map((provider) => {
    const checked = current.includes(provider);
    // An app already selected stays selectable after it is disconnected.
    const enabled = checked || connected.get(provider);
    const label = providerLabel(provider);
    return `
      <label class="playlist-provider-choice${enabled ? "" : " is-disabled"}">
        <input type="checkbox" name="providers" value="${provider}"${checked ? " checked" : ""}${enabled ? "" : " disabled"} />
        <img src="${escapeAttribute(platformIconUrl(provider))}" alt="" loading="lazy" decoding="async" />
        <span>${label}${enabled ? "" : " <small>Not connected</small>"}</span>
      </label>
    `;
  }).join("");
  return `
    <fieldset class="playlist-provider-picker">
      <legend class="field-label">Sync to apps</legend>
      <div class="playlist-provider-choices">${options}</div>
      <p class="playlist-availability-notice">Each app's copy holds only titles that are in that app's library. Titles an app does not have stay in the Plekt playlist, marked "Missing from" that app, and join the app's copy once they arrive. An app gets no playlist until at least one of its titles is in that app's library. Leave every app unticked to keep the playlist in Plekt only.</p>
    </fieldset>
  `;
}

// Help under the "Remove items once watched" switch (decisions 55 and 56).
function removeWatchedHelp(automaticTv) {
  return automaticTv
    ? "An episode leaves this playlist, and every app, once you watch it, and the show moves to Up Next for good."
    : "A movie or episode leaves this playlist, and every app, once you watch it.";
}

// Create (list = null) or edit an existing playlist. The create path is also
// used from media pages and the poster menu, with an item to add afterwards.
export function openPlaylistDialog({ list = null, afterCreateItem = null } = {}) {
  const editing = Boolean(list);
  const automatic = editing && isAutomaticPlaylist(list);
  // Automatic is offered when creating from the Playlists page; a playlist
  // created to hold a picked title picks its items by hand.
  const offerAutomatic = !editing && !afterCreateItem;
  const current = editing ? selectedProviders(list).map((entry) => entry.provider) : [];
  const hasRuleStep = offerAutomatic || automatic;
  const steps = [
    { id: "details", label: "Name and type" },
    ...(hasRuleStep ? [{ id: "rule", label: "Rule" }] : []),
    { id: "apps", label: "Apps" },
  ];
  const kindCards = ["movie", "tv", "mixed"].map((kind) => choiceCardHtml({
    name: "kind",
    value: kind,
    title: PLAYLIST_KIND_LABELS[kind],
    description: KIND_DESCRIPTIONS[kind],
    required: true,
    checked: Boolean(afterCreateItem) && playlistItemKind(afterCreateItem) === kind,
    disabled: Boolean(afterCreateItem) && kind !== "mixed" && playlistItemKind(afterCreateItem) !== kind,
  })).join("");
  const panel = (id, title, body) => `
    <section class="playlist-wizard-panel" data-wizard-panel="${id}"${id === "details" ? "" : " hidden"}>
      <h3>${escapeHtml(title)}</h3>
      ${body}
    </section>`;
  const overlay = helpers.dialogFrame(editing ? `Edit ${list.name}` : "Create a playlist", `
    <form class="personal-media-create-form playlist-wizard" novalidate>
      <nav class="playlist-wizard-steps" aria-label="Steps">
        ${steps.map((step, index) => `<button type="button" class="settings-tab playlist-wizard-tab${index === 0 ? " active" : ""}" data-wizard-tab="${step.id}"${step.id === "rule" && !automatic ? " hidden" : ""}${index === 0 ? ` aria-current="step"` : ""}><span class="playlist-wizard-number" aria-hidden="true">${index + 1}</span><span>${step.label}</span></button>`).join("")}
      </nav>
      <div class="playlist-wizard-main">
        ${panel("details", "Name and type", `
          <label class="field-label" for="personalListName">Playlist name<input id="personalListName" class="field" name="name" maxlength="100" required autocomplete="off" value="${escapeAttribute(editing ? list.name : "")}" /></label>
          ${offerAutomatic ? `<fieldset class="playlist-wizard-fieldset">
            <legend class="field-label">Items</legend>
            <div class="settings-choice-grid" role="radiogroup" aria-label="Items">
              ${choiceCardHtml({ name: "mode", value: "manual", title: "Pick items", description: "You add titles from any media card and order them yourself.", checked: true })}
              ${choiceCardHtml({ name: "mode", value: "automatic", title: "Automatic", description: "A rule (genres, years, watched, recently added) fills it, checked every hour. Movies or TV only." })}
            </div>
          </fieldset>` : ""}
          ${editing ? `<p class="personal-media-dialog-copy">${escapeHtml(PLAYLIST_KIND_LABELS[list.kind] || "Untyped")} playlist${automatic ? ", automatic" : ""}. The type cannot be changed.</p>` : `<fieldset class="playlist-wizard-fieldset">
            <legend class="field-label">Playlist type</legend>
            <div class="settings-choice-grid playlist-wizard-kinds" role="radiogroup" aria-label="Playlist type">${kindCards}</div>
            <p class="playlist-availability-notice">The type cannot be changed later.</p>
          </fieldset>`}
          <label class="settings-modal-field settings-modal-field--checkbox playlist-remove-watched">
            <span class="settings-modal-field-label">
              <span class="settings-modal-field-title">Remove items once watched</span>
              <span class="settings-field-help" data-playlist-remove-watched-help>${escapeHtml(removeWatchedHelp(automatic && list.kind === "tv"))}</span>
            </span>
            <span class="settings-modal-field-control">
              <input type="checkbox" name="removeWatched"${!editing || list.remove_watched ? " checked" : ""} />
            </span>
          </label>
        `)}
        ${hasRuleStep ? panel("rule", "Rule", ruleEditorHtml(automatic ? list.rule : null, { kind: automatic ? list.kind : "" })) : ""}
        ${panel("apps", "Apps", `
          ${providerPickerHtml(current)}
          ${editing && current.length ? `<p class="playlist-deselect-note">Unticking an app deletes this playlist from that app.</p>` : ""}
        `)}
        <p class="personal-media-dialog-error hidden" data-personal-dialog-error role="alert"></p>
        <div class="personal-media-dialog-actions">
          <button class="button-ghost personal-media-dialog-close" type="button">Cancel</button>
          <button class="button-ghost" type="button" data-wizard-back hidden>Back</button>
          <button class="button-ghost" type="button" data-wizard-next>Next</button>
          <button class="button-primary" type="submit" data-wizard-finish${editing ? "" : " hidden"}>${editing ? "Save" : "Create playlist"}</button>
        </div>
      </div>
    </form>
  `);
  const form = overlay.querySelector("form");
  const input = form?.querySelector("input[name=name]");
  const submit = form?.querySelector("[type=submit]");
  const errorMessage = form?.querySelector("[data-personal-dialog-error]");
  let submitting = false;
  input?.focus();
  const kindOf = () => (automatic ? list.kind : form?.querySelector("input[name=kind]:checked")?.value || "");
  const isAutomatic = () => automatic || form?.querySelector("input[name=mode]:checked")?.value === "automatic";
  const showError = (message) => {
    if (!errorMessage) return;
    errorMessage.textContent = message;
    errorMessage.classList.toggle("hidden", !message);
  };
  bindRuleEditor(form, { helpers, kindOf });
  // The steps down the side: the Rule step exists only for Automatic.
  const activeSteps = () => steps.filter((step) => step.id !== "rule" || isAutomatic()).map((step) => step.id);
  let currentStep = "details";
  const detailsError = () => {
    if (!String(input?.value || "").trim()) return "Enter a playlist name.";
    if (!editing && !kindOf()) return "Choose Movies, TV, or Mixed.";
    return "";
  };
  const goTo = (id) => {
    const order = activeSteps();
    if (!order.includes(id)) return;
    if (id !== "details" && currentStep === "details") {
      const problem = detailsError();
      showError(problem);
      if (problem) return;
    }
    currentStep = id;
    const index = order.indexOf(id);
    form.querySelectorAll("[data-wizard-panel]").forEach((section) => { section.hidden = section.dataset.wizardPanel !== id; });
    form.querySelectorAll("[data-wizard-tab]").forEach((tab) => {
      const active = tab.dataset.wizardTab === id;
      tab.hidden = !order.includes(tab.dataset.wizardTab);
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "step");
      else tab.removeAttribute("aria-current");
      const number = tab.querySelector(".playlist-wizard-number");
      if (number) number.textContent = String(order.indexOf(tab.dataset.wizardTab) + 1);
    });
    const last = index === order.length - 1;
    const back = form.querySelector("[data-wizard-back]");
    const next = form.querySelector("[data-wizard-next]");
    if (back) back.hidden = index === 0;
    if (next) next.hidden = last;
    if (submit) submit.hidden = !editing && !last;
  };
  form?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target?.closest("[data-wizard-tab]");
    const order = activeSteps();
    if (tab) goTo(tab.dataset.wizardTab);
    else if (target?.closest("[data-wizard-next]")) goTo(order[order.indexOf(currentStep) + 1]);
    else if (target?.closest("[data-wizard-back]")) goTo(order[order.indexOf(currentStep) - 1]);
  });
  // Choosing Automatic adds the Rule step and rules out Mixed.
  const removeHelp = form?.querySelector("[data-playlist-remove-watched-help]");
  form?.addEventListener("change", (event) => {
    if (!["mode", "kind"].includes(event.target?.name)) return;
    const on = isAutomatic();
    if (removeHelp) removeHelp.textContent = removeWatchedHelp(on && kindOf() === "tv");
    if (event.target.name !== "mode") return;
    const mixed = form.querySelector("input[name=kind][value=mixed]");
    if (mixed) {
      mixed.disabled = on;
      if (on) mixed.checked = false;
    }
    goTo(currentStep);
  });
  // Number the steps as shown (the hidden Rule step is not counted).
  if (form) goTo(currentStep);
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    const order = activeSteps();
    // Enter before the last step moves on instead of creating.
    if (!editing && currentStep !== order[order.length - 1]) {
      goTo(order[order.indexOf(currentStep) + 1]);
      return;
    }
    const problem = detailsError();
    if (problem) {
      goTo("details");
      showError(problem);
      return;
    }
    const name = String(input?.value || "").trim();
    const providers = [...form.querySelectorAll("input[name=providers]:checked")].map((box) => box.value);
    const rule = isAutomatic() ? readRuleFromForm(form) : null;
    const removeWatched = Boolean(form.querySelector("input[name=removeWatched]")?.checked);
    submitting = true;
    if (submit) submit.disabled = true;
    showError("");
    try {
      if (editing) {
        const payload = { action: "list-update", list_id: list.id, providers };
        if (name !== list.name) payload.name = name;
        if (rule && JSON.stringify(rule) !== JSON.stringify(list.rule)) payload.rule = rule;
        if (removeWatched !== Boolean(list.remove_watched)) payload.remove_watched = removeWatched;
        await helpers.personalRequest(payload);
        await helpers.loadPersonalMedia({ force: true });
        helpers.closePersonalDialog(overlay);
        helpers.setMessage(`${name} saved.`, "success");
        return;
      }
      const kind = form.querySelector("input[name=kind]:checked")?.value || "";
      const body = await helpers.personalRequest({ action: "list-create", name, kind, providers, remove_watched: removeWatched, ...(rule ? { rule } : {}) });
      if (!body?.list?.id) throw new Error("The server did not return the created playlist.");
      await helpers.loadPersonalMedia({ force: true });
      if (afterCreateItem) {
        await helpers.addToCustomList(afterCreateItem, body.list.id);
      } else {
        helpers.closePersonalDialog(overlay);
        helpers.setMessage(`${name} created.`, "success");
      }
    } catch (error) {
      submitting = false;
      if (submit && overlay.isConnected) submit.disabled = false;
      const message = error?.message || "Unable to save the playlist.";
      if (errorMessage && overlay.isConnected) {
        errorMessage.textContent = message;
        errorMessage.classList.remove("hidden");
      }
      helpers.setMessage(message, "error");
    }
  });
}

export function openCreateListDialog(afterCreateItem = null) {
  openPlaylistDialog({ afterCreateItem });
}

// "Import from apps" (decision 21); only connected apps can be ticked as targets.
export function openImportPlaylistsDialog() {
  const connected = (state.playlistProviders || []).filter((entry) => entry.configured).map((entry) => entry.provider);
  return openPlaylistImportDialog({ helpers, connected });
}

export function openAddToListDialog(item) {
  const normalized = helpers.normalizeItem(item);
  // Only playlists of the title's type (Movies or TV) and Mixed ones are offered.
  const lists = (state.personalLists || []).filter((list) => playlistAcceptsItem(list, normalized));
  const existingListIds = new Set(helpers.customListsForPersonalItem(normalized).map((list) => String(list.id)));
  const kindLabel = playlistItemKind(normalized) === "tv" ? "TV or Mixed" : "Movies or Mixed";
  const body = lists.length
    ? `<p class="personal-media-dialog-copy">Choose a playlist for <b>${escapeHtml(normalized.title)}</b>.</p><div class="personal-list-choice-grid">${lists.map((list) => {
      const alreadyAdded = existingListIds.has(String(list.id));
      return `<button class="button-ghost${alreadyAdded ? " personal-list-choice--added" : ""}" type="button" ${alreadyAdded ? "disabled" : ""} data-dialog-list-id="${escapeAttribute(list.id)}" aria-label="${escapeAttribute(alreadyAdded ? `${list.name}, already added` : `Add to ${list.name}`)}">${escapeHtml(list.name)}${alreadyAdded ? " · Added" : ""}</button>`;
    }).join("")}</div><button class="button-ghost" type="button" data-dialog-create-list>Create a new playlist</button>`
    : `<p class="personal-media-dialog-copy">You have no ${kindLabel} playlist yet. Create one, then this title will be added to it.</p><button class="button-primary" type="button" data-dialog-create-list>Create a new playlist</button>`;
  const overlay = helpers.dialogFrame(`Add ${normalized.title} to a playlist`, body);
  overlay.addEventListener("click", (event) => {
    const listButton = event.target.closest("[data-dialog-list-id]");
    const createButton = event.target.closest("[data-dialog-create-list]");
    if (listButton) {
      event.preventDefault();
      helpers.addToCustomList(normalized, listButton.dataset.dialogListId).catch((error) => helpers.setMessage(error.message, "error"));
    } else if (createButton) {
      event.preventDefault();
      openCreateListDialog(normalized);
    }
  });
}

async function deletePlaylist(listId) {
  const list = listById(listId);
  if (!list) return;
  const apps = selectedProviders(list).map((entry) => providerLabel(entry.provider));
  const confirmed = await helpers.confirm({
    title: "Delete playlist?",
    body: `Move "${list.name}" to Recently deleted?${apps.length ? ` It is also deleted from ${joinNames(apps)}.` : ""} You can restore it from Recently deleted.`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    danger: true,
  });
  if (!confirmed) return;
  await helpers.personalRequest({ action: "list-delete", list_id: list.id });
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(`${list.name} moved to Recently deleted.`, "success");
}

async function movePlaylistItem(listId, mediaKey, step) {
  const list = listById(listId);
  if (!list) return;
  const order = (list.items || []).map((item) => item.media_key);
  const from = order.indexOf(mediaKey);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return;
  [order[from], order[to]] = [order[to], order[from]];
  await sendOrder(list.id, order);
}

async function sendOrder(listId, order) {
  await helpers.personalRequest({ action: "list-reorder", list_id: listId, order });
  await helpers.loadPersonalMedia({ force: true });
}

async function dropPlaylistItems(listId, fromKeys, toKey, after) {
  const list = listById(listId);
  if (!list) return;
  const order = reorderedBlock((list.items || []).map((item) => item.media_key), fromKeys, toKey, after);
  if (order) await sendOrder(list.id, order);
}

// A stack card stands for all its episodes: dragging it moves them all, and
// dropping onto it lands before its first or after its last episode.
function dragKeysOf(card) {
  const block = card.dataset.playlistDragBlock;
  return block ? block.split("\n") : [card.dataset.playlistDragKey];
}

export function toggleStack(stack) {
  const listId = stack.closest("[data-playlist-rail]")?.dataset.playlistRail || "";
  const first = stack.dataset.playlistStack;
  const id = stackId(listId, first);
  const expanded = !expandedStacks.has(id);
  if (expanded) expandedStacks.add(id);
  else expandedStacks.delete(id);
  stack.dataset.stackExpanded = expanded ? "1" : "0";
  stack.setAttribute("aria-expanded", expanded ? "true" : "false");
  stack.setAttribute("aria-label", String(stack.getAttribute("aria-label") || "").replace(/; (expand|collapse)$/, `; ${expanded ? "collapse" : "expand"}`));
  stack.parentElement?.querySelectorAll("[data-playlist-stack-member]").forEach((member) => {
    if (member.dataset.playlistStackMember === first) member.dataset.stackCollapsed = expanded ? "0" : "1";
  });
}

// The cards a drag moves: a stack card carries its episode cards with it.
function dragGroupOf(card) {
  const first = card.dataset.playlistStack;
  const members = first && typeof card.parentElement?.querySelectorAll === "function"
    ? [...card.parentElement.querySelectorAll(`[data-playlist-stack-member="${globalThis.CSS?.escape ? CSS.escape(first) : first}"]`)]
    : [];
  return [card, ...members];
}

// Runs `move` (a DOM reorder in one rail) and slides every card that shifted
// from its old place to its new one, so the others visibly make way.
function slideRail(row, move) {
  const cards = typeof row?.children === "object" ? [...row.children] : [];
  const before = new Map(cards.map((card) => [card, card.getBoundingClientRect?.().left]));
  move();
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return;
  cards.forEach((card) => {
    const from = before.get(card);
    const to = card.getBoundingClientRect?.().left;
    if (typeof card.animate !== "function" || !card.offsetWidth || from == null || from === to) return;
    card.animate([{ transform: `translateX(${from - to}px)` }, { transform: "translateX(0)" }], { duration: 180, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  });
}

// Delegated on the panel once; the rails are re-rendered on every refresh.
// While a card is dragged it is moved through its rail live: the others slide
// out of the way and the card's own slot shows as a dashed insert outline
// (.is-dragging), while the browser's drag image is the picked-up card. The
// drop sends the order; a cancelled drag puts the cards back.
export function bindPlaylistDragAndDrop(panel) {
  if (!panel || panel.dataset.playlistDragBound) return;
  panel.dataset.playlistDragBound = "1";
  let dragging = null;
  const cardOf = (event) => (event.target instanceof Element ? event.target.closest("[data-playlist-drag-key]") : null);
  const railOf = (element) => element?.closest?.("[data-playlist-rail]")?.dataset.playlistRail;
  const clearMarks = () => panel.querySelectorAll(".is-dragging")
    .forEach((element) => element.classList.remove("is-dragging"));
  const dropSide = (event, card) => {
    const box = card.getBoundingClientRect();
    return event.clientX > box.left + box.width / 2;
  };
  // Where a drop on `card` lands: before its first or after its last item.
  const targetOf = (card, after) => {
    const keys = dragKeysOf(card);
    return { key: after ? keys[keys.length - 1] : keys[0], after };
  };
  const putBack = (source) => {
    const { group, origin } = source;
    if (!origin?.parent || typeof origin.parent.insertBefore !== "function") return;
    group.forEach((element) => origin.parent.insertBefore(element, origin.next && origin.next.parentNode === origin.parent ? origin.next : null));
  };
  // Moves the dragged cards next to `card` in the rail, sliding the others.
  const moveLive = (card, after) => {
    const { group } = dragging;
    const anchor = after && card.dataset.playlistStack ? dragGroupOf(card).at(-1) : card;
    const last = group[group.length - 1];
    const placed = after ? anchor.nextElementSibling === group[0] : last.nextElementSibling === anchor;
    if (placed || typeof anchor.before !== "function") return;
    slideRail(anchor.parentElement, () => (after ? anchor.after(...group) : anchor.before(...group)));
  };
  // Clicking a stack's poster expands or collapses it instead of opening the
  // show (page-card-open.js leaves stacks alone). Capture phase, so the
  // poster link never navigates.
  panel.addEventListener("click", (event) => {
    const stack = event.target instanceof Element ? event.target.closest("[data-playlist-stack]") : null;
    if (!stack || event.target.closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    toggleStack(stack);
  }, true);
  panel.addEventListener("dragstart", (event) => {
    const card = cardOf(event);
    const rail = card?.closest("[data-playlist-rail]");
    if (!card || !rail) return;
    const group = dragGroupOf(card);
    const last = group[group.length - 1];
    dragging = {
      key: card.dataset.playlistDragKey,
      keys: dragKeysOf(card),
      listId: rail.dataset.playlistRail,
      group,
      origin: { parent: card.parentElement, next: last.nextSibling },
      target: null,
    };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", dragging.key);
    }
    // After the browser has taken the drag image, so that stays the card.
    setTimeout(() => { if (dragging?.group[0] === card) card.classList.add("is-dragging"); }, 0);
  });
  panel.addEventListener("dragover", (event) => {
    if (!dragging) return;
    const card = cardOf(event);
    const target = event.target instanceof Element ? event.target : null;
    // The gaps of the dragged card's own rail accept the drop too.
    if (railOf(card || target) !== dragging.listId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    // Over its own slot, or a card still sliding, the last target stands.
    if (!card || dragging.group.includes(card) || card.getAnimations?.().length) return;
    const after = dropSide(event, card);
    dragging.target = targetOf(card, after);
    moveLive(card, after);
  });
  panel.addEventListener("drop", (event) => {
    const card = cardOf(event);
    const source = dragging;
    dragging = null;
    clearMarks();
    const target = event.target instanceof Element ? event.target : null;
    if (!source || railOf(card || target) !== source.listId) {
      if (source) putBack(source);
      return;
    }
    event.preventDefault();
    const drop = source.target || (card && !source.group.includes(card) ? targetOf(card, dropSide(event, card)) : null);
    if (!drop) return;
    dropPlaylistItems(source.listId, source.keys, drop.key, drop.after)
      .catch((error) => {
        putBack(source);
        helpers.setMessage(error.message, "error");
      });
  });
  // A drag that ends without a drop (Escape, or let go outside the rail).
  panel.addEventListener("dragend", () => {
    if (dragging) putBack(dragging);
    dragging = null;
    clearMarks();
  });
}

function openRestoreNameDialog(list, message) {
  const overlay = helpers.dialogFrame(`Restore ${list?.name || "playlist"}`, `
    <form class="personal-media-create-form">
      <p class="personal-media-dialog-copy">${escapeHtml(message)}</p>
      <label class="field-label" for="playlistRestoreName">New name<input id="playlistRestoreName" class="field" name="name" maxlength="100" required autocomplete="off" value="${escapeAttribute(list?.name || "")}" /></label>
      <p class="personal-media-dialog-error hidden" data-personal-dialog-error role="alert"></p>
      <div class="personal-media-dialog-actions"><button class="button-ghost personal-media-dialog-close" type="button">Cancel</button><button class="button-primary" type="submit">Restore</button></div>
    </form>
  `);
  const form = overlay.querySelector("form");
  const input = form?.querySelector("input[name=name]");
  const errorMessage = form?.querySelector("[data-personal-dialog-error]");
  input?.focus();
  input?.select?.();
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = String(input?.value || "").trim();
    if (!name) return;
    try {
      await requestRestore(list.id, name);
      helpers.closePersonalDialog(overlay);
    } catch (error) {
      if (errorMessage && overlay.isConnected) {
        errorMessage.textContent = error?.message || "Unable to restore the playlist.";
        errorMessage.classList.remove("hidden");
      }
    }
  });
}

async function requestRestore(listId, name = undefined) {
  const payload = { action: "list-restore", list_id: listId };
  if (name !== undefined) payload.name = name;
  const body = await helpers.personalRequest(payload);
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(`${body?.name || name || "Playlist"} restored.`, "success");
}

// A live playlist may have taken the name meanwhile; then ask for a new one.
// Returns false when it asked for a new name instead.
async function restorePlaylist(listId) {
  const list = (state.personalDeletedLists || []).find((entry) => String(entry.id) === String(listId));
  try {
    await requestRestore(listId);
    return true;
  } catch (error) {
    if (error?.code !== "name_taken") throw error;
    openRestoreNameDialog(list || { id: listId, name: "" }, error.message);
    return false;
  }
}

async function purgePlaylist(listId) {
  const list = (state.personalDeletedLists || []).find((entry) => String(entry.id) === String(listId));
  const confirmed = await helpers.confirm({
    title: "Delete permanently?",
    body: `Delete "${list?.name || "this playlist"}" permanently? This cannot be undone.`,
    confirmLabel: "Delete permanently",
    cancelLabel: "Keep",
    danger: true,
  });
  if (!confirmed) return;
  await helpers.personalRequest({ action: "list-purge", list_id: listId });
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(`${list?.name || "Playlist"} deleted permanently.`, "success");
}

// One confirmation, then each playlist is purged in turn; a failure stops the
// run and shows its error, with the page reloaded to what is left.
async function purgeAllPlaylists() {
  const lists = [...(state.personalDeletedLists || [])];
  if (!lists.length) return;
  const confirmed = await helpers.confirm({
    title: "Delete all permanently?",
    body: `Delete all ${lists.length} playlists in Recently deleted permanently? This cannot be undone.`,
    confirmLabel: "Delete all permanently",
    cancelLabel: "Keep",
    danger: true,
  });
  if (!confirmed) return;
  try {
    for (const list of lists) {
      await helpers.personalRequest({ action: "list-purge", list_id: list.id });
    }
  } finally {
    await helpers.loadPersonalMedia({ force: true });
  }
  helpers.setMessage(`${lists.length} playlists deleted permanently.`, "success");
}

async function decideHeldChange(button) {
  const { playlistId, playlistProvider, playlistHeldKind, playlistHeld } = button.dataset;
  await helpers.personalRequest({
    action: "list-held",
    list_id: playlistId,
    provider: playlistProvider,
    kind: playlistHeldKind,
    decision: playlistHeld,
  });
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(playlistHeld === "confirm" ? "Change confirmed." : "Change discarded.", "success");
}

// Returns true when the click belonged to the playlists page.
export function handlePlaylistClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return false;
  // Choosing an item closes its Options menu.
  if (target.closest("[role=menuitem]")) target.closest("details.playlist-options")?.removeAttribute("open");
  const run = (button, task) => {
    event.preventDefault();
    button.disabled = true;
    task()
      .catch((error) => helpers.setMessage(error.message, "error"))
      .finally(() => { if (button.isConnected) button.disabled = false; });
    return true;
  };
  const move = target.closest("[data-playlist-move]");
  if (move) return run(move, () => movePlaylistItem(move.dataset.playlistId, move.dataset.playlistKey, Number(move.dataset.playlistMove)));
  const edit = target.closest("[data-playlist-edit]");
  if (edit) {
    event.preventDefault();
    const list = listById(edit.dataset.playlistEdit);
    if (list) openPlaylistDialog({ list });
    return true;
  }
  const remove = target.closest("[data-personal-delete-list]");
  if (remove) return run(remove, () => deletePlaylist(remove.dataset.personalDeleteList));
  const held = target.closest("[data-playlist-held]");
  if (held) return run(held, () => decideHeldChange(held));
  const recentlyDeleted = target.closest("[data-playlist-recently-deleted]");
  if (recentlyDeleted) {
    event.preventDefault();
    openRecentlyDeletedDialog();
    return true;
  }
  return handleRuleClick(target, { run, listById, helpers });
}
