import { state } from "./state.js?v=2.1.1.0.8";
import { escapeHtml, slug } from "./utils.js?v=2.1.1.0.8";
import { buildAuthHeaders } from "./auth.js?v=2.1.1.0.8";

// Fix Match "Season and episode numbers" choice for one TV show: TVDB or TMDB.
// Stored watches keep the media server's numbers; the server translates them
// for the show page (server/src/utils/showSeasonTranslation.js). The choice is
// saved only after the user confirms a preview that states the counts.

const SOURCE_LABEL = { tvdb: "TVDB", tmdb: "TMDB" };

function authHeaders() {
  return buildAuthHeaders(state.token);
}

// The Fix Match button carries only the show title; the ids come from the show
// page that opened it.
function activeShowIds(title) {
  const show = state.activeShowRenderContext?.show;
  if (!show || slug(show.title || "") !== slug(title || "")) return null;
  const tvdbId = String(show.tvdb_id || show.show_tvdb_id || "");
  if (!tvdbId) return null;
  return { tvdbId, tmdbId: String(show.tmdb_id || show.show_tmdb_id || ""), title: show.title };
}

async function fetchPreview(ids, source) {
  const url = new URL("/api/show-season-source/preview", window.location.origin);
  url.searchParams.set("tvdbId", ids.tvdbId);
  if (ids.tmdbId) url.searchParams.set("tmdbId", ids.tmdbId);
  url.searchParams.set("source", source);
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Preview failed (${response.status})`);
  return body.preview;
}

async function saveSource(ids, source) {
  const response = await fetch("/api/show-season-source", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tvdbId: ids.tvdbId, tmdbId: ids.tmdbId, source, confirm: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Save failed (${response.status})`);
  return body.preview;
}

