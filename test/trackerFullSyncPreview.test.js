import test from "node:test";
import assert from "node:assert/strict";
import {
  previewGroupSummary,
  previewGroupTitle,
  previewGroups,
  previewIsExpired,
  previewMissingLabel,
  previewSummaryCounts,
  titleSplitText,
  selectablePreviewItems,
  selectedPreviewItems,
} from "../public/modules/tracker-full-sync.js";

test("full sync preview expires at its server expiry and when expiry is missing", () => {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.equal(previewIsExpired({ expiresAt: "2026-10-23T13:00:00Z" }, now), false);
  assert.equal(previewIsExpired({ expiresAt: "2026-10-23T12:00:00Z" }, now), true);
  assert.equal(previewIsExpired({}, now), true);
  assert.equal(previewIsExpired({expiresAt:now+3600000},now),false);
  assert.equal(previewIsExpired({expiresAt:now},now),true);
  assert.equal(previewIsExpired({expiresAt:'invalid'},now),true);
});

test('import selects Plekt destinations and push selects tracker destinations',()=>{
  const preview={items:[{id:'local',side:'plekt',operation:'add',selectable:true},{id:'remote',side:'tracker',operation:'add',selectable:true}]};
  const chosen=new Set(['local','remote']);
  assert.deepEqual(selectedPreviewItems(preview,chosen,'import').map(i=>i.id),['local']);
  assert.deepEqual(selectedPreviewItems(preview,chosen,'push').map(i=>i.id),['remote']);
  assert.equal(selectedPreviewItems(preview,chosen,'both').length,2);
});

test("only selectable add operations can be chosen for the plan", () => {
  const preview = { items: [
    { id: "add", operation: "add", selectable: true },
    { id: "skip", operation: "skip", selectable: true },
    { id: "date", operation: "date_difference", selectable: true },
    { id: "blocked", operation: "add", selectable: false },
  ] };
  assert.deepEqual(selectablePreviewItems(preview).map(({ id }) => id), ["add"]);
});

test("preview groups episodes by show title and keeps movies together", () => {
  const preview = {
    items: [
      { id: "m1", type: "movie", title: "Carrie" },
      { id: "e2", type: "episode", showTitle: "Avatar: The Last Airbender", title: "The Avatar Returns", season: 1, episode: 2 },
      { id: "e1", type: "episode", showTitle: "Avatar: The Last Airbender", title: "The Boy in the Iceberg", season: 1, episode: 1 },
      { id: "e3", type: "episode", title: "Lost S01E01 Pilot", season: 1, episode: 1 },
      { id: "e4", type: "episode", title: "Lost - Walkabout", season: 1, episode: 4 },
      { id: "m2", type: "movie", title: "Dune" },
    ],
  };
  assert.equal(previewGroupTitle(preview.items[1]), "Avatar: The Last Airbender");
  assert.equal(previewGroupTitle(preview.items[3]), "Lost");
  assert.equal(previewGroupTitle(preview.items[4]), "Lost");
  const groups = previewGroups(preview);
  assert.deepEqual(groups.map((entries) => previewGroupTitle(entries[0])), [
    "Avatar: The Last Airbender",
    "Lost",
    "Movies",
  ]);
  assert.deepEqual(groups[0].map((item) => item.id), ["e1", "e2"]);
  assert.deepEqual(groups[2].map((item) => item.id), ["m1", "m2"]);
});

test("preview summary counts missing TV shows and movies by destination", () => {
  const summary = previewSummaryCounts({
    items: [
      { operation: "add", side: "plekt", type: "episode", showTitle: "Lost", season: 1, episode: 1 },
      { operation: "add", side: "plekt", type: "episode", showTitle: "Lost", season: 1, episode: 2 },
      { operation: "add", side: "plekt", type: "episode", title: "Fringe - S01E01", season: 1, episode: 1 },
      { operation: "add", side: "plekt", type: "show", title: "Firefly" },
      { operation: "add", side: "plekt", type: "movie", title: "Heat" },
      { operation: "add", side: "tracker", type: "movie", title: "Alien" },
      { operation: "skip", side: "plekt", type: "movie" },
      { operation: "date_difference", side: "tracker" },
      { operation: "date_difference", side: "plex" },
    ],
  });
  assert.deepEqual(summary, {
    missingInPlekt: { shows: 3, movies: 1 },
    missingOnTracker: { shows: 0, movies: 1 },
    unchanged: 1,
    datesPreserved: 2,
  });
  assert.equal(titleSplitText(summary.missingInPlekt), "3 TV shows · 1 movie");
  assert.equal(titleSplitText(summary.missingOnTracker), "0 TV shows · 1 movie");
});

test("preview group and item labels name the destination that is missing the watch", () => {
  const entries = [
    { operation: "add", side: "plekt" },
    { operation: "add", side: "plekt" },
    { operation: "add", side: "tracker" },
    { operation: "skip", side: "tracker" },
  ];
  assert.equal(previewMissingLabel(entries[0], "Trakt"), "Missing from Plekt");
  assert.equal(previewMissingLabel(entries[2], "Trakt"), "Missing from Trakt");
  assert.equal(previewMissingLabel(entries[3], "Trakt"), "Left unchanged");
  assert.equal(
    previewGroupSummary(entries, "Trakt"),
    "2 missing from Plekt · 1 missing from Trakt · 4 total",
  );
});
