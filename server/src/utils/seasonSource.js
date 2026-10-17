import { db } from "../db.js";

// Season and episode structure for a TV show comes from TVDB (default) or TMDB.
// The global value is the default for shows first read after it was set. Each
// show's first read saves the source it used, so a later global change never
// re-numbers that show. See plan/archive/metadata-provider-preference/plan.md.
export const SEASON_SOURCES = Object.freeze(["tvdb", "tmdb"]);
export const DEFAULT_SEASON_SOURCE = "tvdb";

const selectMediaConfigStmt = db.prepare("SELECT data FROM settings WHERE id = 'mediaConfig'");
const selectRecordStmt = db.prepare("SELECT season_source FROM show_season_source WHERE show_key = ?");
const insertRecordStmt = db.prepare(
  "INSERT OR IGNORE INTO show_season_source (show_key, season_source, recorded_at) VALUES (?, ?, ?)",
);

export function normalizeSeasonSource(value) {
  const clean = String(value || "").trim().toLowerCase();
  return SEASON_SOURCES.includes(clean) ? clean : DEFAULT_SEASON_SOURCE;
}

// Precedence: per-show override, then the source already saved for the show,
// then the global default. Invalid or empty inputs are skipped.
export function resolveSeasonSource({ showOverride = "", recordedSource = "", globalSource = DEFAULT_SEASON_SOURCE } = {}) {
  const override = String(showOverride || "").trim().toLowerCase();
  if (SEASON_SOURCES.includes(override)) return override;
  const recorded = String(recordedSource || "").trim().toLowerCase();
  if (SEASON_SOURCES.includes(recorded)) return recorded;
  return normalizeSeasonSource(globalSource);
}

export function readGlobalSeasonSource() {
  let stored = {};
  try {
    stored = JSON.parse(selectMediaConfigStmt.get()?.data || "{}") || {};
  } catch {
    stored = {};
  }
  return normalizeSeasonSource(stored.metadata?.seasonSource);
}

// Read-only: the source a show uses right now, without saving it. Cache-only
// readers (Up Next, dashboard) call this so a render never writes a record.
export function readSeasonSource(showKey, { showOverride = "" } = {}) {
  const key = String(showKey || "");
  const recorded = key ? selectRecordStmt.get(key)?.season_source || "" : "";
  return resolveSeasonSource({ showOverride, recordedSource: recorded, globalSource: readGlobalSeasonSource() });
}

// Write-once: the first read of a show saves the source it resolved to.
// INSERT OR IGNORE keeps an existing record, so a later global change does not
// move this show.
export function resolveAndRecordSeasonSource(showKey, { showOverride = "" } = {}) {
  const key = String(showKey || "");
  const source = readSeasonSource(key, { showOverride });
  if (key) insertRecordStmt.run(key, source, Date.now());
  return source;
}

// Fix Match per-show choice. Unlike the write-once record, this replaces the
// show's source. rowNumbering is the numbering its stored watch rows already
// use (rows are never renumbered); the show page translates when they differ.
const upsertOverrideStmt = db.prepare(`
  INSERT INTO show_season_source (show_key, season_source, recorded_at, row_numbering, overridden_at)
  VALUES (@key, @source, @now, @rowNumbering, @now)
  ON CONFLICT(show_key) DO UPDATE SET season_source = excluded.season_source,
    row_numbering = excluded.row_numbering, overridden_at = excluded.overridden_at
`);
const selectFullRecordStmt = db.prepare(
  "SELECT season_source, row_numbering, overridden_at FROM show_season_source WHERE show_key = ?",
);

export function setShowSeasonSource(showKey, source, { rowNumbering = DEFAULT_SEASON_SOURCE, now = Date.now() } = {}) {
  const key = String(showKey || "");
  if (!key) throw new Error("A show key is required");
  const clean = normalizeSeasonSource(source);
  upsertOverrideStmt.run({ key, source: clean, now, rowNumbering: normalizeSeasonSource(rowNumbering) });
  return clean;
}

// The show's display source and the numbering its stored rows use. A show
// with no Fix Match choice has rows numbered the same as its display source.
export function readShowNumbering(showKey) {
  const key = String(showKey || "");
  const record = key ? selectFullRecordStmt.get(key) : null;
  const source = readSeasonSource(key);
  const rowNumbering = record?.row_numbering ? normalizeSeasonSource(record.row_numbering) : source;
  return { source, rowNumbering, translate: source !== rowNumbering, overriddenAt: record?.overridden_at || null };
}

// Called when the global value changes. Every show in showKeys that has no
// record yet is pinned to TVDB, so it keeps its current structure. Shows that
// already have a record are not touched.
export function pinUnrecordedSeasonSources(showKeys = [], now = Date.now()) {
  const keys = [...new Set(showKeys.map((key) => String(key || "")).filter(Boolean))];
  db.transaction(() => {
    for (const key of keys) insertRecordStmt.run(key, DEFAULT_SEASON_SOURCE, now);
  })();
  return keys.length;
}
