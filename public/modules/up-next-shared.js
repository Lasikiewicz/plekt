import { state } from "./state.js?v=2.0.0.2.1";
import { escapeAttribute, escapeHtml, slug } from "./utils.js?v=2.0.0.2.1";

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
  for (const item of items) {
    if (liveKeys.has(upNextItemLiveKey(item))) playing.push(item);
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
  for (const item of items) {
    const key = upNextCoordinateDismissalKey(item);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, item);
    else if (existing.queue_kind !== "resume" && item.queue_kind === "resume") byKey.set(key, item);
  }
  const out = [];
  const placed = new Set();
  for (const item of items) {
    const key = upNextCoordinateDismissalKey(item);
    if (!key) {
      out.push(item);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    out.push(byKey.get(key));
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

export function chooseUpNextRemovalScope(item = {}) {
  return new Promise((resolve) => {
    document.querySelectorAll(".confirm-dialog-overlay").forEach((el) => el.remove());
    const overlay = document.createElement("div");
    overlay.className = "edit-dialog-overlay confirm-dialog-overlay";
    const finish = (value) => {
      overlay.remove();
      resolve(value);
    };
    const title = item.show_title || item.showTitle || item.title || "this show";
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
    overlay.innerHTML = `
      <div class="edit-dialog">
        <h3>Remove from Up Next</h3>
        <p class="confirm-dialog-body">"${escapeHtml(title)}" has more than one card in Up Next. Hide only Season ${escapeHtml(String(item.season ?? ""))}, or the whole show? Either way it is removed in Plekt and every connected media app.</p>
        <div class="edit-dialog-actions">
          <button class="button-danger confirm-dialog-confirm" type="button" data-scope="season">Hide Season ${escapeHtml(String(item.season ?? ""))}</button>
          <button class="button-danger" type="button" data-scope="show">Hide show</button>
          <button class="button-ghost confirm-dialog-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
    overlay.querySelectorAll("[data-scope]").forEach((button) => button.addEventListener("click", () => finish(button.dataset.scope)));
    overlay.querySelector(".confirm-dialog-cancel").addEventListener("click", () => finish(null));
    document.body.appendChild(overlay);
    overlay.querySelector(".confirm-dialog-confirm").focus();
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
  `;
}
