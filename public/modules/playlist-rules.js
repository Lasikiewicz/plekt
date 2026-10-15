// Automatic playlists on the Playlists page (plan step 8c): the rule editor in
// the create and edit dialogs, the rule's summary and Info pop-up, the Auto
// label, the rule error and held check, and the Options menu's Info, Refresh
// now, and Stop updating. playlists.js owns the dialogs and passes its
// injected helpers in.
import { escapeAttribute, escapeHtml, formatDate } from "./utils.js?v=2.0.0.0.10";

const APP_LABELS = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };
const SOURCE_LABELS ={ library: "From your libraries", catalogue: "From the whole TMDB catalogue" };
// The type picks the titles; Ranked keeps its ranking (decisions 69 to 71).
const TYPE_LABELS = {
  top: "Top rated",
  popular: "Popular",
  trending: "Trending this week",
  new: "New releases",
};
const ORDER_LABELS = {
  ranked: "Ranked",
  newest: "Newest first",
  oldest: "Oldest first",
  title: "Title A to Z",
  rating: "Highest rated",
  random: "Random (shuffled once)",
};
// Original languages (TMDB's ISO 639-1 codes), the most asked for first.
const LANGUAGES = [
  ["en", "English"], ["ja", "Japanese"], ["ko", "Korean"], ["es", "Spanish"], ["fr", "French"],
  ["de", "German"], ["zh", "Chinese"], ["hi", "Hindi"], ["it", "Italian"], ["pt", "Portuguese"],
  ["ar", "Arabic"], ["cn", "Cantonese"], ["da", "Danish"], ["nl", "Dutch"], ["fi", "Finnish"],
  ["he", "Hebrew"], ["id", "Indonesian"], ["ml", "Malayalam"], ["no", "Norwegian"], ["pl", "Polish"],
  ["ru", "Russian"], ["sv", "Swedish"], ["ta", "Tamil"], ["te", "Telugu"], ["th", "Thai"], ["tr", "Turkish"],
];
const LANGUAGE_NAMES = new Map(LANGUAGES);
const NEW_RULE_LANGUAGES = ["en"];
const ADDED_DAYS = [7, 30, 90, 365];
const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 20;

export function isAutomaticPlaylist(list = {}) {
  return Boolean(list?.rule);
}

function watchedLabels(kind) {
  const what = kind === "tv" ? "episodes" : "titles";
  return { any: "Watched or not", unwatched: `Unwatched ${what} only`, watched: `Watched ${what} only` };
}

function yearsText(rule) {
  const { yearFrom: from, yearTo: to } = rule;
  if (from && to && to - from === 9 && from % 10 === 0) return `the ${from}s`;
  if (from && to) return from === to ? `${from}` : `${from} to ${to}`;
  if (from) return `${from} or later`;
  if (to) return `${to} or earlier`;
  return "";
}

function languageName(code) {
  return LANGUAGE_NAMES.get(code) || String(code).toUpperCase();
}

// "English or Korean"; nothing when any language will do.
function languagesText(rule) {
  const languages = Array.isArray(rule.languages) ? rule.languages : [];
  return languages.map(languageName).join(" or ");
}

