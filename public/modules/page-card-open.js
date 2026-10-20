// Posters only on the library and media pages (plan/archive/theme-styles/plan.md,
// step 13). The page toggle (app-events.js) folds every item on Library,
// Discover, History, Watchlist, Ratings and Playlists into its poster; this
// module gives those posters the Dashboard compact rows' behaviour
// (dashboard-modern.js): clicking a folded poster opens that item in place,
// closing whichever was open, and a further click behaves as normal. The open
// item stays open until another poster opens, the page changes, or Posters
// only is switched off. CSS (.page-card-open in styles.css) shows it as it
// looks with Posters only off: wider in a grid, a full-width row in a list.

const POSTER_FRAME_SELECTOR = ".history-card-poster-wrapper, .shared-media-card-poster-wrap";
const OPEN_CLASS = "page-card-open";
const FULL_CLASS = "page-card-open-full";
const PANEL_SELECTOR = '[data-view-panel="explorer"], [data-view-panel="discover"], [data-view-panel="personal-media"], [data-view-panel="history"]';
const CONTAINER_SELECTOR = ".discover-feed-row, .personal-media-card-grid, .personal-media-list-row, .history-list, .history-grid-view, .history-table-view, .movie-grid";
const ITEM_SELECTOR = [
  ".discover-feed-row > .shared-media-card",
  ".personal-media-card-grid > .shared-media-card",
  ".personal-media-list-row > .shared-media-card",
  ".history-list > .history-page-card",
  ".history-grid-view .history-grid-card",
  ".history-table-view .history-list-row",
  ".movie-grid > :is(.explorer-history-card, .folder-card, .explorer-overview-card, .explorer-list-card)",
].join(", ");

// The open item, remembered so a re-render of its page reopens it. The same
// title can sit in several Discover feeds or playlists, so it names the
// item's row (its panel, and the row's position and class there) as well as
// the item.
let openItemRef = null;

function compactPanel(element) {
  const panel = element?.closest?.(PANEL_SELECTOR);
  return panel?.classList.contains("page-card-mode-compact") ? panel : null;
}

function itemId(item) {
  const data = item.dataset || {};
  return data.historyId || data.showKey || data.upNextCardId || data.partWatchedCardId || data.href
    || item.getAttribute("href") || item.querySelector("[href]")?.getAttribute("href") || "";
}

function itemRef(item, panel) {
  const container = item.closest(CONTAINER_SELECTOR);
  const id = itemId(item);
  if (!container || !id) return null;
  return {
    panel: panel.dataset.viewPanel,
    index: [...panel.querySelectorAll(CONTAINER_SELECTOR)].indexOf(container),
    containerClass: container.className,
    id,
  };
}

function clearOpenClasses() {
  document.querySelectorAll(`.${OPEN_CLASS}`).forEach((item) => {
    item.classList.remove(OPEN_CLASS, FULL_CLASS);
    item.style?.removeProperty("--page-card-open-poster-width");
    item.style?.removeProperty("--page-card-open-poster-height");
  });
}

function closeOpenItems() {
  openItemRef = null;
  clearOpenClasses();
}

// An open card in a grid takes three poster slots (styles.css); where fewer
// than three posters fit, it takes the whole row instead of overflowing it.
// Measured from a folded neighbour (or the item itself when it is alone),
// since opening the card changes the grid's tracks.
function fitOpenItem(item) {
  const grid = item.parentElement;
  const style = grid ? getComputedStyle(grid) : null;
  const poster = [...(grid?.children || [])].find((child) => child !== item && child.matches(ITEM_SELECTOR) && child.offsetWidth);
  const referenceItem = poster || item;
  const posterFrame = referenceItem.querySelector?.(POSTER_FRAME_SELECTOR) || referenceItem;
  const posterWidth = posterFrame.offsetWidth || referenceItem.offsetWidth;
  const posterHeight = posterFrame.offsetHeight || referenceItem.offsetHeight || Math.round(posterWidth * 1.5);
  if (posterWidth) {
    item.style?.setProperty("--page-card-open-poster-width", `${posterWidth}px`);
    item.style?.setProperty("--page-card-open-poster-height", `${posterHeight}px`);
  }
  if (!style || !style.display.includes("grid")) return;
  const gap = parseFloat(style.columnGap) || 0;
  const width = grid.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const columns = Math.floor((width + gap) / (referenceItem.offsetWidth + gap));
  item.classList.toggle(FULL_CLASS, columns < 3);
}

