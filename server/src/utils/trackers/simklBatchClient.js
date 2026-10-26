import {
  assertSimklTrigger,
  simklRequest,
  simklHistoryPayload,
  simklReviewRequired,
} from "./simklClient.js";

const MAX_BATCH = 100;
const invalid = () => simklReviewRequired("Simkl returned an incomplete or ambiguous batch outcome");
const observedTime = (value) => {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 1000 ? time : null;
};

function itemType(media) {
  const type = media?.type || media?.mediaType;
  if (type === "tv" || type === "series") return "show";
  return type;
}

function identity(media) {
  const rawType = media?.type || media?.mediaType;
  const type = itemType(media);
  const payload = simklHistoryPayload(media);
  const ids = type === "movie" ? payload.movies[0].ids : payload.shows[0].ids;
  const watchedAt = media.watched_at;
  const watchedTime = observedTime(watchedAt);
  if (!watchedTime) throw simklReviewRequired("Simkl needs an observed watch date");
  // Preserve episode vs whole-show so batch payload building and readback stay
  // aligned with what Simkl received for this intent.
  const batchType = type === "show" && !["tv", "show", "series"].includes(rawType) ? "episode" : type;
  return { type: batchType, ids, watchedAt, watchedTime, media };
}

function sameIdentity(left, right) {
  const shared = Object.keys(left.ids).filter((key) => right.ids[key] != null);
  const equal = shared.filter((key) => String(left.ids[key]) === String(right.ids[key]));
  if (equal.length && shared.some((key) => String(left.ids[key]) !== String(right.ids[key]))) {
    throw simklReviewRequired("Simkl media identifiers conflict and need review");
  }
  return equal.length > 0;
}

function buildPayload(items) {
  const movies = [], shows = [];
  const entries = [];
  for (const item of items) {
    if (item.type === "movie") {
      movies.push({ ids: item.ids, watched_at: item.watchedAt });
      entries.push({ item, category: "movies" });
      continue;
    }
    if (item.type === "show") {
      shows.push({ ids: item.ids, watched_at: item.watchedAt });
      entries.push({ item, category: "shows" });
      continue;
    }
    let show = shows.find((candidate) => Array.isArray(candidate.seasons) && sameIdentity({ ids: candidate.ids }, item));
    if (!show) {
      show = { ids: item.ids, seasons: [] };
      shows.push(show);
    }
    let season = show.seasons.find((candidate) => candidate.number === item.media.season);
    if (!season) {
      season = { number: item.media.season, episodes: [] };
      show.seasons.push(season);
    }
    season.episodes.push({ number: item.media.episode, watched_at: item.watchedAt });
    entries.push({ item, category: "episodes" });
  }
  return { body: { ...(movies.length ? { movies } : {}), ...(shows.length ? { shows } : {}) }, entries };
}

function validateDistinct(items) {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (!sameIdentity(items[i], items[j])) continue;
      if (items[i].type !== items[j].type) {
        // A whole-show entry and an episode of the same series must not share a
        // batch: Simkl would expand the show while the episode is also listed.
        if (items[i].type === "show" || items[j].type === "show") {
          throw simklReviewRequired("Simkl batch contains an ambiguous duplicate identity");
        }
        continue;
      }
      if (items[i].type === "movie" || items[i].type === "show"
        || (items[i].media.season === items[j].media.season && items[i].media.episode === items[j].media.episode)) {
        throw simklReviewRequired("Simkl batch contains an ambiguous duplicate identity");
      }
    }
  }
}

function notFoundList(value) {
  // Live large batches sometimes omit not_found or send numeric zeros for empty
  // buckets; only arrays of rows are unmatched items. Readback is authoritative.
  if (value == null || value === 0) return [];
  return Array.isArray(value) ? value : null;
}

