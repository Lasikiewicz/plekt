import { pathToFileURL } from "node:url";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const PLEX_URL = requiredEnv("PLEX_URL");
const PLEX_TOKEN = requiredEnv("PLEX_TOKEN");
const API_KEY = requiredEnv("API_KEY");
const IMPORT_ENDPOINT = process.env.PLEKT_IMPORT_ENDPOINT || process.env.PLEMBFIN_IMPORT_ENDPOINT ||"http://localhost:5056/api/import";
const CHUNK_SIZE = 100;

function trimTrailingSlash(value = "") {
  return String(value).replace(/\/+$/, "");
}

function plexUrl(path) {
  const url = new URL(`${trimTrailingSlash(PLEX_URL)}${path}`);
  url.searchParams.set("X-Plex-Token", PLEX_TOKEN);
  return url;
}

function posterUrl(item = {}, type = "movie") {
  // Return empty string to force the importer to fetch high-quality canonical TMDB posters
  return "";
}

async function plexJson(path) {
  const response = await fetch(plexUrl(path), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Plex request failed ${response.status} for ${path}`);
  }

  return response.json();
}

function providerIds(item = {}) {
  const ids = { imdb_id: "", tmdb_id: "", tvdb_id: "" };
  const rawGuids = [
    item.guid,
    ...(Array.isArray(item.Guid) ? item.Guid.map((guid) => guid.id || guid) : []),
  ].filter(Boolean);

  for (const rawGuid of rawGuids) {
    const guid = String(rawGuid);
    const value = guid.split(/:\/\/|\//).pop();
    if (guid.includes("imdb")) ids.imdb_id = value;
    if (guid.includes("tmdb") || guid.includes("themoviedb")) ids.tmdb_id = value;
    if (guid.includes("tvdb") || guid.includes("thetvdb")) ids.tvdb_id = value;
  }

  return ids;
}

function watchedAt(item = {}) {
  if (item.lastViewedAt) return new Date(Number(item.lastViewedAt) * 1000).toISOString();
  if (item.viewedAt) return new Date(Number(item.viewedAt) * 1000).toISOString();
  return "";
}

function movieRecord(item) {
  const watched = watchedAt(item);
  if (!watched) return undefined;

  return {
    title: item.title || "Unknown Movie",
    media_type: "movie",
    watched_at: watched,
    source: "plex_initial_sync",
    poster_url: posterUrl(item, "movie"),
    ...providerIds(item),
  };
}

function plexIndexOrBlank(value) {
  if (value == null || value === "") return "";
  const number = Number(value);
  return Number.isFinite(number) ? number : "";
}

function episodeCodePart(value) {
  return value === "" ? "?" : value;
}

export function episodeRecord(item) {
  const show = item.grandparentTitle || "Unknown Show";
  const season = plexIndexOrBlank(item.parentIndex);
  const episode = plexIndexOrBlank(item.index);
  const title = `${show} - S${String(episodeCodePart(season)).padStart(2, "0")}E${String(episodeCodePart(episode)).padStart(2, "0")}`;
  const watched = watchedAt(item);
  if (!watched) return undefined;

  return {
    title,
    media_type: "episode",
    watched_at: watched,
    source: "plex_initial_sync",
    season,
    episode,
    poster_url: posterUrl(item, "episode"),
    ...providerIds(item),
  };
}

async function uploadChunk(records, chunkNumber, totalChunks) {
  const response = await fetch(IMPORT_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Api-Key": API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ records }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Chunk ${chunkNumber}/${totalChunks} failed: ${body.error || response.status}`);
  }

  console.log(`Uploaded chunk ${chunkNumber}/${totalChunks}: ${body.inserted || 0} inserted`);
}

async function main() {
  console.log("Fetching play history from Plex status sessions history endpoint...");
  const records = [];
  const pageSize = 500;
  let start = 0;
  let hasMore = true;
  let lastFirstItemKey = null;

  while (hasMore) {
    const url = `/status/sessions/history/all?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${pageSize}`;
    const body = await plexJson(url);
    const items = body.MediaContainer?.Metadata || [];
    if (!items.length) {
      hasMore = false;
      break;
    }

    const firstItemKey = items[0]?.historyKey || items[0]?.viewedAt;
    if (firstItemKey && firstItemKey === lastFirstItemKey) {
      console.log("Pagination ignored by Plex server (received duplicate data). Stopping query loop.");
      break;
    }
    lastFirstItemKey = firstItemKey;

    for (const item of items) {
      if (item.type === "movie") {
        const record = movieRecord(item);
        if (record) records.push(record);
      } else if (item.type === "episode") {
        const record = episodeRecord(item);
        if (record) records.push(record);
      }
    }

    console.log(`Retrieved ${records.length} total watch history events so far...`);
    start += pageSize;
  }

  console.log(`Found ${records.length} watched Plex records in history`);
  const totalChunks = Math.ceil(records.length / CHUNK_SIZE);

  for (let index = 0; index < records.length; index += CHUNK_SIZE) {
    const chunk = records.slice(index, index + CHUNK_SIZE);
    await uploadChunk(chunk, Math.floor(index / CHUNK_SIZE) + 1, totalChunks);
  }

  console.log("Plex history export complete");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
