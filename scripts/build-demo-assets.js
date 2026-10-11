#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { loadLocalEnv } from "../server/src/env.js";

loadLocalEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(ROOT, "public", "demo-assets");
const POSTERS_DIR = path.join(OUTPUT_DIR, "posters");
const BACKDROPS_DIR = path.join(OUTPUT_DIR, "backdrops");
const SEASONS_DIR = path.join(OUTPUT_DIR, "seasons");
const EPISODE_STILLS_DIR = path.join(OUTPUT_DIR, "episode-stills");
const DETAIL_IMAGES_DIR = path.join(OUTPUT_DIR, "images");
const PROFILES_DIR = path.join(OUTPUT_DIR, "profiles");
const REVIEW_AVATARS_DIR = path.join(OUTPUT_DIR, "review-avatars");
const VIDEO_THUMBS_DIR = path.join(OUTPUT_DIR, "video-thumbnails");
const RELATED_POSTERS_DIR = path.join(OUTPUT_DIR, "related-posters");
const CATALOG_PATH = path.join(OUTPUT_DIR, "catalog.json");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");
const LOGO_PATH = path.join(OUTPUT_DIR, "tmdb-logo.svg");

const TMDB_API_ROOT = "https://api.themoviedb.org/3";
const TMDB_IMAGE_ROOT = "https://image.tmdb.org/t/p";
const TMDB_LOGO_URL = "https://www.themoviedb.org/assets/2/v4/logos/v2/blue_square_2-d537fb228cf3ded904ef09b136fe3fec72548ebc1fea3fbbd1ad9e36364db38b.svg";
const TMDB_FAQ_URL = "https://developer.themoviedb.org/docs/faq";
const TMDB_ATTRIBUTION_URL = "https://www.themoviedb.org";
const TMDB_ATTRIBUTION_NOTICE = "This product uses the TMDB API but is not endorsed or certified by TMDB.";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_PAGES = 10;
const REQUEST_SPACING_MS = 180;

const DISCOVERY = {
  movie: {
    endpoint: "discover/movie",
    label: "Top-rated established movies",
    voteCountMinimum: 10_000,
    dateMaximum: "2024-12-31",
    titleKey: "title",
    dateKey: "release_date",
  },
  tv: {
    endpoint: "discover/tv",
    label: "Top-rated established TV shows",
    voteCountMinimum: 2_000,
    dateMaximum: "2024-12-31",
    titleKey: "name",
    dateKey: "first_air_date",
  },
};

function parseArgs(argv) {
  const options = { limit: 50, media: "all" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      options.limit = Number(argv[++index]);
    } else if (arg === "--media") {
      options.media = String(argv[++index] || "all").toLowerCase();
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) {
    throw new Error("--limit must be a whole number between 1 and 50");
  }
  if (!["all", "movie", "tv"].includes(options.media)) {
    throw new Error("--media must be all, movie, or tv");
  }
  return options;
}

function printHelp() {
  console.log(`Build a bundled, non-commercial TMDB fixture for the Plekt demo.

Usage:
  npm run demo:assets
  npm run demo:assets -- --limit 5 --media movie

Authentication is read from TMDB_API_KEY, TMDB_ACCESS_TOKEN, or the TMDB key
already saved in Plekt's local settings. Neither value is written to the
generated catalog, manifest, or image files.
`);
}

let savedConfigDb = null;
let tmdbCredentialPromise = null;
let nextRequestAt = 0;
let requestTail = Promise.resolve();
const detailAssetPromises = new Map();
let selectedCatalogIds = new Set();

async function loadTmdbCredential() {
  if (tmdbCredentialPromise) return tmdbCredentialPromise;
  tmdbCredentialPromise = (async () => {
    const envKey = String(process.env.TMDB_API_KEY || "").trim();
    const envToken = String(process.env.TMDB_ACCESS_TOKEN || "").trim();
    if (envKey || envToken) return { apiKey: envKey, accessToken: envToken, source: "environment" };

    // The app normally stores a user-provided TMDB key in its local settings
    // row rather than .env. Reuse it for this one-shot build, but never expose
    // it in output or generated source files.
    try {
      const { loadMediaConfig } = await import("../server/src/utils/configStore.js");
      const { db } = await import("../server/src/db.js");
      savedConfigDb = db;
      const config = await loadMediaConfig({ resolveConnections: false });
      const savedKey = String(config?.tmdb?.apiKey || "").trim();
      if (savedKey) return { apiKey: savedKey, accessToken: "", source: "saved-config" };
    } catch {
      // Fall through to the same actionable error used for an empty env.
    }

    throw new Error(
      "TMDB_API_KEY or TMDB_ACCESS_TOKEN is required. Set one locally, or save a TMDB API key in Plekt Settings, then rerun npm run demo:assets. The credential is never written to the bundle.",
    );
  })();
  return tmdbCredentialPromise;
}

function tmdbHeaders(credential) {
  const token = String(credential?.accessToken || "").trim();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function apiUrl(endpoint, params = {}, apiKey = "") {
  const url = new URL(`${TMDB_API_ROOT}/${String(endpoint).replace(/^\/+/, "")}`);
  if (apiKey) url.searchParams.set("api_key", apiKey);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
  }
  return url;
}

