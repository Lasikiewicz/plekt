import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("netflix-preview-review-");
const { prepareNetflixImport, saveNetflixPreview, reviewNetflixPreview, commitNetflixImport } = await import("../server/src/utils/netflixImport.js");
const { db } = await import("../server/src/db.js");
test.after(() => db.close());

async function fixture() {
  const preview = await prepareNetflixImport([
    "Title,Date", "Example: Season 2: Episode 1,1/1/24", "Example: Season 2: Alternate,1/2/24",
    "Example: Season 2: Alternate,1/2/24", "Example: Season 3: Missing,1/3/24",
  ].join("\n"), {
    getHistory: async () => [], getSeasonLists: async () => [], getEpisodeAliases: async ({ tmdbLists }) => tmdbLists,
    search: async () => ({ results: [{ id: 1, name: "Example" }, { id: 2, name: "Example" }] }),
  });
  return { preview, previewId: saveNetflixPreview(preview), groupId: preview.reviews[0].groupId, tmdbId: "2" };
}
const lists = [{ season: 2, episodes: [{ id: 21, name: "Canonical One", episode_number: 1 }, { id: 22, name: "Canonical Two", episode_number: 2 }] }];
const dependencies = {
  getHistory: async () => [], getSeasonLists: async () => lists,
  getEpisodeAliases: async () => [{ season: 2, episodes: [lists[0].episodes[0], { ...lists[0].episodes[1], alternateTitles: ["Alternate"] }] }],
};

test("one show decision rematches every row, preserves seasons, deduplicates and never writes history", async () => {
  const fixtureData = await fixture();
  const count = db.prepare("SELECT count(*) AS n FROM watch_history").get().n;
  const result = await reviewNetflixPreview(fixtureData.previewId, fixtureData, dependencies);
  assert.equal(result.matched, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.needsReview, 1);
  assert.equal(result.reviews[0].episodes[0].seasonHint, 3);
  assert.equal(result.reviews[0].showTmdbId, "2");
  assert.ok(fixtureData.preview.records.every((record) => record.tmdb_id === "2" && record.season === 2));
  assert.equal(db.prepare("SELECT count(*) AS n FROM watch_history").get().n, count);
  const again = await reviewNetflixPreview(fixtureData.previewId, fixtureData, dependencies);
  assert.equal(again.matched, 2);
  assert.equal(again.skipped, 1);
});

test("rematch rejects foreign IDs and groups instead of trusting client identities", async () => {
  const data = await fixture();
  await assert.rejects(reviewNetflixPreview(data.previewId, { ...data, tmdbId: "999" }, dependencies), { status: 400 });
  await assert.rejects(reviewNetflixPreview(data.previewId, { ...data, groupId: "foreign" }, dependencies), { status: 400 });
  assert.equal(data.preview.needsReview, 4);
});

test("metadata failure leaves the preview unchanged and unlocks it for retry", async () => {
  const data = await fixture();
  await assert.rejects(reviewNetflixPreview(data.previewId, data, { ...dependencies, getSeasonLists: async () => { throw new Error("offline"); } }), /offline/);
  assert.equal(data.preview.matched, 0);
  assert.equal(data.preview.needsReview, 4);
  const result = await reviewNetflixPreview(data.previewId, data, dependencies);
  assert.equal(result.matched, 2);
});

test("rematch prevents concurrent updates and imports until its atomic result is ready", async () => {
  const data = await fixture();
  let release;
  const pending = reviewNetflixPreview(data.previewId, data, { ...dependencies, getSeasonLists: () => new Promise((resolve) => { release = resolve; }) });
  await assert.rejects(reviewNetflixPreview(data.previewId, data, dependencies), { status: 409 });
  await assert.rejects(commitNetflixImport(data.previewId), { status: 409 });
  release(lists);
  await pending;
});

test("expired preview cannot be rematched", async () => {
  const data = await fixture();
  const now = Date.now;
  Date.now = () => now() + 31 * 60 * 1000;
  try { await assert.rejects(reviewNetflixPreview(data.previewId, data, dependencies), { status: 410 }); }
  finally { Date.now = now; }
});

test("blank show-name rows are excluded and cannot be rematched", async () => {
  const searches = [];
  const search = async ({ query }) => { searches.push(query); return { results: [] }; };
  const preview = await prepareNetflixImport([
    "Title,Date", ": Episode 2,1/2/24", ": Episode 1,1/1/24", ": Episode 3,12/30/23",
  ].join("\n"), { getHistory: async () => [], getSeasonLists: async () => [], search });
  const previewId = saveNetflixPreview(preview);
  assert.equal(preview.total, 0);
  assert.deepEqual(preview.reviews, []);
  assert.deepEqual(searches, []);
  await assert.rejects(reviewNetflixPreview(previewId, { groupId: "blank-run-0", query: "Blank" }, { search }), { status: 400 });
});

test("an all-blank-title preview has no rows to rematch", async () => {
  const search = async () => ({ results: [{ id: 9, name: "Two Seasons" }] });
  const preview = await prepareNetflixImport(["Title,Date", ": Episode 1,1/1/24"].join("\n"), { getHistory: async () => [], search });
  const previewId = saveNetflixPreview(preview);
  assert.equal(preview.total, 0);
  assert.deepEqual(preview.reviews, []);
  await assert.rejects(reviewNetflixPreview(previewId, { groupId: "blank-run-0", query: "two" }, { search }), { status: 400 });
});
