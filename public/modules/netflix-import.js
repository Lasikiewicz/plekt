import { state } from "./state.js?v=2.2.0.1.0";
import { buildAuthHeaders } from "./auth.js?v=2.2.0.1.0";

let bound = false;
let preview = null;
let previewPending = false;
let importPending = false;
let rematchesPending = 0;
let fileRevision = 0;
let openConfirmDialog = async () => false;
const skippedShows = new Set();
// The full personal-information export lists every profile; null for the Title,Date export.
let activity = null;

function el(id) { return document.getElementById(id); }
function headers(json = false) { return { ...buildAuthHeaders(state.token), ...(json ? { "Content-Type": "application/json" } : {}) }; }

function setStatus(text = "", tone = "muted", loading = false) {
  const node = el("netflixImportStatus");
  if (!node) return;
  node.textContent = text;
  node.className = `message tautulli-import-status ${tone}${loading ? " is-loading" : ""}`;
  node.hidden = !text;
  node.setAttribute("aria-busy", loading ? "true" : "false");
  node.style.display = text ? (loading ? "inline-flex" : "block") : "none";
}

function setProgress(percent = null, { indeterminate = false, complete = false, error = false } = {}) {
  const progress = el("netflixImportProgress");
  const bar = el("netflixImportProgressBar");
  if (!progress || !bar) return;
  if (percent == null && !indeterminate && !complete && !error) {
    progress.hidden = true;
    progress.classList.remove("is-indeterminate", "is-complete", "is-error");
    bar.style.width = "0%";
    progress.setAttribute("aria-valuenow", "0");
    return;
  }
  const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : 0;
  progress.hidden = false;
  progress.classList.toggle("is-indeterminate", Boolean(indeterminate) && !complete && !error);
  progress.classList.toggle("is-complete", Boolean(complete));
  progress.classList.toggle("is-error", Boolean(error));
  bar.style.width = complete ? "100%" : (indeterminate ? "35%" : `${safe}%`);
  progress.setAttribute("aria-valuenow", String(complete ? 100 : safe));
}

function chosenProfiles() {
  return [...document.querySelectorAll("#netflixProfileList input[type=checkbox]:checked")].map((input) => input.value);
}

