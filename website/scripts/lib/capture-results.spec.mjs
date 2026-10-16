import test from "node:test";
import assert from "node:assert/strict";
import { parseToolOutput, resultsMarkdown, contactSheetHtml, splitName, summarize } from "./capture-results.mjs";

const output = [
  'Build at http://localhost:5056: {"status":200,"channel":"release","buildVersion":"2.1.0"}',
  "ok\tdashboard-dark.png\t1440x950",
  "ok\tdashboard-modern-dark.png\t1440x900 (catalogue 1440x950)",
  "ok\tdashboard-history-tv-light.png\t1396x620 WARN 2 image(s) never loaded: a.jpg, b.jpg",
  "FAIL\ttv-detail-page-dark.png\tElement not found or hidden: #seasons",
  "ok\tsettings-sync-dark.png\tstate has interactions but the entry has no `steps`; captured at the route only. 1440x950",
  "",
  "4 captured, 1 failed. Output: C:/x/auto",
].join("\n");

test("parses the build line and every result row", () => {
  const { build, rows, errors } = parseToolOutput(output);
  assert.equal(build.baseUrl, "http://localhost:5056");
  assert.equal(build.served.buildVersion, "2.1.0");
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { status: "ok", file: "dashboard-dark.png", size: "1440x950", catalogue: "", warn: "", note: "" });
  assert.equal(rows[1].size, "1440x900");
  assert.equal(rows[1].catalogue, "1440x950");
  assert.equal(rows[2].warn, "2 image(s) never loaded: a.jpg, b.jpg");
  assert.equal(rows[2].size, "1396x620");
  assert.equal(rows[3].note, "Element not found or hidden: #seasons");
  assert.equal(rows[4].size, "1440x950");
  assert.match(rows[4].note, /^state has interactions/);
  assert.deepEqual(summarize(rows), { captured: 4, failed: 1, warnings: 3 });
});

test("setup errors are kept for the results file", () => {
  const { rows, errors } = parseToolOutput("Build mismatch: expected 2.1.0 / release. Nothing captured.\n");
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 1);
});

test("results table lists every row and flags only non-clean rows for phase C", () => {
  const parsed = parseToolOutput(output);
  const md = resultsMarkdown({ ...parsed, expect: { version: "2.1.0", channel: "release" }, exitCode: 1 });
  assert.match(md, /- 4 captured, 1 failed, 3 warnings/);
  assert.match(md, /\| ok \| dashboard-dark\.png \| 1440x950 \| same \|  \|/);
  const phaseC = md.split("## For phase C")[1];
  assert.doesNotMatch(phaseC, /`dashboard-dark\.png`/);
  assert.match(phaseC, /`dashboard-modern-dark\.png`: size 1440x900, catalogue says 1440x950/);
  assert.match(phaseC, /`dashboard-history-tv-light\.png`: WARN 2 image/);
  assert.match(phaseC, /`tv-detail-page-dark\.png`: FAIL: Element not found/);
  assert.match(phaseC, /`settings-sync-dark\.png`: state has interactions/);
});

test("a clean run says nothing is flagged", () => {
  const md = resultsMarkdown({ ...parseToolOutput("ok\ta-dark.png\t10x10\n"), exitCode: 0 });
  assert.match(md, /Nothing flagged; every row is clean/);
});

test("ids split from the longest matching variant", () => {
  const variants = ["dark", "light", "modern-dark", "modern-light"];
  assert.deepEqual(splitName("dashboard-history-tv-modern-dark.png", variants), { id: "dashboard-history-tv", variant: "modern-dark" });
  assert.deepEqual(splitName("dashboard-light.png", variants), { id: "dashboard", variant: "light" });
});

test("contact sheet groups by id, links originals, and highlights flagged rows", () => {
  const { rows } = parseToolOutput(output);
  const html = contactSheetHtml({ rows, variants: ["dark", "light", "modern-dark", "modern-light"] });
  assert.equal((html.match(/<section>/g) || []).length, 4);
  assert.match(html, /<h2>dashboard<\/h2>/);
  assert.match(html, /<a href="auto\/dashboard-dark\.png"><img src="auto\/dashboard-dark\.png"/);
  assert.equal((html.match(/class="flagged"/g) || []).length, 4);
  assert.match(html, /no image/);
  assert.match(html, /<p class="flag">state has interactions/);
});
