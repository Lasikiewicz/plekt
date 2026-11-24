import { state } from "./state.js?v=2.3.0.0.4";
import { escapeAttribute, escapeHtml, slug, registerConfirmDialog, releaseConfirmDialog, trapDialogKey } from "./utils.js?v=2.3.0.0.4";

function identityValues(item = {}, kind = "tmdb") {
  const capitalized = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  return [
    item[`${kind}_id`],
    item[`${kind}Id`],
    item[`show_${kind}_id`],
    item[`show${capitalized}Id`],
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

const UP_NEXT_PROVIDERS = new Set(["plex", "emby", "jellyfin"]);

function showTitleSlug(item = {}) {
  return String(item.show_title || item.showTitle || "")
    .trim()
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isEpisode(item = {}) {
  return String(item.media_type || item.mediaType || "").trim().toLowerCase() === "episode";
}

// The key builders below are title-based as well as id-based, so two
// same-title shows share keys; pair them with provenDifferentShow.
export function upNextCoordinateDismissalKey(item = {}) {
  if (!isEpisode(item)) return "";
  const showTitle = showTitleSlug(item);
  const season = Number(item.season);
  const episode = Number(item.episode);
  if (!showTitle || item.season == null || item.episode == null || item.season === "" || item.episode === "" || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || episode < 0) return "";
  return `episode:${showTitle}:s${season}:e${episode}`;
}

// Up Next puts what is playing right now first: the same episode (show, season
// and episode) or the same movie as a live session. Title-based, as live
// sessions carry no show ids.
function liveSessionUpNextKey(session = {}) {
  const isLiveEpisode = session.mediaType === "episode" || (session.season != null && session.episode != null);
  if (isLiveEpisode) {
    const title = String(session.title || "");
    const showTitle = session.showTitle || title.replace(/\s+-\s+S\d{1,3}E\d{1,4}\b.*$/i, "").trim();
    return upNextCoordinateDismissalKey({ media_type: "episode", show_title: showTitle, season: session.season, episode: session.episode });
  }
  return session.mediaType === "movie" ? `movie:${showTitleSlug({ show_title: session.title })}` : "";
}

function upNextItemLiveKey(item = {}) {
  if (isEpisode(item)) return upNextCoordinateDismissalKey(item);
  const mediaType = String(item.media_type || item.mediaType || "").trim().toLowerCase();
  return mediaType === "movie" ? `movie:${showTitleSlug({ show_title: item.title })}` : "";
}

// A stable split: cards that match a live session come first, in their existing
// order, followed by the rest in theirs.
export function nowPlayingFirst(items = [], sessions = []) {
  const liveKeys = new Set(sessions.map(liveSessionUpNextKey).filter((key) => key && key !== "movie:"));
  if (!liveKeys.size) return items;
  const playing = [];
  const rest = [];
  const counts = new Map();
  for (const item of items) {
    const key = upNextItemLiveKey(item);
    if (liveKeys.has(key)) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const item of items) {
    if (counts.get(upNextItemLiveKey(item)) === 1) playing.push(item);
    else rest.push(item);
  }
  return [...playing, ...rest];
}

// One card per episode: a part-watched card and a next-up card for the same
// show, season and episode show the same thing, so keep one. The part-watched
// card wins (it carries the position); it takes the place of the first card for
// that episode, which keeps the playing card at the top.
export function oneCardPerEpisode(items = []) {
  const byKey = new Map();
  const ambiguous = new Set();
  for (const item of items) {
    const key = upNextCoordinateDismissalKey(item);
    if (!key) continue;
    const group = byKey.get(key) || [];
    if (group.some((candidate) => provenDifferentShow(candidate, item))) ambiguous.add(key);
    group.push(item);
    byKey.set(key, group);
  }
  const out = [];
  const placed = new Set();
  for (const item of items) {
    const key = upNextCoordinateDismissalKey(item);
    if (!key || ambiguous.has(key)) {
      out.push(item);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    const group = byKey.get(key);
    out.push(group.find((candidate) => candidate.queue_kind === "resume") || group[0]);
  }
  return out;
}

export function upNextShowDismissalKeys(item = {}) {
  if (!isEpisode(item)) return [];
  const keys = [];
  for (const provider of ["imdb", "tmdb", "tvdb"]) {
    const id = String(item[`show_${provider}_id`] || item[`show${provider.charAt(0).toUpperCase()}${provider.slice(1)}Id`] || "").trim();
    if (id) keys.push(`show:${provider}:${id.toLowerCase()}`);
  }
  const showTitle = showTitleSlug(item);
  if (showTitle) keys.push(`show:title:${showTitle}`);
  return [...new Set(keys)];
}

export function upNextDismissalKeys(item = {}, mediaKey = "") {
  const keys = new Set();
  const id = String(item.id || "").trim();
  const itemMediaKey = String(item.media_key || item.mediaKey || mediaKey || "").trim();
  if (id) keys.add(id);
  if (itemMediaKey) keys.add(itemMediaKey);
  const providerItemId = String(item.provider_item_id || item.providerItemId || "").trim();
  if (providerItemId) keys.add(providerItemId);
  const providerItems = item.provider_items || item.providerItems || {};
  for (const [provider, values] of Object.entries(providerItems)) {
    if (!UP_NEXT_PROVIDERS.has(String(provider || "").toLowerCase())) continue;
    for (const value of (Array.isArray(values) ? values : [values])) {
      const providerId = String(value || "").trim();
      if (providerId) keys.add(providerId);
    }
  }
  const coordinate = upNextCoordinateDismissalKey(item);
  if (coordinate) keys.add(coordinate);
  // A season-scoped removal must not claim the show's other card.
  if (item.dismissal_scope !== "season") for (const key of upNextShowDismissalKeys(item)) keys.add(key);
  return [...keys].filter(Boolean);
}

function sameShowCard(left = {}, right = {}) {
  if (!isEpisode(left) || !isEpisode(right) || provenDifferentShow(left, right)) return false;
  const keys = new Set(upNextShowDismissalKeys(left));
  return upNextShowDismissalKeys(right).some((key) => keys.has(key));
}

// A show being rewatched can hold two cards, the rewatch and a newly arrived
// episode (loose-ends step 20). Remove on either asks whether to hide that
// card's season or the whole show; a show with one card keeps the plain
// confirmation.
export function upNextHasSiblingCard(item = {}, items = state.upNextItems || []) {
  return items.some((candidate) => candidate !== item
    && String(candidate?.id || "") !== String(item.id || "")
    && sameShowCard(item, candidate));
}

export function upNextRemovalMatches(removed = {}, item = {}, scope = "show") {
  if (!sameShowCard(removed, item)) return false;
  return scope !== "season" || Number(item.season) === Number(removed.season);
}

export function handleUpNextDialogKey(event, overlay, cancel) {
  trapDialogKey(event, overlay, cancel);
}

export function chooseUpNextRemovalScope(item = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "edit-dialog-overlay confirm-dialog-overlay";
    const finish = (value) => {
      if (!releaseConfirmDialog(cancel)) return;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      opener?.focus();
      resolve(value);
    };
    const cancel = () => finish(null);
    const onKeydown = (event) => handleUpNextDialogKey(event, overlay, cancel);
    registerConfirmDialog(cancel);
    const title = item.show_title || item.showTitle || item.title || "this show";
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    overlay.innerHTML = `
      <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="Remove from Up Next">
        <h3>Remove from Up Next</h3>
        <p class="confirm-dialog-body">"${escapeHtml(title)}" has more than one card in Up Next. Hide only Season ${escapeHtml(String(item.season ?? ""))}, or the whole show? Jellyfin Next Up may still show it.</p>
        <div class="edit-dialog-actions">
          <button class="button-danger confirm-dialog-confirm" type="button" data-scope="season">Hide Season ${escapeHtml(String(item.season ?? ""))}</button>
          <button class="button-danger" type="button" data-scope="show">Hide show</button>
          <button class="button-ghost confirm-dialog-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => finish(button.dataset.scope)));
    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", cancel);
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-dialog-cancel").focus();
  });
}

function formatUpNextEpisodeCode(season, episode) {
  const s = Number(season);
  const e = Number(episode);
  if (!Number.isInteger(s) || s < 0 || !Number.isInteger(e) || e <= 0) return "";
  return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
}

export function chooseUpNextAddOptions(show = {}, options = {}) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "edit-dialog-overlay confirm-dialog-overlay";
    const finish = (value) => {
      if (!releaseConfirmDialog(cancel)) return;
      document.removeEventListener("keydown", onKeydown, true);
      overlay.remove();
      opener?.focus();
      resolve(value);
    };
    const cancel = () => finish(null);
    const onKeydown = (event) => handleUpNextDialogKey(event, overlay, cancel);
    registerConfirmDialog(cancel);

    const title = show.title || show.show_title || show.showTitle || options.title || "this show";
    const seasons = Array.isArray(options.seasons) ? options.seasons : [];
    const selectableSeasons = seasons.filter((season) => season && season.has_unwatched !== false);
    const watchedSeasons = Array.isArray(options.watchedSeasons) ? options.watchedSeasons : [];
    const watchedSeasonCount = Number(options.watchedSeasonCount || watchedSeasons.length || 0);
    const earliest = options.earliestUnwatched || null;
    const earliestCode = earliest ? formatUpNextEpisodeCode(earliest.season, earliest.episode) : "";
    const earliestHint = earliestCode
      ? `Starts at ${earliestCode}${earliest.title ? ` — ${earliest.title}` : ""}`
      : (earliest?.season ? `Starts in Season ${earliest.season}` : "Starts from the earliest unwatched episode");
    const showSeasonPicker = seasons.length > 1 && selectableSeasons.length > 0;
    const preferredSeason = selectableSeasons.find((season) => season.watched_count > 0 && season.season_number !== earliest?.season)
      || selectableSeasons[0]
      || null;

    const seasonOptionsHtml = seasons.map((season) => {
      const n = Number(season.season_number);
      const count = Number(season.episode_count || 0);
      const watched = Number(season.watched_count || 0);
      const nextCode = season.next_episode ? formatUpNextEpisodeCode(n, season.next_episode.episode) : "";
      const progressText = count > 0 || watched > 0 ? ` (${watched}/${count || "?"} watched)` : "";
      const suffix = season.has_unwatched === false
        ? " — complete"
        : (nextCode ? ` · Next: ${nextCode}` : "");
      const selectedAttr = preferredSeason && n === Number(preferredSeason.season_number) ? " selected" : "";
      const disabledAttr = season.has_unwatched === false ? " disabled" : "";
      return `<option value="${escapeAttribute(String(n))}"${selectedAttr}${disabledAttr}>Season ${escapeHtml(String(n))}${escapeHtml(progressText)}${escapeHtml(suffix)}</option>`;
    }).join("");

    const bodyText = watchedSeasonCount > 1
      ? `You have watched episodes across Seasons ${watchedSeasons.join(", ")}. Choose where "${title}" should start in Up Next.`
      : `Choose how "${title}" should be added to your Dashboard Up Next rail.`;
    const lookupWarningHtml = options.seasonLookupFailed
      ? `<p class="message muted" role="status">${escapeHtml(options.warning || "Season options could not be loaded in full. You can still add from the earliest unwatched episode.")}</p>`
      : "";

    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    overlay.innerHTML = `
      <div class="edit-dialog" role="dialog" aria-modal="true" aria-label="Add to Up Next">
        <h3>Add to Up Next</h3>
        <p class="confirm-dialog-body">${escapeHtml(bodyText)}</p>
        ${lookupWarningHtml}
        <div class="up-next-add-options" role="radiogroup" aria-label="Up Next starting point">
          <label class="up-next-add-option">
            <input type="radio" name="upNextAddMode" value="earliest" checked />
            <span class="up-next-add-option-content">
              <span class="up-next-add-option-title">Earliest unwatched <span class="up-next-add-default-badge">Default</span></span>
              <span class="up-next-add-option-hint">${escapeHtml(earliestHint)}</span>
            </span>
          </label>
          ${showSeasonPicker ? `
            <label class="up-next-add-option">
              <input type="radio" name="upNextAddMode" value="season" />
              <span class="up-next-add-option-content">
                <span class="up-next-add-option-title">Choose season</span>
                <select class="up-next-add-season-select" aria-label="Choose starting season">${seasonOptionsHtml}</select>
              </span>
            </label>
          ` : ""}
        </div>
        <div class="edit-dialog-actions">
          <button class="button-primary confirm-dialog-confirm" type="button">Add to Up Next</button>
          <button class="button-ghost confirm-dialog-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;

    const earliestRadio = overlay.querySelector('input[name="upNextAddMode"][value="earliest"]');
    const seasonRadio = overlay.querySelector('input[name="upNextAddMode"][value="season"]');
    const seasonSelect = overlay.querySelector(".up-next-add-season-select");
    if (seasonSelect && seasonRadio) {
      const selectSeasonMode = () => { seasonRadio.checked = true; };
      seasonSelect.addEventListener("change", selectSeasonMode);
    }

    overlay.querySelector(".confirm-dialog-confirm").addEventListener("click", () => {
      const useSeason = Boolean(seasonRadio?.checked && seasonSelect?.value);
      const parsed = useSeason ? Number(seasonSelect.value) : null;
      finish({ targetSeason: Number.isInteger(parsed) && parsed > 0 ? parsed : null });
    });
    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", cancel);
    document.addEventListener("keydown", onKeydown, true);
    document.body.appendChild(overlay);
    (earliestRadio || overlay.querySelector(".confirm-dialog-confirm")).focus();
  });
}

// An episode card's plain tmdb/tvdb id is the episode's, so only its show_*
// ids identify the show. A show record (manual show, media page button) has
// no episode media type and carries the show ids directly.
function showIdValue(item = {}, kind = "tmdb") {
  const capitalized = `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  const showLevel = String(item[`show_${kind}_id`] || item[`show${capitalized}Id`] || "").trim();
  if (showLevel) return showLevel.toLowerCase();
  const mediaType = String(item.media_type || item.mediaType || "").trim().toLowerCase();
  if (mediaType === "episode") return "";
  return String(item[`${kind}_id`] || item[`${kind}Id`] || "").trim().toLowerCase();
}

// Two shows can share a title (Scrubs 2001 and its 2026 reboot), and so share
// every title and episode-coordinate key. A TMDB or TVDB show id that
// disagrees proves they are different shows, so title-keyed matching must
// never pair them. Mirrors provenDifferentShow in
// server/src/utils/upNextDismissals.js.
export function provenDifferentShow(left = {}, right = {}) {
  return ["tmdb", "tvdb"].some((kind) => {
    const leftId = showIdValue(left, kind);
    const rightId = showIdValue(right, kind);
    return Boolean(leftId && rightId && leftId !== rightId);
  });
}

export function manualShowMatches(show = {}, candidate = {}) {
  if (provenDifferentShow(show, candidate)) return false;
  const ids = ["tmdb", "tvdb", "imdb"];
  const sameId = ids.some((kind) => {
    const left = identityValues(show, kind);
    const right = identityValues(candidate, kind);
    return left.some((value) => right.includes(value));
  });
  if (sameId) return true;
  const leftTitle = slug(show.title || show.show_title || show.showTitle || "");
  const rightTitle = slug(candidate.title || candidate.show_title || candidate.showTitle || "");
  return Boolean(leftTitle && rightTitle && leftTitle === rightTitle);
}

export function isShowInUpNext(show = {}) {
  if ((state.upNextManualShows || []).some((candidate) => manualShowMatches(show, candidate))) return true;
  return (state.upNextItems || []).some((candidate) => (
    String(candidate?.media_type || candidate?.mediaType || "").toLowerCase() === "episode"
    && manualShowMatches(show, candidate)
  ));
}

export function upNextShowActionHtml(show = {}) {
  const selected = isShowInUpNext(show);
  const title = show.title || show.show_title || "TV show";
  const action = selected ? "remove" : "add";
  return `
    <button class="action-pill action-pill-ghost media-up-next-show-btn${selected ? " is-added" : ""}" type="button"
      data-up-next-show-add
      data-up-next-show-action="${action}"
      data-up-next-show-title="${escapeAttribute(title)}"
      data-up-next-show-tmdb-id="${escapeAttribute(show.tmdb_id || show.tmdbId || show.show_tmdb_id || "")}"
      data-up-next-show-tvdb-id="${escapeAttribute(show.tvdb_id || show.tvdbId || show.show_tvdb_id || "")}"
      data-up-next-show-imdb-id="${escapeAttribute(show.imdb_id || show.imdbId || show.show_imdb_id || "")}"
      data-up-next-show-poster-url="${escapeAttribute(show.poster_url || show.posterUrl || show.show_poster_url || "")}"
      title="${selected ? "Remove this show from the dashboard Up Next rail" : "Add the next unwatched episode to the dashboard Up Next rail"}">
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        ${selected ? '<path d="M3 8h10" />' : '<path d="M8 3v10M3 8h10" />'}
      </svg>
      <span>${selected ? "Remove from <br>Up Next" : "Add to <br>Up Next"}</span>
    </button>
    ${["tmdb", "tvdb", "imdb"].some((kind) => show[`${kind}_id`] || show[`show_${kind}_id`])
      ? `<button class="action-pill action-pill-ghost" type="button" data-up-next-show-options
        data-up-next-show-title="${escapeAttribute(title)}"
        data-up-next-show-tmdb-id="${escapeAttribute(show.tmdb_id || show.show_tmdb_id || "")}"
        data-up-next-show-tvdb-id="${escapeAttribute(show.tvdb_id || show.show_tvdb_id || "")}"
        data-up-next-show-imdb-id="${escapeAttribute(show.imdb_id || show.show_imdb_id || "")}">Up Next options</button>`
      : ""}
  `;
}

export const UP_NEXT_SORT_MODES = Object.freeze(["recently_watched", "newly_aired", "oldest_unwatched", "closest_to_finishing", "custom"]);

export function upNextSortMode(config = state.savedConfig) {
  const raw = String(config?.upNextSync?.sort || "").trim();
  return UP_NEXT_SORT_MODES.includes(raw) ? raw : "recently_watched";
}

function parseAirDateMs(item = {}) {
  const raw = String(item.air_date || item.airDate || "").trim();
  if (!raw) return 0;
  if (/^\d{4}$/.test(raw)) return Date.parse(`${raw}-01-01T00:00:00Z`) || 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseWatchDateMs(value) {
  if (value === null || value === undefined || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortUpNextDisplayItems(items = [], sortMode = upNextSortMode(), partWatchedFirst = state.savedConfig?.upNextSync?.partWatchedFirst !== false) {
  const list = Array.isArray(items) ? items : [];
  if (sortMode !== "newly_aired" && sortMode !== "oldest_unwatched") return list;
  return list
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftResume = left.item?.queue_kind === "resume" && left.item?.playback_position_known !== false;
      const rightResume = right.item?.queue_kind === "resume" && right.item?.playback_position_known !== false;
      if (partWatchedFirst && leftResume !== rightResume) return leftResume ? -1 : 1;
      const placement = { top: -1, bottom: 1 };
      const difference = (placement[left.item?.queue_placement] ?? 0) - (placement[right.item?.queue_placement] ?? 0);
      if (difference) return difference;
      if (partWatchedFirst && leftResume) return left.index - right.index;

      const leftAir = parseAirDateMs(left.item);
      const rightAir = parseAirDateMs(right.item);
      if (leftAir !== rightAir) {
        if (!leftAir) return 1;
        if (!rightAir) return -1;
        return sortMode === "oldest_unwatched" ? leftAir - rightAir : rightAir - leftAir;
      }

      const leftWatched = parseWatchDateMs(left.item?.show_latest_watched_at || left.item?.showLatestWatchedAt);
      const rightWatched = parseWatchDateMs(right.item?.show_latest_watched_at || right.item?.showLatestWatchedAt);
      if (leftWatched !== rightWatched) {
        if (!leftWatched) return 1;
        if (!rightWatched) return -1;
        return rightWatched - leftWatched;
      }

      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function isManualUpNextShow(entry = {}, manualShows = state.upNextManualShows) {
  if (!isEpisode(entry)) return false;
  return (Array.isArray(manualShows) ? manualShows : []).some((show) => manualShowMatches(show, entry));
}

export function upNextCardCues(entry = {}, manualShows = state.upNextManualShows) {
  const cues = [];
  const lane = String(entry?.up_next_lane || entry?.upNextLane || "").trim().toLowerCase();
  if (lane === "rewatch") {
    cues.push({ kind: "rewatch", label: "Rewatch", title: "Next episode from your rewatch" });
  } else if (lane === "new") {
    cues.push({ kind: "new", label: "New episode", title: "Newly aired episode beyond your rewatch" });
  }
  if (isManualUpNextShow(entry, manualShows)) {
    cues.push({ kind: "pinned", label: "Pinned", title: "Manually added to Up Next" });
  }
  if (entry.queue_placement === "top") cues.push({ kind: "placement", label: "Top of queue", title: "Per-show Up Next placement" });
  if (entry.queue_placement === "bottom") cues.push({ kind: "placement", label: "Bottom of queue", title: "Per-show Up Next placement" });
  return cues;
}

export function upNextCardCuesHtml(entry = {}, manualShows = state.upNextManualShows) {
  const cues = upNextCardCues(entry, manualShows);
  if (!cues.length) return "";
  return `<div class="up-next-card-cues">${cues
    .map((cue) => `<span class="up-next-cue up-next-cue--${escapeAttribute(cue.kind)}" title="${escapeAttribute(cue.title)}">${escapeHtml(cue.label)}</span>`)
    .join("")}</div>`;
}

const SYNC_PROVIDER_NAMES = { plex: "Plex", emby: "Emby", jellyfin: "Jellyfin" };

function syncProviderLabels(providers = []) {
  const seen = new Set();
  const labels = [];
  for (const raw of (Array.isArray(providers) ? providers : [])) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(SYNC_PROVIDER_NAMES[key] || key);
  }
  return labels;
}

export function formatUpNextRelativeTime(at, now = Date.now()) {
  const timestamp = Number(at);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const elapsedMs = Math.max(0, Number(now) - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function upNextSyncButtonState({
  signedIn = Boolean(state.token),
  syncEnabled = state.savedConfig?.upNextSync?.enabled !== false,
  syncing = state.upNextSyncing === true,
  loading = state.upNextLoading === true,
  syncStatus = state.upNextSyncStatus,
  now = Date.now(),
} = {}) {
  if (syncing) {
    return {
      disabled: true,
      busy: true,
      status: "syncing",
      label: "Syncing…",
      title: "Pushing Plekt Up Next to Plex, Emby, and Jellyfin…",
      ariaLabel: "Pushing Plekt Up Next to connected media servers",
    };
  }
  if (loading) {
    return {
      disabled: true,
      busy: true,
      status: "loading",
      label: "Refreshing…",
      title: "Refreshing Up Next…",
      ariaLabel: "Refreshing Up Next",
    };
  }
  if (!signedIn) {
    return {
      disabled: true,
      busy: false,
      status: "signed_out",
      label: "",
      title: "Sign in to push Up Next to your media servers",
      ariaLabel: "Sign in to push Up Next to your media servers",
    };
  }
  if (!syncEnabled) {
    return {
      disabled: true,
      busy: false,
      status: "disabled",
      label: "",
      title: "Up Next sync is disabled in Now Playing options or Settings → Sync → Sync Tuning",
      ariaLabel: "Up Next sync is disabled in settings",
    };
  }

  const hides = Array.isArray(syncStatus?.recentMirrorHides) && syncStatus.recentMirrorHides.length
    ? syncStatus.recentMirrorHides
    : (Array.isArray(syncStatus?.mirrorHides) ? syncStatus.mirrorHides : []);
  const hideLog = hides.slice(0, 10).map(({ provider, title, reason, status, at }) => {
    const app = provider === "plex" ? "Plex" : provider === "emby" ? "Emby" : provider;
    const outcome = status === "hidden" ? "Hidden (play to restore)" : status === "skipped" ? "Skipped" : "Failed";
    const when = Number(at) > 0 ? ` · ${formatUpNextRelativeTime(at, now)}` : "";
    return `${app} · ${title} · ${reason} · ${outcome}${when}`;
  });
  const baseTitle = ["Push Plekt Up Next to Plex, Emby, and Jellyfin", ...hideLog].join("\n");
  const status = syncStatus && typeof syncStatus === "object" && Number(syncStatus.at) > 0
    ? String(syncStatus.status || "idle")
    : "idle";
  const rel = syncStatus?.at ? formatUpNextRelativeTime(syncStatus.at, now) : "";
  const modeLabel = syncStatus?.mode === "manual" ? "Manual sync" : "Auto-sync";
  const pushed = syncProviderLabels(syncStatus?.pushedProviders);
  const failed = syncProviderLabels([
    ...(Array.isArray(syncStatus?.unreachableProviders) ? syncStatus.unreachableProviders : []),
    ...(Array.isArray(syncStatus?.failedFeedProviders) ? syncStatus.failedFeedProviders : []),
  ]);

  if (status === "succeeded" && rel) {
    const targetText = pushed.length ? ` to ${pushed.join(", ")}` : "";
    const detail = `${modeLabel} ${rel}${targetText}.`;
    return {
      disabled: false,
      busy: false,
      status: "succeeded",
      label: `Synced ${rel}`,
      title: `${baseTitle}\n${detail}`,
      ariaLabel: `${baseTitle}. ${detail}`,
    };
  }
  if (status === "partial" && rel) {
    const detail = `${modeLabel} ${rel}: synced ${pushed.join(", ") || "available apps"}; ${failed.join(", ") || "another app"} unreachable.`;
    return {
      disabled: false,
      busy: false,
      status: "partial",
      label: `Partial sync · ${rel}`,
      title: `${baseTitle}\n${detail}`,
      ariaLabel: `${baseTitle}. ${detail}`,
    };
  }
  if (status === "failed" && rel) {
    const detail = `Last ${modeLabel.toLowerCase()} ${rel} failed${failed.length ? ` (${failed.join(", ")} unreachable)` : ""}.`;
    return {
      disabled: false,
      busy: false,
      status: "failed",
      label: `Sync failed · ${rel}`,
      title: `${baseTitle}\n${detail}`,
      ariaLabel: `${baseTitle}. ${detail}`,
    };
  }
  return {
    disabled: false,
    busy: false,
    status: "idle",
    label: "",
    title: baseTitle,
    ariaLabel: baseTitle,
  };
}

export function applyUpNextSyncControlState(button, options = {}) {
  if (!button) return null;
  const view = upNextSyncButtonState(options);
  button.disabled = view.disabled;
  button.setAttribute("aria-busy", String(view.busy));
  if (button.dataset) button.dataset.syncStatus = view.status;
  const label = button.querySelector?.(".up-next-sync-label");
  if (label) label.textContent = view.label;
  button.title = view.title;
  button.setAttribute("aria-label", view.ariaLabel);
  return view;
}

