// Artwork checks for recapture.mjs: posters cut off by a rail or the shot edge, and artwork
// whose box shape differs from the image's own shape (squashed with `fill`, heavily cropped
// with `cover`). The page side only measures; the warnings are worked out here so they can
// be tested without a browser. Nothing on the page is changed.

// Intentional stand-ins (the spoiler mask for unwatched episodes) are neither missing art nor
// distorted art.
export const PLACEHOLDER_PATTERN = "spoiler-placeholder";

// The largest accepted shapeDifference between an artwork's box and its image (user's choice,
// 16 October 2026: accepted 2.1.0 pictures measured at most 0.08, rejected history posters 0.46).
export const DEFAULT_ARTWORK_THRESHOLD = 0.1;

// A cut-off card showing less than this percentage is a sliver at a rail edge and is not
// flagged (user's choice, 16 October 2026: an accepted 3% sliver; rejected cards showed 31%, 79%).
export const MIN_SHOWN_PERCENT = 10;

// Artwork smaller than this (icons, badges, avatars) is not measured.
export const MIN_ARTWORK = 40;

// Runs in the page through page.evaluate, so it must not use anything from this module's scope.
// `area` is the shot rectangle in viewport pixels; `vertical` is true only for element and crop
// shots, whose bottom edge is chosen. A page screenshot always ends mid-page, and a composed
// page spans the whole height, so only sideways cut-offs count for those.
export function measureArtwork({ area, vertical, placeholder, minSize }) {
  const placeholderRe = new RegExp(placeholder);
  const label = (img) => img.alt || img.closest("[aria-label]")?.getAttribute("aria-label") || img.closest("[title]")?.getAttribute("title") || (img.currentSrc || img.src || "").split("/").pop().split("?")[0] || "image";
  const rows = [];
  for (const img of document.images) {
    if (placeholderRe.test(`${img.className} ${img.src}`)) continue;
    const st = getComputedStyle(img);
    if (st.visibility === "hidden" || st.display === "none" || st.opacity === "0") continue;
    const r = img.getBoundingClientRect();
    if (r.width < minSize || r.height < minSize) continue;
    // The part of the image left after every clipping ancestor and the shot itself.
    let x0 = Math.max(r.left, area.x), x1 = Math.min(r.right, area.x + area.width);
    const y0 = Math.max(r.top, area.y), y1 = Math.min(r.bottom, area.y + area.height);
    // A card cut only by the edge of a scrolling rail is the rail's scroll hint, not a framing
    // fault (user's choice, 16 October 2026, TV detail Images/Trailers/Related Shows rails).
    let railW = r.width;
    for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.overflowX !== "visible") {
        const pr = p.getBoundingClientRect();
        x0 = Math.max(x0, pr.left); x1 = Math.min(x1, pr.right);
        if (railW === r.width && /auto|scroll/.test(ps.overflowX)) railW = Math.max(0, Math.min(r.right, pr.right) - Math.max(r.left, pr.left));
      }
    }
    const visibleW = Math.max(0, x1 - x0), visibleH = Math.max(0, y1 - y0);
    // Wholly outside the shot (or scrolled away in a rail) is not in the picture at all.
    if (visibleW < 1 || visibleH < 1) continue;
    const name = label(img);
    const cutBelow = vertical && visibleH < r.height - 2;
    // Only clipping beyond the scrolling rail's own edge (the shot or a narrower panel) counts.
    const cutBySide = visibleW < railW - 2;
    if (cutBySide || cutBelow) {
      rows.push({ kind: "clipped", name, shown: Math.round(100 * (visibleW * (vertical ? visibleH : r.height)) / (r.width * r.height)) });
    }
    if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      rows.push({ kind: "shape", name, fit: st.objectFit, box: r.width / r.height, natural: img.naturalWidth / img.naturalHeight });
    }
  }
  return rows;
}

// Runs in the page through page.evaluate, like measureArtwork. A rail (a horizontal scrolling
// flex or grid row) inside the shot that holds nothing at all: no cards, no empty-state text.
// The app fills its rails after the panel around them renders, and an unfilled rail has no
// "Loading" text or images for the other checks to see (step 3b, 16 October 2026).
export function findEmptyRails({ area, minSize }) {
  const rows = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (/^(TEXTAREA|SELECT|INPUT|IFRAME|CANVAS|VIDEO|IMG|svg)$/i.test(el.tagName)) continue;
    if (el.childElementCount || el.textContent.trim()) continue;
    const st = getComputedStyle(el);
    if (!/auto|scroll/.test(st.overflowX) || st.visibility === "hidden") continue;
    const flexRow = /flex/.test(st.display) && /^row/.test(st.flexDirection) && st.flexWrap === "nowrap";
    const gridRow = /grid/.test(st.display) && /column/.test(st.gridAutoFlow);
    if (!flexRow && !gridRow) continue;
    const r = el.getBoundingClientRect();
    if (r.width < minSize || r.height < 1) continue;
    if (r.right <= area.x || r.left >= area.x + area.width || r.bottom <= area.y || r.top >= area.y + area.height) continue;
    rows.push({ kind: "empty", name: el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : el.tagName.toLowerCase() });
  }
  return rows;
}

// How far two aspect ratios differ, as a fraction: 0 is the same shape, 0.5 means one is half
// again as wide (relative to its height) as the other.
export function shapeDifference(box, natural) {
  const r = box / natural;
  return Math.max(r, 1 / r) - 1;
}

const fmt = (n) => n.toFixed(2);

// Turns measured rows (measureArtwork and findEmptyRails) into WARN items. `threshold` is the
// largest accepted shapeDifference.
export function artworkWarnings(rows, { threshold }) {
  const groups = { "cut off": [], squashed: [], "heavily cropped": [] };
  const empty = [];
  for (const row of rows) {
    if (row.kind === "empty") {
      empty.push(row.name);
    } else if (row.kind === "clipped") {
      if (row.shown < MIN_SHOWN_PERCENT) continue;
      groups["cut off"].push(`${row.name} (${row.shown}% shown)`);
    } else if (row.kind === "shape") {
      // `contain`, `scale-down` and `none` keep the image's shape; only fill and cover change it.
      if (row.fit !== "fill" && row.fit !== "cover") continue;
      if (shapeDifference(row.box, row.natural) <= threshold) continue;
      groups[row.fit === "fill" ? "squashed" : "heavily cropped"].push(`${row.name} (box ${fmt(row.box)}, image ${fmt(row.natural)})`);
    }
  }
  // Identical entries (a row of the same show's posters) are listed once with a count.
  const list = (items) => {
    const counts = new Map();
    for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
    const unique = [...counts].map(([item, n]) => (n > 1 ? `${item} x${n}` : item));
    const shown = unique.slice(0, 5).join(", ");
    return unique.length > 5 ? `${shown} and ${unique.length - 5} more` : shown;
  };
  return [
    ...(empty.length ? [`${empty.length} rail(s) empty, no cards rendered: ${list(empty)}`] : []),
    ...Object.entries(groups).filter(([, items]) => items.length).map(([what, items]) => `${items.length} artwork ${what}: ${list(items)}`),
  ];
}