async function readResponse(response, label) {
  if (response.ok) return response;
  let detail = "";
  try {
    const payload = await response.json();
    detail = payload?.status_message ? `: ${payload.status_message}` : "";
  } catch {
    // Keep authentication and upstream response bodies out of command output.
  }
  throw new Error(`TMDB ${label} failed with HTTP ${response.status}${detail}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleRequest() {
  const previous = requestTail;
  let release;
  requestTail = new Promise((resolve) => { release = resolve; });
  await previous;
  const delay = Math.max(0, nextRequestAt - Date.now());
  if (delay) await wait(delay);
  nextRequestAt = Date.now() + REQUEST_SPACING_MS;
  release();
}

async function fetchJson(endpoint, params = {}, attempt = 0) {
  await throttleRequest();
  const credential = await loadTmdbCredential();
  const response = await fetch(apiUrl(endpoint, params, credential.apiKey), {
    headers: tmdbHeaders(credential),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 429 && attempt < 3) {
    const retryAfter = Math.max(1, Number(response.headers.get("retry-after") || 1));
    await wait(retryAfter * 1000 + 250);
    return fetchJson(endpoint, params, attempt + 1);
  }
  await readResponse(response, endpoint);
  return response.json();
}

async function fetchBinary(url, label) {
  const response = await fetch(url, {
    headers: { Accept: "image/avif,image/webp,image/jpeg,image/png,image/svg+xml,*/*" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  await readResponse(response, label);
  return Buffer.from(await response.arrayBuffer());
}

function imageUrl(size, imagePath) {
  const normalized = String(imagePath || "").trim();
  if (!normalized.startsWith("/")) throw new Error("TMDB returned an invalid image path");
  return `${TMDB_IMAGE_ROOT}/${size}${normalized}`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function relativeAssetPath(directory, filename) {
  return `/demo-assets/${directory}/${filename}`;
}

function normalizeItem(item, mediaType, resultIndex, selectionRank) {
  const policy = DISCOVERY[mediaType];
  const title = String(item[policy.titleKey] || "").trim();
  const date = String(item[policy.dateKey] || "").trim();
  return {
    mediaType,
    tmdbId: String(item.id),
    title,
    overview: String(item.overview || "").trim(),
    releaseDate: date,
    voteAverage: Number(item.vote_average || 0),
    voteCount: Number(item.vote_count || 0),
    popularity: Number(item.popularity || 0),
    selectionRank,
    tmdbResultIndex: resultIndex,
    posterPath: String(item.poster_path),
    backdropPath: String(item.backdrop_path),
  };
}

async function discover(mediaType, limit) {
  const policy = DISCOVERY[mediaType];
  const results = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_DISCOVERY_PAGES && results.length < limit; page += 1) {
    const payload = await fetchJson(policy.endpoint, {
      language: "en-GB",
      include_adult: false,
      include_video: false,
      sort_by: "vote_average.desc",
      "vote_count.gte": policy.voteCountMinimum,
      [`${policy.dateKey}.lte`]: policy.dateMaximum,
      page,
    });
    const pageResults = Array.isArray(payload?.results) ? payload.results : [];
    pageResults.forEach((item, pageIndex) => {
      const id = String(item?.id || "").trim();
      if (!id || seen.has(id) || !item?.poster_path || !item?.backdrop_path) return;
      const title = String(item[policy.titleKey] || "").trim();
      if (!title) return;
      seen.add(id);
      results.push(normalizeItem(item, mediaType, ((page - 1) * 20) + pageIndex + 1, results.length + 1));
    });
    if (page >= Number(payload?.total_pages || page) || pageResults.length === 0) break;
  }

  if (results.length < limit) {
    throw new Error(`TMDB returned only ${results.length} image-complete ${mediaType} entries; ${limit} are required`);
  }
  return results.slice(0, limit);
}

async function optimize(buffer, variant) {
  const pipeline = sharp(buffer).rotate();
  if (variant === "poster") {
    return pipeline.resize({ width: 342, withoutEnlargement: true }).webp({ quality: 84, effort: 5 }).toBuffer();
  }
  if (variant === "profile") {
    return pipeline.resize({ width: 185, height: 278, fit: "cover", position: "centre", withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 }).toBuffer();
  }
  if (variant === "episode") {
    return pipeline.resize({ width: 480, height: 270, fit: "cover", position: "centre", withoutEnlargement: true })
      .webp({ quality: 80, effort: 5 }).toBuffer();
  }
  if (variant === "logo") {
    return pipeline.resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 88, effort: 5 }).toBuffer();
  }
  return pipeline.resize({ width: 1280, height: 720, fit: "cover", position: "centre", withoutEnlargement: true })
    .webp({ quality: 82, effort: 5 })
    .toBuffer();
}

function assetToken(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 12);
}

function detailAssetFilename(sourcePath, variant) {
  const raw = String(sourcePath || "");
  const basename = path.basename(raw, path.extname(raw))
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "image";
  return `${variant}-${assetToken(raw)}-${basename}.webp`;
}

async function writeDetailAsset(sourcePath, { directory, outputDirectory, variant, size, label }) {
  const normalized = String(sourcePath || "").trim();
  if (!normalized.startsWith("/")) return null;
  const cacheKey = `${directory}:${normalized}`;
  if (detailAssetPromises.has(cacheKey)) return detailAssetPromises.get(cacheKey);

  const task = (async () => {
    const filename = detailAssetFilename(normalized, variant);
    const absolutePath = path.join(outputDirectory, filename);
    const sourceUrl = imageUrl(size, normalized);
    if (fs.existsSync(absolutePath)) {
      const existing = fs.readFileSync(absolutePath);
      return {
        path: relativeAssetPath(directory, filename),
        sourceUrl,
        sourcePath: normalized,
        bytes: existing.byteLength,
        sha256: sha256(existing),
      };
    }
    const original = await fetchBinary(sourceUrl, label || normalized);
    const optimized = await optimize(original, variant);
    fs.writeFileSync(absolutePath, optimized);
    return {
      path: relativeAssetPath(directory, filename),
      sourceUrl,
      sourcePath: normalized,
      bytes: optimized.byteLength,
      sha256: sha256(optimized),
    };
  })().catch((error) => {
    console.warn(`Could not bundle ${label || normalized}: ${error.message}`);
    return null;
  });
  detailAssetPromises.set(cacheKey, task);
  return task;
}

async function writeVideoThumbnail(video) {
  const key = String(video?.key || "").trim();
  if (!key || String(video?.site || "").toLowerCase() !== "youtube") return null;
  const cacheKey = `video:${key}`;
  if (detailAssetPromises.has(cacheKey)) return detailAssetPromises.get(cacheKey);
  const task = (async () => {
    const filename = `youtube-${assetToken(key)}.webp`;
    const absolutePath = path.join(VIDEO_THUMBS_DIR, filename);
    const sourceUrl = `https://img.youtube.com/vi/${encodeURIComponent(key)}/mqdefault.jpg`;
    if (fs.existsSync(absolutePath)) {
      const existing = fs.readFileSync(absolutePath);
      return {
        path: relativeAssetPath("video-thumbnails", filename),
        sourceUrl,
        bytes: existing.byteLength,
        sha256: sha256(existing),
      };
    }
    const original = await fetchBinary(sourceUrl, `YouTube thumbnail ${key}`);
    const optimized = await optimize(original, "backdrop");
    fs.writeFileSync(absolutePath, optimized);
    return {
      path: relativeAssetPath("video-thumbnails", filename),
      sourceUrl,
      bytes: optimized.byteLength,
      sha256: sha256(optimized),
    };
  })().catch((error) => {
    console.warn(`Could not bundle YouTube thumbnail ${key}: ${error.message}`);
    return null;
  });
  detailAssetPromises.set(cacheKey, task);
  return task;
}