async function fetchTraktPreview(ids) {
  const url = new URL("/api/show-season-source/trakt-preview", window.location.origin);
  url.searchParams.set("tvdbId", ids.tvdbId);
  if (ids.tmdbId) url.searchParams.set("tmdbId", ids.tmdbId);
  const response = await fetch(url, { headers: authHeaders(), cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Trakt preview failed (${response.status})`);
  return body;
}

async function replaceOnTrakt(ids) {
  const response = await fetch("/api/show-season-source/trakt-replace", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ tvdbId: ids.tvdbId, tmdbId: ids.tmdbId, confirm: true }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Trakt replace failed (${response.status})`);
  return body;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function episodeCode(item) {
  return `S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}`;
}

export function confirmationHtml(preview, title) {
  const target = SOURCE_LABEL[preview.source] || preview.source;
  const stored = SOURCE_LABEL[preview.rowNumbering] || preview.rowNumbering;
  const lines = [];
  if (preview.rowNumbering === preview.source) {
    lines.push(`Your ${plural(preview.episodes, "watched episode")} (${plural(preview.watchRows, "watch row")}) already use ${target} numbers, so each one shows on its own episode.`);
  } else {
    lines.push(`${plural(preview.episodes, "watched episode")} (${plural(preview.watchRows, "watch row")}) are stored with ${stored} numbers.`);
    lines.push(`${plural(preview.translatedEpisodes, "episode")} will show on their ${target} episode.`);
    if (preview.review.length) {
      const listed = preview.review.slice(0, 12).map(episodeCode).join(", ");
      const more = preview.review.length > 12 ? ` and ${preview.review.length - 12} more` : "";
      lines.push(`${plural(preview.review.length, "episode")} (${plural(preview.reviewWatchRows, "watch row")}) have no ${target} match and will be listed as Unmatched: ${listed}${more}.`);
    }
  }
  lines.push("No watch is deleted or renumbered, and your media apps keep their own numbering. Trakt is not changed by this step.");
  if (!preview.sourceAvailable) lines.push(`${target} has no season data for this show yet, so it keeps showing TVDB's seasons until it does.`);
  return `
    <p class="season-source-confirm-title"><strong>Show ${escapeHtml(title)} with ${escapeHtml(target)} seasons and episodes?</strong></p>
    <ul class="season-source-confirm-list">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
    <div class="season-source-confirm-actions">
      <button class="button-primary season-source-save" type="button">Switch to ${escapeHtml(target)}</button>
      <button class="button-ghost season-source-cancel" type="button">Cancel</button>
    </div>
  `;
}

export function traktConfirmationHtml(plan, title, source) {
  const target = SOURCE_LABEL[source] || source;
  const lines = [
    `Plekt removes ${escapeHtml(title)}'s plays for ${plural(plan.episodes, "episode")} from your Trakt history and adds back all ${plural(plan.plays, "play")}, with their original dates, under the ${escapeHtml(target)} episode numbers.`,
    "Later watches of this show go to Trakt with the same numbers.",
  ];
  if (plan.review.length) lines.push(`${plural(plan.review.length, "episode")} with no ${escapeHtml(target)} match stay on Trakt as they are.`);
  return `
    <p class="season-source-confirm-title"><strong>Also replace ${escapeHtml(title)} on Trakt?</strong></p>
    <ul class="season-source-confirm-list">${lines.map((line) => `<li>${line}</li>`).join("")}</ul>
    <div class="season-source-confirm-actions">
      <button class="button-primary season-source-trakt-replace" type="button">Replace on Trakt</button>
      <button class="button-ghost season-source-trakt-skip" type="button">Not now</button>
    </div>
  `;
}

// After a save that turns translation on, asks separately whether to replace
// the show on Trakt (second confirmation), then reloads. Nothing is sent to
// Trakt unless the user picks Replace.
async function offerTraktReplace(saved, { ids, status, confirmEl }) {
  const reload = () => window.location.reload();
  if (!saved || saved.rowNumbering === saved.source) return reload();
  let plan = null;
  try {
    plan = await fetchTraktPreview(ids);
  } catch {
    return reload();
  }
  if (!plan.traktConnected || !plan.available) return reload();
  confirmEl.innerHTML = traktConfirmationHtml(plan, ids.title, saved.source);
  confirmEl.hidden = false;
  confirmEl.querySelector(".season-source-trakt-skip").addEventListener("click", reload);
  const replaceButton = confirmEl.querySelector(".season-source-trakt-replace");
  replaceButton.addEventListener("click", async () => {
    replaceButton.disabled = true;
    status.textContent = "Replacing on Trakt…";
    try {
      const result = await replaceOnTrakt(ids);
      confirmEl.hidden = true;
      status.textContent = `Trakt updated: ${plural(result.plays, "play")} re-added for ${plural(result.episodes, "episode")}${result.rejected ? `; Trakt rejected ${result.rejected}` : ""}. Reloading…`;
      setTimeout(reload, 1500);
    } catch (error) {
      replaceButton.disabled = false;
      status.textContent = `Trakt was not changed: ${error.message}`;
    }
  });
}

// Mounts the choice into `host` (an element inside the Fix Match dialog).
// `onSaved(preview, context)` runs after a confirmed save; by default it
// offers the Trakt replace, then reloads so the show re-renders.
export function mountShowSeasonSource(host, title, { onSaved = offerTraktReplace } = {}) {
  const ids = host ? activeShowIds(title) : null;
  if (!host || !ids) return;
  host.innerHTML = `
    <hr class="season-source-rule" />
    <p class="muted-copy season-source-intro">Season and episode numbers for this show. Your stored watches are never renumbered.</p>
    <div class="season-source-options" role="radiogroup" aria-label="Season and episode numbers">
      <label class="season-source-option"><input type="radio" name="show-season-source" value="tvdb" disabled /> TVDB</label>
      <label class="season-source-option"><input type="radio" name="show-season-source" value="tmdb" disabled /> TMDB</label>
    </div>
    <p class="edit-dialog-status season-source-status" role="status" aria-live="polite">Checking the current choice…</p>
    <div class="season-source-confirm" hidden></div>
  `;
  const radios = [...host.querySelectorAll('input[name="show-season-source"]')];
  const status = host.querySelector(".season-source-status");
  const confirmEl = host.querySelector(".season-source-confirm");
  let current = "";

  const select = (value) => radios.forEach((radio) => { radio.checked = radio.value === value; });
  const setBusy = (busy) => radios.forEach((radio) => { radio.disabled = busy; });
  const closeConfirm = () => {
    confirmEl.hidden = true;
    confirmEl.innerHTML = "";
    select(current);
  };

  fetchPreview(ids, "tmdb")
    .then((preview) => {
      current = preview.currentSource;
      select(current);
      setBusy(false);
      status.textContent = `Currently ${SOURCE_LABEL[current] || current}.`;
    })
    .catch((error) => {
      status.textContent = `Could not read the current choice: ${error.message}`;
    });

  for (const radio of radios) {
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const source = radio.value;
      setBusy(true);
      status.textContent = "Working out what changes…";
      try {
        const preview = await fetchPreview(ids, source);
        if (preview.unchanged) {
          closeConfirm();
          status.textContent = `Already ${SOURCE_LABEL[source]}.`;
          return;
        }
        status.textContent = "";
        confirmEl.innerHTML = confirmationHtml(preview, ids.title);
        confirmEl.hidden = false;
        confirmEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
        confirmEl.querySelector(".season-source-cancel").addEventListener("click", () => {
          closeConfirm();
          status.textContent = `Currently ${SOURCE_LABEL[current] || current}.`;
        });
        const saveButton = confirmEl.querySelector(".season-source-save");
        saveButton.addEventListener("click", async () => {
          saveButton.disabled = true;
          status.textContent = "Saving…";
          try {
            const saved = await saveSource(ids, source);
            current = source;
            confirmEl.hidden = true;
            status.textContent = `Saved. ${ids.title} now uses ${SOURCE_LABEL[source]} seasons and episodes.`;
            await onSaved(saved, { ids, host, status, confirmEl });
          } catch (error) {
            saveButton.disabled = false;
            status.textContent = `Could not save: ${error.message}`;
          }
        });
      } catch (error) {
        closeConfirm();
        status.textContent = `Could not preview the change: ${error.message}`;
      } finally {
        setBusy(false);
      }
    });
  }
}
