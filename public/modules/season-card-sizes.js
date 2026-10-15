// An open season's episode box is placed level with its card by
// positionSeasonDetails (media-detail-show.js), which runs once at render. A
// season card above it can still change height afterwards; the cards below move
// and the box is left beside the wrong card. Each season list gets one
// ResizeObserver on its cards, and a size change calls back to reposition.
const observersByList = new WeakMap();

export function watchSeasonCardSizes(list, onChange) {
  if (typeof ResizeObserver === "undefined") return;
  let observer = observersByList.get(list);
  if (!observer) {
    observer = new ResizeObserver(onChange);
    observersByList.set(list, observer);
  }
  list.querySelectorAll(".season-accordion").forEach((card) => observer.observe(card));
}
