import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";
makeTempDataDir("plekt-trakt-exact-play-");
const { safeTraktReplaceItems } = await import("../server/src/utils/showTraktHistorySafety.js");
const { db } = await import("../server/src/db.js");
test.after(() => db.close());
const media = (season, episode, watched_at) => ({ season, episode, watched_at });

test("a different Trakt-only play within the same minute is never eligible for deletion", () => {
  const remote = [{ historyId: "1", media: media(2, 1), watchedAt: Date.parse("2026-01-01T12:00:59.000Z") }];
  const result = safeTraktReplaceItems([{ season: 2, episode: 1, to: { season: 1, episode: 4 }, dates: ["2026-01-01T12:00:01.000Z", "2026-01-01T12:00:02.000Z"] }], remote, media);
  assert.equal(result.remove.length, 0);
  assert.equal(result.desired.size, 2, "distinct local timestamps cannot collapse");
});

test("indistinguishable duplicate remote history ids are preserved", () => {
  const remote = ["1", "2"].map((historyId) => ({ historyId, media: media(2, 1), watchedAt: Date.parse("2026-01-01T12:00:00Z") }));
  const result = safeTraktReplaceItems([{ season: 2, episode: 1, to: { season: 1, episode: 4 }, dates: ["2026-01-01T12:00:00Z"] }], remote, media);
  assert.equal(result.remove.length, 0);
});
