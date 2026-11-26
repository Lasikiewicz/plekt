import { escapeAttribute, escapeHtml, formatDate, formatTmdbDate, toDateTimeInputValue } from "./utils.js?v=2.4.0.0.0";

export const BULK_REVIEW_BATCH_CAP = 50;
export const DEFAULT_BULK_REVIEW_MODE = "episode_timing";

const selectedIds = new Set();
let inlineDateItems = new Map();
let sharedBulkMode = "";
let sharedCustomValue = "";
let bulkBusy = false;

export function isBulkSelectableReview(review = {}) {
  if (!review || !review.id) return false;
  return review.review_kind !== "source_mismatch" && review.review_kind !== "episode_order_conflict";
}

function isEpisode(review = {}) {
  return String(review.media_type || review.media?.type || review.media?.media_type || "").toLowerCase() === "episode";
}

function reviewReleaseDate(review = {}) {
  const value = review.release_date || review.releaseDate || review.media?.releaseDate;
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function reviewHasReleaseDate(review = {}) {
  return Boolean(reviewReleaseDate(review));
}

function reviewShowTitle(review = {}) {
  const media = review.media || {};
  const explicit = String(review.show_title || media.showTitle || media.show_title || "").trim();
  if (explicit) return explicit;
  const title = String(review.title || media.title || "").trim();
  const match = title.match(/^(.*?)(?:\s+-\s+S\d{1,2}E\d{1,2})(?:\s+-\s+.*)?$/i);
  return (match?.[1] || title.split(" - ")[0] || "Unknown show").trim() || "Unknown show";
}

function reviewEpisodeCode(review = {}) {
  const season = review.season ?? review.media?.season;
  const episode = review.episode ?? review.media?.episode;
  const s = season === null || season === undefined || season === "" ? null : Number(season);
  const e = episode === null || episode === undefined || episode === "" ? null : Number(episode);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return "Episode";
  return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
}

function reviewEpisodeTitle(review = {}) {
  return String(review.episode_title || review.media?.episodeTitle || review.media?.episode_title || "").trim();
}

function reviewSourceLabel(review = {}) {
  const source = String(review.source || review.media?.source || "").trim();
  return source ? source.replace(/^./, (char) => char.toUpperCase()) : "";
}

function reviewDetectedIso(review = {}) {
  const numeric = Number(review.updated_at || review.created_at || 0);
  if (Number.isFinite(numeric) && numeric > 0) {
    const date = new Date(numeric);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const observed = String(review.observed_watched_at || review.media?.watched_at || "").trim();
  if (observed) {
    const date = new Date(observed);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return "";
}

function reviewHasEpisodeTiming(review = {}) {
  return isEpisode(review) && Boolean(review.episode_timing?.watchedAt);
}

function formatDateDayOnly(value = "") {
  if (!value) return "";
  const formatted = formatTmdbDate(String(value).slice(0, 10));
  return formatted || String(value).slice(0, 10);
}

export function displayUnitKey(review = {}) {
  if (!isEpisode(review)) return `movie:${String(review.id)}`;
  const media = review.media || {};
  const ids = review.showIds || review.show_ids || media.showIds || media.show_ids || {};
  const showKey = ids.tvdb || ids.tmdb || ids.imdb || String(review.show_title || media.showTitle || review.title || "").toLowerCase().trim();
  const season = review.season ?? media.season ?? "";
  const episode = review.episode ?? media.episode ?? "";
  return `ep:${showKey}:s${season}e${episode}`;
}

export function clearBulkReviewSelection({ clearDecisions = false } = {}) {
  selectedIds.clear();
  sharedBulkMode = "";
  sharedCustomValue = "";
  if (clearDecisions) inlineDateItems.clear();
}

export function isBulkReviewBusy() {
  return bulkBusy;
}

export function setBulkReviewBusy(busy) {
  bulkBusy = Boolean(busy);
}

export function pruneBulkReviewSelection(reviews = []) {
  const list = (Array.isArray(reviews) ? reviews : []).filter(isBulkSelectableReview);
  const validIds = new Set(list.map((review) => String(review.id)));
  const validKeys = new Set(list.map(displayUnitKey));
  for (const id of [...selectedIds]) {
    if (!validIds.has(id)) selectedIds.delete(id);
  }
  for (const key of [...inlineDateItems.keys()]) {
    if (!validKeys.has(key)) inlineDateItems.delete(key);
  }
  if (!selectedIds.size) {
    sharedBulkMode = "";
    sharedCustomValue = "";
  }
}

export function isReviewSelected(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  return list.length > 0 && list.every((id) => selectedIds.has(id));
}

export function isReviewPartiallySelected(ids = []) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return false;
  const count = list.filter((id) => selectedIds.has(id)).length;
  return count > 0 && count < list.length;
}

export function toggleBulkReviewIds(ids = [], checked = null) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return;
  const shouldSelect = checked === null ? !isReviewSelected(list) : Boolean(checked);
  for (const id of list) {
    if (shouldSelect) selectedIds.add(id);
    else selectedIds.delete(id);
  }
  sharedBulkMode = "";
  if (!selectedIds.size) sharedCustomValue = "";
}

export function selectedBulkReviews(allReviews = []) {
  return (Array.isArray(allReviews) ? allReviews : [])
    .filter((review) => isBulkSelectableReview(review) && selectedIds.has(String(review.id)));
}

export function selectAllVisibleReviews(visibleReviews = [], checked = true, { cap = BULK_REVIEW_BATCH_CAP } = {}) {
  const selectable = (Array.isArray(visibleReviews) ? visibleReviews : []).filter(isBulkSelectableReview);
  sharedBulkMode = "";
  if (!checked) {
    for (const review of selectable) selectedIds.delete(String(review.id));
    if (!selectedIds.size) sharedCustomValue = "";
    return { selectedUnits: 0, capped: false };
  }
  const units = new Set();
  let capped = false;
  for (const review of selectable) {
    const unit = displayUnitKey(review);
    if (!units.has(unit) && units.size >= cap) {
      capped = true;
      continue;
    }
    units.add(unit);
    selectedIds.add(String(review.id));
  }
  return { selectedUnits: units.size, capped };
}

export function bulkSelectionSummary(selectedReviews = []) {
  const list = (Array.isArray(selectedReviews) ? selectedReviews : []).filter(isBulkSelectableReview);
  const episodeUnits = new Set();
  const episodeTimingUnits = new Set();
  let movieCount = 0;
  let hasAnyReleaseDate = false;
  let missingReleaseDateCount = 0;
  for (const review of list) {
    if (reviewHasReleaseDate(review)) hasAnyReleaseDate = true;
    else missingReleaseDateCount += 1;
    if (isEpisode(review)) {
      const unit = displayUnitKey(review);
      episodeUnits.add(unit);
      if (reviewHasEpisodeTiming(review)) episodeTimingUnits.add(unit);
    } else {
      movieCount += 1;
    }
  }
  const episodeCount = episodeUnits.size;
  const episodeTimingCount = episodeTimingUnits.size;
  const displayCount = episodeCount + movieCount;
  const hasMovies = movieCount > 0;
  const hasEpisodes = episodeCount > 0;
  const isMixed = hasMovies && hasEpisodes;
  const episodeTimingAllowed = episodeTimingCount > 0;
  const overCap = displayCount > BULK_REVIEW_BATCH_CAP;
  return {
    reviewCount: list.length,
    episodeCount,
    episodeTimingCount,
    movieCount,
    displayCount,
    hasMovies,
    hasEpisodes,
    isMixed,
    hasAnyReleaseDate,
    missingReleaseDateCount,
    episodeTimingAllowed,
    overCap,
  };
}

export function effectiveBulkMode(requestedMode, summary) {
  const mode = String(requestedMode || DEFAULT_BULK_REVIEW_MODE);
  if (mode === "episode_timing" && !summary?.episodeTimingAllowed) {
    return summary?.hasAnyReleaseDate ? "release_day" : "detected";
  }
  if (mode === "release_day" && summary && !summary.hasAnyReleaseDate) {
    return "detected";
  }
  return mode;
}

export function effectiveModeForReview(review, requestedMode) {
  return effectiveItemMode(requestedMode, reviewHasReleaseDate(review), reviewHasEpisodeTiming(review));
}

function effectiveItemMode(requestedMode, hasReleaseDate, hasEpisodeTiming) {
  const mode = String(requestedMode || DEFAULT_BULK_REVIEW_MODE);
  if (mode === "release_day" && !hasReleaseDate) {
    return "detected";
  }
  if (mode === "episode_timing" && !hasEpisodeTiming) {
    return hasReleaseDate ? "release_day" : "detected";
  }
  return mode;
}

function selectionSubjectLabel(summary) {
  const count = Number(summary?.displayCount || 0);
  if (summary?.isMixed) {
    return `${count} selected items (${summary.movieCount} movie${summary.movieCount === 1 ? "" : "s"}, ${summary.episodeCount} episode${summary.episodeCount === 1 ? "" : "s"})`;
  }
  if (summary?.hasMovies) {
    return `${count} selected movie${count === 1 ? "" : "s"}`;
  }
  return `${count} selected episode${count === 1 ? "" : "s"}`;
}

export function bulkDismissConfirmation(summary) {
  const count = Number(summary?.displayCount || 0);
  const subject = selectionSubjectLabel(summary);
  return {
    title: "Dismiss selected reviews",
    body: `Keep ${subject} unwatched and mark them unplayed across Plex, Emby, Jellyfin, and connected trackers (including Trakt)? Items will be processed sequentially (up to ${BULK_REVIEW_BATCH_CAP} per batch).`,
    confirmLabel: `Dismiss ${count} item${count === 1 ? "" : "s"}`,
    danger: true,
  };
}

export function bulkItemDecision(item) {
  const { mode } = item;
  if (mode === "unwatched") return { action: "dismiss", mode, watchedAt: "" };
  if (mode === "release_day") return { mode, watchedAt: `${item.releaseDate}T00:00:00.000Z` };
  if (mode === "detected" && item.detectedAt) return { mode, watchedAt: item.detectedAt };
  if (mode === "episode_timing") return { mode, watchedAt: item.episodeTiming.watchedAt };
  if (mode === "custom") {
    const date = new Date(item.customValue);
    return { mode, watchedAt: Number.isFinite(date.getTime()) ? date.toISOString() : "" };
  }
  return { mode: "now", watchedAt: "" };
}

export function describeItemWatchDatePreview(item) {
  const { mode, watchedAt } = bulkItemDecision(item);
  if (mode === "unwatched") return "Mark unwatched and clear review";
  if (mode === "now") {
    return item.mode === "detected" ? "Time of saving (detection time unavailable)" : "Time of saving";
  }
  if (!watchedAt) return "Choose a date and time";
  if (mode === "release_day") {
    return `${formatDateDayOnly(watchedAt)} (${item.isEpisode ? "air date" : "release date"})`;
  }
  if (mode === "episode_timing") {
    const { direction, anchorCode } = item.episodeTiming;
    return `${formatDate(watchedAt)} (${direction} ${anchorCode})`;
  }
  return mode === "detected" ? `${formatDate(watchedAt)} (detection time)` : formatDate(watchedAt);
}

export function summarizeBulkConfirmItems(items = []) {
  const counts = { episode_timing: 0, release_day: 0, detected: 0, now: 0, custom: 0, unwatched: 0 };
  for (const item of Array.isArray(items) ? items : []) {
    counts[bulkItemDecision(item).mode] += 1;
  }
  const parts = [];
  if (counts.episode_timing) parts.push(`${counts.episode_timing} same as other episodes`);
  if (counts.release_day) parts.push(`${counts.release_day} release/air date`);
  if (counts.detected) parts.push(`${counts.detected} detection time`);
  if (counts.now) parts.push(`${counts.now} now`);
  if (counts.custom) parts.push(`${counts.custom} custom date`);
  if (counts.unwatched) parts.push(`${counts.unwatched} mark unwatched`);
  return parts.join(" · ");
}

export function buildBulkConfirmItems(reviews = [], requestedMode = DEFAULT_BULK_REVIEW_MODE) {
  const list = (Array.isArray(reviews) ? reviews : []).filter(isBulkSelectableReview);
  const grouped = new Map();
  for (const review of list) {
    const key = displayUnitKey(review);
    let entry = grouped.get(key);
    if (!entry) {
      entry = {
        key,
        reviewIds: [],
        reviews: [],
        sources: [],
        isEpisode: isEpisode(review),
        title: isEpisode(review) ? reviewShowTitle(review) : (String(review.title || review.media?.title || "Unknown movie").trim() || "Unknown movie"),
        code: isEpisode(review) ? reviewEpisodeCode(review) : "",
        episodeTitle: isEpisode(review) ? reviewEpisodeTitle(review) : "",
        releaseDate: "",
        detectedAt: "",
        episodeTiming: null,
      };
      grouped.set(key, entry);
    }
    entry.reviewIds.push(String(review.id));
    entry.reviews.push(review);
    const src = reviewSourceLabel(review);
    if (src && !entry.sources.includes(src)) entry.sources.push(src);
    if (!entry.episodeTitle && isEpisode(review)) entry.episodeTitle = reviewEpisodeTitle(review);
    if (!entry.episodeTiming && reviewHasEpisodeTiming(review)) {
      entry.episodeTiming = review.episode_timing;
    }
    const rel = reviewReleaseDate(review);
    if (!entry.releaseDate && rel) entry.releaseDate = rel;
    const det = reviewDetectedIso(review);
    if (det && (!entry.detectedAt || Date.parse(det) > Date.parse(entry.detectedAt))) {
      entry.detectedAt = det;
    }
  }

  return [...grouped.values()].map((entry) => {
    const hasReleaseDate = Boolean(entry.releaseDate);
    const hasEpisodeTiming = Boolean(entry.episodeTiming);
    const mode = effectiveItemMode(requestedMode, hasReleaseDate, hasEpisodeTiming);
    const customSeed = entry.detectedAt || entry.releaseDate || new Date().toISOString();
    return {
      ...entry,
      hasReleaseDate,
      hasEpisodeTiming,
      mode,
      customValue: toDateTimeInputValue(customSeed) || toDateTimeInputValue(new Date()),
    };
  });
}

function itemDisplayLabel(item) {
  if (!item.isEpisode) return item.title;
  return `${item.title} ${item.code}${item.episodeTitle ? ` - ${item.episodeTitle}` : ""}`;
}

function mergeWithStoredItem(item) {
  const previous = inlineDateItems.get(item.key);
  if (!previous?.edited) return item;
  return {
    ...item,
    mode: effectiveItemMode(previous.mode, item.hasReleaseDate, item.hasEpisodeTiming),
    customValue: previous.customValue || item.customValue,
    edited: true,
  };
}

export function syncInlineReviewItems(reviews = []) {
  const items = buildBulkConfirmItems(reviews, DEFAULT_BULK_REVIEW_MODE).map(mergeWithStoredItem);
  inlineDateItems = new Map(items.map((item) => [item.key, item]));
  return inlineDateItems;
}

export function getInlineReviewDecisionItem(reviews = []) {
  const list = (Array.isArray(reviews) ? reviews : [reviews]).filter(isBulkSelectableReview);
  if (!list.length) return null;
  const built = buildBulkConfirmItems(list, DEFAULT_BULK_REVIEW_MODE)[0];
  if (!built) return null;
  const merged = mergeWithStoredItem(built);
  inlineDateItems.set(merged.key, merged);
  return merged;
}

export function validateInlineDecision(item, { now = Date.now() } = {}) {
  if (!item) return { ok: false, error: "Watch decision is unavailable.", selector: "" };
  const decision = bulkItemDecision(item);
  const title = itemDisplayLabel(item);
  if (decision.mode === "custom" && !decision.watchedAt) {
    return {
      ok: false,
      error: `Choose a valid date and time for "${title}".`,
      item,
      selector: "[data-bulk-confirm-item-datetime]",
    };
  }
  if (decision.watchedAt && Date.parse(decision.watchedAt) > now + 60_000) {
    return {
      ok: false,
      error: `The watch date for "${title}" is in the future. Choose an earlier date.`,
      item,
      selector: item.mode === "custom" ? "[data-bulk-confirm-item-datetime]" : "[data-bulk-item-mode-choice]",
    };
  }
  return { ok: true, decision };
}

export function validateBulkSelectionDecisions(items = [], { now = Date.now() } = {}) {
  const itemDecisions = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const check = validateInlineDecision(item, { now });
    if (!check.ok) return check;
    for (const id of item.reviewIds) {
      itemDecisions.set(id, check.decision);
    }
  }
  return { ok: true, itemDecisions };
}

