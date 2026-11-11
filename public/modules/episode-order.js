import { buildAuthHeaders } from "./auth.js?v=2.2.4.2.9";
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.2.4.2.9";
import { state } from "./state.js?v=2.2.4.2.9";

const API = "/api/episode-order";
const ORDERS = ["official", "dvd", "absolute", "alternate", "regional", "altdvd", "alttwo"];
const FALLBACK_NAMES = { official: "Aired order", dvd: "DVD order", absolute: "Absolute order", alternate: "Alternate order", regional: "Regional order", altdvd: "Alternate DVD order", alttwo: "Alternate order 2" };
// Same icon size and style as the other show Options menu items.
const ORDER_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5 11.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5zm-3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm0 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>`;
const orderLabel = (order, labels) => (labels && labels[order]) || FALLBACK_NAMES[order] || "Episode order";

let dialog;
let activeTvdbId = "";
let data = null;
let viewOrder = "";
let busy = false;
let message = "";
let showAll = false;
let simklAck = false;

export function episodeOrderButtonHtml(show = {}) {
  initEpisodeOrder();
  const tvdbId = String(show.tvdb_id || show.show_tvdb_id || "");
  if (!tvdbId || !document.documentElement.classList.contains("admin-session")) return "";
  return `<button class="action-pill" type="button" data-episode-order-tvdb="${escapeAttribute(tvdbId)}" aria-label="Episode order for ${escapeAttribute(show.title || show.name || "this show")}">${ORDER_ICON}<span>Episode order${show.episode_order && show.episode_order !== "official" ? `: ${escapeHtml(show.episode_order_label || orderLabel(show.episode_order))}` : ""}</span></button>`;
}

// Watches saved before the order was chosen carry no order provenance, so they are not shown as episodes.
export function episodeReviewNoticeHtml(count) {
  const n = Number(count) || 0;
  return n > 0 ? `<div class="empty-log"><b>${n} earlier ${n === 1 ? "watch is" : "watches are"} hidden</b><span>${n === 1 ? "It was" : "They were"} saved before this episode order was chosen, so Plekt cannot place ${n === 1 ? "it" : "them"} on an episode. Nothing was changed or removed. Use Fix Match to re-match ${n === 1 ? "it" : "them"}.</span></div>` : "";
}

export async function preflightEpisodeOrderAction(body) {
  const response = await fetch(`${API}/preflight`,{method:"POST",headers:{...buildAuthHeaders(state.token),"Content-Type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
  const result = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(result.error || "Episode mapping preflight failed. No watched state was changed.");
  if (!result.ok || (body.records && !Array.isArray(result.records))) throw new Error("Episode mapping preflight was incomplete. No watched state was changed.");
  return result;
}

function ensureDialog() {
  if (dialog?.isConnected) return dialog;
  dialog = document.createElement("dialog");
  dialog.className = "episode-order-dialog edit-dialog glass-panel";
  dialog.setAttribute("aria-labelledby", "episode-order-title");
  dialog.addEventListener("click", onDialogClick);
  dialog.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog.close(); } });
  dialog.addEventListener("close", () => { activeTvdbId = ""; data = null; viewOrder = ""; busy = false; message = ""; showAll = false; });
  document.body.append(dialog);
  return dialog;
}

const code = (episode) => `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;
const episodeLabel = (episode) => `${code(episode)} · ${episode.name || "Untitled episode"}`;
const byId = (list, id) => (list || []).find((episode) => String(episode.id) === String(id));

