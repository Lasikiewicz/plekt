import crypto from "node:crypto";
import { isIP } from "node:net";
import { loadRuntimeState, setRuntimeState } from "./configStore.js";
import { getUpcomingCalendarMonth } from "./upcomingCalendarCache.js";
import { getCachedMovies } from "./dataRepo.js";
import { getCachedTmdbDetails } from "./tmdbGateway.js";

const TOKEN_KEY = "calendarFeedToken";
const TYPES_KEY = "calendarFeedTypes";
export const DEFAULT_CALENDAR_FEED_TYPES = Object.freeze(["tv", "movies"]);

export function normalizeCalendarFeedTypes(types) {
  if (!Array.isArray(types)) return [];
  return DEFAULT_CALENDAR_FEED_TYPES.filter((type) => types.includes(type));
}

export function createCalendarFeedToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function calendarFeedTokenMatches(expected, supplied) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(supplied || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export function isPublicCalendarOrigin(baseUrl = "") {
  let url;
  try { url = new URL(String(baseUrl || "")); } catch { return false; }
  if (!new Set(["http:", "https:"]).has(url.protocol)
    || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return false;

  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [a, b, c] = hostname.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      || (a === 100 && b >= 64 && b <= 127)) return false;
  } else if (ipVersion === 6) {
    const firstGroup = Number.parseInt(hostname.split(":")[0], 16);
    if (hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:")
      || !Number.isInteger(firstGroup) || firstGroup < 0x2000 || firstGroup > 0x3fff || firstGroup === 0x3fff
      || hostname === "2001:db8" || hostname.startsWith("2001:db8:")
      || /^(fc|fd)/.test(hostname) || /^fe[89ab]/.test(hostname)) return false;
  } else {
    if (!hostname.includes(".") || hostname === "localhost"
      || /\.(?:localhost|local|lan|home|internal|intranet|test|invalid|example)$/.test(hostname)
      || hostname.endsWith(".home.arpa")) return false;
  }
  return true;
}

export function resolveCalendarOrigin(configuredOrigin = "", browserOrigin = "") {
  return configuredOrigin || browserOrigin;
}

export async function getCalendarFeedSettings(baseUrl = "") {
  const runtime = await loadRuntimeState();
  const token = String(runtime[TOKEN_KEY] || "");
  const ready = isPublicCalendarOrigin(baseUrl);
  return {
    ready,
    url: ready && token ? `${new URL(baseUrl).origin}/api/calendar-feed.ics?token=${encodeURIComponent(token)}` : "",
    types: normalizeCalendarFeedTypes(runtime[TYPES_KEY]).length
      ? normalizeCalendarFeedTypes(runtime[TYPES_KEY])
      : [...DEFAULT_CALENDAR_FEED_TYPES],
    message: ready ? "" : "Open Plekt at an internet-reachable address or set PLEKT_PUBLIC_URL before generating or viewing the feed URL.",
  };
}

export async function regenerateCalendarFeedToken(types = DEFAULT_CALENDAR_FEED_TYPES) {
  const selectedTypes = normalizeCalendarFeedTypes(types);
  if (!selectedTypes.length) throw new Error("Select movies, TV shows or both.");
  const token = createCalendarFeedToken();
  await setRuntimeState({ [TOKEN_KEY]: token, [TYPES_KEY]: selectedTypes });
  return token;
}

export async function getCalendarFeed(token, {
  now = new Date(),
  upcomingMonth = getUpcomingCalendarMonth,
  listMovies = getCachedMovies,
  cachedMovieDetails = getCachedTmdbDetails,
} = {}) {
  const runtime = await loadRuntimeState();
  if (!calendarFeedTokenMatches(runtime[TOKEN_KEY], token)) return null;
  const selectedTypes = normalizeCalendarFeedTypes(runtime[TYPES_KEY]).length
    ? normalizeCalendarFeedTypes(runtime[TYPES_KEY])
    : [...DEFAULT_CALENDAR_FEED_TYPES];

  const month = now.toISOString().slice(0, 7);
  const through = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth(), 1)).toISOString().slice(0, 7);
  const episodes = [];
  if (selectedTypes.includes("tv")) {
    for (let cursor = month; cursor <= through; cursor = nextMonth(cursor)) {
      const result = await upcomingMonth(cursor);
      episodes.push(...(result.episodes || []));
    }
  }
  const movies = [];
  if (selectedTypes.includes("movies")) {
    const libraryMovies = await listMovies();
    for (const movie of dedupeMovies(libraryMovies)) {
      const recordedDate = String(movie.release_date || "").slice(0, 10);
      if (recordedDate && recordedDate < now.toISOString().slice(0, 10)) continue;
      // A calendar subscription must stay a fast, read-only cache consumer. Do
      // not turn a calendar refresh into hundreds of serial TMDB requests.
      const details = movie.tmdb_id
        ? cachedMovieDetails({ mediaType: "movie", tmdbId: movie.tmdb_id })
        : null;
      const date = String(recordedDate || details?.release_date || "").slice(0, 10);
      if (date < now.toISOString().slice(0, 10) || date > `${through}-31`) continue;
      if (!date) continue;
      movies.push({ date, title: movie.title || details?.title || "Movie", tmdbId: movie.tmdb_id || details?.id || "" });
    }
  }
  return { episodes: episodes.filter((item) => item.airDate >= now.toISOString().slice(0, 10)), movies };
}

function nextMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}

function dedupeMovies(rows = []) {
  const unique = new Map();
  for (const row of rows) {
    const key = row.tmdb_id ? `tmdb:${row.tmdb_id}` : `title:${String(row.title || "").toLowerCase()}`;
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

function escapeIcs(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

export function serializeCalendarFeed({ episodes = [], movies = [] } = {}, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const events = [
    ...episodes.map((item) => ({
      uid: `episode-${item.tmdbId}-${item.season}-${item.episode}@plekt`, date: item.airDate,
      summary: `${item.showTitle} S${String(item.season).padStart(2, "0")}E${String(item.episode).padStart(2, "0")}${item.episodeTitle ? ` - ${item.episodeTitle}` : ""}`,
      description: `Upcoming episode of ${item.showTitle}`,
    })),
    ...movies.map((item) => ({ uid: `movie-${item.tmdbId || encodeURIComponent(item.title)}@plekt`, date: item.date, summary: item.title, description: "Movie release" })),
  ];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Plekt//Calendar Feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const event of events) lines.push("BEGIN:VEVENT", `UID:${escapeIcs(event.uid)}`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${event.date.replace(/-/g, "")}`, `SUMMARY:${escapeIcs(event.summary)}`, `DESCRIPTION:${escapeIcs(event.description)}`, "END:VEVENT");
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
