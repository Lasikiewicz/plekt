import { markPlexPlayed } from "../server/src/utils/plexClient.js";
import { markEmbyPlayed } from "../server/src/utils/embyClient.js";
import { markJellyfinPlayed } from "../server/src/utils/jellyfinClient.js";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const HISTORY_ENDPOINT = process.env.PLEKT_HISTORY_ENDPOINT || process.env.PLEMBFIN_HISTORY_ENDPOINT ||"http://localhost:5055/api/history?limit=25000";
const API_KEY = requiredEnv("API_KEY");

const TARGET_CONFIG = {
  plex: {
    baseUrl: requiredEnv("PLEX_URL"),
    token: requiredEnv("PLEX_TOKEN"),
  },
  emby: {
    baseUrl: requiredEnv("EMBY_URL"),
    apiKey: requiredEnv("EMBY_API_KEY"),
    userId: requiredEnv("EMBY_USER_ID"),
  },
  jellyfin: {
    baseUrl: requiredEnv("JELLYFIN_URL"),
    apiKey: requiredEnv("JELLYFIN_API_KEY"),
    userId: requiredEnv("JELLYFIN_USER_ID"),
  },
};

const ROW_DELAY_MS = 150;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMasterHistory() {
  const response = await fetch(HISTORY_ENDPOINT, {
    headers: {
      "X-Api-Key": API_KEY,
      Accept: "application/json",
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`History download failed: ${body.error || response.status}`);
  }

  if (!Array.isArray(body.history)) {
    throw new Error("History API did not return a history array");
  }

  return body.history;
}

function cleanShowTitleForDeduplication(title) {
  const str = String(title || "");
  const regex = /(?:\s*-\s*|\s+)S(\d+)E(\d+)/i;
  const match = str.match(regex);
  if (match) {
    return str.slice(0, match.index).replace(/\s*-\s*$/, "").trim();
  }
  return str.replace(/\s*-\s*$/, "").trim();
}

function getCompositeKey(row) {
  const type = String(row.media_type || "").toLowerCase();
  const normalize = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  if (type === "movie") {
    if (row.imdb_id) return `movie:imdb:${row.imdb_id}`;
    if (row.tmdb_id) return `movie:tmdb:${row.tmdb_id}`;
    if (row.tvdb_id) return `movie:tvdb:${row.tvdb_id}`;
    return `movie:title:${normalize(row.title)}`;
  } else {
    const s = row.season == null ? "?" : Number(row.season);
    const e = row.episode == null ? "?" : Number(row.episode);

    if (row.imdb_id) return `episode:imdb:${row.imdb_id}:s${s}e${e}`;
    if (row.tmdb_id) return `episode:tmdb:${row.tmdb_id}:s${s}e${e}`;
    if (row.tvdb_id) return `episode:tvdb:${row.tvdb_id}:s${s}e${e}`;

    const baseTitle = cleanShowTitleForDeduplication(row.title);
    return `episode:title:${normalize(baseTitle)}:s${s}e${e}`;
  }
}

function deduplicateHistory(history) {
  const seen = new Set();
  const unique = [];

  for (const row of history) {
    const key = getCompositeKey(row);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(row);
    }
  }

  return unique;
}

function mediaFromHistoryRow(row) {
  return {
    title: row.title,
    type: row.media_type,
    source: row.source,
    ids: {
      imdb: row.imdb_id || undefined,
      tmdb: row.tmdb_id || undefined,
      tvdb: row.tvdb_id || undefined,
    },
    season: row.season == null ? undefined : Number(row.season),
    episode: row.episode == null ? undefined : Number(row.episode),
    isValid: Boolean(row.title && row.media_type),
  };
}

async function pushToTarget(target, media) {
  if (target === "plex") return markPlexPlayed(TARGET_CONFIG.plex, media);
  if (target === "emby") return markEmbyPlayed(TARGET_CONFIG.emby, media);
  if (target === "jellyfin") return markJellyfinPlayed(TARGET_CONFIG.jellyfin, media);
  throw new Error(`Unknown target: ${target}`);
}

async function pushRow(row, index, total) {
  let jellyfinItemId = null;
  let embyItemId = null;
  let plexRatingKey = null;
  let seriesId = null;

  // Example Explicit Loop Sanitization
  jellyfinItemId = null;
  embyItemId = null;
  plexRatingKey = null;
  seriesId = null;

  const media = mediaFromHistoryRow(row);
  const targets = ["plex", "emby", "jellyfin"];
  const results = [];

  for (const target of targets) {
    try {
      const result = await pushToTarget(target, media);
      if (result && result.status === "fulfilled" && result.itemId) {
        if (target === "plex") plexRatingKey = result.itemId;
        if (target === "emby") embyItemId = result.itemId;
        if (target === "jellyfin") jellyfinItemId = result.itemId;
      }
      results.push(`${target}: ${result.status === "not_found" ? "not found" : "success"}`);
    } catch (error) {
      results.push(`${target}: error (${error.message})`);
    }
  }

  console.log(`[SYNCING] ${index} / ${total} - '${media.title}' pushed to ${results.join(", ")}.`);
}

async function main() {
  console.log("Downloading master D1 history...");
  const rawHistory = await fetchMasterHistory();

  const formattedRaw = rawHistory.length.toLocaleString("en-US");
  console.log(`  Downloaded ${formattedRaw} history logs.`);

  const cleanHistory = deduplicateHistory(rawHistory);
  const formattedClean = cleanHistory.length.toLocaleString("en-US");
  console.log(`  ✔ Cleaned database array: Isolate ${formattedClean} unique media assets to sync.`);
  console.log("  Starting force-push sync...");

  for (let index = 0; index < cleanHistory.length; index += 1) {
    await pushRow(cleanHistory[index], index + 1, cleanHistory.length);
    await delay(ROW_DELAY_MS);
  }

  console.log("Force-push history sync complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