function dateChoicePillHtml({ value, label, selected = false, disabled = false, title = "", dataAttr = "", keyAttr = "" } = {}) {
  return `<button class="manual-watch-review-date-pill${selected ? " is-selected" : ""}" type="button" ${dataAttr}="${escapeAttribute(value)}"${keyAttr ? ` ${keyAttr}` : ""} aria-pressed="${selected ? "true" : "false"}"${disabled ? " disabled" : ""}${title ? ` title="${escapeAttribute(title)}"` : ""}>${escapeHtml(label)}</button>`;
}

export function renderInlineReviewDecisionBarHtml(reviews = [], factsHtml = "", { disabled = false } = {}) {
  const item = getInlineReviewDecisionItem(reviews);
  if (!item) return "";
  const isDisabled = disabled || bulkBusy;
  const maxDateTime = toDateTimeInputValue(new Date());
  const label = escapeAttribute(itemDisplayLabel(item));
  const key = escapeAttribute(item.key);
  const keyAttr = `data-bulk-item-key="${key}"`;
  const pills = [
    ...(item.isEpisode ? [dateChoicePillHtml({
      value: "episode_timing",
      label: "Same as other episodes",
      selected: item.mode === "episode_timing",
      disabled: isDisabled || !item.hasEpisodeTiming,
      title: item.hasEpisodeTiming ? "" : "No other watched episodes in this season",
      dataAttr: "data-bulk-item-mode-choice",
      keyAttr,
    })] : []),
    dateChoicePillHtml({
      value: "release_day",
      label: item.isEpisode ? "Air date" : "Release date",
      selected: item.mode === "release_day",
      disabled: isDisabled || !item.hasReleaseDate,
      title: item.hasReleaseDate ? "" : `${item.isEpisode ? "Air" : "Release"} date unavailable`,
      dataAttr: "data-bulk-item-mode-choice",
      keyAttr,
    }),
    dateChoicePillHtml({
      value: "detected",
      label: "Detection time",
      selected: item.mode === "detected",
      disabled: isDisabled,
      dataAttr: "data-bulk-item-mode-choice",
      keyAttr,
    }),
    dateChoicePillHtml({
      value: "now",
      label: "Now",
      selected: item.mode === "now",
      disabled: isDisabled,
      dataAttr: "data-bulk-item-mode-choice",
      keyAttr,
    }),
    dateChoicePillHtml({
      value: "custom",
      label: "Pick date & time…",
      selected: item.mode === "custom",
      disabled: isDisabled,
      dataAttr: "data-bulk-item-mode-choice",
      keyAttr,
    }),
  ].join("");

  return `
    <div class="manual-watch-review-inline-bar" data-bulk-item-row ${keyAttr}>
      <div class="manual-watch-review-facts">
        ${factsHtml}
        <div class="manual-watch-review-fact manual-watch-review-fact--will-save" data-bulk-item-preview-wrap ${keyAttr}>
          <span class="manual-watch-review-fact-label">Will save</span>
          <span class="manual-watch-review-fact-value" data-bulk-item-preview aria-live="polite">${escapeHtml(describeItemWatchDatePreview(item))}</span>
        </div>
      </div>
      <div class="manual-watch-review-date-options" role="group" aria-label="Watch date options for ${label}">
        ${pills}
        <input class="field manual-watch-review-bulk-item-datetime" type="datetime-local" data-bulk-confirm-item-datetime ${keyAttr} value="${escapeAttribute(item.customValue)}" max="${escapeAttribute(maxDateTime)}" aria-label="Custom date and time for ${label}"${item.mode === "custom" ? "" : " hidden"}${isDisabled ? " disabled" : ""} />
      </div>
      <div class="manual-watch-review-confirm-action manual-watch-review-actions">
        <button class="button-primary" type="button" data-manual-watch-review-confirm${isDisabled ? " disabled" : ""}>Confirm watched</button>
      </div>
    </div>
  `;
}

