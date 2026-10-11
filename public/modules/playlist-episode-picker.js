// Episode picker for TV playlists (plan/archive/custom-playlist-sync/plan.md decisions 13,
// 17, 20). A TV playlist holds separate episodes, so adding a show opens this
// dialog: every episode the metadata lists, specials and unaired ones
// included, grouped by season. The picked ones go to the top of the playlist
// as one block in episode order. playlists.js passes its helpers in, so this
// module imports only utils.
import { escapeAttribute, escapeHtml } from "./utils.js?v=2.0.0.0.0";

function titleKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function coordinate(season, episode) {
  return `${season}:${episode}`;
}

// Episodes of this show already in the playlist, as "season:episode".
export function episodesInPlaylist(list = {}, show = {}, ids = {}) {
  const tmdbId = String(ids.tmdb_id || show.tmdb_id || "");
  const tvdbId = String(ids.tvdb_id || show.tvdb_id || "");
  const showTitle = titleKey(show.title);
  const held = new Set();
  for (const item of list.items || []) {
    if (item.media_type !== "episode" || item.season == null || item.episode == null) continue;
    const sameShow = (tmdbId && String(item.tmdb_id || item.show_tmdb_id || "") === tmdbId)
      || (tvdbId && String(item.tvdb_id || item.show_tvdb_id || "") === tvdbId)
      || (!item.tmdb_id && !item.tvdb_id && showTitle && titleKey(item.show_title) === showTitle);
    if (sameShow) held.add(coordinate(item.season, item.episode));
  }
  return held;
}

function airLabel(airDate, today) {
  if (!airDate) return "Unaired";
  if (airDate > today) return `Airs ${airDate}`;
  return airDate;
}

export function episodePickerHtml(episodes = [], held = new Set(), today = new Date().toISOString().slice(0, 10)) {
  const seasons = new Map();
  for (const entry of episodes) {
    if (!seasons.has(entry.season)) seasons.set(entry.season, []);
    seasons.get(entry.season).push(entry);
  }
  const firstOpen = [...seasons.keys()].find((season) => season > 0) ?? [...seasons.keys()][0];
  return [...seasons.entries()].map(([season, entries]) => {
    const name = season === 0 ? "Specials" : `Season ${season}`;
    const inList = entries.filter((entry) => held.has(coordinate(entry.season, entry.episode))).length;
    const rows = entries.map((entry) => {
      const already = held.has(coordinate(entry.season, entry.episode));
      const label = `E${entry.episode}${entry.title ? ` · ${entry.title}` : ""}`;
      return `
        <li>
          <label class="playlist-episode-choice${already ? " is-held" : ""}">
            <input type="checkbox" name="episode" value="${escapeAttribute(coordinate(entry.season, entry.episode))}"${already ? " checked disabled" : ""} />
            <span class="playlist-episode-name">${escapeHtml(label)}</span>
            <small>${escapeHtml(already ? "In playlist" : airLabel(entry.air_date, today))}</small>
          </label>
        </li>
      `;
    }).join("");
    return `
      <details class="playlist-episode-season"${season === firstOpen ? " open" : ""}>
        <summary>${escapeHtml(name)} <span>${entries.length} episode${entries.length === 1 ? "" : "s"}${inList ? `, ${inList} in playlist` : ""}</span></summary>
        <button class="button-ghost playlist-episode-season-toggle" type="button" data-episode-season-toggle>Select all in ${escapeHtml(name)}</button>
        <ul class="playlist-episode-list">${rows}</ul>
      </details>
    `;
  }).join("");
}

// Picked episodes in episode order, ready for the list-add-episodes action.
export function pickedEpisodes(form, episodes = []) {
  const picked = new Set([...form.querySelectorAll("input[name=episode]:checked:not(:disabled)")].map((box) => box.value));
  return episodes
    .filter((entry) => picked.has(coordinate(entry.season, entry.episode)))
    .map((entry) => ({ season: entry.season, episode: entry.episode, title: entry.title, overview: entry.overview, air_date: entry.air_date }));
}