function readNotFoundEntries(result, entries) {
  // Live 23 October full apply: a 100-episode POST returned added + a large
  // added.statuses echo and omitted not_found entirely. Treat a missing
  // not_found as empty; only an explicit unmatched row is a rejection.
  const fail = (reason) => {
    throw Object.assign(invalid(), { parseReason: reason });
  };
  if (!result || !result.added || typeof result.added !== "object") fail("missing_added");
  const notFoundBody = result.not_found == null ? {} : result.not_found;
  if (typeof notFoundBody !== "object" || Array.isArray(notFoundBody)) fail("bad_not_found_body");
  // Live Simkl history responses include added.statuses (per-request echo). Counts
  // and not_found remain authoritative; statuses is informational only.
  const addedKeys = Object.keys(result.added).filter((key) => !["movies", "episodes", "shows", "statuses"].includes(key));
  const notFoundKeys = Object.keys(notFoundBody).filter((key) => !["movies", "episodes", "shows"].includes(key));
  if (addedKeys.length) fail(`unknown_added_keys:${addedKeys.join(",")}`);
  if (notFoundKeys.length) fail(`unknown_not_found_keys:${notFoundKeys.join(",")}`);
  if (result.added.statuses != null && !Array.isArray(result.added.statuses)) fail("bad_statuses");
  if (result.added.shows != null && (!Number.isSafeInteger(result.added.shows) || result.added.shows < 0)) fail("bad_added_shows");
  const showNotFound = notFoundList(notFoundBody.shows);
  if (!showNotFound) fail("bad_not_found_shows");
  const notFound = [];
  // A whole-show rejection covers every sent episode of exactly that show
  // (an unknown show id, such as an episode-level IMDb id). It is not found
  // for those episodes only; an unmatched or shared rejection still holds.
  // Whole-show history entries use the same not_found.shows bucket.
  const showEpisodes = entries.filter((entry) => entry.category === "episodes");
  const showLevel = entries.filter((entry) => entry.category === "shows");
  for (const row of showNotFound) {
    const ids = row?.show?.ids || row?.ids;
    if (!ids || typeof ids !== "object") fail("show_not_found_ids");
    const candidates = [
      ...showEpisodes.filter(({ item }) => sameIdentity(item, identity({ ...item.media, ids }))),
      ...showLevel.filter(({ item }) => sameIdentity(item, identity({ ...item.media, ids }))),
    ];
    if (!candidates.length || candidates.some((entry) => notFound.includes(entry))) fail("show_not_found_unmatched");
    notFound.push(...candidates);
  }
  const showRejected = notFound.filter((entry) => entry.category === "episodes").length;
  const wholeShowRejected = notFound.filter((entry) => entry.category === "shows").length;
  const categories = entries.some((entry) => entry.category === "shows")
    ? ["movies", "episodes", "shows"]
    : ["movies", "episodes"];
  for (const category of categories) {
    // Whole-show rejections are already consumed from not_found.shows above;
    // episode rows may still appear under not_found.episodes. Skip the shows
    // count loop for episode-only batches: Simkl still reports added.shows for
    // nested episode payloads, and that count is not a whole-show target total.
    const list = category === "shows" ? [] : notFoundList(notFoundBody[category]);
    if (category !== "shows" && !list) fail(`bad_not_found_${category}`);
    const targets = entries.filter((entry) => entry.category === category);
    const matched = new Set();
    for (const row of list) {
      if (!row || typeof row !== "object") fail(`bad_${category}_row`);
      let ids, season, episode;
      if (category === "movies") ids = row.movie?.ids || row.ids;
      else {
        ids = row.show?.ids || row.episode?.show?.ids || row.ids || row.show_ids;
        season = row.season ?? row.episode?.season;
        episode = row.number ?? row.episode?.number ?? row.episode_number ?? (typeof row.episode === 'number' ? row.episode : undefined);
      }
      if (!ids || typeof ids !== "object") fail(`${category}_ids`);
      const candidates = targets.filter(({ item }) => {
        const candidate = identity({ ...item.media, ids });
        if (!sameIdentity(item, candidate)) return false;
        return category === "movies" || (season === item.media.season && episode === item.media.episode);
      });
      if (candidates.length !== 1 || matched.has(candidates[0]) || notFound.includes(candidates[0])) fail(`${category}_match`);
      matched.add(candidates[0]);
      notFound.push(candidates[0]);
    }
    const addedCount = result.added[category] ?? (targets.length === 0 ? 0 : undefined);
    const rejected = category === "episodes"
      ? list.length + showRejected
      : category === "shows"
        ? wholeShowRejected
        : list.length;
    // Existing watched items can legitimately add zero. Only readback proves
    // success; counts must never claim more items than were requested.
    if (!Number.isSafeInteger(addedCount) || addedCount < 0 || addedCount + rejected > targets.length) {
      fail(`counts_${category}:added=${addedCount},rejected=${rejected},targets=${targets.length}`);
    }
  }
  return notFound;
}