// In a sideways-scrolling rail (Discover, Playlists) the opened card is wider
// than its poster and the card that closed shifts the row, so the row itself
// is scrolled to put the card's left edge at the rail's start whenever any of
// it is cut off. Run again once the layout settles, since a closing card or a
// re-render can move it after the first pass.
function revealOpenItem(item) {
  if (!item?.isConnected || !item.classList?.contains(OPEN_CLASS)) return;
  const row = item.parentElement;
  if (row && row.scrollWidth > row.clientWidth && typeof row.getBoundingClientRect === "function") {
    const style = getComputedStyle(row);
    const inset = parseFloat(style.scrollPaddingLeft) || parseFloat(style.paddingLeft) || 0;
    const rowBox = row.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    if (box.left < rowBox.left + inset || box.right > rowBox.right) {
      row.scrollLeft += box.left - rowBox.left - inset;
    }
  }
  item.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

function revealSoon(item) {
  requestAnimationFrame(() => revealOpenItem(item));
  setTimeout(() => revealOpenItem(item), 350);
}

function openItem(item, panel) {
  closeOpenItems();
  openItemRef = itemRef(item, panel);
  fitOpenItem(item);
  item.classList.add(OPEN_CLASS);
  revealSoon(item);
}

// Re-applies the open state to an item a re-render replaced; if its row or
// the item is gone, nothing is open.
function syncOpenItem() {
  const ref = openItemRef;
  if (!ref) return;
  const panel = document.querySelector(`[data-view-panel="${ref.panel}"]`);
  const container = panel?.classList.contains("page-card-mode-compact") ? panel.querySelectorAll(CONTAINER_SELECTOR)[ref.index] : null;
  const current = container?.className === ref.containerClass
    ? [...container.querySelectorAll(ITEM_SELECTOR)].find((item) => item.closest(CONTAINER_SELECTOR) === container && itemId(item) === ref.id)
    : null;
  if (current?.classList.contains(OPEN_CLASS)) return;
  clearOpenClasses();
  if (!current) {
    openItemRef = null;
    return;
  }
  fitOpenItem(current);
  current.classList.add(OPEN_CLASS);
  revealSoon(current);
}

const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";

if (hasDocument) {
  // Capture phase: a folded poster is a link (or holds one), so the first
  // click must open it before the router or the page's own handlers see it.
  document.addEventListener("click", (event) => {
    const item = event.target.closest?.(ITEM_SELECTOR);
    // A playlist episode stack expands on click instead (playlists.js).
    if (!item || item.classList.contains(OPEN_CLASS) || item.dataset?.playlistStack !== undefined || event.target.closest("button")) return;
    const panel = compactPanel(item);
    if (!panel) return;
    event.preventDefault();
    event.stopPropagation();
    openItem(item, panel);
  }, true);

  // Switching Posters only either way folds the open item back.
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-card-mode-toggle]")) closeOpenItems();
  });

  // Arriving on a page, including a menu click on the page already open,
  // folds the open item back.
  document.addEventListener("plembfin:page-entry", closeOpenItems);

  const pageShell = document.querySelector?.(".page-shell");
  if (pageShell && typeof MutationObserver === "function") {
    let frame = 0;
    new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes")) {
        closeOpenItems();
        return;
      }
      if (openItemRef && !frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          syncOpenItem();
        });
      }
    }).observe(pageShell, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-active-view"] });
  }

  if (typeof window !== "undefined") {
    let resizeFrame = 0;
    window.addEventListener("resize", () => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        const item = document.querySelector(".page-card-open.explorer-history-card");
        if (item) fitOpenItem(item);
      });
    }, { passive: true });
  }
}