function escapeSelectorAttr(value = "") {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(String(value));
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function syncInlineItemUi(scopeRoot, item, { focusCustom = false } = {}) {
  if (!scopeRoot || !item) return;
  const escaped = escapeSelectorAttr(item.key);
  const preview = scopeRoot.querySelector?.(`[data-bulk-item-preview-wrap][data-bulk-item-key="${escaped}"] [data-bulk-item-preview]`)
    || scopeRoot.querySelector?.("[data-bulk-item-preview]");
  if (preview) preview.textContent = describeItemWatchDatePreview(item);
  const row = scopeRoot.querySelector?.(`[data-bulk-item-row][data-bulk-item-key="${escaped}"]`) || scopeRoot;
  for (const pill of row.querySelectorAll?.("[data-bulk-item-mode-choice]") || []) {
    const selected = pill.dataset.bulkItemModeChoice === item.mode;
    pill.classList?.toggle?.("is-selected", selected);
    pill.setAttribute?.("aria-pressed", selected ? "true" : "false");
  }
  const dt = row.querySelector?.("[data-bulk-confirm-item-datetime]");
  if (dt) {
    dt.hidden = item.mode !== "custom";
    if (item.mode === "custom") {
      if (item.customValue && dt.value !== item.customValue) dt.value = item.customValue;
      if (focusCustom) dt.focus?.();
    }
  }
}

function selectedInlineItems(allReviews = []) {
  const selected = selectedBulkReviews(allReviews);
  return buildBulkConfirmItems(selected, DEFAULT_BULK_REVIEW_MODE).map((item) => {
    const merged = mergeWithStoredItem(item);
    inlineDateItems.set(merged.key, merged);
    return merged;
  });
}

function uniformSelectedMode(items = []) {
  if (!items.length) return "";
  const first = items[0].mode;
  return items.every((item) => item.mode === first) ? first : "";
}

function syncBulkBarFromInlineEdit(container, allReviews = []) {
  if (!container?.querySelector) return;
  const items = selectedInlineItems(allReviews);
  if (!items.length) return;
  const summaryEl = container.querySelector("[data-bulk-bar-summary]");
  if (summaryEl) summaryEl.textContent = `Selected: ${summarizeBulkConfirmItems(items)}`;
  const uniform = uniformSelectedMode(items);
  sharedBulkMode = uniform;
  for (const pill of container.querySelectorAll?.("[data-manual-watch-review-bulk-apply-mode]") || []) {
    const selected = pill.dataset.manualWatchReviewBulkApplyMode === uniform;
    pill.classList?.toggle?.("is-selected", selected);
    pill.setAttribute?.("aria-pressed", selected ? "true" : "false");
  }
  const sharedDt = container.querySelector("[data-manual-watch-review-bulk-shared-datetime]");
  if (sharedDt) sharedDt.hidden = uniform !== "custom";
}

export function reviewSelectCheckboxHtml({
  ids = [],
  label = "Select item",
  scope = "item",
  groupKey = "",
  seasonKey = "",
} = {}) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return "";
  const checked = isReviewSelected(list);
  const partial = !checked && isReviewPartiallySelected(list);
  const attrs = [
    `data-manual-watch-review-select="${escapeAttribute(scope)}"`,
    `data-manual-watch-review-select-ids="${escapeAttribute(list.join(","))}"`,
    groupKey ? `data-manual-watch-review-group-key="${escapeAttribute(groupKey)}"` : "",
    seasonKey ? `data-manual-watch-review-season-key="${escapeAttribute(seasonKey)}"` : "",
    partial ? `data-indeterminate="true"` : "",
  ].filter(Boolean).join(" ");

  return `<label class="manual-watch-review-select-box" title="${escapeAttribute(label)}"><input type="checkbox" class="manual-watch-review-select-input" ${attrs} aria-label="${escapeAttribute(label)}"${checked ? " checked" : ""} /></label>`;
}