function mergeQuota(...metadata) {
  return Object.assign({}, ...metadata.filter((value) => value && typeof value === "object"));
}

async function requestWithMetadata(request, connection, path, options) {
  const minimumRemaining = path === '/sync/history' ? 58 : path === '/sync/activities' ? 57 : 56;
  const result = await request(connection, path, { ...options, withMetadata: true, minimumRemaining });
  // The production request helper returns this envelope when requested. The
  // fallback keeps injection ergonomic for focused offline tests.
  return result && Object.hasOwn(result, "data") && Object.hasOwn(result, "metadata")
    ? result
    : { data: result, metadata: {} };
}

// One lookup per distinct sent title, so episodes of a show share its row.
function watchedTitles(entries) {
  const titles = [];
  for (const { item } of entries) {
    const type = item.type === "movie" ? "movie" : "show";
    if (!titles.some((title) => title.type === type && sameIdentity(title, item))) titles.push({ type, ids: item.ids });
  }
  return titles;
}

// /sync/watched reports the title's current watch-through. A date_from delta
// can also list a separate past watch-through record (Simkl files an older
// episode of a show with newer progress there), which is not watched progress.
async function readback(connection, preSendCursor, titles, { request, trigger }) {
  const activities = await requestWithMetadata(request, connection, "/sync/activities", {});
  const cursor = activities.data?.all;
  if (!observedTime(cursor)) throw invalid();
  if (Date.parse(cursor) < Date.parse(preSendCursor)) throw simklReviewRequired("Simkl batch activity cursor moved backwards; review required");
  const watched = await requestWithMetadata(request, connection, "/sync/watched", {
    body: titles.map(({ type, ids }) => ({ type, ids })),
    query: { extended: "episodes" },
    arrayResponse: true,
  });
  const rows = watched.data;
  if (!Array.isArray(rows) || rows.length !== titles.length) throw invalid();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object") throw invalid();
    const echoed = row.ids && typeof row.ids === "object" ? row.ids : {};
    if (Object.keys(echoed).some((key) => titles[index].ids[key] != null && String(echoed[key]) !== String(titles[index].ids[key]))) throw invalid();
  });
  return {
    titles: titles.map((title, index) => ({ ...title, row: rows[index] })),
    activities: activities.data,
    cursor,
    quota: mergeQuota(activities.metadata, watched.metadata),
    trigger,
  };
}

function confirmedWatchedAt(row, item) {
  if (row.result !== true) return null;
  if (item.type === "movie") return row.list === "completed" ? observedTime(row.last_watched_at) : null;
  if (item.type === "show") {
    // Whole-show history expands to aired episodes; any progressed show confirms.
    const last = observedTime(row.last_watched_at);
    if (last) return last;
    for (const season of Array.isArray(row.seasons) ? row.seasons : []) {
      for (const episode of season?.episodes || []) {
        if (episode?.watched === true) {
          const time = observedTime(episode.last_watched_at);
          if (time) return time;
        }
      }
    }
    return null;
  }
  const seasons = Array.isArray(row.seasons) ? row.seasons.filter((season) => season?.number === item.media.season) : [];
  if (seasons.length !== 1 || !Array.isArray(seasons[0].episodes)) return null;
  const episodes = seasons[0].episodes.filter((episode) => episode?.number === item.media.episode);
  return episodes.length === 1 && episodes[0].watched === true ? observedTime(episodes[0].last_watched_at) : null;
}