function csvRows(text = "") {
  const source = String(text).replace(/^﻿/, "");
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
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

// Reads the export's profile names. Only real views count; trailers and previews do not.
function readActivity(text) {
  const rows = csvRows(text);
  const header = (rows[0] || []).map((value) => value.trim().toLowerCase());
  const profileIndex = header.indexOf("profile name");
  if (profileIndex < 0 || !header.includes("start time") || !header.includes("title")) return null;
  const supplementalIndex = header.indexOf("supplemental video type");
  const titleIndex = header.indexOf("title");
  const counts = new Map();
  for (const cells of rows.slice(1)) {
    if (supplementalIndex >= 0 && String(cells[supplementalIndex] || "").trim()) continue;
    const title = String(cells[titleIndex] || "").trim();
    if (!title || /^unknown title(?:\s*\(episode\s+\d+\))?$/i.test(title) || title.startsWith(":")) continue;
    const name = String(cells[profileIndex] || "").trim();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return { rows, profileIndex, supplementalIndex, profiles: [...counts].sort((a, b) => b[1] - a[1]) };
}

// Only the chosen profiles' real views are uploaded, which keeps large exports small.
function activityCsv(profiles) {
  const chosen = new Set(profiles);
  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [activity.rows[0].map(quote).join(",")];
  for (const cells of activity.rows.slice(1)) {
    if (!chosen.has(String(cells[activity.profileIndex] || "").trim())) continue;
    if (activity.supplementalIndex >= 0 && String(cells[activity.supplementalIndex] || "").trim()) continue;
    lines.push(cells.map(quote).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function clearPreview() {
  preview = null;
  skippedShows.clear();
  if (el("netflixImportSummary")) {
    el("netflixImportSummary").textContent = "";
    el("netflixImportSummary").hidden = true;
  }
  renderReviews();
}

function renderProfiles() {
  const fieldset = el("netflixProfileChoice");
  const list = el("netflixProfileList");
  if (!fieldset || !list) return;
  list.replaceChildren();
  fieldset.hidden = !activity;
  if (!activity) return;
  for (const [name, count] of activity.profiles) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = name;
    input.checked = activity.profiles.length === 1;
    input.addEventListener("change", () => {
      // A preview belongs to the profiles it was made from.
      if (!previewPending) clearPreview();
      updateButtons();
    });
    const text = document.createElement("span");
    text.textContent = `${name || "(no profile name)"} (${count.toLocaleString()} views)`;
    label.append(input, text);
    list.append(label);
  }
}

async function loadFile() {
  const requestRevision = fileRevision;
  activity = null;
  renderProfiles();
  const file = el("netflixCsvFile")?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    if (requestRevision !== fileRevision) return;
    activity = readActivity(text);
    renderProfiles();
  } catch (error) {
    if (requestRevision === fileRevision) setStatus(error.message || "Could not read this CSV.", "error");
  } finally {
    if (requestRevision === fileRevision) updateButtons();
  }
}

function updateButtons() {
  const hasFile = Boolean(el("netflixCsvFile")?.files?.[0]);
  const needsProfiles = Boolean(activity) && !chosenProfiles().length;
  for (const input of document.querySelectorAll("#netflixProfileList input")) input.disabled = previewPending || importPending;
  const previewButton = el("netflixPreviewButton");
  if (previewButton) {
    previewButton.disabled = previewPending || importPending || rematchesPending > 0 || !hasFile || needsProfiles;
    previewButton.textContent = previewPending ? "Matching titles…" : "Preview import";
  }
  if (el("netflixImportButton")) el("netflixImportButton").disabled = previewPending || importPending || rematchesPending > 0 || !preview;
  const fileStatus = el("netflixImportFileStatus");
  const fileName = el("netflixCsvFileName");
  if (fileName) fileName.textContent = el("netflixCsvFile")?.files?.[0]?.name || "No file selected";
  if (fileStatus) {
    fileStatus.textContent = !hasFile ? "Choose CSV" : needsProfiles ? "Choose profiles" : "CSV selected";
    fileStatus.className = `status-pill ${hasFile && !needsProfiles ? "status-success" : "status-muted"}`;
  }
}

function reviewValue(group) {
  return group?.querySelector('input[type="radio"]:checked')?.value || "";
}

function setReviewValue(group, value) {
  if (!group) return;
  const input = [...group.querySelectorAll('input[type="radio"]')].find((option) => option.value === String(value));
  if (input) input.checked = true;
}

function catalogLinks(candidate, fallbackTitle = "") {
  const mediaType = candidate.mediaType || "movie";
  const title = mediaType === "episode" ? fallbackTitle || candidate.title : candidate.title || fallbackTitle;
  const tmdbId = mediaType === "episode" ? candidate.showTmdbId : candidate.id;
  const tmdbType = mediaType === "tv" || mediaType === "episode" ? "tv" : "movie";
  const links = document.createElement("span");
  links.className = "netflix-catalog-links";
  if (tmdbId) {
    const tmdb = document.createElement("a");
    tmdb.href = `https://www.themoviedb.org/${tmdbType}/${encodeURIComponent(tmdbId)}`;
    tmdb.target = "_blank";
    tmdb.rel = "noopener noreferrer";
    tmdb.textContent = "TMDB";
    links.append(tmdb);
  }
  if (title) {
    const tvdb = document.createElement("a");
    tvdb.href = `https://thetvdb.com/search?query=${encodeURIComponent(title)}`;
    tvdb.target = "_blank";
    tvdb.rel = "noopener noreferrer";
    tvdb.textContent = "TVDB search";
    links.append(tvdb);
  }
  return links;
}

function addReviewSelect(section, {
  labelText,
  reviewRows,
  candidates = [],
  skipLabel = "Skip this title",
  emptyOnly = false,
  selectedValue = "",
  yearMatchId = "",
  groupId = "",
  mediaType = "movie",
  linkTitle = "",
}) {
  const card = document.createElement("section");
  card.className = "netflix-review-card";
  const head = document.createElement("div");
  head.className = "netflix-review-card-head";
  const title = document.createElement("strong");
  title.textContent = labelText;
  const type = document.createElement("span");
  type.className = "netflix-media-type";
  type.textContent = mediaType === "tv" || mediaType === "episode" ? "TV Show" : "Movie";
  head.append(title, type);
  const choices = document.createElement("fieldset");
  choices.className = "netflix-match-options";
  choices.setAttribute("aria-label", labelText);
  choices.dataset.reviewRows = String(reviewRows);
  if (groupId) choices.dataset.groupId = String(groupId);
  if (yearMatchId) choices.dataset.yearMatchId = String(yearMatchId);
  const options = [{ value: "skip", title: skipLabel, skip: true }, ...(!emptyOnly ? candidates.map((candidate) => ({
    candidate,
    value: `${candidate.id}|${candidate.season ?? ""}|${candidate.episode ?? ""}`,
    title: candidate.title,
  })) : [])];
  let chosen = selectedValue;
  if (yearMatchId && !options.some((option) => option.value === chosen)) {
    chosen = options.find((option) => option.value.startsWith(`${yearMatchId}|`))?.value || "";
  }
  if (!options.some((option) => option.value === chosen)) chosen = "skip";
  options.forEach((option, index) => {
    const row = document.createElement("div");
    row.className = "netflix-match-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `netflix-review-${reviewRows}-${groupId || "row"}`;
    input.value = option.value;
    input.id = `netflix-choice-${reviewRows}-${groupId || "row"}-${index}`;
    input.checked = option.value === chosen;
    input.addEventListener("change", () => { if (groupId) skippedShows.delete(String(groupId)); });
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.className = "netflix-match-option-label";
    const name = document.createElement("strong");
    name.textContent = option.title;
    label.append(name);
    if (option.candidate) {
      const candidate = option.candidate;
      const meta = document.createElement("span");
      const seasonLabel = candidate.season != null && candidate.episode != null
        ? `S${String(candidate.season).padStart(2, "0")}E${String(candidate.episode).padStart(2, "0")}` : "";
      meta.textContent = [seasonLabel, candidate.year, candidate.netflixEvidence ? "Netflix title alias" : ""].filter(Boolean).join(" · ");
      if (meta.textContent) label.append(meta);
    }
    row.append(input, label);
    const links = option.candidate ? catalogLinks(option.candidate, linkTitle) : null;
    if (links?.childElementCount) row.append(links);
    choices.append(row);
  });
  card.append(head, choices);
  section.append(card);
  return choices;
}

function rowChoices() {
  const choices = new Map();
  for (const group of document.querySelectorAll("#netflixReviewList [data-review-rows]")) {
    const row = String(group.dataset.reviewRows || "");
    choices.set(row, { value: reviewValue(group), yearMatchId: group.dataset.yearMatchId || "" });
  }
  return choices;
}

function showIdentity(group) {
  const chosen = (group.showCandidates || []).find((item) => String(item.id) === String(group.showTmdbId));
  return chosen?.title || group.show;
}

function addShowCandidateCards(section, group) {
  const choices = document.createElement("fieldset");
  choices.className = "netflix-match-options netflix-show-candidates";
  choices.setAttribute("aria-label", `Match show: ${group.show}`);
  choices.dataset.showGroupId = String(group.groupId);
  const options = [{ id: "skip", title: "Skip this show", skip: true }, ...(group.showCandidates || [])];
  for (const [index, candidate] of options.entries()) {
    const row = document.createElement("div");
    row.className = "netflix-match-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `netflix-show-${group.groupId}`;
    input.value = candidate.skip ? "skip" : String(candidate.id);
    input.id = `netflix-show-choice-${group.groupId}-${index}`;
    input.checked = candidate.skip
      ? skippedShows.has(String(group.groupId)) || !group.showTmdbId
      : String(candidate.id) === String(group.showTmdbId || "");
    input.addEventListener("change", () => {
      if (candidate.skip) {
        skippedShows.add(String(group.groupId));
        for (const choicesGroup of section.querySelectorAll("[data-review-rows]")) setReviewValue(choicesGroup, "skip");
      } else skippedShows.delete(String(group.groupId));
    });
    const label = document.createElement("label");
    label.htmlFor = input.id;
    label.className = "netflix-match-option-label";
    const title = document.createElement("strong");
    title.textContent = candidate.title;
    label.append(title);
    if (candidate.year || candidate.netflixEvidence) {
      const meta = document.createElement("span");
      meta.textContent = [candidate.year, candidate.netflixEvidence ? "Netflix title alias" : ""].filter(Boolean).join(" · ");
      label.append(meta);
    }
    row.append(input, label);
    if (!candidate.skip) {
      const links = catalogLinks(candidate);
      if (links.childElementCount) row.append(links);
    }
    choices.append(row);
  }
  section.append(choices);
  return choices;
}

function renderReviews(groups = [], choices = rowChoices()) {
  const root = el("netflixReviewList");
  if (!root) return;
  root.replaceChildren();
  const incomplete = groups.filter((group) => group.reason === "missing_title"
    || (group.type === "show" && group.episodes.every((episode) => episode.reason === "missing_show_title")));
  const incompleteRows = new Set(incomplete.flatMap((group) => group.type === "show"
    ? group.episodes.map((episode) => String(episode.row)) : [String(group.row)]));
  if (incomplete.length) {
    const bulk = document.createElement("button");
    bulk.type = "button";
    bulk.className = "button-ghost sync-tool-button";
    bulk.textContent = "Skip all incomplete rows";
    bulk.setAttribute("aria-label", "Skip all incomplete Netflix review rows");
    bulk.addEventListener("click", () => {
      for (const choiceGroup of root.querySelectorAll("[data-review-rows]")) {
        if (incompleteRows.has(String(choiceGroup.dataset.reviewRows))) setReviewValue(choiceGroup, "skip");
      }
      for (const group of incomplete) if (group.type === "show" && group.groupId) skippedShows.add(String(group.groupId));
      for (const details of root.querySelectorAll("details.netflix-review-group")) details.open = false;
    });
    root.append(bulk);
  }

  for (const group of groups) {
    if (group.type === "year_matched") {
      const details = document.createElement("details");
      details.className = "netflix-review-group netflix-year-matched";
      const summary = document.createElement("summary");
      summary.textContent = `Matched by watch year (${group.items.length}) — open to change or skip`;
      details.append(summary);
      for (const item of group.items) {
        const saved = choices.get(String(item.row));
        addReviewSelect(details, {
          labelText: `${item.title} (${String(item.watchedAt || "").slice(0, 10)})`,
          reviewRows: item.row,
          candidates: item.candidates || [],
          yearMatchId: saved?.yearMatchId || item.selectedCandidateId || "",
          selectedValue: saved?.value || "",
          mediaType: "movie",
        });
      }
      root.append(details);
      continue;
    }
    const section = document.createElement("section");
    section.className = "netflix-review-group";
    if (group.type === "show") {
      const heading = document.createElement("div");
      heading.className = "netflix-review-card-head";
      const headingText = document.createElement("strong");
      const missingShow = group.episodes.every((episode) => episode.reason === "missing_show_title");
      const blankRun = missingShow && group.blankRun;
      const count = `${group.episodes.length} episode${group.episodes.length === 1 ? "" : "s"}`;
      headingText.textContent = blankRun
        ? `Unknown show (no title in Netflix export) — ${count} watched ${runDates(group.episodes)}`
        : missingShow
          ? `Unknown show (no title in Netflix export) — ${count} cannot be matched`
          : `${showIdentity(group)} — ${count}`;
      const type = document.createElement("span");
      type.className = "netflix-media-type";
      type.textContent = "TV Show";
      heading.append(headingText, type);
      section.append(heading);
      if (blankRun) {
        const searchLabel = document.createElement("label");
        searchLabel.className = "netflix-review-row netflix-show-choice";
        const label = document.createElement("span");
        label.textContent = "Find show";
        const input = document.createElement("input");
        input.type = "search";
        input.className = "field";
        input.placeholder = "Show you watched on these dates";
        input.setAttribute("aria-label", `Search for the show watched ${runDates(group.episodes)}`);
        input.dataset.runSearchGroupId = String(group.groupId);
        const find = document.createElement("button");
        find.type = "button";
        find.className = "button-ghost sync-tool-button";
        find.textContent = "Search";
        find.setAttribute("aria-label", `Search shows for the run watched ${runDates(group.episodes)}`);
        find.addEventListener("click", () => searchRunShows(group, input.value, find));
        searchLabel.append(label, input, find);
        section.append(searchLabel);
      }
      if (!missingShow || blankRun) {
        const showChoices = addShowCandidateCards(section, group);
        if ((group.showCandidates || []).length) {
          const guidance = document.createElement("p");
          guidance.className = "tautulli-step-note";
          guidance.textContent = "Choose a show, then select Match episodes to find its episode options. Open Review episodes and select each episode you want to include; episodes stay skipped until selected. This updates the preview only — no history is written.";
          section.append(guidance);
          const match = document.createElement("button");
          match.type = "button";
          match.className = "button-primary sync-tool-button";
          match.textContent = "Match episodes";
          match.setAttribute("aria-label", `Match episodes for ${group.show}`);
          match.addEventListener("click", () => {
            const candidateId = showChoices.querySelector('input[type="radio"]:checked')?.value || "";
            if (candidateId && candidateId !== "skip") rematchShow(group, candidateId, match);
          });
          section.append(match);
        }
      }
      if (missingShow) {
        const note = document.createElement("p");
        note.className = "tautulli-step-note";
        note.textContent = blankRun
          ? "Netflix left these rows without a series name (for example “: Episode 8”). If you know the show you watched on these dates, search for it and match the episodes; otherwise skip them."
          : "Netflix left these rows without a series name (for example “: Episode 8”). Skip them — they cannot be matched.";
        section.append(note);
      }
      const episodeDetails = document.createElement("details");
      episodeDetails.className = "netflix-show-episodes";
      episodeDetails.open = false;
      const episodeSummary = document.createElement("summary");
      episodeSummary.textContent = `Review episodes (${group.episodes.length})`;
      episodeDetails.append(episodeSummary);
      const episodeRows = document.createElement("div");
      const episodeSelects = new Map();
      const seasons = new Map();
      for (const episode of group.episodes) {
        const saved = choices.get(String(episode.row));
        const beforeCount = episodeRows.children.length;
        addReviewSelect(episodeRows, {
          labelText: `${episode.title} (${String(episode.watchedAt || "").slice(0, 10)})`,
          reviewRows: episode.row,
          candidates: (episode.candidates || []).filter((candidate) => candidate.season != null && candidate.episode != null),
          skipLabel: "Skip this episode",
          emptyOnly: missingShow || episode.reason === "missing_show_title",
          selectedValue: saved?.value || "",
          groupId: group.groupId || "",
          mediaType: "episode",
          linkTitle: group.show,
        });
        const select = episodeRows.children[beforeCount]?.querySelector("[data-review-rows]");
        if (select) episodeSelects.set(String(episode.row), select);
        const candidates = (episode.candidates || []).filter((candidate) => candidate.season != null && candidate.episode != null
          && (episode.seasonHint == null || Number(candidate.season) === Number(episode.seasonHint)));
        const hintedSeason = Number(episode.seasonHint ?? candidates[0]?.season);
        // A blank run has no season evidence, so it gets one explicit season choice instead.
        if (!group.blankRun && Number.isInteger(hintedSeason) && hintedSeason > 0 && candidates.length) {
          const items = seasons.get(hintedSeason) || [];
          items.push({ episode, candidates });
          seasons.set(hintedSeason, items);
        }
      }
      episodeDetails.append(episodeRows);
      if (group.blankRun && !missingShow) addRunSeasonChoice(section, group, episodeSelects, episodeDetails);
      for (const [season, items] of seasons) {
        const batch = document.createElement("section");
        batch.className = "netflix-season-suggestions";
        const seasonHeading = document.createElement("h5");
        seasonHeading.textContent = `Season ${season} suggestions`;
        batch.append(seasonHeading);
        const previewList = document.createElement("ul");
        const proposals = [];
        for (const { episode, candidates } of items) {
          const candidate = candidates[0];
          if (!candidate) continue;
          const li = document.createElement("li");
          li.textContent = `${episode.title} → S${String(candidate.season).padStart(2, "0")}E${String(candidate.episode).padStart(2, "0")} ${candidate.title}`;
          previewList.append(li);
          proposals.push({ row: String(episode.row), candidate });
        }
        batch.append(previewList);
        const use = document.createElement("button");
        use.type = "button";
        use.className = "button-ghost sync-tool-button";
        use.textContent = `Use suggested matches for season ${season}`;
        use.setAttribute("aria-label", `Use suggested episode matches for season ${season} of ${group.show}`);
        use.addEventListener("click", () => {
          for (const { row, candidate } of proposals) {
            const select = episodeSelects.get(row);
            const value = `${candidate.id}|${candidate.season}|${candidate.episode}`;
            if (select && [...select.querySelectorAll('input[type="radio"]')].some((option) => option.value === value)) setReviewValue(select, value);
          }
        });
        batch.append(use);
        episodeDetails.append(batch);
      }
      section.append(episodeDetails);
    } else if (group.type === "movie") {
      const saved = choices.get(String(group.row));
      addReviewSelect(section, {
        labelText: `${group.title} (${String(group.watchedAt || "").slice(0, 10)})`,
        reviewRows: group.row,
        candidates: group.candidates || [],
        selectedValue: saved?.value || "",
        mediaType: "movie",
      });
    } else {
      const saved = choices.get(String(group.row));
      addReviewSelect(section, {
        labelText: group.reason === "missing_title"
          ? `Netflix export has no title (${String(group.watchedAt || "").slice(0, 10)})`
          : `${group.title} (${String(group.watchedAt || "").slice(0, 10)})`,
        reviewRows: group.row,
        skipLabel: "Skip row (title missing)",
        emptyOnly: true,
        selectedValue: saved?.value || "",
        mediaType: "movie",
      });
    }
    root.append(section);
  }
}

function runDates(episodes = []) {
  const dates = episodes.map((episode) => String(episode.watchedAt || "").slice(0, 10)).filter(Boolean).sort();
  if (!dates.length) return "on an unknown date";
  return dates[0] === dates.at(-1) ? `on ${dates[0]}` : `${dates[0]} to ${dates.at(-1)}`;
}

function renderPreviewSummary() {
  const summary = el("netflixImportSummary");
  if (!summary || !preview) return;
  summary.replaceChildren();
  const counts = document.createElement("div");
  counts.className = "netflix-summary-counts";
  const stats = [
    [preview.matched, "Matched"],
    [preview.matchedByYear || 0, "Matched by watch year"],
    [preview.needsReview, "Require review"],
    [preview.skipped, "Already in Plekt"],
    [preview.excluded?.shortViews || 0, "Views under 5 minutes left out"],
  ];
  for (const [value, label] of stats) {
    const box = document.createElement("div");
    box.className = "netflix-summary-box";
    const count = document.createElement("strong");
    count.textContent = Number(value || 0).toLocaleString();
    const caption = document.createElement("span");
    caption.textContent = label;
    box.append(count, caption);
    counts.append(box);
  }
  const instructions = document.createElement("p");
  instructions.className = "tautulli-step-note";
  instructions.textContent = "Review required items below. Skip is selected by default unless a year match is pre-selected in a collapsed section.";
  summary.append(counts, instructions);
  summary.hidden = false;
}

// One season for a whole blank-name run: fills each row's select with Episode N of that
// season and lists the result. Rows stay editable; nothing imports until confirmation.
function addRunSeasonChoice(section, group, episodeSelects, episodeDetails) {
  const optionsFor = (episode) => (episode.candidates || []).filter((candidate) => candidate.season != null && candidate.episode != null);
  const runSeasons = [...new Set(group.episodes.flatMap((episode) => optionsFor(episode).map((candidate) => Number(candidate.season))))]
    .filter(Number.isInteger).sort((a, b) => a - b);
  if (!runSeasons.length) return;
  const wrap = document.createElement("section");
  wrap.className = "netflix-season-suggestions";
  const line = document.createElement("label");
  line.className = "netflix-review-row";
  const label = document.createElement("span");
  label.textContent = "Season for this run";
  const select = document.createElement("select");
  select.className = "field";
  select.setAttribute("aria-label", `Season for the ${group.show} run watched ${runDates(group.episodes)}`);
  select.dataset.runSeasonGroupId = String(group.groupId);
  select.add(new Option("Choose a season", ""));
  for (const season of runSeasons) select.add(new Option(`Season ${season}`, String(season)));
  const chosen = [...episodeSelects.values()].map((row) => reviewValue(row).split("|")[1]).filter(Boolean);
  if (chosen.length && new Set(chosen).size === 1 && runSeasons.includes(Number(chosen[0]))) select.value = chosen[0];
  const list = document.createElement("ul");
  const candidateIn = (episode, season) => optionsFor(episode).find((entry) => Number(entry.season) === season);
  const labelFor = (episode, value, season) => {
    if (value && value !== "skip") {
      const match = optionsFor(episode).find((entry) => `${entry.id}|${entry.season}|${entry.episode}` === value);
      if (match) {
        return `${episode.title} → S${String(match.season).padStart(2, "0")}E${String(match.episode).padStart(2, "0")} ${match.title}`;
      }
    }
    if (value === "skip") return `${episode.title} → skipped`;
    return `${episode.title} → not in season ${season}; choose it below or skip`;
  };
  const showProposals = () => {
    list.replaceChildren();
    if (!select.value) return;
    const season = Number(select.value);
    for (const episode of group.episodes) {
      const li = document.createElement("li");
      li.textContent = labelFor(episode, reviewValue(episodeSelects.get(String(episode.row))), season);
      list.append(li);
    }
  };
  select.addEventListener("change", () => {
    if (select.value) {
      skippedShows.delete(String(group.groupId));
      for (const episode of group.episodes) {
        const candidate = candidateIn(episode, Number(select.value));
        const row = episodeSelects.get(String(episode.row));
        if (row && candidate) setReviewValue(row, `${candidate.id}|${candidate.season}|${candidate.episode}`);
      }
      episodeDetails.open = true;
    }
    showProposals();
  });
  for (const row of episodeSelects.values()) row.addEventListener("change", showProposals);
  showProposals();
  line.append(label, select);
  wrap.append(line, list);
  section.append(wrap);
}

function searchRunShows(group, query, button) {
  if (!String(query || "").trim()) {
    setStatus("Type a show name to search for.", "error");
    return;
  }
  return updateShowGroup(group, { query: String(query).trim() }, button, {
    busyText: "Searching…", idleText: "Search", progress: "Searching TMDB shows…",
    done: (result) => result.searchResults ? "Choose the show, then match its episodes. No history has been written yet." : "No shows found. Try another name or skip these rows.",
  });
}

function rematchShow(group, tmdbId, button) {
  if (!tmdbId) {
    setStatus("Choose a show before matching its episodes.", "error");
    return;
  }
  return updateShowGroup(group, { tmdbId }, button, {
    busyText: "Matching episodes…", idleText: "Match episodes", progress: `Matching episodes for ${group.show}…`,
    done: () => "Episode matches updated. No history has been written yet.",
  });
}

async function updateShowGroup(group, request, button, { busyText, idleText, progress, done }) {
  if (rematchesPending || !preview?.previewId) return;
  const requestRevision = fileRevision;
  const choices = rowChoices();
  rematchesPending += 1;
  button.disabled = true;
  button.textContent = busyText;
  setStatus(progress, "muted", true);
  updateButtons();
  try {
    const result = await readJson(await fetch("/api/netflix/import/preview/review", {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({ previewId: preview.previewId, groupId: group.groupId, ...request }),
    }));
    if (requestRevision !== fileRevision || !preview || result.previewId !== preview.previewId) return;
    const nextChoices = rowChoices();
    for (const [row, selection] of choices) if (!nextChoices.has(row)) nextChoices.set(row, selection);
    preview = { ...preview, ...result };
    if (Array.isArray(result.reviews)) renderReviews(result.reviews, nextChoices);
    renderPreviewSummary();
    setStatus(done(result), "success");
  } catch (error) {
    if (requestRevision === fileRevision) setStatus(error.message || `Could not update ${group.show}.`, "error");
  } finally {
    rematchesPending = Math.max(0, rematchesPending - 1);
    if (requestRevision === fileRevision) {
      button.disabled = false;
      button.textContent = idleText;
    }
    updateButtons();
  }
}

async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function waitForPreview(jobId, requestRevision) {
  while (previewPending && requestRevision === fileRevision) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    if (requestRevision !== fileRevision) return null;
    const response = await fetch(`/api/netflix/import/preview/status?jobId=${encodeURIComponent(jobId)}`, { headers: headers() });
    const job = await readJson(response);
    const processed = Number(job.processed) || 0;
    const total = Number(job.total) || 0;
    const percent = total ? Math.floor(processed * 100 / total) : 0;
    if (job.status === "error") {
      setProgress(percent, { error: true });
      throw new Error(job.error || "Preview failed.");
    }
    if (job.status === "complete") {
      setProgress(100, { complete: true });
      return job;
    }
    setProgress(percent, { indeterminate: total === 0 });
    setStatus(total ? `Matching titles: ${processed.toLocaleString()} of ${total.toLocaleString()} (${percent}%)…` : "Matching titles…", "muted", true);
  }
  return null;
}

async function startPreview() {
  const file = el("netflixCsvFile")?.files?.[0];
  if (!file || rematchesPending) return;
  const requestRevision = ++fileRevision;
  previewPending = true;
  preview = null;
  skippedShows.clear();
  if (el("netflixImportSummary")) {
    el("netflixImportSummary").textContent = "";
    el("netflixImportSummary").hidden = true;
  }
  renderReviews();
  updateButtons();
  setProgress(null, { indeterminate: true });
  setStatus("Reading Netflix CSV…", "muted", true);
  try {
    const profiles = activity ? chosenProfiles() : null;
    if (profiles && !profiles.length) throw new Error("Choose at least one Netflix profile.");
    const csv = profiles ? activityCsv(profiles) : await file.text();
    if (requestRevision !== fileRevision) return;
    setStatus("Starting title matching…", "muted", true);
    const startResponse = await fetch("/api/netflix/import/preview/start", {
      method: "POST", headers: headers(true), body: JSON.stringify({ csv, ...(profiles ? { profiles } : {}) }),
    });
    const start = await startResponse.json().catch(() => ({}));
    if (requestRevision !== fileRevision) return;
    if (!startResponse.ok || start.ok === false) {
      if (startResponse.status === 409 && start.jobId) {
        setStatus("A preview is already running. Showing its progress…", "muted", true);
        const result = await waitForPreview(start.jobId, requestRevision);
        if (!result) throw new Error("Preview was cancelled.");
        preview = result;
      } else throw new Error(start.error || `Request failed (${startResponse.status})`);
    } else {
      const result = await waitForPreview(start.jobId, requestRevision);
      if (!result) throw new Error("Preview was cancelled.");
      preview = result;
    }
    if (requestRevision !== fileRevision) return;
    renderPreviewSummary();
    renderReviews(preview.reviews || [], new Map());
    setStatus("Preview ready. No history has been written yet.", "success");
  } catch (error) {
    if (requestRevision === fileRevision) {
      setProgress(null, { error: true });
      setStatus(error.message || "Could not preview this CSV.", "error");
    }
  } finally {
    if (requestRevision === fileRevision) {
      previewPending = false;
      setProgress();
      updateButtons();
    }
  }
}

function reviewDecisions() {
  const decisions = [];
  for (const choiceGroup of document.querySelectorAll("#netflixReviewList [data-review-rows]")) {
    const rows = String(choiceGroup.dataset.reviewRows || "").split(",").map(Number).filter(Number.isFinite);
    const groupId = String(choiceGroup.dataset.groupId || "");
    const value = reviewValue(choiceGroup);
    if (value === "skip" || (groupId && skippedShows.has(groupId))) {
      rows.forEach((row) => decisions.push({ row, action: "skip" }));
      continue;
    }
    if (!value) throw new Error("Choose a match or skip each item in the requires-review list.");
    const [candidateId, season, episode] = value.split("|");
    rows.forEach((row) => decisions.push({ row, action: "import", candidateId, ...(season ? { season: Number(season), episode: Number(episode) } : {}) }));
  }
  return decisions;
}

async function commitImport() {
  if (!preview?.previewId || rematchesPending) return;
  let reviewedRows;
  try { reviewedRows = reviewDecisions(); }
  catch (error) { setStatus(error.message, "error"); return; }
  const confirmed = await openConfirmDialog("Import Netflix viewing history? Plekt will create a local watch-history backup, add the selected plays, then queue them for connected services.");
  if (!confirmed) return;
  importPending = true;
  updateButtons();
  setStatus("Creating backup and importing selected history…", "muted", true);
  try {
    const result = await readJson(await fetch("/api/netflix/import", {
      method: "POST", headers: headers(true), body: JSON.stringify({ previewId: preview.previewId, reviewedRows }),
    }));
    preview = null;
    skippedShows.clear();
    renderReviews();
    el("netflixImportSummary").textContent = `${result.inserted.toLocaleString()} watches imported; ${result.skipped.toLocaleString()} already present and ${result.reviewedSkipped.toLocaleString()} skipped after review. Outbound sync is queued.`;
    el("netflixImportSummary").hidden = false;
    setStatus("Netflix import complete.", "success");
  } catch (error) {
    setStatus(error.message || "Netflix import failed.", "error");
  } finally {
    importPending = false;
    updateButtons();
  }
}

export function initNetflixImport(callbacks = {}) {
  openConfirmDialog = callbacks.openConfirmDialog || openConfirmDialog;
  if (bound) return;
  bound = true;
  el("netflixCsvFile")?.addEventListener("change", () => {
    fileRevision += 1;
    previewPending = false;
    clearPreview();
    updateButtons();
    loadFile();
  });
  el("netflixPreviewButton")?.addEventListener("click", () => startPreview());
  el("netflixImportButton")?.addEventListener("click", () => commitImport());
  updateButtons();
}