export function renderBulkReviewBar({ visibleReviews = [], allReviews = [] } = {}) {
  const selectableVisible = (Array.isArray(visibleReviews) ? visibleReviews : []).filter(isBulkSelectableReview);
  if (!selectableVisible.length) return "";

  const sourceReviews = allReviews.length ? allReviews : selectableVisible;
  syncInlineReviewItems(sourceReviews);

  const visibleIds = selectableVisible.map((review) => String(review.id));
  const selected = selectedBulkReviews(sourceReviews);
  const summary = bulkSelectionSummary(selected);
  const selectedItems = summary.overCap ? [] : selectedInlineItems(sourceReviews);

  const visibleSelectedCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const visibleUnits = new Set(selectableVisible.map(displayUnitKey)).size;
  const allVisibleChecked = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const cappedAllChecked = !allVisibleChecked && visibleUnits > BULK_REVIEW_BATCH_CAP && summary.displayCount >= BULK_REVIEW_BATCH_CAP;
  const partialVisible = !allVisibleChecked && !cappedAllChecked && visibleSelectedCount > 0;
  const selectAllLabel = visibleUnits > BULK_REVIEW_BATCH_CAP
    ? `Select first ${BULK_REVIEW_BATCH_CAP} visible`
    : `Select all (${visibleUnits})`;

  const uniformMode = uniformSelectedMode(selectedItems);
  const activeApplyMode = sharedBulkMode || uniformMode;
  const maxDateTime = toDateTimeInputValue(new Date());
  const customInputValue = sharedCustomValue || selectedItems[0]?.customValue || maxDateTime;
  const breakdown = selectedItems.length ? summarizeBulkConfirmItems(selectedItems) : "";
  const controlsDisabled = bulkBusy || summary.overCap;
  const bulkDatePills = summary.displayCount ? [
    ...(summary.hasEpisodes ? [dateChoicePillHtml({
      value: "episode_timing",
      label: "Same as other episodes",
      selected: activeApplyMode === "episode_timing",
      disabled: controlsDisabled || !summary.episodeTimingAllowed,
      title: summary.episodeTimingAllowed ? "" : "No watched episodes in the selected seasons",
      dataAttr: "data-manual-watch-review-bulk-apply-mode",
    })] : []),
    dateChoicePillHtml({
      value: "release_day",
      label: summary.isMixed ? "Release / air date" : summary.hasEpisodes ? "Air date" : "Release date",
      selected: activeApplyMode === "release_day",
      disabled: controlsDisabled || !summary.hasAnyReleaseDate,
      dataAttr: "data-manual-watch-review-bulk-apply-mode",
    }),
    dateChoicePillHtml({
      value: "detected",
      label: "Detection time",
      selected: activeApplyMode === "detected",
      disabled: controlsDisabled,
      dataAttr: "data-manual-watch-review-bulk-apply-mode",
    }),
    dateChoicePillHtml({
      value: "now",
      label: "Now",
      selected: activeApplyMode === "now",
      disabled: controlsDisabled,
      dataAttr: "data-manual-watch-review-bulk-apply-mode",
    }),
    dateChoicePillHtml({
      value: "custom",
      label: "Pick date & time…",
      selected: activeApplyMode === "custom",
      disabled: controlsDisabled,
      dataAttr: "data-manual-watch-review-bulk-apply-mode",
    }),
  ].join("") : "";

  return `
    <div class="manual-watch-review-bulk-bar${summary.displayCount ? " has-selection" : ""}" role="region" aria-label="Bulk review actions">
      <div class="manual-watch-review-bulk-left">
        <label class="manual-watch-review-select-all">
          <input type="checkbox" class="manual-watch-review-select-input" data-manual-watch-review-select-all${allVisibleChecked || cappedAllChecked ? " checked" : ""}${partialVisible ? ' data-indeterminate="true"' : ""}${bulkBusy ? " disabled" : ""} />
          <span>${escapeHtml(selectAllLabel)}</span>
        </label>
        <span class="manual-watch-review-bulk-count" aria-live="polite">
          ${summary.displayCount
            ? `${summary.displayCount} selected${summary.overCap ? ` (max ${BULK_REVIEW_BATCH_CAP})` : ""}`
            : "Tick items below to confirm or dismiss together"}
        </span>
      </div>
      ${summary.displayCount ? `
        <div class="manual-watch-review-bulk-controls">
          <button class="button-primary" type="button" data-manual-watch-review-bulk-action="approve"${controlsDisabled ? " disabled" : ""}>Confirm selected (${summary.displayCount})</button>
          <button class="button-danger" type="button" data-manual-watch-review-bulk-action="dismiss"${controlsDisabled ? " disabled" : ""}>Dismiss selected (${summary.displayCount})</button>
          <button class="button-ghost" type="button" data-manual-watch-review-bulk-clear${bulkBusy ? " disabled" : ""}>Clear</button>
        </div>
        <div class="manual-watch-review-bulk-apply-row">
          <span class="manual-watch-review-fact-label">Set selected dates</span>
          <div class="manual-watch-review-date-options" role="group" aria-label="Set watch date for all selected items">
            ${bulkDatePills}
            <input class="field manual-watch-review-bulk-shared-datetime" type="datetime-local" data-manual-watch-review-bulk-shared-datetime value="${escapeAttribute(customInputValue)}" max="${escapeAttribute(maxDateTime)}" aria-label="Shared custom date and time for all selected items"${activeApplyMode === "custom" ? "" : " hidden"}${controlsDisabled ? " disabled" : ""} />
          </div>
        </div>
      ` : ""}
      ${summary.overCap
        ? `<p class="manual-watch-review-bulk-note is-warning" role="alert">Select at most ${BULK_REVIEW_BATCH_CAP} items per batch (currently ${summary.displayCount} selected).</p>`
        : breakdown
          ? `<p class="manual-watch-review-bulk-note" data-bulk-bar-summary aria-live="polite">Selected: ${escapeHtml(breakdown)}</p>`
          : ""}
    </div>
  `;
}