async function writeProfileImage(person) {
  const profilePath = String(person?.profile_path || "").trim();
  if (!profilePath || !person?.id) return null;
  return writeDetailAsset(profilePath, {
    directory: "profiles",
    outputDirectory: PROFILES_DIR,
    variant: "profile",
    size: "w185",
    label: `profile image ${person.id}`,
  });
}

async function writeImage(item, variant) {
  const isPoster = variant === "poster";
  const directory = isPoster ? "posters" : "backdrops";
  const outputDirectory = isPoster ? POSTERS_DIR : BACKDROPS_DIR;
  const sourcePath = isPoster ? item.posterPath : item.backdropPath;
  const sourceSize = isPoster ? "w500" : "w1280";
  const filename = `${item.mediaType}-${item.tmdbId}.webp`;
  const sourceUrl = imageUrl(sourceSize, sourcePath);
  const original = await fetchBinary(sourceUrl, `${item.mediaType} ${item.tmdbId} ${variant}`);
  const optimized = await optimize(original, variant);
  const absolutePath = path.join(outputDirectory, filename);
  fs.writeFileSync(absolutePath, optimized);
  return {
    path: relativeAssetPath(directory, filename),
    sourceUrl,
    bytes: optimized.byteLength,
    sha256: sha256(optimized),
  };
}

async function writeSeasonImage(item, season) {
  const seasonNumber = Number(season?.season_number);
  const sourcePath = String(season?.poster_path || "").trim();
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0 || !sourcePath.startsWith("/")) return null;
  const filename = `tv-${item.tmdbId}-season-${seasonNumber}.webp`;
  const sourceUrl = imageUrl("w500", sourcePath);
  const original = await fetchBinary(sourceUrl, `tv ${item.tmdbId} season ${seasonNumber} poster`);
  const optimized = await optimize(original, "poster");
  const absolutePath = path.join(SEASONS_DIR, filename);
  fs.writeFileSync(absolutePath, optimized);
  return {
    path: relativeAssetPath("seasons", filename),
    sourceUrl,
    bytes: optimized.byteLength,
    sha256: sha256(optimized),
  };
}

async function writeEpisodeStill(item, episode) {
  const sourcePath = String(episode?.still_path || "").trim();
  const seasonNumber = Number(episode?.season_number || 0);
  const episodeNumber = Number(episode?.episode_number || 0);
  if (!sourcePath.startsWith("/") || !Number.isInteger(seasonNumber) || !Number.isInteger(episodeNumber)) return null;
  return writeDetailAsset(sourcePath, {
    directory: "episode-stills",
    outputDirectory: EPISODE_STILLS_DIR,
    variant: "episode",
    size: "w780",
    label: `tv ${item.tmdbId} S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")} still`,
  });
}

