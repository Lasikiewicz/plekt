import crypto from "node:crypto";

// Runs once under the schema migration's write lock. Missing target telemetry
// cannot authorize a destination, even when that destination exists today.
export function migrateLegacyTrackerIntents(database, now = Date.now()) {
  const connection = database.prepare("SELECT * FROM tracker_connections WHERE provider='trakt'").get();
  if (!connection) return;
  const rows = database.prepare("SELECT * FROM watch_history WHERE sync_action IN ('watched','unwatched','unplayed')").all();
  const insert = database.prepare(`INSERT OR IGNORE INTO tracker_write_intents
    (id,provider,connection_id,account_id,logical_key,watch_record_id,media_key,media_json,action,watched_at,event_type,fingerprint,status,due_at,expires_at,created_at,updated_at,last_error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of rows) {
    if (/trakt/i.test(row.source || "")) continue;
    const telemetry = String(row.sync_dispatch_telemetry || "");
    const line = telemetry.match(/^(?:Target\s+)?trakt status:\s*(.*)$/im)?.[1] || "";
    if (/^(success|skipped)\b/i.test(line)) continue;
    const pending = /^pending\b/i.test(line);
    const failed = /^(error|failed)\b/i.test(line);
    // A rate limit was refused outright; other transient failures may have landed.
    const rateLimited = failed && /\b429\b/.test(line);
    const uncertain = failed && !rateLimited && /5\d\d|timed out|request failed/i.test(line);
    const ambiguous = /Dispatch status: pending/i.test(telemetry) && !line;
    if (!pending && !rateLimited && !uncertain && !ambiguous) continue;
    const action = row.sync_action === "watched" ? "watched" : "unwatched";
    // Same logical key a later dispatch of this record derives, so the two never split.
    const watchedAt = new Date(row.watched_at || now).toISOString();
    const media = { title: row.title, type: row.media_type, source: row.source, watched_at: row.watched_at,
      ids: { imdb: row.imdb_id, tmdb: row.tmdb_id, tvdb: row.tvdb_id }, season: row.season, episode: row.episode };
    const eventType = "legacy";
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(["trakt", row.media_key, action, watchedAt, eventType])).digest("hex");
    insert.run(crypto.randomUUID(), "trakt", connection.id, connection.remote_user_id || "", `${row.id}:${action}:${watchedAt}`, row.id,
      row.media_key || row.id, JSON.stringify(media), action, watchedAt, eventType, fingerprint,
      ambiguous ? "review" : uncertain ? "uncertain" : rateLimited ? "retry" : "pending", now, now + 30 * 86400_000, now, now,
      ambiguous ? "Legacy pending work has no positively identified tracker destination; review required" : null);
  }
}