// One row per episode of the previewed order: what it is now, and the aired
// episode it becomes. An episode with no link gets a picker to link it by hand.
function previewRows(order) {
  const source = (data.episodes?.[order] || []).filter((episode) => episode.season >= 0);
  const links = data.linksByOrder?.[order] || [];
  const used = new Set(links.map((link) => String(link.airedId)));
  const free = (data.episodes?.official || []).filter((episode) => !used.has(String(episode.id)));
  let season = null;
  const entries = source.map((episode) => {
    const link = links.find((item) => String(item.dvdId) === String(episode.id));
    return { episode, link, target: link ? byId(data.episodes?.official, link.airedId) : null };
  }).filter(({ episode, link, target }) => showAll || !target || link.manual || code(target) !== code(episode));
  return entries.map(({ episode, link, target }) => {
    const heading = episode.season !== season ? `<div class="episode-order-season">${episode.season ? `Season ${episode.season}` : "Specials"}</div>` : "";
    season = episode.season;
    const result = target
      ? `<span class="episode-order-target${code(target) !== code(episode) ? " is-changed" : ""}">${escapeHtml(episodeLabel(target))}</span>${link.manual ? `<span class="episode-order-badge">Manual link</span>` : ""}${link.manual ? `<button class="button-ghost episode-order-small" type="button" data-episode-order-action="remove-link" data-order="${escapeAttribute(order)}" data-source-id="${escapeAttribute(episode.id)}">Remove link</button>` : ""}`
      : `<span class="episode-order-badge is-warning">No match</span><select class="field episode-order-pick" data-episode-order-pick="${escapeAttribute(episode.id)}" aria-label="Aired episode for ${escapeAttribute(episodeLabel(episode))}"><option value="">Link to an aired episode…</option>${free.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(episodeLabel(item))}</option>`).join("")}</select><button class="button-ghost episode-order-small" type="button" data-episode-order-action="save-link" data-order="${escapeAttribute(order)}" data-source-id="${escapeAttribute(episode.id)}">Link</button>`;
    return `${heading}<div class="episode-order-row"><span class="episode-order-source">${escapeHtml(episodeLabel(episode))}</span><span class="episode-order-arrow" aria-hidden="true">→</span><div class="episode-order-result">${result}</div></div>`;
  }).join("");
}

function render() {
  if (!dialog) return;
  if (!data) {
    dialog.innerHTML = `<h3 id="episode-order-title">Episode order</h3><p class="edit-dialog-status is-muted" role="status">${escapeHtml(message || "Loading episode order…")}</p><div class="edit-dialog-actions"><button class="button-ghost" type="button" data-episode-order-action="close">Close</button></div>`;
    return;
  }
  const current = data.order || "official";
  const choices = ORDERS.filter((order) => data.available?.[order]);
  const view = viewOrder || current;
  const name = (order) => orderLabel(order, data.labels);
  const links = data.linksByOrder?.[view] || [];
  const total = (data.episodes?.[view] || []).filter((episode) => episode.season >= 0).length;
  const cards = choices.map((order) => `<button type="button" class="episode-order-card${view === order ? " is-selected" : ""}" data-episode-order-action="view" data-order="${escapeAttribute(order)}" aria-pressed="${view === order}" ${busy ? "disabled" : ""}><strong>${escapeHtml(name(order))}</strong><span>${current === order ? "In use" : order === "official" ? "Episodes as TVDB airs them" : "Preview and switch"}</span></button>`).join("");
  let body;
  const hasAlternatives = choices.some((order) => order !== "official");
  if (view === "official") {
    body = hasAlternatives
      ? `<p class="muted-copy episode-order-empty">Aired order uses each episode's own season and episode number. There is nothing to translate.</p>`
      : `<p class="muted-copy episode-order-empty">No alternative episode orders are available for this show. Plekt uses the aired order.</p>`;
  } else {
    const unmatched = total - links.length;
    const rows = (data.episodes?.[view] || []).filter((episode) => episode.season >= 0);
    const renumbered = rows.filter((episode) => { const link = links.find((item) => String(item.dvdId) === String(episode.id)); const target = link && byId(data.episodes?.official, link.airedId); return target && code(target) !== code(episode); }).length;
    const same = links.length - renumbered;
    const headline = unmatched
      ? `<strong>${unmatched}</strong> of ${total} episodes have no matching aired episode and need a link.`
      : `All <strong>${total}</strong> episodes match an aired episode automatically.`;
    const detail = renumbered ? ` ${renumbered} get a different season or episode number; ${same} keep theirs.` : (links.length ? " Every episode keeps the same number." : "");
    body = `<div class="episode-order-summarybar"><p class="episode-order-summary">${headline}${detail}<br><span class="muted-copy">Left: what ${escapeHtml(name(view))} calls the episode, as your media server reports it. Right: the aired episode it becomes in Plekt and Trakt.</span></p><button class="button-ghost episode-order-small" type="button" data-episode-order-action="toggle-all">${showAll ? "Show only changes" : `Show all ${total} episodes`}</button></div>
      <div class="episode-order-list" role="list">${previewRows(view) || `<p class="muted-copy episode-order-empty">Nothing to change. Choose "Show all ${total} episodes" to see every one.</p>`}</div>`;
  }
  // Simkl cannot prove an episode from its TVDB id, so it receives nothing
  // for a show in a non-Aired order. The admin must agree before switching.
  const needsSimklAck = view !== "official" && view !== current && data.simklConnected === true;
  const canSwitch = view !== current && !busy && (!needsSimklAck || simklAck);
  const futureSimklNotice = view !== "official" && view !== current && data.simklConnected === false;
  const simklNotice = futureSimklNotice
    ? `<div class="episode-order-simkl" role="note" aria-label="Simkl note"><p><strong>Simkl does not support this order.</strong> Simkl is not connected, so nothing changes now. If you connect Simkl later, this show's watches in ${escapeHtml(name(view))} will not be sent to it. Other shows are not affected.</p></div>`
    : needsSimklAck
    ?`<div class="episode-order-simkl" role="group" aria-label="Simkl warning"><p><strong>Simkl does not support this order.</strong> Simkl cannot confirm which episode a watch in ${escapeHtml(name(view))} is, so Plekt will not send this show's watches to Simkl while this order is in use. Only this show is affected; its watches still reach Plex, Emby, Jellyfin and Trakt.</p><label class="episode-order-simkl-check"><input type="checkbox" data-episode-order-action="ack-simkl" ${simklAck ? "checked" : ""} ${busy ? "disabled" : ""}> <span>I understand that watches for this show will not be sent to Simkl.</span></label></div>`
    : "";
  dialog.innerHTML = `
    <header class="episode-order-head"><div><h3 id="episode-order-title">Episode order</h3><p class="muted-copy">Choose the numbering your media server uses for this show. Plekt translates it to the aired episode before saving a watch or sending it to a tracker.</p></div><button class="button-ghost" type="button" data-episode-order-action="close" aria-label="Close episode order">Close</button></header>
    <div class="episode-order-cards" role="group" aria-label="Episode order">${cards || `<p class="muted-copy">No episode orders are available for this show.</p>`}</div>
    <div class="episode-order-body">${body}</div>
    ${simklNotice}
    <footer class="episode-order-footer"><p class="edit-dialog-status${message ? "" : " is-muted"} episode-order-status" role="status" aria-live="polite">${escapeHtml(busy ? "Saving…" : message || `Current order: ${name(current)}. Changing it does not rewrite existing watch history.`)}</p><div class="edit-dialog-actions"><button class="button-ghost" type="button" data-episode-order-action="close">Close</button>${hasAlternatives ? `<button class="button-primary" type="button" data-episode-order-action="use-order" ${canSwitch ? "" : "disabled"}>Use ${escapeHtml(name(view))}</button>` : ""}</div></footer>
  `;
}