export function openEpisodePicker({ show, list, helpers }) {
  const showTitle = show?.title || "this show";
  const overlay = helpers.dialogFrame(`Add episodes of ${showTitle}`, `
    <form class="personal-media-create-form playlist-episode-picker">
      <p class="personal-media-dialog-copy">Pick the episodes to add to <b>${escapeHtml(list?.name || "the playlist")}</b>. They go to the top of the playlist in episode order.</p>
      <div class="playlist-episode-seasons" data-episode-picker-body><p class="personal-media-dialog-copy">Loading episodes...</p></div>
      <p class="personal-media-dialog-error hidden" data-personal-dialog-error role="alert"></p>
      <div class="personal-media-dialog-actions"><button class="button-ghost personal-media-dialog-close" type="button">Cancel</button><button class="button-primary" type="submit" disabled>Add episodes</button></div>
    </form>
  `);
  const form = overlay.querySelector("form");
  const body = form?.querySelector("[data-episode-picker-body]");
  const submit = form?.querySelector("[type=submit]");
  const errorMessage = form?.querySelector("[data-personal-dialog-error]");
  let episodes = [];
  let ids = {};
  const showError = (message) => {
    if (!errorMessage || !overlay.isConnected) return;
    errorMessage.textContent = message;
    errorMessage.classList.remove("hidden");
  };
  const updateSubmit = () => {
    const count = pickedEpisodes(form, episodes).length;
    if (!submit) return;
    submit.disabled = count === 0;
    submit.textContent = count ? `Add ${count} episode${count === 1 ? "" : "s"}` : "Add episodes";
  };

  helpers.personalRequest({
    action: "show-episodes",
    show: { title: show?.title || "", tmdb_id: show?.tmdb_id || "", tvdb_id: show?.tvdb_id || "", imdb_id: show?.imdb_id || "" },
  }).then((result) => {
    if (!overlay.isConnected || !body) return;
    episodes = Array.isArray(result?.episodes) ? result.episodes : [];
    ids = result?.ids || {};
    body.innerHTML = episodes.length
      ? episodePickerHtml(episodes, episodesInPlaylist(list, show, ids))
      : `<p class="personal-media-dialog-copy">No episodes are listed for ${escapeHtml(showTitle)}.</p>`;
    updateSubmit();
  }).catch((error) => {
    if (body && overlay.isConnected) body.innerHTML = "";
    showError(error?.message || "Could not load the episodes.");
  });

  form?.addEventListener("change", updateSubmit);
  form?.addEventListener("click", (event) => {
    const toggle = event.target instanceof Element ? event.target.closest("[data-episode-season-toggle]") : null;
    if (!toggle) return;
    event.preventDefault();
    const boxes = [...toggle.closest("details").querySelectorAll("input[name=episode]:not(:disabled)")];
    const selectAll = boxes.some((box) => !box.checked);
    boxes.forEach((box) => { box.checked = selectAll; });
    updateSubmit();
  });
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const picked = pickedEpisodes(form, episodes);
    if (!picked.length || submit?.disabled) return;
    if (submit) submit.disabled = true;
    try {
      const result = await helpers.personalRequest({
        action: "list-add-episodes",
        list_id: list.id,
        show: {
          title: showTitle,
          tmdb_id: ids.tmdb_id || show?.tmdb_id || "",
          tvdb_id: ids.tvdb_id || show?.tvdb_id || "",
          imdb_id: ids.imdb_id || show?.imdb_id || "",
          poster_url: show?.poster_url || "",
        },
        episodes: picked,
      });
      await helpers.loadPersonalMedia({ force: true });
      helpers.closePersonalDialog(overlay);
      const added = Number(result?.added || 0);
      helpers.setMessage(`${added} episode${added === 1 ? "" : "s"} of ${showTitle} added to ${list.name}.`, "success");
    } catch (error) {
      updateSubmit();
      showError(error?.message || "Unable to add the episodes.");
    }
  });
  return overlay;
}
