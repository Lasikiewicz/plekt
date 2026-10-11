// The website content-impact gate reports in --preview and blocks only --confirm.
//
// "Force to main" settles the release (changelog approval and a checked build)
// before any website work, so the preview has to show the would-be entry even
// while guides are outstanding. The real promotion must still refuse.

import test from "node:test";
import assert from "node:assert/strict";

const { previewAlphaToMainRelease, promoteAlphaToMain } = await import("../scripts/promote-alpha-to-main.js");

const OUTSTANDING = ["Stats: needs website/src/content/docs/stats.mdx (commit abc1234: feat: Add a genre chart)"];

function fixtureSources() {
  return {
    changelog: { version: "1.3.0", entries: [{ version: "1.3.0", commit: "0000000", message: "Previous release" }] },
    alpha: {
      baseVersion: "1.3.0",
      build: 2,
      releaseMessage: "Genre charts, a steadier Now Playing panel, and faster search.",
      entries: [{
        version: "1.3.0.2.0",
        commit: "1111111",
        message: "Genre charts and a steadier Now Playing panel.",
        sections: {
          newFeatures: ["Stats shows a chart of your most watched genres."],
          majorBugFixes: ["The Now Playing panel no longer flickers between items."],
          tweaks: ["Search results appear faster on large libraries."],
        },
      }],
    },
    manualVersion: "1.3.0",
  };
}

test("preview with an outstanding guide returns the entry plus the outstanding list", () => {
  const result = previewAlphaToMainRelease({
    sources: fixtureSources(),
    impactViolations: () => OUTSTANDING,
  });
  assert.equal(result.newMainVersion, "1.3.1");
  assert.equal(result.mainEntry.message, "Genre charts, a steadier Now Playing panel, and faster search.");
  assert.ok(result.mainEntry.details.length >= 3);
  assert.deepEqual(result.websiteImpactOutstanding, OUTSTANDING);
});

test("preview with no outstanding guide reports an empty list", () => {
  const result = previewAlphaToMainRelease({
    sources: fixtureSources(),
    impactViolations: () => [],
  });
  assert.deepEqual(result.websiteImpactOutstanding, []);
});

test("confirm with the same outstanding guide still refuses", () => {
  assert.throws(
    () => promoteAlphaToMain({
      sources: fixtureSources(),
      impactViolations: () => OUTSTANDING,
    }),
    /website content-impact gate failed:\n- Stats: needs website\/src\/content\/docs\/stats\.mdx/,
  );
});


test("the first Plekt release carries image migration guidance readable by old changelog clients", () => {
  const result = previewAlphaToMainRelease({ sources: fixtureSources(), impactViolations: () => [] });
  assert.equal(result.mainEntry.brandMigration, "plekt");
  assert.ok(result.mainEntry.details.some((detail) => detail.includes("Plembfin is now Plekt")));
  assert.ok(result.mainEntry.sections.tweaks.some((detail) => detail.includes("keep the same tag, volumes and settings")));
});

test("later releases do not repeat the first-release migration entry", () => {
  const sources = fixtureSources();
  sources.changelog.entries[0].brandMigration = "plekt";
  const result = previewAlphaToMainRelease({ sources, impactViolations: () => [] });
  assert.equal(result.mainEntry.brandMigration, undefined);
  assert.ok(!result.mainEntry.details.some((detail) => detail.includes("Plembfin is now Plekt")));
});
