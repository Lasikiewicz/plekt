export function titleKey(value = "") {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\s*\(\d{4}\)\s*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseNetflixDate(value = "") {
  const match = String(value).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return "";
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = match[3].length === 2 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T12:00:00.000Z`;
}

// Netflix often writes "Season 12: The Stockholm Syndrome" or "Limited Series: Leap"
// after the show name. Strip those labels so episode titles can match TMDB names, and
// keep the season/episode numbers as matching hints when present.
export function parseNetflixEpisodePart(raw = "", { showTitle = "" } = {}) {
  // The full export sometimes drops the "Season" word and leaves its double space:
  // "Queen Charlotte: A Bridgerton Story:  1: Crown Jewels", ":  7: Episode 8".
  let rest = String(raw || "").replace(/(^\s{2,}|:\s{2,})(\d{1,3}):(?=\s)/, (_, lead, number) => `${lead.trim() ? ": " : ""}Season ${number}:`).trim();
  let seasonHint = null;
  let episodeHint = null;

  // Netflix sometimes repeats the series name with its season number as a label.
  const repeated = rest.match(/^([^:]+?)\s+(\d+)\s*:\s*(.+)$/);
  if (showTitle && repeated && titleKey(repeated[1]) === titleKey(showTitle)) {
    seasonHint = Number(repeated[2]);
    rest = repeated[3].trim();
  }

  const limited = rest.match(/(?:^|:\s*)Limited Series\s*:\s*(.+)$/i);
  if (limited) {
    rest = limited[1].trim();
    // Netflix uses this label for miniseries; TMDB still stores them as season 1.
    seasonHint = 1;
  }

  // Non-English accounts export the localized word ("Staffel 2:", "Temporada 1:"), and
  // German may add a release batch after a dash ("Staffel 2 – Teil B:").
  const season = rest.match(/(?:^|:\s*)(?:Season|Series|Vol\.?|Volume|Staffel|Saison|Temporada|Stagione|Seizoen|Säsong|Sæson|Sesong|Sezon|Kausi)\s+(\d+)(?:\s*[–-]\s*[^:]+)?\s*:\s*(.+)$/iu);
  if (season) {
    seasonHint = Number(season[1]);
    rest = season[2].trim();
  }

  // Netflix parts are release batches, not necessarily provider seasons.
  rest = rest.replace(/^Part\s+\d+\s*:\s*/i, "").trim();

  const episodeOnly = rest.match(/^Episode\s+(\d+)\s*$/i);
  if (episodeOnly) episodeHint = Number(episodeOnly[1]);

  return { episodeTitle: rest, seasonHint, episodeHint };
}

function csvRows(csv = "") {
  const source = String(csv || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (quoted) throw new Error("The CSV contains an unclosed quoted field.");
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error("Choose a Netflix Viewing Activity CSV with a header and at least one row.");
  return rows;
}

// Sessions on one profile, title and day shorter than this in total are accidental
// starts or autoplay, not watches. Phantom plays are worse than missed ones.
export const NETFLIX_MIN_WATCH_SECONDS = 5 * 60;

function durationSeconds(value = "") {
  const match = String(value).trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
}

// The personal-information export logs "Start Time" in UTC as YYYY-MM-DD HH:MM:SS.
function parseNetflixStartTime(value = "") {
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(time);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? time : NaN;
}

function isViewingActivityHeader(headers = []) {
  return ["title", "start time", "profile name", "duration"].every((name) => headers.includes(name));
}

function isUnusableNetflixTitle(value = "") {
  const title = String(value || "").trim();
  return !title || /^unknown title(?:\s*\(episode\s+\d+\))?$/i.test(title) || title.startsWith(":");
}

// Profile names and their real-view row counts, for choosing whose history to import.
export function netflixCsvProfiles(csv = "") {
  const rows = csvRows(csv);
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  if (!isViewingActivityHeader(headers)) return [];
  const profileIndex = headers.indexOf("profile name");
  const titleIndex = headers.indexOf("title");
  const supplementalIndex = headers.indexOf("supplemental video type");
  const counts = new Map();
  for (const cells of rows) {
    if (isUnusableNetflixTitle(cells[titleIndex])) continue;
    if (supplementalIndex >= 0 && String(cells[supplementalIndex] || "").trim()) continue;
    const name = String(cells[profileIndex] || "").trim();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, rows]) => ({ name, rows }));
}

// One play per title per day from the full export: trailers, previews and recaps are
// dropped, only chosen profiles count, and a profile's sessions for that title and day
// must add up to the minimum watch time. Several chosen profiles watching the same
// title that day still make one play, dated at the latest session's end.
function viewingActivityRecords(rows, headers, { profiles } = {}) {
  const column = (name) => headers.indexOf(name);
  const titleIndex = column("title");
  const startIndex = column("start time");
  const durationIndex = column("duration");
  const profileIndex = column("profile name");
  const supplementalIndex = column("supplemental video type");
  const bookmarkIndex = column("bookmark");
  const available = new Set(rows.filter((cells) => !isUnusableNetflixTitle(cells[titleIndex]))
    .map((cells) => String(cells[profileIndex] || "").trim()));
  const chosen = new Set((Array.isArray(profiles) ? profiles : []).map((name) => String(name).trim()));
  if (!chosen.size && available.size > 1) {
    throw Object.assign(new Error("Choose the Netflix profiles whose history you want to import."), { status: 400 });
  }
  const excluded = { supplemental: 0, otherProfiles: 0, shortViews: 0 };
  const sessions = new Map();
  rows.forEach((cells, index) => {
    const rowNumber = index + 2;
    const title = String(cells[titleIndex] || "").trim();
    if (isUnusableNetflixTitle(title)) return;
    if (supplementalIndex >= 0 && String(cells[supplementalIndex] || "").trim()) { excluded.supplemental += 1; return; }
    const profile = String(cells[profileIndex] || "").trim();
    if (chosen.size && !chosen.has(profile)) { excluded.otherProfiles += 1; return; }
    const start = parseNetflixStartTime(cells[startIndex]);
    if (!Number.isFinite(start)) throw new Error(`CSV row ${rowNumber} needs a valid Start Time (YYYY-MM-DD HH:MM:SS).`);
    const seconds = durationSeconds(cells[durationIndex]);
    if (!Number.isFinite(seconds)) throw new Error(`CSV row ${rowNumber} needs a valid Duration (HH:MM:SS).`);
    const day = new Date(start).toISOString().slice(0, 10);
    const key = `${profile}\u0000${title}\u0000${day}`;
    const entry = sessions.get(key) || { order: index, rowNumber, title, day, seconds: 0, endsAt: 0, views: 0, bookmark: 0 };
    const bookmark = bookmarkIndex >= 0 ? durationSeconds(cells[bookmarkIndex]) : NaN;
    if (Number.isFinite(bookmark)) entry.bookmark = Math.max(entry.bookmark, bookmark);
    entry.seconds += seconds;
    entry.views += 1;
    entry.endsAt = Math.max(entry.endsAt, start + seconds * 1000);
    sessions.set(key, entry);
  });
  const plays = new Map();
  for (const entry of sessions.values()) {
    if (entry.seconds < NETFLIX_MIN_WATCH_SECONDS) { excluded.shortViews += entry.views; continue; }
    const key = `${entry.title}\u0000${entry.day}`;
    const play = plays.get(key);
    if (!play) plays.set(key, { ...entry });
    else {
      play.order = Math.min(play.order, entry.order);
      play.bookmark = Math.max(play.bookmark, entry.bookmark);
      if (entry.endsAt > play.endsAt) Object.assign(play, { endsAt: entry.endsAt, rowNumber: entry.rowNumber });
    }
  }
  // Keep the export's newest-first order: neighbouring rows are matching evidence.
  const records = [...plays.values()].sort((a, b) => a.order - b.order).map((play, index) => {
    // This export appends Netflix's own number: "Show: Season 1: Ivo (Episode 7)".
    // The title still decides the match; the number only breaks ties.
    const numbered = play.title.match(/^(.*\S)\s*\(Episode\s+(\d+)\)$/i);
    return {
      index,
      rowNumber: play.rowNumber,
      title: numbered ? numbered[1] : play.title,
      watchedAt: new Date(play.endsAt).toISOString(),
      // Furthest playback position: a title cannot be shorter than this.
      ...(play.bookmark ? { bookmarkSeconds: play.bookmark } : {}),
      ...(numbered ? { episodeNumber: Number(numbered[2]) } : {}),
    };
  });
  return { records, excluded };
}

export function readNetflixCsv(csv = "", { profiles } = {}) {
  const rows = csvRows(csv);
  const headers = rows.shift().map((value) => value.trim().toLowerCase());
  if (isViewingActivityHeader(headers)) {
    const result = viewingActivityRecords(rows, headers, { profiles });
    if (!result.records.length) throw Object.assign(new Error("No watches of at least 5 minutes were found for the chosen profiles."), { status: 400 });
    return { format: "viewing_activity", ...result };
  }
  const titleIndex = headers.indexOf("title");
  const dateIndex = headers.indexOf("date");
  if (titleIndex < 0 || dateIndex < 0) throw new Error("The CSV must include Title and Date columns.");
  const records = rows.map((cells, index) => {
    const title = String(cells[titleIndex] || "").trim();
    if (isUnusableNetflixTitle(title)) return null;
    const watchedAt = parseNetflixDate(cells[dateIndex]);
    if (!watchedAt) throw new Error(`CSV row ${index + 2} needs a valid M/D/YY date.`);
    return { index, rowNumber: index + 2, title, watchedAt };
  }).filter(Boolean);
  return { format: "title_date", records, excluded: null };
}

export function parseNetflixCsv(csv = "", options = {}) {
  return readNetflixCsv(csv, options).records;
}
