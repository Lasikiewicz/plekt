#!/usr/bin/env node
// Synthetic library generator.
//
// Builds a disposable Plembfin library at a stated scale so the performance
// work can be measured against something bigger than one developer's real
// library. `seed-demo-content.js` seeds a fixed handful of titles for a demo
// screenshot; this is the test rig, parameterized by history rows, shows,
// movies, and TMDB cache blob size.
//
// It writes only to a directory it is explicitly pointed at, and refuses a
// directory holding a database it did not create. Every library it makes
// carries a `synthetic-library.json` marker recording the parameters and the
// counts, so a later run can tell its own output from someone's real data.
//
// Usage:
//   node scripts/generate-synthetic-library.js --data-dir <path> [options]
//
// Options (defaults in brackets):
//   --movies <n>             distinct movies [3000]
//   --shows <n>              distinct shows [400]
//   --episodes-per-show <n>  episodes per show [24]
//   --history-rows <n>       total watch_history rows [distinct items + 20%]
//   --tmdb-entries <n>       tmdb_metadata_cache rows [1500]
//   --tmdb-blob-kb <n>       size of each cached TMDB details blob [24]
//   --posters <n>            distinct poster images generated and shared [8]
//   --seed <n>               PRNG seed, so a scale is reproducible [1]
//
// The explorer pages at 240 items, so measuring paging needs more than 2,400
// movies; the default clears page 10 with room to spare.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER_NAME = "synthetic-library.json";
const MARKER_VERSION = 1;
const EXPLORER_PAGE_SIZE = 240;
const DAY_MS = 24 * 60 * 60 * 1000;

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function parseArgs(argv) {
  const args = { };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    i += 1;
  }
  return args;
}

function intOption(args, name, fallback) {
  const raw = args[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return Math.floor(value);
}

// Small deterministic PRNG so a named scale reproduces exactly. Math.random
// would make two runs at the same scale different libraries, and a benchmark
// compared against a differently-shaped library is not a comparison.
function makeRandom(seed) {
  let state = (Number(seed) || 1) >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

const ADJECTIVES = ["Quiet", "Northern", "Broken", "Glass", "Amber", "Hollow", "Distant", "Crimson", "Silent", "Iron", "Paper", "Winter", "Salt", "Copper", "Midnight", "Low", "Static", "Open", "False", "Last"];
const NOUNS = ["Harbour", "Engine", "Relay", "Signal", "Archive", "Beacon", "Orbit", "Circuit", "Meridian", "Cascade", "Foundry", "Lantern", "Compass", "Threshold", "Anchor", "Current", "Ledger", "Frontier", "Ember", "Drift"];
const SUFFIXES = ["", " Rising", " Protocol", " Country", " Theory", " in Motion", " Standard", " Winter", " Down", " Again"];

function titleFor(index, random) {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)];
  const suffix = SUFFIXES[Math.floor(random() * SUFFIXES.length)];
  // The numeric tail keeps titles distinct at scale; two identical titles would
  // collapse into one explorer card and quietly shrink the measured library.
  return `${adjective} ${noun}${suffix} ${index}`;
}