async function request(method = "GET", body = null) {
  const url = new URL(API, window.location.origin);
  if (method === "GET") url.searchParams.set("tvdbId", activeTvdbId);
  const response = await fetch(url, {
    method,
    headers: { ...buildAuthHeaders(state.token), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

async function load() {
  const requestedId = activeTvdbId;
  try {
    const loaded = await request();
    if (requestedId !== activeTvdbId || !dialog.open) return;
    data = loaded;
    if (!viewOrder || !data.available?.[viewOrder]) viewOrder = data.order || "official";
    render();
  } catch (error) {
    data = null;
    message = `Could not load episode order: ${error.message}`;
    render();
  }
}

// Saves, then reloads the state so the list shows what is now stored.
async function save(method, payload, done) {
  busy = true; message = ""; render();
  try {
    await request(method, { tvdbId: activeTvdbId, revision: data.revision, confirm: true, ...payload });
    busy = false;
    if (payload.order) { dialog.close(); window.location.reload(); return; }
    await load();
    message = done;
  } catch (error) {
    busy = false;
    message = `Could not save: ${error.message}`;
  }
  render();
}

function onDialogClick(event) {
  const button = event.target.closest("[data-episode-order-action]");
  if (!button || !dialog.contains(button) || busy) return;
  const action = button.dataset.episodeOrderAction;
  if (action === "close") { dialog.close(); return; }
  if (action === "view") { viewOrder = button.dataset.order; message = ""; showAll = false; simklAck = false; render(); return; }
  if (action === "ack-simkl") { simklAck = button.checked === true; render(); return; }
  if (action === "toggle-all") { showAll = !showAll; render(); return; }
  if (action === "use-order") { save("POST", { order: viewOrder, acknowledgeSimkl: simklAck }, ""); return; }
  const order = button.dataset.order;
  const sourceId = button.dataset.sourceId;
  if (action === "save-link") {
    const airedId = button.parentElement.querySelector("[data-episode-order-pick]")?.value;
    if (!airedId) { message = "Choose the aired episode to link first."; render(); return; }
    save("POST", { linkOrder: order, dvdId: sourceId, airedId }, "Link saved.");
  } else if (action === "remove-link") {
    save("DELETE", { linkOrder: order, dvdId: sourceId }, "Link removed. Automatic matching is used when available.");
  }
}

export function initEpisodeOrder() {
  if (document.documentElement.dataset.episodeOrderEvents === "bound") return;
  document.documentElement.dataset.episodeOrderEvents = "bound";
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-episode-order-tvdb]");
    if (!button || !document.documentElement.classList.contains("admin-session")) return;
    activeTvdbId = button.dataset.episodeOrderTvdb;
    viewOrder = "";
    busy = false;
    message = "";
    showAll = false;
    simklAck = false;
    data = null;
    const modal = ensureDialog();
    render();
    modal.showModal();
    modal.querySelector('[data-episode-order-action="close"]')?.focus();
    await load();
    modal.querySelector('[data-episode-order-action="close"]')?.focus();
  });
}