export function syncIndeterminateCheckboxes(container) {
  if (!container?.querySelectorAll) return;
  for (const input of container.querySelectorAll('input[type="checkbox"][data-indeterminate="true"]')) {
    input.indeterminate = true;
  }
}

// Shared sequential batch runner for single-episode multi-provider and
// multi-select actions. Always posts one single-item review endpoint call at a
// time so identity revalidation, telemetry, and Trakt unwatch guards stay
// identical.
export async function runSequentialReviewBatch(reviews, {
  action = "approve",
  mode = DEFAULT_BULK_REVIEW_MODE,
  watchedAt = "",
  continueOnError = false,
  postAction,
  onOptimisticRemove,
  onItemComplete,
  onRestoreFailed,
  onProgress,
  resolveItemMode,
  resolveItemDecision,
} = {}) {
  const records = Array.isArray(reviews) ? [...reviews] : [];
  if (!records.length) {
    return { completed: 0, total: 0, failed: [], unresolved: [] };
  }

  const optimistic = action === "defer" ? [] : (onOptimisticRemove?.(records) || []);
  let completed = 0;
  const failed = [];
  let stoppedEarly = false;

  for (let index = 0; index < records.length; index += 1) {
    const review = records[index];
    const resolved = typeof resolveItemDecision === "function"
      ? resolveItemDecision(review, mode, watchedAt)
      : {
          mode: typeof resolveItemMode === "function" ? resolveItemMode(review, mode) : mode,
          watchedAt,
        };
    const itemMode = resolved?.mode ?? mode;
    const itemWatchedAt = resolved?.watchedAt ?? watchedAt;
    onProgress?.({ index, completed, total: records.length, review });
    try {
      await postAction(review.id, resolved?.action || action, itemMode, itemWatchedAt);
      if (action !== "defer") onItemComplete?.(review.id);
      completed += 1;
    } catch (error) {
      failed.push({ review, error });
      if (!continueOnError) {
        stoppedEarly = true;
        break;
      }
    }
  }

  const unresolved = stoppedEarly
    ? records.slice(completed)
    : failed.map((entry) => entry.review);

  if (unresolved.length && optimistic.length) {
    onRestoreFailed?.(unresolved);
  }

  return {
    completed,
    total: records.length,
    failed,
    unresolved,
  };
}