// One line under the heading, e.g. "From your libraries · Comedy or Drama ·
// English · the 1990s · Unwatched titles only · Newest first · Up to 50".
export function playlistRuleSummary(list = {}) {
  const rule = list.rule;
  if (!rule) return "";
  const genres = Array.isArray(rule.genres) ? rule.genres : [];
  const parts = [
    SOURCE_LABELS[rule.source] || SOURCE_LABELS.library,
    TYPE_LABELS[rule.type] || TYPE_LABELS.top,
    genres.length ? genres.join(rule.genreMatch === "all" ? " and " : " or ") : "Any genre",
    languagesText(rule),
    yearsText(rule),
    list.kind === "tv" ? "Next episode of each show" : "",
    list.kind !== "tv" && rule.watched && rule.watched !== "any" ? watchedLabels(list.kind)[rule.watched] : "",
    rule.addedWithinDays ? `Added in the last ${rule.addedWithinDays} day${rule.addedWithinDays === 1 ? "" : "s"}` : "",
    rule.order && rule.order !== "ranked" ? ORDER_LABELS[rule.order] || "" : "",
    rule.limit ? `Up to ${rule.limit}${list.kind === "tv" ? ` show${rule.limit === 1 ? "" : "s"}` : ""}` : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

function ruleHoldText(hold) {
  if (hold.confirmed) return "Confirmed. It applies at the next check.";
  const count = Number(hold.removal_count || 0);
  return `The last check would remove ${count} of this playlist's ${Number(hold.item_count || 0)} items at once, so nothing was changed. Confirm to update it, or discard to keep the items as they are (the next hourly check asks again if the titles still do not match).`;
}

function ruleStatusText(list) {
  const checked = list.rule_checked_at ? `Last checked ${formatDate(Number(list.rule_checked_at))}` : "Not checked yet";
  return `${checked}. Updated every hour; edits made inside an app are put back.`;
}

// Left of the title: a spinner while a check runs, also after a reload
// (decision 63). Refresh now unhides it while its own check runs.
export function playlistRefreshIndicatorHtml(list = {}) {
  if (!isAutomaticPlaylist(list)) return "";
  return `<span class="playlist-refresh-indicator" data-playlist-refresh-indicator role="status" aria-label="Refreshing" title="Checking the rule"${list.rule_checking ? "" : " hidden"}></span>`;
}

// Right of the heading, left of Options: the Auto label (its tooltip gives
// the last check). The rule itself is in Info, so the row stays one line.
export function playlistRuleHeadingHtml(list = {}) {
  if (!isAutomaticPlaylist(list)) return "";
  const status = ruleStatusText(list);
  // A confirmed hold is a small tag here, not a line under the heading (decision 64).
  const confirmed = list.rule_hold?.confirmed
    ? `<span class="playlist-rule-confirmed" title="Confirmed. It applies at the next check.">Confirmed</span>`
    : "";
  return `${confirmed}<span class="playlist-rule-label" title="${escapeAttribute(status)}" aria-label="${escapeAttribute(`Automatic. ${status}`)}">Auto</span>`;
}

// Info, Refresh now, and Stop updating, in the Options menu with Edit and Delete.
export function playlistRuleMenuItemsHtml(list = {}) {
  if (!isAutomaticPlaylist(list)) return "";
  const id = escapeAttribute(list.id);
  const refresh = list.rule_checking
    ? `<button class="playlist-options-item" type="button" role="menuitem" data-playlist-refresh-rule="${id}" disabled aria-busy="true">Refreshing</button>`
    : `<button class="playlist-options-item" type="button" role="menuitem" data-playlist-refresh-rule="${id}" title="Check the rule now">Refresh now</button>`;
  return `<button class="playlist-options-item" type="button" role="menuitem" data-playlist-rule-info="${id}">Info</button>${refresh}<button class="playlist-options-item" type="button" role="menuitem" data-playlist-stop-rule="${id}" title="Keep the items and edit them by hand">Stop updating</button>`;
}

// Every detail of the rule, one row each, for the Info pop-up.
export function playlistRuleDetails(list = {}) {
  const rule = list.rule;
  if (!rule) return [];
  const tv = list.kind === "tv";
  const genres = Array.isArray(rule.genres) ? rule.genres : [];
  const limit = Number(rule.limit) || 0;
  return [
    ["Titles from", rule.source === "catalogue" ? "The whole TMDB catalogue" : "Your libraries"],
    ["Type", TYPE_LABELS[rule.type] || TYPE_LABELS.top],
    ["Genres", genres.length ? genres.join(rule.genreMatch === "all" ? " and " : " or ") : "Any genre"],
    ["Original language", languagesText(rule) || "Any language"],
    ["Years", yearsText(rule) || "Any year"],
    tv ? ["Episodes", "The next episode of each show"] : ["Watched", watchedLabels(list.kind)[rule.watched] || watchedLabels(list.kind).any],
    rule.addedWithinDays ? ["Recently added", `Added in the last ${rule.addedWithinDays} day${rule.addedWithinDays === 1 ? "" : "s"}`] : null,
    ["Order", ORDER_LABELS[rule.order] || ORDER_LABELS.ranked],
    [tv ? "Most shows" : "Most titles", limit ? `Up to ${limit}` : "No maximum"],
    ["Remove items once watched", list.remove_watched ? "On" : "Off"],
    ["Updates", ruleStatusText(list)],
  ].filter(Boolean);
}

function openRuleInfo(list, helpers) {
  const rows = playlistRuleDetails(list)
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  helpers.dialogFrame(list.name || "Playlist", `
    <dl class="playlist-rule-info">${rows}</dl>
    <div class="personal-media-dialog-actions"><button class="button-ghost personal-media-dialog-close" type="button">Close</button></div>
  `);
}

// Below the heading only when something needs attention: a failed check or a
// held one.
export function playlistRulePanelHtml(list = {}) {
  if (!isAutomaticPlaylist(list)) return "";
  const id = escapeAttribute(list.id);
  // A confirmed hold shows as a tag in the heading instead (decision 64).
  const hold = list.rule_hold?.confirmed ? null : list.rule_hold;
  return `
      ${list.rule_error ? `<p class="playlist-rule-error" role="alert">The last check failed, so the items were left as they were: ${escapeHtml(list.rule_error)}</p>` : ""}
      ${hold ? `<div class="playlist-held-change" role="status">
        <span>${escapeHtml(ruleHoldText(hold))}</span>
        ${hold.confirmed ? "" : `<div class="playlist-held-actions">
          <button class="button-primary" type="button" data-playlist-rule-held="confirm" data-playlist-id="${id}">Confirm</button>
          <button class="button-ghost" type="button" data-playlist-rule-held="discard" data-playlist-id="${id}">Discard</button>
        </div>`}
      </div>` : ""}
  `;
}

function optionsHtml(entries, selected) {
  return entries.map(([value, label]) => `<option value="${escapeAttribute(value)}"${String(value) === String(selected) ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function yearsChoice(rule) {
  const { yearFrom: from, yearTo: to } = rule;
  if (!from && !to) return "any";
  if (from && to && to - from === 9 && DECADES.includes(from)) return String(from);
  return "custom";
}

// A radio or checkbox drawn as a Settings choice card (title and description).
export function choiceCardHtml({ type = "radio", name, value, title, description = "", checked = false, disabled = false, required = false }) {
  return `
    <label class="settings-choice-option">
      <input type="${type}" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}"${required ? " required" : ""}${checked ? " checked" : ""}${disabled ? " disabled" : ""} />
      <span class="settings-choice-option-body">
        <span class="settings-choice-option-title">${escapeHtml(title)}</span>
        ${description ? `<span class="settings-choice-option-description">${escapeHtml(description)}</span>` : ""}
      </span>
    </label>`;
}

const SOURCE_DESCRIPTIONS = {
  library: "Titles your apps hold. Recently added works here.",
  catalogue: "Any title TMDB lists; titles no app has are marked Missing.",
};

// The rule fields. `kind` is movie or tv; `rule` prefills an edit.
export function ruleEditorHtml(rule = null, { hidden = false, kind = "" } = {}) {
  // A new automatic playlist starts as Top rated, ranked, up to 20 (decisions 71, 72).
  const current = { source: "library", type: "top", genres: [], genreMatch: "any", yearFrom: null, yearTo: null, watched: "any", addedWithinDays: null, limit: DEFAULT_LIMIT, order: "ranked", ...(rule || {}) };
  // A new automatic playlist starts with English (decision 61); a rule saved
  // before the Language choice, or with none ticked, takes any language.
  current.languages = rule ? (Array.isArray(rule.languages) ? rule.languages : []) : NEW_RULE_LANGUAGES;
  const years = yearsChoice(current);
  const added = [["", "Any time"], ...ADDED_DAYS.map((days) => [days, `In the last ${days} days`])];
  if (current.addedWithinDays && !ADDED_DAYS.includes(current.addedWithinDays)) added.push([current.addedWithinDays, `In the last ${current.addedWithinDays} days`]);
  return `
    <fieldset class="playlist-rule-editor${hidden ? " hidden" : ""}" data-playlist-rule-editor>
      <legend class="field-label">Where titles come from</legend>
      <div class="settings-choice-grid" role="radiogroup" aria-label="Where titles come from">
        ${Object.entries(SOURCE_LABELS).map(([value, label]) => choiceCardHtml({ name: "ruleSource", value, title: label, description: SOURCE_DESCRIPTIONS[value], checked: current.source === value })).join("")}
      </div>
      <div class="playlist-rule-genres-head">
        <span class="field-label">Genres</span>
        <select class="field" name="ruleGenreMatch" aria-label="Genre match">${optionsHtml([["any", "Any of them"], ["all", "All of them"]], current.genreMatch)}</select>
      </div>
      <div class="playlist-rule-genres" data-playlist-rule-genres data-selected="${escapeAttribute(JSON.stringify(current.genres))}" data-kind="${escapeAttribute(kind)}">
        <p class="playlist-availability-notice">${kind ? "Loading genres..." : "Choose Movies or TV to see its genres."}</p>
      </div>
      <div class="playlist-rule-genres-head">
        <span class="field-label" id="playlist-rule-languages-label">Original language</span>
      </div>
      <div class="playlist-rule-genres" data-playlist-rule-languages>
        ${languageListHtml(current.languages)}
        <p class="playlist-availability-notice">None ticked means any language.</p>
      </div>
      <div class="playlist-rule-grid">
        <label class="field-label">Type<select class="field" name="ruleType">${optionsHtml(Object.entries(TYPE_LABELS), current.type)}</select></label>
        <label class="field-label">Years<select class="field" name="ruleYears">${optionsHtml([["any", "Any year"], ...DECADES.map((decade) => [decade, `${decade}s`]), ["custom", "Choose years"]], years)}</select></label>
        <div class="playlist-rule-years${years === "custom" ? "" : " hidden"}" data-playlist-rule-years>
          <label class="field-label">From<input class="field" type="number" name="ruleYearFrom" min="1870" max="2200" inputmode="numeric" value="${escapeAttribute(current.yearFrom ?? "")}" /></label>
          <label class="field-label">To<input class="field" type="number" name="ruleYearTo" min="1870" max="2200" inputmode="numeric" value="${escapeAttribute(current.yearTo ?? "")}" /></label>
        </div>
        <label class="field-label${kind === "tv" ? " hidden" : ""}" data-playlist-rule-watched-field>Watched<select class="field" name="ruleWatched" data-playlist-rule-watched>${optionsHtml(Object.entries(watchedLabels(kind)), current.watched)}</select></label>
        <label class="field-label">Added to your library<select class="field" name="ruleAdded"${current.source === "catalogue" ? " disabled" : ""}>${optionsHtml(added, current.addedWithinDays ?? "")}</select></label>
        <label class="field-label">Order<select class="field" name="ruleOrder">${optionsHtml(Object.entries(ORDER_LABELS), current.order)}</select></label>
        <label class="field-label"><span data-playlist-rule-limit-label>${kind === "tv" ? "Most shows" : "Most titles"}</span><input class="field" type="number" name="ruleLimit" min="1" max="${MAX_LIMIT}" inputmode="numeric" placeholder="${current.source === "catalogue" ? DEFAULT_LIMIT : "No maximum"}" value="${escapeAttribute(current.limit ?? "")}" /></label>
      </div>
    </fieldset>
  `;
}

function selectedGenres(container) {
  const checked = [...container.querySelectorAll("input[name=ruleGenre]:checked")].map((box) => box.value);
  if (container.dataset.loaded === "1") return checked;
  try {
    return JSON.parse(container.dataset.selected || "[]");
  } catch {
    return [];
  }
}

function genreListHtml(genres, selected, catalogue) {
  const known = new Set(genres.map((genre) => genre.name));
  // A genre the rule holds but no app lists any more stays choosable.
  const all = [...genres, ...selected.filter((name) => !known.has(name)).map((name) => ({ name, tmdb_id: null }))];
  if (!all.length) return `<p class="playlist-availability-notice">No genres found.</p>`;
  return `<div class="playlist-rule-genre-list">${all.map((genre) => {
    const tmdbOnly = catalogue && !genre.tmdb_id;
    const checked = selected.includes(genre.name) && !tmdbOnly;
    return `<label class="playlist-rule-genre"><input type="checkbox" name="ruleGenre" value="${escapeAttribute(genre.name)}" data-tmdb="${genre.tmdb_id ? "1" : "0"}"${checked ? " checked" : ""}${tmdbOnly ? " disabled" : ""} /> <span>${escapeHtml(genre.name)}</span></label>`;
  }).join("")}</div>`;
}

function languageListHtml(selected) {
  // A saved language this list does not name stays choosable.
  const all = [...LANGUAGES, ...selected.filter((code) => !LANGUAGE_NAMES.has(code)).map((code) => [code, languageName(code)])];
  return `<div class="playlist-rule-genre-list" role="group" aria-labelledby="playlist-rule-languages-label">${all.map(([code, name]) => (
    `<label class="playlist-rule-genre"><input type="checkbox" name="ruleLanguage" value="${escapeAttribute(code)}"${selected.includes(code) ? " checked" : ""} /> <span>${escapeHtml(name)}</span></label>`
  )).join("")}</div>`;
}

const genreCache = new Map();

async function loadGenres(kind, helpers) {
  if (!genreCache.has(kind)) {
    genreCache.set(kind, helpers.personalRequest({ action: "list-rule-genres", kind }).catch((error) => {
      genreCache.delete(kind);
      throw error;
    }));
  }
  return genreCache.get(kind);
}

// Wires the editor inside `form`: the source switch, the years choice, and
// the genre list for the chosen kind (reloaded when the kind changes).
export function bindRuleEditor(form, { helpers, kindOf }) {
  const editor = form?.querySelector("[data-playlist-rule-editor]");
  if (!editor) return;
  const container = editor.querySelector("[data-playlist-rule-genres]");
  const source = () => editor.querySelector("input[name=ruleSource]:checked")?.value || "library";
  const renderGenres = async () => {
    const kind = kindOf();
    if (!["movie", "tv"].includes(kind)) {
      container.innerHTML = `<p class="playlist-availability-notice">Choose Movies or TV to see its genres.</p>`;
      return;
    }
    const selected = selectedGenres(container);
    container.dataset.kind = kind;
    container.dataset.loaded = "0";
    container.dataset.selected = JSON.stringify(selected);
    container.innerHTML = `<p class="playlist-availability-notice">Loading genres...</p>`;
    try {
      const body = await loadGenres(kind, helpers);
      if (container.dataset.kind !== kind) return;
      const unread = Object.entries(body?.apps || {}).filter(([, app]) => app.status !== "ok" && app.status !== "not_configured").map(([provider]) => APP_LABELS[provider] || provider);
      container.innerHTML = genreListHtml(body?.genres || [], selected, source() === "catalogue")
        + (unread.length ? `<p class="playlist-availability-notice">Genres from ${escapeHtml(unread.join(", "))} could not be read just now.</p>` : "");
      container.dataset.loaded = "1";
    } catch (error) {
      container.innerHTML = `<p class="playlist-rule-error" role="alert">Could not load genres: ${escapeHtml(error?.message || "unknown error")}</p>`;
    }
  };
  const applySource = () => {
    const catalogue = source() === "catalogue";
    const added = editor.querySelector("select[name=ruleAdded]");
    if (added) {
      added.disabled = catalogue;
      if (catalogue) added.value = "";
    }
    const limit = editor.querySelector("input[name=ruleLimit]");
    if (limit) limit.placeholder = catalogue ? String(DEFAULT_LIMIT) : "No maximum";
    // The catalogue source takes TMDB genres only.
    container.querySelectorAll("input[name=ruleGenre]").forEach((box) => {
      const tmdbOnly = catalogue && box.dataset.tmdb !== "1";
      box.disabled = tmdbOnly;
      if (tmdbOnly) box.checked = false;
    });
  };
  const applyKind = () => {
    const kind = kindOf();
    const watched = editor.querySelector("[data-playlist-rule-watched]");
    const labels = watchedLabels(kind);
    watched?.querySelectorAll("option").forEach((option) => { option.textContent = labels[option.value] || option.textContent; });
    // TV holds each show's next episode, so Watched does not apply (decision 54).
    editor.querySelector("[data-playlist-rule-watched-field]")?.classList.toggle("hidden", kind === "tv");
    const limitLabel = editor.querySelector("[data-playlist-rule-limit-label]");
    if (limitLabel) limitLabel.textContent = kind === "tv" ? "Most shows" : "Most titles";
    if (container.dataset.kind !== kind || container.dataset.loaded !== "1") renderGenres();
  };
  editor.addEventListener("change", (event) => {
    const name = event.target?.name;
    if (name === "ruleSource") applySource();
    if (name === "ruleYears") editor.querySelector("[data-playlist-rule-years]")?.classList.toggle("hidden", event.target.value !== "custom");
  });
  form.addEventListener("change", (event) => {
    if (event.target?.name === "kind" || event.target?.name === "mode") applyKind();
  });
  if (!editor.classList.contains("hidden")) applyKind();
  return { refresh: applyKind };
}

function wholeNumber(value) {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}

// The rule as list-create and list-update take it; the server validates it.
export function readRuleFromForm(form) {
  const editor = form?.querySelector("[data-playlist-rule-editor]");
  if (!editor) return null;
  const value = (selector) => editor.querySelector(selector)?.value ?? "";
  const container = editor.querySelector("[data-playlist-rule-genres]");
  const source = editor.querySelector("input[name=ruleSource]:checked")?.value || "library";
  const years = value("select[name=ruleYears]");
  let yearFrom = null;
  let yearTo = null;
  if (years === "custom") {
    yearFrom = wholeNumber(value("input[name=ruleYearFrom]"));
    yearTo = wholeNumber(value("input[name=ruleYearTo]"));
  } else if (years !== "any") {
    yearFrom = Number(years);
    yearTo = yearFrom + 9;
  }
  return {
    source,
    type: value("select[name=ruleType]") || "top",
    genres: container ? selectedGenres(container) : [],
    genreMatch: value("select[name=ruleGenreMatch]") || "any",
    languages: [...editor.querySelectorAll("input[name=ruleLanguage]:checked")].map((box) => box.value),
    yearFrom,
    yearTo,
    watched: editor.querySelector("[data-playlist-rule-watched-field]")?.classList.contains("hidden") ? "any" : value("select[name=ruleWatched]") || "any",
    addedWithinDays: source === "catalogue" ? null : wholeNumber(value("select[name=ruleAdded]")),
    limit: wholeNumber(value("input[name=ruleLimit]")),
    order: value("select[name=ruleOrder]") || "ranked",
  };
}

function refreshMessage(result = {}) {
  if (result.status === "queued") return ["The check is queued and runs within a minute.", "success"];
  if (result.status === "error") return [`The check failed, so the items were left as they were: ${result.error || "unknown error"}`, "error"];
  if (result.status === "held") return [`The check would remove ${result.removed} items at once. Confirm or discard it on the playlist.`, "success"];
  if (result.status === "changed") {
    const parts = [result.added ? `${result.added} added` : "", result.removed ? `${result.removed} removed` : "", result.reordered ? "order updated" : ""].filter(Boolean);
    return [`Playlist updated: ${parts.join(", ") || "changed"}.`, "success"];
  }
  return ["Checked. The playlist already matches its rule.", "success"];
}

// The spinner left of the title (and "Refreshing" on the menu item) stays
// until the check and reload finish, shown for at least a moment so a quick
// check is still visible.
const REFRESHING_MIN_MS = 900;

async function refreshRule(button, helpers) {
  const listId = button.dataset.playlistRefreshRule;
  const label = button.textContent;
  const indicator = button.closest?.(".personal-media-list-section")?.querySelector?.("[data-playlist-refresh-indicator]");
  if (indicator) indicator.hidden = false;
  button.textContent = "Refreshing";
  button.setAttribute("aria-busy", "true");
  const shown = new Promise((resolve) => setTimeout(resolve, REFRESHING_MIN_MS));
  try {
    const result = await helpers.personalRequest({ action: "list-refresh-rule", list_id: listId });
    await shown;
    await helpers.loadPersonalMedia({ force: true });
    helpers.setMessage(...refreshMessage(result));
  } finally {
    if (indicator?.isConnected) indicator.hidden = true;
    if (button.isConnected) {
      button.textContent = label;
      button.removeAttribute("aria-busy");
    }
  }
}

async function stopRule(list, helpers) {
  const confirmed = await helpers.confirm({
    title: "Stop updating?",
    body: `"${list.name}" keeps its current items and becomes a playlist you edit by hand. It cannot be made automatic again.`,
    confirmLabel: "Stop updating",
    cancelLabel: "Keep automatic",
  });
  if (!confirmed) return;
  await helpers.personalRequest({ action: "list-stop-rule", list_id: list.id });
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(`${list.name} is no longer automatic.`, "success");
}

async function decideRuleHold(button, helpers) {
  const decision = button.dataset.playlistRuleHeld;
  await helpers.personalRequest({ action: "list-rule-held", list_id: button.dataset.playlistId, decision });
  await helpers.loadPersonalMedia({ force: true });
  helpers.setMessage(decision === "confirm" ? "Confirmed. The playlist updates at the next check." : "Discarded. The playlist keeps its items.", "success");
}

// The panel's buttons; `run(button, task)` is playlists.js's click runner.
export function handleRuleClick(target, { run, listById, helpers }) {
  const info = target.closest("[data-playlist-rule-info]");
  if (info) {
    const list = listById(info.dataset.playlistRuleInfo);
    if (list) openRuleInfo(list, helpers);
    return true;
  }
  const refresh = target.closest("[data-playlist-refresh-rule]");
  if (refresh) return run(refresh, () => refreshRule(refresh, helpers));
  const stop = target.closest("[data-playlist-stop-rule]");
  if (stop) {
    const list = listById(stop.dataset.playlistStopRule);
    return list ? run(stop, () => stopRule(list, helpers)) : false;
  }
  const held = target.closest("[data-playlist-rule-held]");
  if (held) return run(held, () => decideRuleHold(held, helpers));
  return false;
}
