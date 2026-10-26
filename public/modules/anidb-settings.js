import { state } from "./state.js?v=2.1.1.1.0";
import { buildAuthHeaders } from "./auth.js?v=2.1.1.1.0";
import { escapeHtml, escapeAttribute } from "./utils.js?v=2.1.1.1.0";
import { renderFieldRow } from "./settings-ui.js?v=2.1.1.1.0";

async function request(action, body, method = "POST") {
  const response = await fetch(`/api/anidb/${action}`, {
    method, headers: { ...buildAuthHeaders(state.token), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "AniDB request failed");
  return value;
}

function changed() {
  state.tmdbDetailsCache.clear();
  state.tmdbSeasonCache.clear();
  document.dispatchEvent(new CustomEvent("plembfin:config-changed"));
}

export function renderAnidbSettings() {
  const host = document.querySelector("#anidbSettings");
  if (!host || host.dataset.bound === "true") return;
  host.dataset.bound = "true";
  host.innerHTML = `<details class="sync-tool-details" id="anidb-provider-details">
    <summary class="accordion-header"><div class="sync-tool-summary-title"><b>AniDB</b></div><span>Anime titles and descriptions</span></summary>
    <div class="tool-item-row"><div class="sync-tools-content">
      <p class="tool-accordion-desc">For anime only. Seasons, episode numbering, artwork and watch history keep their existing sources. Uncertain matches keep the existing metadata until you confirm a selection.</p>
      <form id="anidbEnableForm" class="sync-tuning-form">
        ${renderFieldRow({ key: "enabled", label: "Use AniDB for matched anime", type: "checkbox", value: state.savedConfig?.metadata?.anidbEnabled === true })}
        <p class="tool-accordion-desc">No personal API key needed. Metadata refreshes at most once per day; the last successful data stays available during an outage.</p>
        <p class="tool-accordion-desc">AniDB data is provided under <a href="https://anidb.net/policy" target="_blank" rel="noopener noreferrer">noncommercial, attribution and share-alike terms</a>. Existing providers supply any missing fields.</p>
        <button class="btn" type="submit">Save AniDB setting</button>
      </form>
      <details class="sync-tool-details"><summary>Match an anime</summary>
        <p class="tool-accordion-desc">Use the IDs from the movie or show's TMDB/TVDB link. <a href="https://anidb.net/search/anime" target="_blank" rel="noopener noreferrer">Find an AniDB entry</a>, then paste its numeric ID below. A season entry must not replace a whole-show synopsis without your choice.</p>
        <form id="anidbMatchForm" class="sync-tuning-form">
          <label class="field-label">Media type<select class="field" name="mediaType"><option value="tv">TV show</option><option value="movie">Movie</option></select></label>
          <label class="field-label">TMDB ID<input class="field" name="tmdbId" inputmode="numeric" pattern="[1-9][0-9]*" placeholder="TMDB movie or show ID"></label>
          <label class="field-label">TVDB show ID (optional)<input class="field" name="tvdbId" inputmode="numeric" pattern="[1-9][0-9]*" placeholder="For TV shows without a TMDB ID"></label>
          <label class="field-label">AniDB anime ID<input class="field" name="aid" inputmode="numeric" pattern="[1-9][0-9]*" required placeholder="Numeric ID from the AniDB entry"></label>
          <button class="btn" type="submit">Preview match</button>
        </form>
        <div id="anidbPreview" aria-live="polite"></div>
      </details>
      <div id="anidbSavedMatches"></div>
      <p id="anidbCacheInfo" class="tool-accordion-desc"></p>
      <button class="btn" id="anidbClearCache" type="button">Clear AniDB metadata cache</button>
      <p class="tool-accordion-desc">Saved matches and daily request limits stay in place when the cache is cleared.</p>
      <p id="anidbStatus" class="message" role="status" aria-live="polite"></p>
    </div></div></details>`;
  const status = host.querySelector("#anidbStatus");
  const message = (text) => { status.textContent = text; };
  let generation = 0;
  let previewIdentity = null;
  const form = host.querySelector("#anidbMatchForm");
  const values = () => Object.fromEntries(new FormData(form));
  const signature = () => JSON.stringify(values());
  const invalidate = () => {
    generation++;
    previewIdentity = null;
    host.querySelector("#anidbPreview").replaceChildren();
  };
  form.addEventListener("input", invalidate);
  form.addEventListener("change", () => {
    form.elements.tvdbId.disabled = form.elements.mediaType.value === "movie";
    invalidate();
  });
  async function refresh() {
    const data = await request("status", null, "GET");
    state.savedConfig.metadata = { ...state.savedConfig.metadata, anidbEnabled: data.enabled };
    host.querySelector('[data-modal-field="enabled"]').checked = data.enabled;
    host.querySelector("#anidbCacheInfo").textContent = `${data.cache.entries} cached anime entries · ${Math.ceil(data.cache.bytes / 1024)} KB`;
    const saved = host.querySelector("#anidbSavedMatches");
    saved.innerHTML = `<h4>Saved anime matches</h4>${data.matches.length ? `<ul>${data.matches.map((row) => `<li>
      <span>${escapeHtml(row.label)} · ${row.media_type === "tv" ? "TV show" : "Movie"}, ${row.tmdb_id ? `TMDB ${escapeHtml(row.tmdb_id)}` : `TVDB ${escapeHtml(row.tvdb_id)}`}, AniDB ${escapeHtml(row.aid)}</span>
      <button class="btn" type="button" data-anidb-remove="${escapeAttribute(row.media_key)}">Remove match</button></li>`).join("")}</ul>` : `<p class="tool-accordion-desc">No saved matches. A single AniDB link on the show's TVDB record applies automatically once whole-show coverage is verified; uncertain entries keep your existing metadata.</p>`}`;
    saved.querySelectorAll("[data-anidb-remove]").forEach((button) => button.addEventListener("click", async () => {
      const row = data.matches.find((item) => item.media_key === button.dataset.anidbRemove);
      button.disabled = true;
      try {
        await request("matches", { mediaType: row.media_type, tmdbId: row.tmdb_id, tvdbId: row.tvdb_id }, "DELETE");
        changed(); await refresh(); message("Match removed. The existing metadata will be used.");
      } catch (error) { message(error.message); button.disabled = false; }
    }));
  }
  host.querySelector("#anidbEnableForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const enabled = host.querySelector('[data-modal-field="enabled"]').checked;
      await request("settings", { enabled });
      state.savedConfig.metadata = { ...state.savedConfig.metadata, anidbEnabled: enabled };
      changed(); message("AniDB setting saved.");
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const attempt = ++generation;
    const input = values();
    const expected = signature();
    const button = form.querySelector("button");
    button.disabled = true;
    previewIdentity = null;
    host.querySelector("#anidbPreview").textContent = "Loading AniDB preview…";
    try {
      if (!input.tmdbId && !input.tvdbId) throw new Error("Enter a TMDB ID or TVDB show ID.");
      const data = await request("preview", input);
      if (attempt !== generation || signature() !== expected) return;
      const preview = host.querySelector("#anidbPreview");
      if (!data.data) {
        preview.textContent = data.retryAt ? `AniDB is unavailable or this entry is within its daily request limit. Try after ${new Date(data.retryAt).toLocaleString()}.` : "AniDB metadata is unavailable.";
        return;
      }
      previewIdentity = input;
      preview.innerHTML = `<h4>${escapeHtml(data.data.title)}</h4><p>${escapeHtml(data.data.overview || "No AniDB description available; the existing description will be used.")}</p>
        <p class="tool-accordion-desc">${escapeHtml(data.data.type)} · ${input.mediaType === "tv" ? "TV show" : "Movie"} ${input.tmdbId ? `TMDB ${escapeHtml(input.tmdbId)}` : `TVDB ${escapeHtml(input.tvdbId)}`} → AniDB ${escapeHtml(input.aid)}</p>
        <label><input type="checkbox" id="anidbConfirm"> I choose this entry for the whole movie or show. Keep the current episode numbering.</label>
        <button class="btn" id="anidbSaveMatch" type="button" disabled>Save anime match</button>`;
      const save = preview.querySelector("#anidbSaveMatch");
      preview.querySelector("#anidbConfirm").addEventListener("change", (event) => { save.disabled = !event.target.checked; });
      save.addEventListener("click", async () => {
        if (!previewIdentity || signature() !== expected) return;
        save.disabled = true;
        try {
          await request("matches", { ...previewIdentity, confirm: true });
          invalidate(); changed(); await refresh(); message("Anime match saved. Reopen the media page to see its AniDB metadata.");
        } catch (error) { message(error.message); save.disabled = false; }
      });
    } catch (error) { if (attempt === generation) host.querySelector("#anidbPreview").textContent = error.message; }
    finally { button.disabled = false; }
  });
  host.querySelector("#anidbClearCache").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const data = await request("cache", null, "DELETE");
      invalidate(); changed(); await refresh(); message(data.message);
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });
  refresh().catch((error) => message(error.message));
}
