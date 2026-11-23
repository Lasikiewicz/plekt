import { escapeAttribute, escapeHtml, formatDate, formatTmdbDate, toDateTimeInputValue } from "./utils.js?v=2.3.0.0.1";

export const BULK_REVIEW_BATCH_CAP = 50;
export const DEFAULT_BULK_REVIEW_MODE = "episode_timing";

const selectedIds = new Set();
let inlineDateItems = new Map();
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

function displayUnitKey(review = {}) {
  if (!isEpisode(review)) return `movie:${String(review.id)}`;
  const media = review.media || {};
  const ids = review.showIds || review.show_ids || media.showIds || media.show_ids || {};
  const showKey = ids.tvdb || ids.tmdb || ids.imdb || String(review.show_title || media.showTitle || review.title || "").toLowerCase().trim();
  const season = review.season ?? media.season ?? "";
  const episode = review.episode ?? media.episode ?? "";
  return `ep:${showKey}:s${season}e${episode}`;
}

export function clearBulkReviewSelection() {
  selectedIds.clear();
  inlineDateItems.clear();
}

export function isBulkReviewBusy() {
  return bulkBusy;
}

export function setBulkReviewBusy(busy) {
  bulkBusy = Boolean(busy);
}

export function pruneBulkReviewSelection(reviews = []) {
  const valid = new Set(
    (Array.isArray(reviews) ? reviews : [])
      .filter(isBulkSelectableReview)
      .map((review) => String(review.id)),
  );
  for (const id of [...selectedIds]) {
    if (!valid.has(id)) selectedIds.delete(id);
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
}

export function selectedBulkReviews(allReviews = []) {
  return (Array.isArray(allReviews) ? allReviews : [])
    .filter((review) => isBulkSelectableReview(review) && selectedIds.has(String(review.id)));
}

export function selectAllVisibleReviews(visibleReviews = [], checked = true, { cap = BULK_REVIEW_BATCH_CAP } = {}) {
  const selectable = (Array.isArray(visibleReviews) ? visibleReviews : []).filter(isBulkSelectableReview);
  if (!checked) {
    for (const review of selectable) selectedIds.delete(String(review.id));
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
    return "release_day";
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

function bulkSubmitLabel(items) {
  if (items.some((item) => item.mode === "unwatched")) return "Save watch decisions";
  return `Mark ${items.length} item${items.length === 1 ? "" : "s"} watched`;
}

function bulkConfirmDescription(items) {
  return items.some((item) => item.mode === "unwatched")
    ? "Plekt will save these decisions. Items marked unwatched will be cleared from review and marked unplayed in connected apps."
    : "Plekt will save these watch dates and sync to your connected apps.";
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

function itemOptionHtml(value, label, { selected = false, disabled = false } = {}) {
  return `<option value="${escapeAttribute(value)}"${selected ? " selected" : ""}${disabled ? " disabled" : ""}>${escapeHtml(label)}</option>`;
}

function itemSourceMetaText(item) {
  const parts = [];
  if (item.sources?.length) parts.push(`Flagged on ${item.sources.join(", ")}`);
  if (item.releaseDate) {
    parts.push(`${item.isEpisode ? "Aired" : "Released"} ${formatDateDayOnly(item.releaseDate)}`);
  }
  return parts.join(" · ");
}

function itemDisplayLabel(item) {
  if (!item.isEpisode) return item.title;
  return `${item.title} ${item.code}${item.episodeTitle ? ` - ${item.episodeTitle}` : ""}`;
}

function buildSelectedWatchDates(reviews, mode) {
  return buildBulkConfirmItems(reviews, mode).map((item) => {
    const previous = inlineDateItems.get(item.key);
    if (!previous?.edited) return item;
    return {
      ...item,
      mode: effectiveItemMode(previous.mode, item.hasReleaseDate, item.hasEpisodeTiming),
      customValue: previous.customValue,
      edited: true,
    };
  });
}

function renderBulkItemControls(item, maxDateTime, disabled = false) {
  const releaseLabel = `${item.isEpisode ? "Air date" : "Release date"}${item.hasReleaseDate ? "" : " (unavailable)"}`;
  const episodeTimingLabel = item.hasEpisodeTiming
    ? "Same as other episodes"
    : "Same as other episodes (no watched episodes in season)";
  const label = escapeAttribute(itemDisplayLabel(item));
  const key = escapeAttribute(item.key);
  const options = [
    ...(item.isEpisode ? [itemOptionHtml("episode_timing", episodeTimingLabel, { selected: item.mode === "episode_timing", disabled: !item.hasEpisodeTiming })] : []),
    itemOptionHtml("release_day", releaseLabel, { selected: item.mode === "release_day", disabled: !item.hasReleaseDate }),
    itemOptionHtml("detected", "Detection time", { selected: item.mode === "detected" }),
    itemOptionHtml("now", "Now", { selected: item.mode === "now" }),
    itemOptionHtml("custom", "Pick date & time…", { selected: item.mode === "custom" }),
    itemOptionHtml("unwatched", "Mark unwatched and clear review", { selected: item.mode === "unwatched" }),
  ].join("");
  return `
    <div class="manual-watch-review-bulk-item-controls">
      <select class="field manual-watch-review-bulk-item-select" data-bulk-confirm-item-mode data-bulk-item-key="${key}" aria-label="Watch decision for ${label}"${disabled ? " disabled" : ""}>
        ${options}
      </select>
      <input class="field manual-watch-review-bulk-item-datetime" type="datetime-local" data-bulk-confirm-item-datetime data-bulk-item-key="${key}" value="${escapeAttribute(item.customValue)}" max="${escapeAttribute(maxDateTime)}" aria-label="Custom date and time for ${label}"${item.mode === "custom" ? "" : " hidden"}${disabled ? " disabled" : ""} />
    </div>
  `;
}

function syncBulkItemPreview(row, item) {
  const preview = row?.querySelector("[data-bulk-item-preview]");
  if (preview) preview.textContent = describeItemWatchDatePreview(item);
}

function updateBulkItemDate(target, items) {
  const select = target.closest?.("[data-bulk-confirm-item-mode]");
  const control = select || target.closest?.("[data-bulk-confirm-item-datetime]");
  const item = control && items.get(control.dataset.bulkItemKey);
  if (!item) return null;
  const row = control.closest("[data-bulk-item-row]");
  if (select) {
    item.mode = effectiveItemMode(select.value, item.hasReleaseDate, item.hasEpisodeTiming);
    const field = row?.querySelector("[data-bulk-confirm-item-datetime]");
    if (field) field.hidden = item.mode !== "custom";
  } else {
    item.customValue = control.value;
  }
  syncBulkItemPreview(row, item);
  return item;
}

export function renderBulkConfirmDialog({
  items = [],
  summary,
  activeMode = DEFAULT_BULK_REVIEW_MODE,
  sharedCustomValue = "",
  maxDateTime = toDateTimeInputValue(new Date()),
  heading = "Review watch decisions",
} = {}) {
  const resolvedSummary = summary || bulkSelectionSummary(items.flatMap((item) => item.reviews || []));
  const effectiveApplyMode = effectiveBulkMode(activeMode, resolvedSummary);
  const subject = selectionSubjectLabel(resolvedSummary);
  const rowsHtml = items.map((item) => {
    const sourceMeta = itemSourceMetaText(item);
    return `
      <li class="manual-watch-review-bulk-item-row" data-bulk-item-row data-bulk-item-key="${escapeAttribute(item.key)}">
        <div class="manual-watch-review-bulk-item-info">
          <div class="manual-watch-review-bulk-item-heading">
            ${item.isEpisode
              ? `<span class="watch-date-episode-code">${escapeHtml(item.code)}</span>`
              : `<span class="manual-watch-review-bulk-item-kind">Movie</span>`}
            <span class="manual-watch-review-bulk-item-title">${escapeHtml(item.title)}</span>
            ${item.isEpisode && item.episodeTitle ? `<span class="manual-watch-review-bulk-item-ep-title">${escapeHtml(item.episodeTitle)}</span>` : ""}
          </div>
          ${sourceMeta ? `<div class="manual-watch-review-bulk-item-meta">${escapeHtml(sourceMeta)}</div>` : ""}
          <div class="manual-watch-review-bulk-item-preview"><span data-bulk-item-preview aria-live="polite">${escapeHtml(describeItemWatchDatePreview(item))}</span></div>
        </div>
        ${renderBulkItemControls(item, maxDateTime)}
      </li>
    `;
  }).join("");

  const episodeAllLabel = !resolvedSummary.episodeTimingAllowed
    ? "Same as other episodes (none available)"
    : resolvedSummary.episodeTimingCount < resolvedSummary.displayCount
      ? "Same as other episodes where available"
      : "Same as other episodes";
  const breakdown = summarizeBulkConfirmItems(items);

  return `
    <div class="watch-date-overlay manual-watch-review-bulk-overlay" role="dialog" aria-modal="true" aria-label="${escapeAttribute(heading)}">
      <div class="watch-date-dialog manual-watch-review-bulk-dialog">
        <div class="watch-date-head">
          <div class="watch-date-head-text">
            <h3>${escapeHtml(heading)}</h3>
            <p class="watch-date-sub">${escapeHtml(subject)}</p>
          </div>
          <button class="watch-date-close" type="button" data-bulk-confirm-cancel aria-label="Cancel">&times;</button>
        </div>
        <div class="manual-watch-review-bulk-summary" aria-live="polite">
          <span class="manual-watch-review-bulk-summary-title" data-bulk-confirm-description>${escapeHtml(bulkConfirmDescription(items))}</span>
          <span class="manual-watch-review-bulk-summary-counts" data-bulk-confirm-summary>${escapeHtml(breakdown)}</span>
        </div>
        <div class="manual-watch-review-bulk-apply-all">
          <label class="manual-watch-review-bulk-apply-label">
            <span>Set all watch dates to</span>
            <select class="field" data-bulk-confirm-apply-all aria-label="Set watched date option for all selected items">
              <option value="episode_timing"${effectiveApplyMode === "episode_timing" ? " selected" : ""}${resolvedSummary.episodeTimingAllowed ? "" : " disabled"}>${escapeHtml(episodeAllLabel)}</option>
              <option value="release_day"${effectiveApplyMode === "release_day" ? " selected" : ""}>Release / air date</option>
              <option value="detected"${effectiveApplyMode === "detected" ? " selected" : ""}>Detection time</option>
              <option value="now"${effectiveApplyMode === "now" ? " selected" : ""}>Now</option>
              <option value="custom"${effectiveApplyMode === "custom" ? " selected" : ""}>Pick date &amp; time…</option>
            </select>
          </label>
          <input class="field manual-watch-review-bulk-shared-datetime" type="datetime-local" data-bulk-confirm-shared-datetime value="${escapeAttribute(sharedCustomValue || "")}" max="${escapeAttribute(maxDateTime)}" aria-label="Shared custom date and time for all selected items"${effectiveApplyMode === "custom" ? "" : " hidden"} />
        </div>
        <div class="watch-date-episodes manual-watch-review-bulk-items">
          <div class="watch-date-episodes-head">
            <span>Selected items</span>
            <span>${items.length}</span>
          </div>
          <ul class="watch-date-episode-list manual-watch-review-bulk-item-list">${rowsHtml}</ul>
        </div>
        <p class="manual-watch-review-bulk-dialog-error" data-bulk-confirm-error role="alert" hidden></p>
        <div class="manual-watch-review-bulk-dialog-footer">
          <div class="manual-watch-review-bulk-dialog-actions">
            <button class="button-ghost" type="button" data-bulk-confirm-cancel>Cancel</button>
            <button class="button-primary" type="button" data-bulk-confirm-submit>${escapeHtml(bulkSubmitLabel(items))}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function openBulkConfirmDialog({ reviews = [], initialMode = DEFAULT_BULK_REVIEW_MODE, items: initialItems, heading } = {}) {
  if (typeof document === "undefined" || !document.body) return Promise.resolve(null);
  const selectable = (Array.isArray(reviews) ? reviews : []).filter(isBulkSelectableReview);
  if (!selectable.length) return Promise.resolve(null);

  const summary = bulkSelectionSummary(selectable);
  let applyMode = effectiveBulkMode(initialMode, summary);
  const items = initialItems || buildBulkConfirmItems(selectable, applyMode);
  const itemByKey = new Map(items.map((item) => [item.key, item]));
  const sharedCustomValue = items[0]?.customValue || toDateTimeInputValue(new Date());

  if (document.body.querySelector(".manual-watch-review-bulk-overlay")) return Promise.resolve(null);
  const trigger = document.activeElement;
  document.body.insertAdjacentHTML("beforeend", renderBulkConfirmDialog({
    items,
    summary,
    activeMode: applyMode,
    sharedCustomValue,
    ...(heading ? { heading } : {}),
  }));
  const overlay = document.body.querySelector(".manual-watch-review-bulk-overlay");
  if (!overlay) return Promise.resolve(null);

  const errorEl = overlay.querySelector("[data-bulk-confirm-error]");
  const summaryEl = overlay.querySelector("[data-bulk-confirm-summary]");
  const descriptionEl = overlay.querySelector("[data-bulk-confirm-description]");
  const submitButton = overlay.querySelector("[data-bulk-confirm-submit]");
  const rows = new Map([...overlay.querySelectorAll("[data-bulk-item-row]")].map((row) => [row.dataset.bulkItemKey, row]));
  const setDialogError = (message = "") => {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  };
  const syncSummary = () => {
    if (summaryEl) summaryEl.textContent = summarizeBulkConfirmItems(items);
    if (descriptionEl) descriptionEl.textContent = bulkConfirmDescription(items);
    if (submitButton) submitButton.textContent = bulkSubmitLabel(items);
  };
  const syncRowPreview = (item) => {
    const row = rows.get(item.key);
    syncBulkItemPreview(row, item);
    return row;
  };

  return new Promise((resolve) => {
    const cleanup = (result) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      trigger?.focus();
      resolve(result);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup(null);
      } else if (event.key === "Tab") {
        const controls = overlay.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled):not([hidden])");
        const start = event.shiftKey ? controls[controls.length - 1] : controls[0];
        const end = event.shiftKey ? controls[0] : controls[controls.length - 1];
        if (document.activeElement === end || !overlay.contains(document.activeElement)) {
          event.preventDefault();
          start?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    overlay.querySelector("[data-bulk-confirm-apply-all]")?.focus();

    overlay.addEventListener("change", (event) => {
      const applySelect = event.target.closest?.("[data-bulk-confirm-apply-all]");
      if (applySelect) {
        applyMode = effectiveBulkMode(applySelect.value, summary);
        const sharedInput = overlay.querySelector("[data-bulk-confirm-shared-datetime]");
        if (sharedInput) {
          sharedInput.hidden = applyMode !== "custom";
          if (applyMode === "custom" && !sharedInput.value) {
            sharedInput.value = sharedCustomValue || toDateTimeInputValue(new Date());
          }
        }
        for (const item of items) {
          item.mode = effectiveItemMode(applyMode, item.hasReleaseDate, item.hasEpisodeTiming);
          if (applyMode === "custom" && sharedInput?.value) {
            item.customValue = sharedInput.value;
          }
          const row = syncRowPreview(item);
          const select = row?.querySelector("[data-bulk-confirm-item-mode]");
          const dt = row?.querySelector("[data-bulk-confirm-item-datetime]");
          if (select) select.value = item.mode;
          if (dt) {
            dt.hidden = item.mode !== "custom";
            if (item.mode === "custom") dt.value = item.customValue || toDateTimeInputValue(new Date());
          }
        }
        syncSummary();
        setDialogError("");
        return;
      }

      const sharedDt = event.target.closest?.("[data-bulk-confirm-shared-datetime]");
      if (sharedDt) {
        for (const item of items) {
          if (item.mode !== "custom") continue;
          item.customValue = sharedDt.value;
          const row = syncRowPreview(item);
          const dt = row?.querySelector("[data-bulk-confirm-item-datetime]");
          if (dt) dt.value = sharedDt.value;
        }
        syncSummary();
        setDialogError("");
        return;
      }

      if (updateBulkItemDate(event.target, itemByKey)) {
        syncSummary();
        setDialogError("");
      }
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest?.("[data-bulk-confirm-cancel]")) {
        cleanup(null);
        return;
      }
      if (event.target.closest?.("[data-bulk-confirm-submit]")) {
        const itemDecisions = new Map();
        const nowLimit = Date.now() + 60_000;
        for (const item of items) {
          const decision = bulkItemDecision(item);
          const title = itemDisplayLabel(item);
          const invalid = decision.mode === "custom" && !decision.watchedAt;
          if (invalid || Date.parse(decision.watchedAt) > nowLimit) {
            setDialogError(invalid
              ? `Choose a valid date and time for "${title}".`
              : `The watch date for "${title}" is in the future. Choose an earlier date.`);
            const selector = item.mode === "custom" ? "[data-bulk-confirm-item-datetime]" : "[data-bulk-confirm-item-mode]";
            rows.get(item.key)?.querySelector(selector)?.focus();
            return;
          }
          for (const id of item.reviewIds) {
            itemDecisions.set(id, decision);
          }
        }
        cleanup({ mode: applyMode, watchedAt: "", itemDecisions });
      }
    });
  });
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

  const visibleIds = selectableVisible.map((review) => String(review.id));
  const selected = selectedBulkReviews(allReviews.length ? allReviews : selectableVisible);
  const summary = bulkSelectionSummary(selected);

  const visibleSelectedCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const visibleUnits = new Set(selectableVisible.map(displayUnitKey)).size;
  const allVisibleChecked = visibleIds.length > 0 && visibleSelectedCount === visibleIds.length;
  const cappedAllChecked = !allVisibleChecked && visibleUnits > BULK_REVIEW_BATCH_CAP && summary.displayCount >= BULK_REVIEW_BATCH_CAP;
  const partialVisible = !allVisibleChecked && !cappedAllChecked && visibleSelectedCount > 0;
  const selectAllLabel = visibleUnits > BULK_REVIEW_BATCH_CAP
    ? `Select first ${BULK_REVIEW_BATCH_CAP} visible`
    : `Select all (${visibleUnits})`;

  const previewItems = summary.overCap ? [] : buildSelectedWatchDates(
    selected, effectiveBulkMode(DEFAULT_BULK_REVIEW_MODE, summary),
  );
  if (!summary.overCap) inlineDateItems = new Map(previewItems.map((item) => [item.key, item]));
  const maxDateTime = toDateTimeInputValue(new Date());
  const preview = previewItems.length ? `
    <div class="manual-watch-review-selection-dates">
      <p class="manual-watch-review-bulk-note"><strong>Proposed watch decisions</strong></p>
      <ul aria-label="Proposed watch decisions">
        ${previewItems.map((item) => `
          <li data-bulk-item-row>
            <div class="manual-watch-review-selection-date-info">
              <strong>${escapeHtml(itemDisplayLabel(item))}</strong>
              <span data-bulk-item-preview aria-live="polite">${escapeHtml(describeItemWatchDatePreview(item))}</span>
            </div>
            ${renderBulkItemControls(item, maxDateTime, bulkBusy)}
          </li>
        `).join("")}
      </ul>
    </div>
  ` : "";

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
          <button class="button-primary" type="button" data-manual-watch-review-bulk-action="approve"${bulkBusy || summary.overCap ? " disabled" : ""}>Confirm selected (${summary.displayCount})…</button>
          <button class="button-danger" type="button" data-manual-watch-review-bulk-action="dismiss"${bulkBusy || summary.overCap ? " disabled" : ""}>Dismiss selected (${summary.displayCount})</button>
          <button class="button-ghost" type="button" data-manual-watch-review-bulk-clear${bulkBusy ? " disabled" : ""}>Clear</button>
        </div>
      ` : ""}
      ${summary.overCap ? `<p class="manual-watch-review-bulk-note is-warning" role="alert">Select at most ${BULK_REVIEW_BATCH_CAP} items per batch (currently ${summary.displayCount} selected).</p>` : preview}
    </div>
  `;
}

export function syncIndeterminateCheckboxes(container) {
  if (!container?.querySelectorAll) return;
  for (const input of container.querySelectorAll('input[type="checkbox"][data-indeterminate="true"]')) {
    input.indeterminate = true;
  }
}

// Shared sequential batch runner for show, season, episode, and multi-select
// actions. Always posts one single-item review endpoint call at a time so
// identity revalidation, telemetry, and Trakt unwatch guards stay identical.
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

export function handleBulkSelectionChange(event, { getFilteredReviews, onRender } = {}) {
  const editedItem = updateBulkItemDate(event.target, inlineDateItems);
  if (editedItem) {
    editedItem.edited = true;
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
  openBulkConfirm = openBulkConfirmDialog,
  runSelectionAction,
  setMessage,
} = {}) {
  if (bulkBusy) return;
  const reviews = selectedBulkReviews(getAllReviews?.() || []);
  const summary = bulkSelectionSummary(reviews);
  if (!summary.displayCount) return;
  if (summary.overCap) {
    setMessage?.(`Select at most ${BULK_REVIEW_BATCH_CAP} items per batch.`, "warning");
    return;
  }
  const initialMode = effectiveBulkMode(DEFAULT_BULK_REVIEW_MODE, summary);
  if (action === "approve") {
    const items = buildSelectedWatchDates(reviews, initialMode);
    const plan = await openBulkConfirm({ reviews, initialMode, items });
    if (!plan) return;
    return runSelectionAction?.(reviews, "approve", plan.mode, "", plan.itemDecisions);
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
  onRender?.();
  const appliedModes = new Set();
  let result;
  try {
    result = await runSequentialReviewBatch(records, {
      action,
      mode,
      watchedAt,
      continueOnError: true,
      postAction,
      resolveItemDecision: (review, fallbackMode, fallbackWatchedAt) => {
        const override = decisionFromMap(itemDecisions, review);
        const resolvedMode = override?.mode || effectiveModeForReview(review, fallbackMode);
        const resolvedWatchedAt = override?.watchedAt ?? (resolvedMode === "custom" ? fallbackWatchedAt : "");
        appliedModes.add(resolvedMode);
        return override?.action === "dismiss"
          ? { action: "dismiss", mode: "", watchedAt: "" }
          : { mode: resolvedMode, watchedAt: resolvedWatchedAt };
      },
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
