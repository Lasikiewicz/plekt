import test from "node:test";
import assert from "node:assert/strict";
import { artworkWarnings, shapeDifference, DEFAULT_ARTWORK_THRESHOLD } from "./capture-quality.mjs";

const threshold = DEFAULT_ARTWORK_THRESHOLD;
const poster = (name, box, fit = "cover") => ({ kind: "shape", name, fit, box, natural: 340 / 500 });

test("shape difference is symmetric and zero for the same shape", () => {
  assert.equal(shapeDifference(1.5, 1.5), 0);
  assert.equal(shapeDifference(2, 1).toFixed(3), shapeDifference(1, 2).toFixed(3));
  assert.equal(shapeDifference(0.99, 0.68).toFixed(2), "0.46");
});

test("the rejected 2.1.0 history posters are flagged as heavily cropped", () => {
  const rows = [poster("Carrie - S01E05 poster", 0.99), poster("Carrie - S01E04 poster", 0.99)];
  assert.deepEqual(artworkWarnings(rows, { threshold }), ["2 artwork heavily cropped: Carrie - S01E05 poster (box 0.99, image 0.68), Carrie - S01E04 poster (box 0.99, image 0.68)"]);
});

test("accepted 2.1.0 shapes stay quiet at the default threshold", () => {
  // Measured: corrected history framing 0.63 (0.08 off), an odd Related Shows poster 0.67 vs 0.71.
  const rows = [poster("Carrie - S01E05 poster", 0.63), { kind: "shape", name: "La Femme Nikita", fit: "cover", box: 0.67, natural: 0.71 }, { kind: "shape", name: "Scene image", fit: "cover", box: 1.79, natural: 1.78 }];
  assert.deepEqual(artworkWarnings(rows, { threshold }), []);
});

test("fill is squashing, contain and none are never flagged", () => {
  const rows = [poster("Stretched", 1.2, "fill"), poster("Letterboxed", 1.2, "contain"), poster("Natural", 1.2, "none")];
  assert.deepEqual(artworkWarnings(rows, { threshold }), ["1 artwork squashed: Stretched (box 1.20, image 0.68)"]);
});

test("cut-off artwork is listed with how much shows, and repeats are counted", () => {
  const rows = [
    { kind: "clipped", name: "New York Undercover", shown: 10 },
    { kind: "clipped", name: "Scene image", shown: 74 },
    { kind: "clipped", name: "Scene image", shown: 74 },
  ];
  assert.deepEqual(artworkWarnings(rows, { threshold }), ["3 artwork cut off: New York Undercover (10% shown), Scene image (74% shown) x2"]);
});

test("a sliver under 10% at a rail edge is not flagged", () => {
  // Measured: accepted media-appearance 3%; rejected history card 31%.
  const rows = [{ kind: "clipped", name: "Scene image", shown: 3 }, { kind: "clipped", name: "Carrie - S01E01 poster", shown: 31 }];
  assert.deepEqual(artworkWarnings(rows, { threshold }), ["1 artwork cut off: Carrie - S01E01 poster (31% shown)"]);
});

test("an empty rail is reported first, even with no artwork in the shot", () => {
  // Measured 16 October 2026: dashboard-history-tv shot before the history row filled.
  assert.deepEqual(artworkWarnings([{ kind: "empty", name: "#tvHistoryRow" }], { threshold }), ["1 rail(s) empty, no cards rendered: #tvHistoryRow"]);
  const rows = [{ kind: "clipped", name: "Card", shown: 50 }, { kind: "empty", name: "#movieHistoryRow" }];
  assert.deepEqual(artworkWarnings(rows, { threshold }), ["1 rail(s) empty, no cards rendered: #movieHistoryRow", "1 artwork cut off: Card (50% shown)"]);
});

test("long lists are shortened", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ kind: "clipped", name: `Card ${i}`, shown: 50 }));
  assert.match(artworkWarnings(rows, { threshold })[0], /^8 artwork cut off: Card 0 .*Card 4 \(50% shown\) and 3 more$/);
});
