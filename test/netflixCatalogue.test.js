import test from "node:test";
import assert from "node:assert/strict";
import { createNetflixCatalogue } from "../server/src/utils/netflixCatalogue.js";

const catalogue = createNetflixCatalogue({ schemaVersion: 1, sources: [{ period: "2026H1", url: "https://about.netflix.com/report" }], entries: [
  { mediaType: "tv", titles: ["Reported Show", "원제"], sourcePeriods: ["2026H1"] },
  { mediaType: "tv", titles: ["Reported Show", "Another Original"], sourcePeriods: ["2026H1"] },
  { mediaType: "movie", titles: ["Film: A Subtitle"], sourcePeriods: ["2026H1"] },
  { mediaType: "tv", titles: ["Series: A Subtitle"], sourcePeriods: ["2026H1"] },
] });

test("official paired aliases rank suggestions without dropping competing remakes", () => {
  const candidates = [{ id: 1, name: "Reported Show", original_name: "Reported Show", popularity: 100 },
    { id: 2, name: "Reported Show", original_name: "원제", popularity: 1 }];
  const ranked = catalogue.rankCandidates("Reported Show", "tv", candidates);
  assert.deepEqual(ranked.map((item) => item.id), [2, 1]);
  assert.equal(ranked[0].netflixEvidence.kind, "paired_title");
  assert.deepEqual(ranked[0].netflixEvidence.sources, ["https://about.netflix.com/report"]);
  assert.equal(candidates[1].netflixEvidence, undefined, "input provider data stays unchanged");
});

test("aliases retain their actual row pairing rather than making transitive same-name links", () => {
  assert.deepEqual(catalogue.aliases("원제", "tv"), ["Reported Show"]);
  assert.equal(catalogue.aliases("원제", "tv").includes("Another Original"), false);
  assert.deepEqual(catalogue.aliases("Reported Show", "movie"), []);
});

test("positive catalogue evidence preserves full show and movie subtitles", () => {
  assert.equal(catalogue.showPrefix("Series: A Subtitle: Opening"), "Series: A Subtitle");
  assert.equal(catalogue.has("Film: A Subtitle", "movie"), true);
  assert.equal(catalogue.has("Film", "movie"), false);
  assert.equal(catalogue.showPrefix("Unknown: Opening"), "");
});

test("an absent or unsupported snapshot is neutral", () => {
  const missing = createNetflixCatalogue();
  assert.deepEqual(missing.aliases("Reported Show", "tv"), []);
  assert.deepEqual(missing.aliasMatches("Reported Show", "tv", [{ id: 1, name: "Reported Show" }]), []);
  assert.equal(createNetflixCatalogue({ schemaVersion: 99, entries: [{ mediaType: "movie", titles: ["Film"] }] }).has("Film", "movie"), false);
});