export function handleBulkSelectionClick(event, { getFilteredReviews, getAllReviews, onRender, container } = {}) {
  const bulkModeBtn = event.target.closest?.("[data-manual-watch-review-bulk-apply-mode]");
  if (bulkModeBtn && !bulkModeBtn.disabled) {
    const allReviews = getAllReviews?.() || getFilteredReviews?.() || [];
    const items = selectedInlineItems(allReviews);
    const requestedMode = String(bulkModeBtn.dataset.manualWatchReviewBulkApplyMode || "");
    if (!requestedMode || !items.length) return true;
    sharedBulkMode = requestedMode;
    if (requestedMode === "custom" && !sharedCustomValue) {
      sharedCustomValue = items[0]?.customValue || toDateTimeInputValue(new Date());
    }
    for (const item of items) {
      item.mode = effectiveItemMode(requestedMode, item.hasReleaseDate, item.hasEpisodeTiming);
      if (requestedMode === "custom" && sharedCustomValue) {
        item.customValue = sharedCustomValue;
      }
      item.edited = true;
      inlineDateItems.set(item.key, item);
    }
    onRender?.();
    return true;
  }

  const itemModeBtn = event.target.closest?.("[data-bulk-item-mode-choice]");
  if (itemModeBtn && !itemModeBtn.disabled) {
    const key = itemModeBtn.dataset.bulkItemKey;
    const item = key && inlineDateItems.get(key);
    if (!item) return true;
    item.mode = effectiveItemMode(itemModeBtn.dataset.bulkItemModeChoice, item.hasReleaseDate, item.hasEpisodeTiming);
    item.edited = true;
    const card = itemModeBtn.closest?.("[data-manual-watch-review-id], [data-manual-watch-review-ids]") || container;
    syncInlineItemUi(card, item, { focusCustom: item.mode === "custom" });
    syncBulkBarFromInlineEdit(container, getAllReviews?.() || getFilteredReviews?.() || []);
    return true;
  }

  return false;
}