/**
 * Send one bounded history batch and confirm it using exactly one activities
 * read plus one /sync/watched lookup. A thrown error after POST is uncertain;
 * callers must hold the durable chunk for review and must never resend it.
 */
export async function sendSimklWatchedBatch(connection, media, {
  trigger,
  preSendCursor,
  request = simklRequest,
} = {}) {
  assertSimklTrigger(trigger);
  if (!Array.isArray(media) || media.length < 1 || media.length > MAX_BATCH) {
    throw simklReviewRequired(`Simkl history batches must contain 1 to ${MAX_BATCH} items`);
  }
  if (!observedTime(preSendCursor)) throw simklReviewRequired("Simkl batch requires a known pre-send activity cursor");
  const items = media.map(identity);
  validateDistinct(items);
  const { body, entries } = buildPayload(items);
  const titles = watchedTitles(entries);
  let posted;
  try {
    posted = await requestWithMetadata(request, connection, "/sync/history", {
      body,
      query: { skip_auto_watching: "yes" },
    });
  } catch (error) {
    error.uncertainOutcome = true;
    error.noResend = true;
    try {
      const observed = await readback(connection, preSendCursor, titles, { request, trigger });
      error.readbackCursor = observed.cursor;
      error.quota = observed.quota;
    } catch (readbackError) {
      error.readbackErrorCode = readbackError?.code || "SIMKL_READBACK_FAILED";
    }
    throw error;
  }

  let observed;
  try {
    observed = await readback(connection, preSendCursor, titles, { request, trigger });
  } catch (error) {
    error.uncertainOutcome = true;
    error.noResend = true;
    throw error;
  }

  // After a successful POST, never abandon the chunk as wholly unreadable: the
  // watched readback is authoritative. A confusing not_found/counts shape is
  // logged and treated as "no explicit rejection", then each item is confirmed
  // or held from /sync/watched (live 23 October large-batch responses).
  let notFound = [];
  try {
    notFound = readNotFoundEntries(posted.data, entries);
  } catch (error) {
    const reason = error.parseReason || error.message || "unknown";
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = path.join("plan/active/external-tracker-connections/checks", `simkl-batch-unreadable-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({ reason, entries: entries.length, data: posted.data }, null, 1));
      console.warn(`[simkl-batch] unreadable /sync/history response for ${entries.length} item(s): ${reason} saved ${file}; confirming via watched readback`);
    } catch {
      console.warn(`[simkl-batch] unreadable /sync/history response for ${entries.length} item(s): ${reason}; confirming via watched readback: ${JSON.stringify(posted.data).slice(0, 12000)}`);
    }
  }
  const outcomes = entries.map(({ item, category }, index) => {
    const missing = notFound.includes(entries[index]);
    if (missing) return { media: item.media, status: "not_found", category };
    const title = observed.titles.find((candidate) => candidate.type === (category === "movies" ? "movie" : "show") && sameIdentity(candidate, item));
    const watchedAt = title ? confirmedWatchedAt(title.row, item) : null;
    if (watchedAt == null) return { media: item.media, status: "review", category };
    return { media: item.media, status: "confirmed", category, watchedAt };
  });
  return {
    outcomes,
    result: posted.data,
    cursor: observed.cursor,
    activities: observed.activities,
    quota: mergeQuota(posted.metadata, observed.quota),
    counts: {
      requested: entries.length,
      confirmed: outcomes.filter(row => row.status === 'confirmed').length,
      notFound: notFound.length,
    },
  };
}

export { MAX_BATCH as SIMKL_HISTORY_BATCH_LIMIT };
