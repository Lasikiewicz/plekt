// The rating tables' provider CHECK enumerations become free text validated by
// the tracker registry (plan/active/external-tracker-connections/plan.md,
// "Provider columns use permissive text"), so a new tracker needs no rebuild.
// A CHECK cannot be altered in place: each table is copied into a new one,
// row counts are compared, and its index is recreated.
const RATING_TABLE_REBUILDS = [
  {
    table: "personal_rating_sources",
    columns: `
      provider TEXT NOT NULL,
      media_key TEXT NOT NULL,
      media_json TEXT NOT NULL,
      provider_item_id TEXT,
      provider_ids_json TEXT,
      remote_rating INTEGER CHECK (remote_rating BETWEEN 1 AND 10 OR remote_rating IS NULL),
      remote_state TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_state IN ('rated', 'unrated', 'unknown')),
      remote_rated_at INTEGER,
      last_seen_at INTEGER,
      last_snapshot_generation INTEGER,
      last_complete_snapshot_at INTEGER,
      last_inbound_at INTEGER,
      last_outbound_rating INTEGER,
      last_outbound_state TEXT CHECK (last_outbound_state IN ('rated', 'unrated')),
      last_outbound_intent_id TEXT,
      last_outbound_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sync_status IN ('unknown', 'synced', 'pending', 'conflict', 'not_found', 'reauth_required', 'failed', 'held')),
      last_error TEXT,
      PRIMARY KEY (provider, media_key)`,
    indexes: ["CREATE INDEX IF NOT EXISTS idx_personal_rating_sources_snapshot ON personal_rating_sources(provider, last_snapshot_generation, remote_state)"],
  },
  {
    table: "personal_rating_sync_queue",
    columns: `
      provider TEXT NOT NULL,
      media_key TEXT NOT NULL,
      media_json TEXT NOT NULL,
      desired_state TEXT NOT NULL CHECK (desired_state IN ('rated', 'unrated')),
      desired_rating INTEGER CHECK (desired_rating BETWEEN 1 AND 10 OR desired_rating IS NULL),
      source TEXT NOT NULL CHECK (source IN ('manual', 'import', 'reconcile', 'push')),
      intent_id TEXT NOT NULL,
      canonical_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'not_found', 'reauth_required', 'failed', 'held')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      succeeded_at INTEGER,
      PRIMARY KEY (provider, media_key)`,
    indexes: ["CREATE INDEX IF NOT EXISTS idx_personal_rating_sync_queue_due ON personal_rating_sync_queue(status, next_attempt_at, updated_at)"],
  },
  {
    table: "personal_rating_sync_runs",
    columns: `
      provider TEXT PRIMARY KEY,
      run_id TEXT,
      generation INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'baseline' CHECK (mode IN ('baseline', 'import')),
      status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'succeeded', 'partial', 'failed')),
      baseline_complete INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER,
      completed_at INTEGER,
      scanned_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      cleared_count INTEGER NOT NULL DEFAULT 0,
      queued_count INTEGER NOT NULL DEFAULT 0,
      cursor_json TEXT,
      last_error TEXT,
      updated_at INTEGER NOT NULL`,
    indexes: [],
  },
];

function rebuildRatingTables(database, needsRebuild) {
  for (const { table, columns, indexes } of RATING_TABLE_REBUILDS) {
    const sql = String(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql || "");
    if (!sql || !needsRebuild(table, sql)) continue;
    const rebuilt = `${table}__provider_rebuild`;
    database.exec(`DROP TABLE IF EXISTS ${rebuilt}; CREATE TABLE ${rebuilt} (${columns});`);
    const target = new Set(database.pragma(`table_info(${rebuilt})`).map((column) => column.name));
    const copied = database.pragma(`table_info(${table})`).map((column) => column.name).filter((name) => target.has(name)).join(", ");
    database.exec(`INSERT INTO ${rebuilt} (${copied}) SELECT ${copied} FROM ${table}`);
    const before = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    const after = database.prepare(`SELECT COUNT(*) AS count FROM ${rebuilt}`).get().count;
    if (before !== after) throw new Error(`${table} rebuild copied ${after} of ${before} rows`);
    database.exec(`DROP TABLE ${table}; ALTER TABLE ${rebuilt} RENAME TO ${table};`);
    for (const statement of indexes) database.exec(statement);
  }
}

export function rebuildRatingTablesWithoutProviderCheck(database) {
  rebuildRatingTables(database, (_table, sql) => /provider\s+TEXT[^,]*CHECK\s*\(\s*provider\s+IN/i.test(sql));
}

// A held outbound rating (Simkl: a write could create watched history) is a
// terminal queue and source status, so both status CHECKs gain 'held'.
export function addHeldRatingStatus(database) {
  rebuildRatingTables(database, (table, sql) => table !== "personal_rating_sync_runs" && !sql.includes("'held'"));
}