export function handleBulkSelectionChange(event, { getFilteredReviews, getAllReviews, onRender, container } = {}) {
  const sharedDt = event.target.closest?.("[data-manual-watch-review-bulk-shared-datetime]");
  if (sharedDt) {
    sharedCustomValue = sharedDt.value;
    const allReviews = getAllReviews?.() || getFilteredReviews?.() || [];
    const items = selectedInlineItems(allReviews);
    for (const item of items) {
      if (item.mode !== "custom") continue;
      item.customValue = sharedDt.value;
      item.edited = true;
      inlineDateItems.set(item.key, item);
      syncInlineItemUi(container, item);
    }
    syncBulkBarFromInlineEdit(container, allReviews);
    return true;
  }

  const itemDt = event.target.closest?.("[data-bulk-confirm-item-datetime]");
  if (itemDt) {
    const item = inlineDateItems.get(itemDt.dataset.bulkItemKey);
    if (!item) return false;
    item.customValue = itemDt.value;
    item.edited = true;
    const card = itemDt.closest?.("[data-manual-watch-review-id], [data-manual-watch-review-ids]") || container;
    syncInlineItemUi(card, item);
    syncBulkBarFromInlineEdit(container, getAllReviews?.() || getFilteredReviews?.() || []);
    return true;
  }

  const selectAll = event.target.closest?.("[data-manual-watch-review-select-all]");
  if (selectAll) {
    selectAllVisibleReviews(getFilteredReviews?.() || [], selectAll.checked);
    onRender?.();
    return true;
  }

  const box = event.target.closest?.("[data-manual-watch-review-select]");
  if (box) {
    const ids = String(box.dataset.manualWatchReviewSelectIds || "").split(",").filter(Boolean);
    toggleBulkReviewIds(ids, box.checked);
    onRender?.();
    return true;
  }
  return false;
}

export async function triggerBulkSelectionWorkflow(action, {
  getAllReviews,
  openConfirmDialog,
  runSelectionAction,
  setMessage,
  container,
} = {}) {
  if (bulkBusy) return;
  const allReviews = getAllReviews?.() || [];
  const reviews = selectedBulkReviews(allReviews);
  const summary = bulkSelectionSummary(reviews);
  if (!summary.displayCount) return;
  if (summary.overCap) {
    setMessage?.(`Select at most ${BULK_REVIEW_BATCH_CAP} items per batch.`, "warning");
    return;
  }
  const initialMode = effectiveBulkMode(DEFAULT_BULK_REVIEW_MODE, summary);
  if (action === "approve") {
    const items = selectedInlineItems(allReviews);
    const validation = validateBulkSelectionDecisions(items);
    if (!validation.ok) {
      setMessage?.(validation.error, "error");
      if (validation.item && validation.selector && container?.querySelector) {
        const escapedKey = escapeSelectorAttr(validation.item.key);
        container.querySelector(`[data-bulk-item-row][data-bulk-item-key="${escapedKey}"] ${validation.selector}`)?.focus?.();
      }
      return;
    }
    return runSelectionAction?.(reviews, "approve", initialMode, "", validation.itemDecisions);
  }
  const confirmed = Boolean(await openConfirmDialog?.(bulkDismissConfirmation(summary)));
  if (!confirmed) return;
  return runSelectionAction?.(reviews, action, initialMode, "");
}