function normalizeKeyPart(value) {
  return String(value ?? "none").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

// Same shape as mediaKeyFor() in dataRepo.js, reproduced rather than imported so
// the generator does not pull the whole data layer (and its startup side
// effects) into a script whose only job is to write rows.
function mediaKey({ mediaType, tmdbId, season = null, episode = null }) {
  const coordinates = [normalizeKeyPart(mediaType), normalizeKeyPart(season), normalizeKeyPart(episode)].join(":");
  return `${coordinates}:tmdb:${normalizeKeyPart(tmdbId)}`;
}

// Terminal telemetry. A synthetic row must never look like outstanding work:
// "Historical import" is the phrase the pending-dispatch queries exclude on,
// so a server pointed at this library cannot re-dispatch thousands of fake
// watches to Plex, Emby, Jellyfin or Trakt.
const SYNTHETIC_TELEMETRY = [
  "Origin: synthetic_library",
  "Loop-check: Skipped propagation",
  "Dispatch status: skipped",
  "Details: Historical import; synthetic benchmark library, never propagated.",
  "Target plex status: skipped - Historical import; not re-propagated",
  "Target emby status: skipped - Historical import; not re-propagated",
  "Target jellyfin status: skipped - Historical import; not re-propagated",
].join("\n");

// Every row in a real library carries a `watch_provenance` blob, and
// `rowToWatch` JSON.parses it on every cache rebuild. A fixture that leaves the
// column NULL therefore measures a cheaper rebuild than any real install has,
// which is exactly the kind of unrepresentative baseline this generator exists
// to avoid. The shape and size here match a real historical-import row.
function syntheticProvenance(watchedAtIso) {
  return JSON.stringify({
    version: 1,
    source: "synthetic_library",
    ingest_path: "historical_import",
    event: "",
    phase: "",
    item_id: "",
    session_id: "",
    user: "",
    device: "",
    device_id: "",
    client: "",
    client_version: "",
    source_timestamp: "",
    captured_at: watchedAtIso,
    confidence: "exact",
    note: "",
  });
}

function assertDisposableDirectory(dataDir) {
  const resolved = path.resolve(dataDir);
  const repoData = path.resolve(repoRoot, "data");
  if (resolved === repoData) {
    throw new Error(`Refusing to write to the repository's own data directory (${repoData}). Point --data-dir at a disposable path.`);
  }
  if (resolved === repoRoot) {
    throw new Error("Refusing to write to the repository root. Point --data-dir at a disposable path.");
  }
  const legacyDbPath = path.join(resolved, "plembfin.db");
  const dbPath = fs.existsSync(legacyDbPath) ? legacyDbPath : path.join(resolved, "plekt.db");
  const markerPath = path.join(resolved, MARKER_NAME);
  if (fs.existsSync(dbPath) && !fs.existsSync(markerPath)) {
    throw new Error(
      `Refusing to overwrite ${dbPath}: it has no ${MARKER_NAME} marker, so this generator did not create it. `
      + "Choose an empty directory, or delete that database yourself if it really is disposable.",
    );
  }
  return { resolved, dbPath, markerPath, replacing: fs.existsSync(markerPath) };
}

function removeExistingLibrary(target) {
  for (const name of ["plekt.db", "plekt.db-wal", "plekt.db-shm", "plembfin.db", "plembfin.db-wal", "plembfin.db-shm", MARKER_NAME]) {
    fs.rmSync(path.join(target.resolved, name), { force: true });
  }
  fs.rmSync(path.join(target.resolved, "media"), { recursive: true, force: true });
}

async function generatePosterPool(count, postersDir) {
  if (count <= 0) return [];
  const { default: sharp } = await import("sharp");
  fs.mkdirSync(postersDir, { recursive: true });
  const pool = [];
  for (let index = 0; index < count; index += 1) {
    const hue = Math.round((index / count) * 360);
    const svg = `
      <svg width="680" height="1020" viewBox="0 0 680 1020" xmlns="http://www.w3.org/2000/svg">
        <rect width="680" height="1020" fill="hsl(${hue}, 34%, 22%)" />
        <circle cx="520" cy="220" r="150" fill="none" stroke="hsl(${hue}, 62%, 70%)" stroke-width="4" opacity="0.6" />
        <text x="60" y="880" fill="hsl(${hue}, 62%, 82%)" font-family="Arial, sans-serif" font-size="44" font-weight="700">SYNTHETIC ${index + 1}</text>
      </svg>`;
    const filename = `synthetic-${String(index + 1).padStart(3, "0")}.webp`;
    const absolutePath = path.join(postersDir, filename);
    await sharp(Buffer.from(svg)).webp({ quality: 80 }).toFile(absolutePath);
    pool.push({
      filename,
      storagePath: path.join("posters", filename).replaceAll("\\", "/"),
      url: `/media/posters/${filename}`,
      sizeBytes: fs.statSync(absolutePath).size,
    });
  }
  return pool;
}

// A TMDB details blob padded to a realistic size. Finding C is about how much
// JSON is parsed to read two fields, so the padding has to live inside the
// stored document rather than beside it.
function tmdbDetailsBlob(title, tmdbId, mediaType, targetBytes) {
  const base = {
    id: Number(tmdbId),
    title,
    name: title,
    overview: `${title} is a synthetic entry generated for performance measurement.`,
    media_type: mediaType,
    // `cachedTmdbShowDetails` consumers read `status` and `poster_path` out of
    // this blob, and the poster pipeline reads the backdrop fields. A blob
    // without them measures a cache read that never resolves anything.
    status: mediaType === "tv" ? "Returning Series" : "Released",
    poster_path: `/synthetic-${tmdbId}-poster.jpg`,
    backdrop_path: `/synthetic-${tmdbId}-backdrop.jpg`,
    first_air_date: "2019-04-02",
    release_date: "2019-04-02",
    vote_average: 7.1,
    runtime: 104,
    genres: [{ id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }],
    credits: { cast: [], crew: [] },
    images: { backdrops: [], posters: [] },
    _synthetic_padding: "",
  };
  const overhead = JSON.stringify(base).length;
  const padding = Math.max(0, targetBytes - overhead);
  base._synthetic_padding = "x".repeat(padding);
  return JSON.stringify(base);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDirArg = args["data-dir"];
  if (!dataDirArg || dataDirArg === true) {
    console.error("--data-dir <path> is required. It must be a disposable directory, never the live data/ folder.");
    process.exitCode = 1;
    return;
  }

  const target = assertDisposableDirectory(String(dataDirArg));
  const movieCount = intOption(args, "movies", 3000);
  const showCount = intOption(args, "shows", 400);
  const episodesPerShow = intOption(args, "episodes-per-show", 24);
  const episodeCount = showCount * episodesPerShow;
  const distinctItems = movieCount + episodeCount;
  const historyRows = Math.max(distinctItems, intOption(args, "history-rows", Math.round(distinctItems * 1.2)));
  const tmdbEntries = intOption(args, "tmdb-entries", 1500);
  const tmdbBlobBytes = intOption(args, "tmdb-blob-kb", 24) * 1024;
  const posterPoolSize = intOption(args, "posters", 8);
  const seed = intOption(args, "seed", 1);

  if (target.replacing) {
    console.log(`Replacing the synthetic library already in ${target.resolved}.`);
    removeExistingLibrary(target);
  }
  fs.mkdirSync(target.resolved, { recursive: true });

  // DATA_DIR is read when paths.js is first imported, so it has to be set
  // before the data layer loads.
  process.env.DATA_DIR = target.resolved;
  const { POSTERS_DIR } = await import("../server/src/paths.js");
  const { db, bumpDataVersion } = await import("../server/src/db.js");

  const random = makeRandom(seed);
  const startedAt = Date.now();
  const posters = await generatePosterPool(posterPoolSize, POSTERS_DIR);
  const posterFor = (index) => (posters.length ? posters[index % posters.length] : null);

  // Branches carry different optional `watch_history` columns, so the insert is
  // built from the table the database actually has rather than from a fixed
  // column list. A generator that only runs on the branch it was written on is
  // no use for comparing one branch against another.
  const historyColumns = new Set(db.prepare("PRAGMA table_info(watch_history)").all().map((row) => row.name));
  const optionalHistory = [
    { column: "episode_title_status", binding: "@episodeTitleStatus" },
  ].filter((entry) => historyColumns.has(entry.column));
  const optionalHistoryColumnSql = optionalHistory.map((entry) => `${entry.column}, `).join("");
  const optionalHistoryValueSql = optionalHistory.map((entry) => `${entry.binding}, `).join("");
  const insertHistory = db.prepare(`
    INSERT INTO watch_history (
      id, title, title_lower, media_type, watched_at, source, tmdb_id, season, episode,
      poster_url, sync_action, sync_dispatch_telemetry, sync_retry_count, sync_next_retry_at,
      media_key, show_title, show_title_lower, episode_title, watch_provenance, ${optionalHistoryColumnSql}
      created_at, updated_at
    ) VALUES (
      @id, @title, @titleLower, @mediaType, @watchedAt, 'synthetic', @tmdbId, @season, @episode,
      @posterUrl, 'watched', @telemetry, 0, 0,
      @mediaKey, @showTitle, @showTitleLower, @episodeTitle, @watchProvenance, ${optionalHistoryValueSql}
      @createdAt, @updatedAt
    )
  `);
  const insertPlaystate = db.prepare(`
    INSERT OR REPLACE INTO playstate (
      media_key, title, title_lower, media_type, state, watched_at, last_source,
      sources, tmdb_id, season, episode, poster_url, updated_at
    ) VALUES (
      @mediaKey, @title, @titleLower, @mediaType, 'watched', @watchedAt, 'synthetic',
      @sources, @tmdbId, @season, @episode, @posterUrl, @updatedAt
    )
  `);
  const insertPoster = db.prepare(`
    INSERT OR REPLACE INTO poster_cache (
      id, media_key, variant, status, source, detail, storage_path, content_type,
      size_bytes, url, updated_at_ms
    ) VALUES (
      @id, @mediaKey, 'poster', 'cached', 'synthetic', 'Synthetic benchmark artwork',
      @storagePath, 'image/webp', @sizeBytes, @url, @updatedAt
    )
  `);
  // The gateway mirrors `status` and `poster_path` into their own columns on
  // every write, so a fixture that leaves them NULL measures the upgrade
  // fallback path rather than the one a running install actually takes.
  const insertTmdb = db.prepare(`
    INSERT OR REPLACE INTO tmdb_metadata_cache (id, tmdb_id, media_type, title, details, status, poster_path,
      backdrop_path, schema_version, updated_at_ms)
    VALUES (@id, @tmdbId, @mediaType, @title, @details, @status, @posterPath, @backdropPath, 1, @updatedAt)
  `);

  // Build the item list first so watch rows can be spread across it. Watch
  // dates run backwards from now at a steady spacing: a burst of identical
  // timestamps is exactly what the phantom-watch repair deletes, and a library
  // that deletes part of itself on the next boot is not a fixture.
  const items = [];
  for (let index = 0; index < movieCount; index += 1) {
    const title = titleFor(index + 1, random);
    const tmdbId = String(900000 + index);
    items.push({
      kind: "movie",
      title,
      tmdbId,
      season: null,
      episode: null,
      showTitle: null,
      episodeTitle: null,
      mediaType: "movie",
      mediaKey: mediaKey({ mediaType: "movie", tmdbId }),
      poster: posterFor(index),
    });
  }
  for (let showIndex = 0; showIndex < showCount; showIndex += 1) {
    const showTitle = titleFor(showIndex + 1, random);
    const tmdbId = String(800000 + showIndex);
    for (let episodeIndex = 0; episodeIndex < episodesPerShow; episodeIndex += 1) {
      const season = Math.floor(episodeIndex / 12) + 1;
      const episode = (episodeIndex % 12) + 1;
      const episodeTitle = `Episode ${episode}`;
      items.push({
        kind: "episode",
        title: `${showTitle} - S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
        tmdbId,
        season,
        episode,
        showTitle,
        episodeTitle,
        mediaType: "episode",
        mediaKey: mediaKey({ mediaType: "episode", tmdbId, season, episode }),
        poster: posterFor(showIndex),
      });
    }
  }

  // Spacing between consecutive watch rows. Two years of history at the
  // requested row count, floored at a minute so a large library cannot produce
  // a burst.
  const spanMs = 2 * 365 * DAY_MS;
  const spacingMs = Math.max(60_000, Math.floor(spanMs / Math.max(1, historyRows)));
  const now = Date.now();

  const writeLibrary = db.transaction(() => {
    for (let row = 0; row < historyRows; row += 1) {
      const item = items[row % items.length];
      const watchedAtMs = now - (row * spacingMs);
      const watchedAt = new Date(watchedAtMs).toISOString();
      const titleLower = item.title.toLowerCase();
      insertHistory.run({
        id: `synthetic:${row}`,
        title: item.title,
        titleLower,
        mediaType: item.mediaType,
        watchedAt,
        tmdbId: item.tmdbId,
        season: item.season,
        episode: item.episode,
        posterUrl: item.poster?.url || null,
        telemetry: SYNTHETIC_TELEMETRY,
        mediaKey: item.mediaKey,
        showTitle: item.showTitle,
        showTitleLower: item.showTitle ? item.showTitle.toLowerCase() : null,
        episodeTitle: item.episodeTitle,
        episodeTitleStatus: item.episodeTitle ? "resolved" : "missing",
        watchProvenance: syntheticProvenance(watchedAt),
        createdAt: watchedAtMs,
        updatedAt: watchedAtMs,
      });
      // The first pass over the item list is the canonical state; later rows
      // are rewatches and must not rewrite it to an older date.
      if (row < items.length) {
        insertPlaystate.run({
          mediaKey: item.mediaKey,
          title: item.title,
          titleLower,
          mediaType: item.mediaType,
          watchedAt,
          sources: JSON.stringify({ synthetic: { state: "watched", watchedAt } }),
          tmdbId: item.tmdbId,
          season: item.season,
          episode: item.episode,
          posterUrl: item.poster?.url || null,
          updatedAt: watchedAtMs,
        });
        if (item.poster) {
          insertPoster.run({
            id: `synthetic:${item.mediaKey}`,
            mediaKey: item.mediaKey,
            storagePath: item.poster.storagePath,
            sizeBytes: item.poster.sizeBytes,
            url: item.poster.url,
            updatedAt: now,
          });
        }
      }
    }
  });
  writeLibrary();

  const writeTmdbCache = db.transaction(() => {
    for (let index = 0; index < tmdbEntries; index += 1) {
      // Spread across the whole item list rather than taking the first N.
      // `items` is ordered movies-first, so `index % items.length` wrote only
      // movie rows and the TV Shows path never found a cached entry at all.
      const item = items[Math.floor((index * items.length) / Math.max(tmdbEntries, 1)) % items.length];
      const mediaType = item.kind === "movie" ? "movie" : "tv";
      insertTmdb.run({
        // Must match the gateway's own key shape (`tv_123` / `movie_123`).
        // A different separator here means every lookup misses, and the
        // fixture silently measures a cache that is never read.
        id: `${mediaType}_${item.tmdbId}`,
        tmdbId: item.tmdbId,
        mediaType,
        title: item.showTitle || item.title,
        details: tmdbDetailsBlob(item.showTitle || item.title, item.tmdbId, mediaType, tmdbBlobBytes),
        status: mediaType === "tv" ? "Returning Series" : "Released",
        posterPath: `/synthetic-${item.tmdbId}-poster.jpg`,
        backdropPath: `/synthetic-${item.tmdbId}-backdrop.jpg`,
        updatedAt: now,
      });
    }
  });
  writeTmdbCache();

  bumpDataVersion("synthetic-library-generator");

  const counts = {
    watchHistoryRows: db.prepare("SELECT COUNT(*) AS n FROM watch_history").get().n,
    playstateRows: db.prepare("SELECT COUNT(*) AS n FROM playstate").get().n,
    distinctMovies: db.prepare("SELECT COUNT(DISTINCT media_key) AS n FROM watch_history WHERE media_type = 'movie'").get().n,
    distinctEpisodes: db.prepare("SELECT COUNT(DISTINCT media_key) AS n FROM watch_history WHERE media_type = 'episode'").get().n,
    distinctShows: db.prepare("SELECT COUNT(DISTINCT show_title_lower) AS n FROM watch_history WHERE show_title_lower IS NOT NULL").get().n,
    tmdbCacheRows: db.prepare("SELECT COUNT(*) AS n FROM tmdb_metadata_cache").get().n,
    posterCacheRows: db.prepare("SELECT COUNT(*) AS n FROM poster_cache").get().n,
  };
  db.close();

  const databaseBytes = fs.statSync(target.dbPath).size;
  const marker = {
    marker: "plembfin-synthetic-library",
    version: MARKER_VERSION,
    generatedAt: new Date().toISOString(),
    generatorDurationMs: Date.now() - startedAt,
    parameters: {
      movies: movieCount,
      shows: showCount,
      episodesPerShow,
      historyRows,
      tmdbEntries,
      tmdbBlobKb: tmdbBlobBytes / 1024,
      posters: posterPoolSize,
      seed,
    },
    counts,
    databaseBytes,
    explorerPages: {
      pageSize: EXPLORER_PAGE_SIZE,
      moviePages: Math.ceil(counts.distinctMovies / EXPLORER_PAGE_SIZE),
      reachesPageTen: counts.distinctMovies >= EXPLORER_PAGE_SIZE * 10,
    },
  };
  fs.writeFileSync(target.markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  console.log(JSON.stringify(marker, null, 2));
  console.log(`\nSynthetic library written to ${target.resolved}`);
  console.log(`Start a server against it with DATA_DIR="${target.resolved}".`);
  if (!marker.explorerPages.reachesPageTen) {
    console.warn(`Warning: ${counts.distinctMovies} movies do not reach explorer page 10 (needs ${EXPLORER_PAGE_SIZE * 10}). Finding H cannot be measured on this library.`);
  }
}

main().catch((error) => {
  console.error("Failed to generate the synthetic library:", error.message);
  process.exitCode = 1;
});