async function writeLogo() {
  const logo = await fetchBinary(TMDB_LOGO_URL, "TMDB approved logo");
  fs.writeFileSync(LOGO_PATH, logo);
  return {
    path: "/demo-assets/tmdb-logo.svg",
    sourceUrl: TMDB_LOGO_URL,
    bytes: logo.byteLength,
    sha256: sha256(logo),
  };
}

function pruneGeneratedImages(directory, expectedFilenames, mediaTypes) {
  const selectedPrefixes = mediaTypes.map((mediaType) => `${mediaType}-`);
  let removed = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".webp")) continue;
    if (!selectedPrefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
    if (expectedFilenames.has(entry.name)) continue;
    // These two directories are owned by this generator; only unreferenced
    // generated WebP files are eligible for cleanup.
    fs.rmSync(path.join(directory, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

function pruneGeneratedSeasonImages(expectedFilenames, tvIds) {
  let removed = 0;
  for (const entry of fs.readdirSync(SEASONS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".webp")) continue;
    if (!tvIds.some((id) => entry.name.startsWith(`tv-${id}-season-`))) continue;
    if (expectedFilenames.has(entry.name)) continue;
    fs.rmSync(path.join(SEASONS_DIR, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function catalogItem(item, poster, backdrop, enrichment = null) {
  return {
    mediaType: item.mediaType,
    tmdbId: item.tmdbId,
    title: item.title,
    overview: item.overview,
    releaseDate: item.releaseDate,
    voteAverage: item.voteAverage,
    voteCount: item.voteCount,
    popularity: item.popularity,
    selectionRank: item.selectionRank,
    tmdbResultIndex: item.tmdbResultIndex,
    poster: {
      path: poster.path,
      sourceUrl: poster.sourceUrl,
      bytes: poster.bytes,
      sha256: poster.sha256,
    },
    backdrop: {
      path: backdrop.path,
      sourceUrl: backdrop.sourceUrl,
      bytes: backdrop.bytes,
      sha256: backdrop.sha256,
    },
    ...(enrichment?.metadata ? { metadata: enrichment.metadata } : {}),
    ...(enrichment?.seasonDetails ? { seasonDetails: enrichment.seasonDetails } : {}),
    sourceUrl: `https://www.themoviedb.org/${item.mediaType === "movie" ? "movie" : "tv"}/${item.tmdbId}`,
  };
}

function compactResource(resource, limit) {
  return {
    ...(resource && typeof resource === "object" ? resource : {}),
    results: Array.isArray(resource?.results) ? resource.results.slice(0, limit) : [],
  };
}

function compactCast(credits) {
  return (Array.isArray(credits?.cast) ? credits.cast : []).slice(0, 24).map((person, index) => ({
    id: person.id,
    name: String(person.name || "").trim(),
    character: String(person.character || "").trim(),
    profile_path: String(person.profile_path || "").trim() || null,
    order: Number.isFinite(Number(person.order)) ? Number(person.order) : index,
  })).filter((person) => person.id && person.name);
}

function selectedPosterPath(mediaType, id) {
  const key = `${mediaType}:${String(id || "").trim()}`;
  if (!selectedCatalogIds.has(key)) return "";
  return relativeAssetPath("posters", `${mediaType}-${String(id).trim()}.webp`);
}

async function localizeImageGroups(images = {}, item) {
  const groups = [
    // Keep every image the current detail and artwork-picker surfaces can
    // display. Anything retained in the fixture has a local file path.
    ["backdrops", 20, "backdrop", "w780"],
    ["posters", 20, "poster", "w500"],
    ["logos", 10, "logo", "w500"],
  ];
  const localized = {};
  for (const [group, limit, variant, size] of groups) {
    const sourceImages = Array.isArray(images?.[group]) ? images[group].slice(0, limit) : [];
    const records = await mapWithConcurrency(sourceImages, 4, async (image) => {
      const asset = await writeDetailAsset(image?.file_path, {
        directory: "images",
        outputDirectory: DETAIL_IMAGES_DIR,
        variant,
        size,
        label: `${item.mediaType} ${item.tmdbId} ${group} image`,
      });
      if (!asset) return null;
      return {
        ...image,
        file_path: asset.path,
        demo_source_path: String(image.file_path || "").trim(),
      };
    });
    localized[group] = records.filter(Boolean);
  }
  return localized;
}

async function localizeCast(cast) {
  return mapWithConcurrency(cast, 4, async (person) => {
    const asset = await writeProfileImage(person);
    return {
      ...person,
      profile_path: asset?.path || null,
      ...(asset ? { demo_source_path: asset.sourcePath } : {}),
    };
  });
}

async function localizeVideos(videos) {
  const sourceVideos = Array.isArray(videos?.results) ? videos.results
    .filter((video) => String(video?.site || "").toLowerCase() === "youtube")
    .filter((video) => ["Trailer", "Teaser", "Clip"].includes(String(video?.type || "")))
    .slice(0, 8) : [];
  const localized = await mapWithConcurrency(sourceVideos, 4, async (video) => {
    const asset = await writeVideoThumbnail(video);
    if (!asset) return null;
    return { ...video, thumbnail_path: asset.path };
  });
  return { results: localized.filter(Boolean) };
}

async function localizeReviews(reviews, item) {
  const sourceReviews = Array.isArray(reviews?.results) ? reviews.results.slice(0, 10) : [];
  const localized = await mapWithConcurrency(sourceReviews, 4, async (review) => {
    const authorDetails = review?.author_details && typeof review.author_details === "object"
      ? { ...review.author_details }
      : null;
    if (authorDetails) {
      const asset = await writeDetailAsset(authorDetails.avatar_path, {
        directory: "review-avatars",
        outputDirectory: REVIEW_AVATARS_DIR,
        variant: "avatar",
        size: "w185",
        label: `${item.mediaType} ${item.tmdbId} review avatar`,
      });
      authorDetails.avatar_path = asset?.path || null;
      if (asset) authorDetails.demo_source_path = asset.sourcePath;
    }
    return {
      ...review,
      ...(authorDetails ? { author_details: authorDetails } : {}),
    };
  });
  return { ...(reviews && typeof reviews === "object" ? reviews : {}), results: localized };
}

async function localizeEpisodes(episodes, item) {
  return mapWithConcurrency(episodes, 8, async (episode) => {
    const asset = await writeEpisodeStill(item, episode);
    return {
      ...episode,
      still_path: asset?.path || null,
      ...(asset ? { demo_source_path: String(episode.still_path || "").trim() } : {}),
    };
  });
}

async function localizeRelatedEntries(entries, mediaType, limit = 15) {
  const sourceEntries = Array.isArray(entries) ? entries.slice(0, limit) : [];
  const localized = await mapWithConcurrency(sourceEntries, 4, async (entry) => {
    const selectedPoster = selectedPosterPath(mediaType, entry?.id);
    const asset = selectedPoster
      ? null
      : await writeDetailAsset(entry?.poster_path, {
        directory: "related-posters",
        outputDirectory: RELATED_POSTERS_DIR,
        variant: "poster",
        size: "w500",
        label: `${mediaType} related poster ${entry?.id || "unknown"}`,
      });
    const posterPath = selectedPoster || asset?.path || "";
    if (!posterPath) return null;
    return {
      ...entry,
      poster_path: posterPath,
      backdrop_path: null,
    };
  });
  return localized.filter(Boolean);
}

async function localizeRelatedResource(resource, mediaType, limit = 15) {
  return {
    ...(resource && typeof resource === "object" ? resource : {}),
    results: await localizeRelatedEntries(resource?.results, mediaType, limit),
  };
}

function compactWatchProviders(resource) {
  const results = resource?.results && typeof resource.results === "object" ? resource.results : {};
  const kept = {};
  for (const region of ["GB", "US"]) {
    if (!results[region]) continue;
    kept[region] = {
      ...results[region],
      ...Object.fromEntries(["flatrate", "rent", "buy", "ads", "free", "other"].map((kind) => [
        kind,
        Array.isArray(results[region][kind])
          ? results[region][kind].map((provider) => ({ ...provider, logo_path: null }))
          : results[region][kind],
      ])),
    };
  }
  return { results: kept };
}

async function localizeEnrichment(item, raw, mediaType) {
  const castSource = mediaType === "tv" && raw?.aggregate_credits?.cast?.length
    ? raw.aggregate_credits
    : raw?.credits;
  const [cast, images, videos, reviews] = await Promise.all([
    localizeCast(compactCast(castSource)),
    localizeImageGroups(raw?.images, item),
    localizeVideos(raw?.videos),
    localizeReviews(raw?.reviews, item),
  ]);
  const compactCollection = raw?.belongs_to_collection && raw.belongs_to_collection.id
    ? {
      ...raw.belongs_to_collection,
      poster_path: selectedPosterPath("movie", raw.belongs_to_collection.id) || null,
      backdrop_path: null,
      parts: await localizeRelatedEntries(raw.belongs_to_collection.parts, "movie", 20),
    }
    : null;
  const [similar, recommendations] = await Promise.all([
    localizeRelatedResource(raw?.similar, mediaType),
    localizeRelatedResource(raw?.recommendations, mediaType),
  ]);
  return {
    cast,
    images,
    videos,
    similar,
    recommendations,
    reviews,
    watchProviders: compactWatchProviders(raw?.["watch/providers"]),
    belongsToCollection: compactCollection,
  };
}

function compactEpisode(episode) {
  if (!episode || typeof episode !== "object") return null;
  return {
    id: episode.id,
    name: String(episode.name || "").trim(),
    overview: String(episode.overview || "").trim(),
    air_date: String(episode.air_date || "").trim(),
    air_time: String(episode.air_time || "").trim(),
    episode_number: Number(episode.episode_number || 0),
    season_number: Number(episode.season_number || 0),
    runtime: episode.runtime == null ? null : Number(episode.runtime),
    still_path: String(episode.still_path || "").trim() || null,
  };
}

function compactShowMetadata(item, raw, seasons, seasonAssetsByNumber, posterAsset, backdropAsset, extras = {}) {
  const externalIds = raw?.external_ids || {};
  const seasonMetadata = seasons.map((season) => {
    const seasonNumber = Number(season.season_number);
    const poster = seasonAssetsByNumber.get(seasonNumber) || null;
    return {
      id: season.id,
      name: String(season.name || `Season ${seasonNumber}`).trim(),
      overview: String(season.overview || "").trim(),
      air_date: String(season.air_date || "").trim(),
      season_number: seasonNumber,
      episode_count: Number(season.episode_count || 0),
      vote_average: Number(season.vote_average || 0),
      // The demo never needs the original TMDB path: the bundled poster is
      // the canonical value so every client fallback remains offline-safe.
      poster_path: poster?.path || null,
      poster,
      poster_url: poster?.path || "",
    };
  });
  const genres = (Array.isArray(raw?.genres) ? raw.genres : []).map((genre) => ({
    id: genre.id,
    name: String(genre.name || "").trim(),
  })).filter((genre) => genre.id && genre.name);
  const networks = (Array.isArray(raw?.networks) ? raw.networks : []).map((network) => ({
    id: network.id,
    name: String(network.name || "").trim(),
    logo_path: null,
    origin_country: String(network.origin_country || "").trim(),
  })).filter((network) => network.id && network.name);
  const createdBy = (Array.isArray(raw?.created_by) ? raw.created_by : []).map((person) => ({
    id: person.id,
    name: String(person.name || "").trim(),
    credit_id: String(person.credit_id || "").trim(),
  })).filter((person) => person.id && person.name);
  const keywords = (Array.isArray(raw?.keywords?.results) ? raw.keywords.results : []).map((keyword) => ({
    id: keyword.id,
    name: String(keyword.name || "").trim(),
  })).filter((keyword) => keyword.id && keyword.name);
  return {
    id: String(raw?.id || item.tmdbId),
    name: String(raw?.name || item.title).trim(),
    overview: String(raw?.overview || item.overview || "").trim(),
    tagline: String(raw?.tagline || "").trim(),
    first_air_date: String(raw?.first_air_date || item.releaseDate || "").trim(),
    last_air_date: String(raw?.last_air_date || "").trim(),
    status: String(raw?.status || "").trim(),
    type: String(raw?.type || "").trim(),
    in_production: Boolean(raw?.in_production),
    vote_average: Number(raw?.vote_average || item.voteAverage || 0),
    vote_count: Number(raw?.vote_count || item.voteCount || 0),
    popularity: Number(raw?.popularity || item.popularity || 0),
    original_language: String(raw?.original_language || "").trim(),
    origin_country: Array.isArray(raw?.origin_country) ? raw.origin_country.slice(0, 8) : [],
    episode_run_time: Array.isArray(raw?.episode_run_time) ? raw.episode_run_time.map(Number).filter(Number.isFinite).slice(0, 8) : [],
    number_of_seasons: Number(raw?.number_of_seasons || seasonMetadata.length || 0),
    number_of_episodes: Number(raw?.number_of_episodes || seasonMetadata.reduce((sum, season) => sum + season.episode_count, 0)),
    genres,
    networks,
    created_by: createdBy,
    external_ids: {
      tmdb_id: String(raw?.id || item.tmdbId),
      imdb_id: String(externalIds.imdb_id || "").trim(),
      tvdb_id: String(externalIds.tvdb_id || "").trim(),
    },
    poster_path: posterAsset?.path || null,
    backdrop_path: backdropAsset?.path || null,
    cached_poster_url: posterAsset?.path || "",
    cached_backdrop_url: backdropAsset?.path || "",
    seasons: seasonMetadata,
    next_episode_to_air: extras.nextEpisode !== undefined ? extras.nextEpisode : compactEpisode(raw?.next_episode_to_air),
    last_episode_to_air: extras.lastEpisode !== undefined ? extras.lastEpisode : compactEpisode(raw?.last_episode_to_air),
    credits: { cast: extras.cast || compactCast(raw?.credits), crew: [] },
    images: extras.images || { backdrops: [], posters: [], logos: [] },
    videos: extras.videos || { results: [] },
    reviews: extras.reviews || compactResource(raw?.reviews, 10),
    similar: extras.similar || { results: [] },
    recommendations: extras.recommendations || { results: [] },
    "watch/providers": extras.watchProviders || { results: {} },
    content_ratings: { results: Array.isArray(raw?.content_ratings?.results) ? raw.content_ratings.results.slice(0, 12) : [] },
    keywords: { keywords: [], results: keywords },
    ...(extras.belongsToCollection ? { belongs_to_collection: extras.belongsToCollection } : {}),
    demo_fixture: true,
  };
}

async function enrichShow(item, posterAsset, backdropAsset) {
  const raw = await fetchJson(`tv/${item.tmdbId}`, {
    language: "en-GB",
    include_image_language: "en,null",
    append_to_response: "credits,videos,reviews,similar,recommendations,watch/providers,external_ids,content_ratings,keywords,images,aggregate_credits",
  });
  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons.filter((season) => Number.isInteger(Number(season?.season_number)) && Number(season.season_number) >= 0)
    : [];
  const seasonAssets = await mapWithConcurrency(seasons, 4, async (season) => [
    Number(season.season_number),
    await writeSeasonImage(item, season).catch(() => null),
  ]);
  const seasonAssetsByNumber = new Map(seasonAssets);
  const seasonDetails = await mapWithConcurrency(seasons, 4, async (season) => {
    const seasonNumber = Number(season.season_number);
    const details = await fetchJson(`tv/${item.tmdbId}/season/${seasonNumber}`, { language: "en-GB" }).catch(() => null);
    const episodes = Array.isArray(details?.episodes) ? details.episodes.map(compactEpisode).filter(Boolean) : [];
    const localizedEpisodes = await localizeEpisodes(episodes, item);
    return [String(seasonNumber), {
      id: details?.id || season.id || `demo-season-${item.tmdbId}-${seasonNumber}`,
      name: details?.name || season.name || `Season ${seasonNumber}`,
      overview: String(details?.overview || season.overview || "").trim(),
      season_number: seasonNumber,
      air_date: String(details?.air_date || season.air_date || "").trim(),
      poster_path: seasonAssetsByNumber.get(seasonNumber)?.path || null,
      poster_url: seasonAssetsByNumber.get(seasonNumber)?.path || "",
      episodes: localizedEpisodes,
    }];
  });
  const localizedHints = await localizeEpisodes(
    [raw?.next_episode_to_air, raw?.last_episode_to_air].map(compactEpisode).filter(Boolean),
    item,
  );
  const extras = await localizeEnrichment(item, raw, "tv");
  return {
    metadata: compactShowMetadata(item, raw, seasons, seasonAssetsByNumber, posterAsset, backdropAsset, {
      ...extras,
      nextEpisode: localizedHints.find((episode) => episode.id === raw?.next_episode_to_air?.id) || null,
      lastEpisode: localizedHints.find((episode) => episode.id === raw?.last_episode_to_air?.id) || null,
    }),
    seasonDetails: Object.fromEntries(seasonDetails),
  };
}

function compactMovieMetadata(item, raw, extras = {}, posterAsset = null, backdropAsset = null) {
  const externalIds = raw?.external_ids || {};
  const productionCompanies = (Array.isArray(raw?.production_companies) ? raw.production_companies : []).map((company) => ({
    id: company.id,
    name: String(company.name || "").trim(),
    logo_path: null,
    origin_country: String(company.origin_country || "").trim(),
  })).filter((company) => company.id && company.name);
  const genres = (Array.isArray(raw?.genres) ? raw.genres : []).map((genre) => ({
    id: genre.id,
    name: String(genre.name || "").trim(),
  })).filter((genre) => genre.id && genre.name);
  const keywords = (Array.isArray(raw?.keywords?.keywords) ? raw.keywords.keywords : []).map((keyword) => ({
    id: keyword.id,
    name: String(keyword.name || "").trim(),
  })).filter((keyword) => keyword.id && keyword.name);
  return {
    id: String(raw?.id || item.tmdbId),
    title: String(raw?.title || item.title).trim(),
    original_title: String(raw?.original_title || "").trim(),
    overview: String(raw?.overview || item.overview || "").trim(),
    tagline: String(raw?.tagline || "").trim(),
    release_date: String(raw?.release_date || item.releaseDate || "").trim(),
    runtime: raw?.runtime == null ? null : Number(raw.runtime),
    status: String(raw?.status || "").trim(),
    adult: Boolean(raw?.adult),
    video: Boolean(raw?.video),
    homepage: String(raw?.homepage || "").trim(),
    vote_average: Number(raw?.vote_average || item.voteAverage || 0),
    vote_count: Number(raw?.vote_count || item.voteCount || 0),
    popularity: Number(raw?.popularity || item.popularity || 0),
    original_language: String(raw?.original_language || "").trim(),
    origin_country: Array.isArray(raw?.origin_country) ? raw.origin_country.slice(0, 8) : [],
    genres,
    production_companies: productionCompanies,
    production_countries: Array.isArray(raw?.production_countries) ? raw.production_countries.slice(0, 12) : [],
    spoken_languages: Array.isArray(raw?.spoken_languages) ? raw.spoken_languages.slice(0, 12) : [],
    external_ids: {
      tmdb_id: String(raw?.id || item.tmdbId),
      imdb_id: String(externalIds.imdb_id || raw?.imdb_id || "").trim(),
      tvdb_id: "",
    },
    imdb_id: String(externalIds.imdb_id || raw?.imdb_id || "").trim(),
    poster_path: posterAsset?.path || null,
    backdrop_path: backdropAsset?.path || null,
    cached_poster_url: posterAsset?.path || "",
    cached_backdrop_url: backdropAsset?.path || "",
    credits: { cast: extras.cast || compactCast(raw?.credits), crew: [] },
    images: extras.images || { backdrops: [], posters: [], logos: [] },
    videos: extras.videos || { results: [] },
    reviews: extras.reviews || compactResource(raw?.reviews, 10),
    similar: extras.similar || { results: [] },
    recommendations: extras.recommendations || { results: [] },
    "watch/providers": extras.watchProviders || { results: {} },
    content_ratings: { results: Array.isArray(raw?.release_dates?.results) ? raw.release_dates.results.slice(0, 12) : [] },
    keywords: { keywords, results: keywords },
    ...(extras.belongsToCollection ? { belongs_to_collection: extras.belongsToCollection } : {}),
    demo_fixture: true,
  };
}

async function enrichMovie(item, posterAsset, backdropAsset) {
  const raw = await fetchJson(`movie/${item.tmdbId}`, {
    language: "en-GB",
    include_image_language: "en,null",
    append_to_response: "credits,videos,reviews,similar,recommendations,watch/providers,external_ids,release_dates,keywords,images",
  });
  if (raw?.belongs_to_collection?.id) {
    raw.belongs_to_collection = {
      ...raw.belongs_to_collection,
      parts: (await fetchJson(`collection/${raw.belongs_to_collection.id}`, { language: "en-GB" }).catch(() => null))?.parts || [],
    };
  }
  const extras = await localizeEnrichment(item, raw, "movie");
  return {
    metadata: compactMovieMetadata(item, raw, extras, posterAsset, backdropAsset),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // Validate before creating output directories so a missing credential leaves
  // the working tree untouched.
  await loadTmdbCredential();
  fs.mkdirSync(POSTERS_DIR, { recursive: true });
  fs.mkdirSync(BACKDROPS_DIR, { recursive: true });
  fs.mkdirSync(SEASONS_DIR, { recursive: true });
  fs.mkdirSync(EPISODE_STILLS_DIR, { recursive: true });
  fs.mkdirSync(DETAIL_IMAGES_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.mkdirSync(REVIEW_AVATARS_DIR, { recursive: true });
  fs.mkdirSync(VIDEO_THUMBS_DIR, { recursive: true });
  fs.mkdirSync(RELATED_POSTERS_DIR, { recursive: true });

  const mediaTypes = options.media === "all" ? ["movie", "tv"] : [options.media];
  const discovered = Object.fromEntries(await Promise.all(
    mediaTypes.map(async (mediaType) => [mediaType, await discover(mediaType, options.limit)]),
  ));
  const allItems = mediaTypes.flatMap((mediaType) => discovered[mediaType]);
  selectedCatalogIds = new Set(allItems.map((item) => `${item.mediaType}:${item.tmdbId}`));
  const expectedFilenames = new Set(allItems.map((item) => `${item.mediaType}-${item.tmdbId}.webp`));
  const removed = pruneGeneratedImages(POSTERS_DIR, expectedFilenames, mediaTypes)
    + pruneGeneratedImages(BACKDROPS_DIR, expectedFilenames, mediaTypes);
  if (removed) console.log(`Removed ${removed} unreferenced generated image${removed === 1 ? "" : "s"}.`);

  console.log(`Preparing ${allItems.length} TMDB titles (${mediaTypes.join(" + ")})…`);
  const assets = await mapWithConcurrency(allItems, 4, async (item) => {
    const [poster, backdrop] = await Promise.all([
      writeImage(item, "poster"),
      writeImage(item, "backdrop"),
    ]);
    try {
      const enrichment = item.mediaType === "tv"
        ? await enrichShow(item, poster, backdrop)
        : await enrichMovie(item, poster, backdrop);
      return catalogItem(item, poster, backdrop, enrichment);
    } catch (error) {
      console.warn(`${item.mediaType.toUpperCase()} metadata enrichment failed for ${item.title}; keeping artwork-only entry (${error.message}).`);
      return catalogItem(item, poster, backdrop);
    }
  });
  const expectedSeasonFilenames = new Set(assets.flatMap((item) => Object.values(item.seasonDetails || {})
    .map((season) => String(season.poster_url || "").split("/").pop())
    .filter(Boolean)));
  const removedSeasons = pruneGeneratedSeasonImages(expectedSeasonFilenames, mediaTypes.includes("tv") ? allItems.filter((item) => item.mediaType === "tv").map((item) => item.tmdbId) : []);
  if (removedSeasons) console.log(`Removed ${removedSeasons} unreferenced generated season poster${removedSeasons === 1 ? "" : "s"}.`);
  const logo = await writeLogo();
  const generatedAt = new Date().toISOString();
  const selection = Object.fromEntries(mediaTypes.map((mediaType) => [mediaType, {
    endpoint: DISCOVERY[mediaType].endpoint,
    label: DISCOVERY[mediaType].label,
    sort: "vote_average.desc",
    voteCountMinimum: DISCOVERY[mediaType].voteCountMinimum,
    dateMaximum: DISCOVERY[mediaType].dateMaximum,
    language: "en-GB",
    limit: options.limit,
  }]));
  const manifest = {
    schemaVersion: 2,
    generatedAt,
    usage: "non-commercial demo only",
    source: {
      provider: "TMDB",
      website: TMDB_ATTRIBUTION_URL,
      faq: TMDB_FAQ_URL,
      logo: logo.path,
      logoSourceUrl: logo.sourceUrl,
      attributionNotice: TMDB_ATTRIBUTION_NOTICE,
    },
    selection,
    assets: {
      logo,
      titles: assets.map((item) => ({
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        poster: item.poster,
        backdrop: item.backdrop,
        seasons: (item.metadata?.seasons || []).filter((season) => season.poster).map((season) => ({
          seasonNumber: season.season_number,
          poster: season.poster,
        })),
      })),
    },
  };
  const catalog = {
    schemaVersion: 2,
    generatedAt,
    source: manifest.source,
    selection,
    items: assets,
  };
  fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${assets.length} catalog items to ${path.relative(ROOT, CATALOG_PATH)}.`);
  console.log(`Wrote source manifest to ${path.relative(ROOT, MANIFEST_PATH)}.`);
}

main().catch((error) => {
  console.error(`Failed to build demo assets: ${error.message}`);
  process.exitCode = 1;
}).finally(() => {
  try { savedConfigDb?.close(); } catch { /* ignore one-shot cleanup errors */ }
});