function decisionFromMap(itemDecisions, review) {
  if (!itemDecisions) return null;
  const key = String(review?.id ?? "");
  if (itemDecisions instanceof Map) return itemDecisions.get(key) || null;
  if (typeof itemDecisions === "object") return itemDecisions[key] || null;
  return null;
}

export async function executeBulkSelectionAction(reviews, {
  action = "approve",
  mode = DEFAULT_BULK_REVIEW_MODE,
  watchedAt = "",
  itemDecisions = null,
  postAction,
  postBulkAction,
  optimisticallyRemove,
  completeOptimistic,
  restoreOptimistic,
  onRender,
  setMessage,
  policyLabel,
} = {}) {
  const records = Array.isArray(reviews) ? reviews : [];
  if (!records.length || bulkBusy) return null;
  bulkBusy = true;
  const appliedModes = new Set();
  const resolveRecordDecision = (review, fallbackMode, fallbackWatchedAt) => {
    const override = decisionFromMap(itemDecisions, review);
    const resolvedMode = override?.mode || effectiveModeForReview(review, fallbackMode);
    const resolvedWatchedAt = override?.watchedAt ?? (resolvedMode === "custom" ? fallbackWatchedAt : "");
    appliedModes.add(resolvedMode);
    return action === "dismiss" || override?.action === "dismiss"
      ? { action: "dismiss", mode: "", watchedAt: "" }
      : { action: "approve", mode: resolvedMode, watchedAt: resolvedWatchedAt };
  };

  if (typeof postBulkAction === "function") {
    const payloadItems = records.map((review) => {
      const decision = resolveRecordDecision(review, mode, watchedAt);
      return decision.action === "dismiss"
        ? { id: String(review.id), action: "dismiss" }
        : {
          id: String(review.id),
          action: "approve",
          mode: decision.mode,
          ...(decision.watchedAt ? { watched_at: decision.watchedAt } : {}),
        };
    });
    const optimistic = optimisticallyRemove?.(records) || [];
    clearBulkReviewSelection();
    onRender?.();
    try {
      await postBulkAction(action, payloadItems);
      for (const review of records) completeOptimistic?.(review.id);
    } catch (error) {
      if (optimistic.length) {
        restoreOptimistic?.(records);
        onRender?.();
      }
      setMessage?.(error?.message || `Bulk ${action} failed.`, "error");
      return {
        completed: 0,
        total: records.length,
        failed: records.map((review) => ({ review, error })),
        unresolved: records,
      };
    } finally {
      bulkBusy = false;
      onRender?.();
    }
    const hasUnwatches = appliedModes.has("unwatched");
    const singleMode = appliedModes.size === 1 ? [...appliedModes][0] : "";
    const label = singleMode
      ? (typeof policyLabel === "function" ? policyLabel(singleMode) : singleMode)
      : "per-item dates";
    setMessage?.(
      action === "dismiss"
        ? `Queued ${records.length} dismissal${records.length === 1 ? "" : "s"} — updating connected apps in the background.`
        : `Queued ${records.length} watch decision${records.length === 1 ? "" : "s"}${!hasUnwatches ? ` (${label})` : ""} — saving and syncing in the background.`,
      "success",
    );
    return {
      completed: records.length,
      total: records.length,
      failed: [],
      unresolved: [],
      queued: true,
    };
  }

  onRender?.();
  let result;
  try {
    result = await runSequentialReviewBatch(records, {
      action,
      mode,
      watchedAt,
      continueOnError: true,
      postAction,
      resolveItemDecision: resolveRecordDecision,
      onOptimisticRemove: (items) => {
        const removed = optimisticallyRemove?.(items) || [];
        clearBulkReviewSelection();
        onRender?.();
        return removed;
      },
      onItemComplete: completeOptimistic,
      onRestoreFailed: (unresolved) => {
        restoreOptimistic?.(unresolved);
        onRender?.();
      },
      onProgress: ({ index, total }) => {
        setMessage?.(`${action === "dismiss" ? "Dismissing" : "Confirming"} ${index + 1} of ${total}…`, "muted");
      },
    });
  } finally {
    bulkBusy = false;
    onRender?.();
  }
  const hasUnwatches = appliedModes.has("unwatched");
  const verb = action === "dismiss" ? "Dismissed" : hasUnwatches ? "Processed" : "Confirmed";
  if (result.failed.length) {
    const firstErr = result.failed[0]?.error?.message || "One or more items failed.";
    setMessage?.(
      `${verb} ${result.completed} of ${result.total} review records. ${result.failed.length} failed and were kept in review (${firstErr}).`,
      result.completed ? "warning" : "error",
    );
    return result;
  }
  const singleMode = appliedModes.size === 1 ? [...appliedModes][0] : "";
  const label = singleMode
    ? (typeof policyLabel === "function" ? policyLabel(singleMode) : singleMode)
    : "per-item dates";
  setMessage?.(
    `${verb} ${result.completed} review record${result.completed === 1 ? "" : "s"}${action === "approve" && !hasUnwatches ? ` (${label})` : ""}.`,
    "success",
  );
  return result;
}
