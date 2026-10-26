import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cataloguePath = path.join(root, "server", "resources", "netflix-catalogue.json");

test("Netflix catalogue snapshot has a valid schema and reproducible identity keys", () => {
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
  assert.equal(catalogue.schemaVersion, 1);
  assert.match(catalogue.generatedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.ok(Array.isArray(catalogue.sources) && catalogue.sources.length >= 4);
  assert.ok(Array.isArray(catalogue.entries) && catalogue.entries.length > 0);

  const periods = new Set();
  for (const source of catalogue.sources) {
    assert.match(source.period, /^\d{4}H[12]$/);
    assert.match(source.url, /^https:\/\/about\.netflix\.com\//);
    assert.match(source.downloadUrl, /^https:\/\/assets\.ctfassets\.net\/.+\.xlsx$/);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!periods.has(source.period), `duplicate source period ${source.period}`);
    periods.add(source.period);
  }

  const identities = new Set();
  for (const entry of catalogue.entries) {
    assert.ok(["tv", "movie"].includes(entry.mediaType));
    assert.ok(Array.isArray(entry.titles) && entry.titles.length > 0);
    assert.deepEqual(entry.titles, [...new Set(entry.titles)].sort());
    assert.ok(entry.titles.every((title) => typeof title === "string" && title.trim() === title && title.length > 0));
    assert.ok(Array.isArray(entry.reportTitles) && entry.reportTitles.length > 0);
    assert.ok(entry.reportTitles.every((title) => typeof title === "string" && title.trim() === title));
    assert.ok(Array.isArray(entry.sourcePeriods) && entry.sourcePeriods.length > 0);
    assert.ok(entry.sourcePeriods.every((period) => periods.has(period)));
    assert.deepEqual(entry.sourcePeriods, [...new Set(entry.sourcePeriods)]);
    if (entry.releaseYears) assert.ok(entry.releaseYears.length && entry.releaseYears.every((year) => Number.isInteger(year) && year > 1900));
    const identity = JSON.stringify([entry.mediaType, entry.titles]);
    assert.ok(!identities.has(identity), `duplicate identity ${identity}`);
    identities.add(identity);
  }

  assert.ok(catalogue.entries.every((entry) => !["Other Shows", "Other Movies"].includes(entry.titles[0])));
});

test("Netflix catalogue preserves bilingual report aliases and strips matching season suffixes", () => {
  const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
  const squidGame = catalogue.entries.find((entry) => entry.mediaType === "tv" && entry.titles.includes("Squid Game"));
  assert.ok(squidGame, "Squid Game entry is present");
  assert.ok(squidGame.titles.includes("오징어 게임"));
  assert.ok(squidGame.reportTitles.some((title) => /Squid Game: Season \d+ \/\/ 오징어 게임: 시즌 \d+/.test(title)));
  assert.ok(!squidGame.titles.some((title) => /:\s*(?:Season|Series|Part|Volume)\s+\d+$/i.test(title)));
});
