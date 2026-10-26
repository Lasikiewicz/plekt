import fs from "node:fs";

const cataloguePath = new URL("../../resources/netflix-catalogue.json", import.meta.url);
const titleAliasesPath = new URL("../../resources/netflix-title-aliases.json", import.meta.url);
let bundledCatalogue;

function key(value = "") {
  return String(value).normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/\s*\(\d{4}\)\s*$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Reports are positive title/alias evidence, never a complete availability list.
export function createNetflixCatalogue(snapshot = {}, verifiedAliases = []) {
  const index = new Map();
  // These pairs have Netflix sources, with producer corroboration where needed,
  // separate from report evidence. They cannot supply a reported clear winner.
  const aliasIndex = new Map();
  for (const entry of verifiedAliases) {
    if (!["tv", "movie"].includes(entry.mediaType) || !Array.isArray(entry.titles)
      || !Array.isArray(entry.sources) || !entry.sources.length
      || !entry.sources.some((source) => /^https:\/\/www\.netflix\.com\//.test(source))
      || !entry.sources.every((source) => /^https:\/\/www\.(?:netflix\.com|ufa\.de)\//.test(source))) continue;
    const titles = entry.titles.filter((title) => typeof title === "string" && title.trim());
    if (titles.length < 2) continue;
    for (const title of titles) {
      const id = `${entry.mediaType}:${key(title)}`;
      if (!aliasIndex.has(id)) aliasIndex.set(id, []);
      aliasIndex.get(id).push({ titles, sources: entry.sources });
    }
  }
  const sources = new Map((snapshot.sources || []).map((source) => [source.period, source.url]));
  for (const entry of snapshot.schemaVersion === 1 ? snapshot.entries || [] : []) {
    if (!["tv", "movie"].includes(entry.mediaType) || !Array.isArray(entry.titles)) continue;
    const titles = [...new Set(entry.titles.filter((title) => typeof title === "string" && title.trim()))];
    if (!titles.length) continue;
    const clean = { titles, sources: (entry.sourcePeriods || []).map((period) => sources.get(period)).filter(Boolean),
      reportTitles: entry.reportTitles || [], releaseYears: (entry.releaseYears || []).filter(Number.isInteger) };
    for (const title of titles) {
      const id = `${entry.mediaType}:${key(title)}`;
      if (!index.has(id)) index.set(id, []);
      index.get(id).push(clean);
    }
  }
  function entriesFor(title, mediaType) { return index.get(`${mediaType}:${key(title)}`) || []; }
  function aliasEntriesFor(title, mediaType) {
    return [...entriesFor(title, mediaType), ...(aliasIndex.get(`${mediaType}:${key(title)}`) || [])];
  }
  function aliases(title, mediaType) {
    return [...new Map(aliasEntriesFor(title, mediaType).flatMap((entry) => entry.titles)
      .filter((alias) => key(alias) !== key(title)).map((alias) => [key(alias), alias])).values()];
  }
  function rankCandidates(title, mediaType, candidates = []) {
    const entries = aliasEntriesFor(title, mediaType);
    const alternativeKeys = new Set(aliases(title, mediaType).map(key));
    return candidates.map((candidate) => {
      const names = mediaType === "tv" ? [candidate.name, candidate.original_name] : [candidate.title, candidate.original_title];
      const matched = names.filter((name) => name && alternativeKeys.has(key(name)));
      if (!matched.length) return candidate;
      const supporting = entries.filter((entry) => entry.titles.some((alias) => matched.some((name) => key(alias) === key(name))));
      return { ...candidate, netflixEvidence: { kind: "paired_title", aliases: [...new Set(matched)],
        sources: [...new Set(supporting.flatMap((entry) => entry.sources))] } };
    }).sort((a, b) => Number(Boolean(b.netflixEvidence)) - Number(Boolean(a.netflixEvidence))
      || Number(b.popularity || 0) - Number(a.popularity || 0));
  }
  function aliasMatches(title, mediaType, candidates = []) {
    // A paired alias may recover a title search miss. It must not exclude a
    // same-name remake: callers keep all original exact candidates in that case.
    return rankCandidates(title, mediaType, candidates).filter((candidate) => candidate.netflixEvidence);
  }
  // Whether a report entry can be this TMDB candidate. A "(1999)" title label or
  // Netflix's premiere year must agree within a year; an entry with neither fits
  // every same-named candidate, so it cannot single one out.
  function entryFits(entry, candidate, mediaType) {
    const year = Number(String(candidate.release_date || candidate.first_air_date || "").slice(0, 4));
    const labels = entry.titles.map((title) => Number(title.match(/\((\d{4})\)\s*$/)?.[1])).filter(Boolean);
    if (labels.length) return Boolean(year) && labels.some((label) => Math.abs(label - year) <= 1);
    if (!entry.releaseYears.length) return true;
    if (!year) return false;
    const first = entry.releaseYears[0];
    if (mediaType === "movie") return Math.abs(first - year) <= 1;
    // A show's dates are season premieres: it must have started by the first one,
    // and close to it when the report lists its first season or no season at all.
    const opening = entry.reportTitles.some((title) => !/:\s*(?:season|series|part|volume)\s+(?:[2-9]|\d\d)/i.test(title));
    return year <= first + 1 && (!opening || year >= first - 1);
  }
  // Candidates that some report entry under one of their own names can be.
  function reportedCandidates(mediaType, candidates = []) {
    return candidates.filter((candidate) => {
      const names = mediaType === "tv" ? [candidate.name, candidate.original_name] : [candidate.title, candidate.original_title];
      return names.filter(Boolean).some((name) => entriesFor(name, mediaType).some((entry) => entryFits(entry, candidate, mediaType)));
    });
  }
  function showPrefix(title) {
    let found = "";
    for (let position = title.indexOf(":"); position > 0; position = title.indexOf(":", position + 1)) {
      const prefix = title.slice(0, position).trim();
      if (entriesFor(prefix, "tv").length) found = prefix;
    }
    return found;
  }
  return { has: (title, mediaType) => entriesFor(title, mediaType).length > 0, aliases, rankCandidates, aliasMatches, reportedCandidates, showPrefix };
}

export function getNetflixCatalogue() {
  if (!bundledCatalogue) {
    let verifiedAliases = [];
    try {
      const saved = JSON.parse(fs.readFileSync(titleAliasesPath, "utf8"));
      if (saved.schemaVersion === 1 && Array.isArray(saved.entries)) verifiedAliases = saved.entries;
    } catch { /* Missing editorial evidence never changes ordinary matching. */ }
    try { bundledCatalogue = createNetflixCatalogue(JSON.parse(fs.readFileSync(cataloguePath, "utf8")), verifiedAliases); }
    catch { bundledCatalogue = createNetflixCatalogue(); }
  }
  return bundledCatalogue;
}
