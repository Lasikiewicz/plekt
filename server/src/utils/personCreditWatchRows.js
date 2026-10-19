const CREDIT_QUERY_BATCH_SIZE = 300;

// Match a large cast list to watched rows without exceeding SQLite builds
// that cap a prepared statement at 999 bound variables. A query binds each
// credit id once and each title twice (for title_lower and show_title_lower).
export function getPersonCreditWatchRows(database, { creditTmdbIds = [], creditTitles = [] } = {}) {
  const ids = [...new Set(creditTmdbIds.map((value) => String(value || "").trim()).filter(Boolean))];
  const titles = [...new Set(creditTitles.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  const rowsById = new Map();
  const batchCount = Math.ceil(Math.max(ids.length, titles.length) / CREDIT_QUERY_BATCH_SIZE);

  for (let batch = 0; batch < batchCount; batch += 1) {
    const offset = batch * CREDIT_QUERY_BATCH_SIZE;
    const idBatch = ids.slice(offset, offset + CREDIT_QUERY_BATCH_SIZE);
    const titleBatch = titles.slice(offset, offset + CREDIT_QUERY_BATCH_SIZE);
    const conditions = [];
    const params = [];

    if (idBatch.length) {
      conditions.push(`(tmdb_id IS NOT NULL AND tmdb_id IN (${idBatch.map(() => "?").join(",")}))`);
      params.push(...idBatch);
    }
    if (titleBatch.length) {
      const titlePlaceholders = titleBatch.map(() => "?").join(",");
      conditions.push(`title_lower IN (${titlePlaceholders})`);
      conditions.push(`show_title_lower IN (${titlePlaceholders})`);
      params.push(...titleBatch, ...titleBatch);
    }

    const query = `
      SELECT id, tmdb_id, title, media_type, season, episode, show_title, title_lower, show_title_lower, source
      FROM watch_history
      WHERE ${conditions.join(" OR ")}
    `;
    for (const row of database.prepare(query).all(params)) {
      rowsById.set(String(row.id), row);
    }
  }

  return [...rowsById.values()];
}
