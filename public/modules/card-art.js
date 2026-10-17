import { escapeAttribute, showName } from "./utils.js?v=2.1.0.0.3";
import { tmdbImage } from "./images.js?v=2.1.0.0.3";
import { fetchTmdbDetails, fetchTmdbSeasonDetails } from "./tmdb.js?v=2.1.0.0.3";
import { THEME_STYLE_EVENT, isModernStyle } from "./appearance.js?v=2.1.0.0.3";

// --- Modern backdrop artwork behind cards -----------------------------------
// Cards on every page (Dashboard, History, the library, Discover, Watchlist,
// Ratings, Playlists) carry data-art="type|tmdb|tvdb|imdb|title". Under Modern
// the backdrop for each key is looked up once through the batched TMDB details
// request and published as a CSS rule in one injected stylesheet, so the
// cards themselves are never mutated (the dashboard's reconcile signature is
// their outerHTML) and a re-rendered card picks its backdrop up immediately.
// One page-wide watcher finds cards as any page renders them and requests a
// key only when one of its cards nears view. A lookup that fails (a batch
// timing out on a cold cache) is retried a few times, instead of leaving that
// title blank until a reload.

export function artKey(type, { tmdb = "", tvdb = "", imdb = "", title = "" } = {}) {
  const parts = [tmdb, tvdb, imdb].map((value) => String(value ?? "").trim().replace(/\|/g, ""));
  const name = String(title ?? "").trim();
  if (!parts.some(Boolean) && !name) return "";
  return [type, ...parts, name].join("|");
}

// An episode takes its own still, falling back to its show's backdrop (the
// name part of an episode key is "<season>x<episode> <show title>"); a show or
// a movie takes its own backdrop.
export function mediaArtKey(entry = {}) {
  const type = String(entry.media_type || entry.mediaType || entry.type || "").toLowerCase();
  if (type === "episode") {
    const season = Number(entry.season);
    const episode = Number(entry.episode);
    const showTitle = entry.show_title || showName(entry.title);
    if (Number.isInteger(season) && Number.isInteger(episode) && entry.season != null && entry.episode != null) {
      return artKey("episode", { tmdb: entry.show_tmdb_id, tvdb: entry.show_tvdb_id, imdb: entry.show_imdb_id, title: `${season}x${episode} ${showTitle}` });
    }
    return artKey("tv", { tmdb: entry.show_tmdb_id, tvdb: entry.show_tvdb_id, imdb: entry.show_imdb_id, title: entry.show_title || showName(entry.title) });
  }
  const kind = ["tv", "show", "series"].includes(type) ? "tv" : "movie";
  return artKey(kind, { tmdb: entry.tmdb_id, tvdb: entry.tvdb_id, imdb: entry.imdb_id, title: entry.title });
}

export function cardArtAttribute(entry = {}) {
  const key = mediaArtKey(entry);
  return key ? ` data-art="${escapeAttribute(key)}"` : "";
}

// Delays before each retry of a failed lookup; after the last, the key stays
// blank until the page reloads.
export const ART_RETRY_DELAYS_MS = [5000, 30000, 120000];

const requestedArt = new Set();
const failedAttempts = new Map();
let artSheet = null;

// Resolves to the backdrop URL, "" when the title has none, or null when the
// lookup itself failed and is worth retrying.
async function resolveBackdrop(key) {
  const [type, tmdb, tvdb, imdb, ...title] = key.split("|");
  try {
    if (type === "episode") {
      const [, season, episode, showTitle] = /^(\d+)x(\d+) (.*)$/s.exec(title.join("|")) || [];
      const showId = tmdb || (tvdb ? `tvdb:${tvdb}` : "");
      const seasonData = showId ? await fetchTmdbSeasonDetails(showId, Number(season)) : null;
      const still = seasonData?.episodes?.find((item) => Number(item.episode_number) === Number(episode))?.still_path;
      if (still) return tmdbImage(still, "w780");
      return resolveBackdrop(["tv", tmdb, tvdb, imdb, showTitle || ""].join("|"));
    }
    const details = await fetchTmdbDetails(type, tmdb, title.join("|"), { tvdbId: tvdb, imdbId: imdb }, { light: true });
    if (!details) return null;
    return details.cached_backdrop_url || tmdbImage(details.backdrop_path, "w780") || "";
  } catch {
    return null;
  }
}

function publishArt(key, url) {
  if (!url || typeof CSS === "undefined") return;
  if (!artSheet) {
    artSheet = document.createElement("style");
    artSheet.id = "modernArtStyles";
    document.head.append(artSheet);
  }
  const safeUrl = url.replace(/["\\\s]/g, (char) => encodeURIComponent(char));
  const selector = CSS.escape(key);
  // The page backdrop uses its own property: the cards inside the page would
  // otherwise inherit it when they have no backdrop of their own.
  artSheet.append(`[data-art="${selector}"]{--modern-art:url("${safeUrl}");--modern-art-shade:1}\n`
    + `[data-page-art="${selector}"]{--modern-page-art:url("${safeUrl}")}\n`);
}

function retryLater(key) {
  const attempt = failedAttempts.get(key) || 0;
  if (attempt >= ART_RETRY_DELAYS_MS.length) return;
  failedAttempts.set(key, attempt + 1);
  setTimeout(() => {
    requestedArt.delete(key);
    scheduleCardArtScan();
  }, ART_RETRY_DELAYS_MS[attempt]);
}

export function requestArtKey(key) {
  if (!key || requestedArt.has(key)) return Promise.resolve();
  requestedArt.add(key);
  return resolveBackdrop(key).then((url) => {
    if (url === null) {
      retryLater(key);
      return;
    }
    failedAttempts.delete(key);
    publishArt(key, url);
  });
}

let cardArtObserver = null;
export function observeCardArtwork(root) {
  if (!root || !isModernStyle()) {
    cardArtObserver?.disconnect();
    return;
  }
  const cards = root.querySelectorAll("[data-art]");
  if (!("IntersectionObserver" in window)) {
    cards.forEach((card) => requestArtKey(card.getAttribute("data-art")));
    return;
  }
  cardArtObserver ||= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      cardArtObserver.unobserve(entry.target);
      requestArtKey(entry.target.getAttribute("data-art"));
    }
  }, { rootMargin: "300px" });
  for (const card of cards) {
    if (!requestedArt.has(card.getAttribute("data-art"))) cardArtObserver.observe(card);
  }
}

const hasDocument = typeof document !== "undefined" && typeof document.querySelector === "function";
const pageShell = hasDocument ? document.querySelector(".page-shell") : null;
let scanFrame = 0;

function scheduleCardArtScan() {
  if (!pageShell || scanFrame) return;
  scanFrame = requestAnimationFrame(() => {
    scanFrame = 0;
    observeCardArtwork(pageShell);
  });
}

if (pageShell && typeof MutationObserver !== "undefined") {
  // Pages render cards at any time (infinite scroll, view switches, live
  // updates); one pass per frame picks up every new card.
  new MutationObserver(scheduleCardArtScan).observe(pageShell, { childList: true, subtree: true });
  scheduleCardArtScan();
}

if (hasDocument) document.addEventListener(THEME_STYLE_EVENT, scheduleCardArtScan);
