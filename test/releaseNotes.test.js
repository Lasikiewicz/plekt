import test from "node:test";
import assert from "node:assert/strict";
import { generateReleaseNotes, getReleaseMetadata } from "../scripts/generate-release-notes.js";

const mainManifest = {
  version: "1.0.0",
  entries: [{
    version: "1.0.0",
    message: "Safer and more explainable synchronization.",
    websiteUrl: "https://plembfin.com",
    sections: {
      newFeatures: ["Explainable Sync Activity"],
      majorBugFixes: ["Repair provider identity matches"],
      tweaks: ["Improve first-run guidance"],
    },
  }],
};

const alphaManifest = {
  baseVersion: "1.0.0",
  build: 2,
  entries: [{
    build: 2,
    version: "1.0.0.2",
    message: "Improve the alpha installer experience.",
    details: ["Improve the alpha installer experience."],
    sections: { newFeatures: [], majorBugFixes: [], tweaks: [] },
  }],
};

test("main release metadata uses the stable release tag", () => {
  assert.deepEqual(getReleaseMetadata({ channel: "main", manifest: mainManifest }), {
    channel: "main",
    entry: mainManifest.entries[0],
    version: "1.0.0",
    build: null,
    tagName: "v1.0.0",
    title: "Plekt v1.0.0",
  });
});

test("alpha release metadata uses the numbered prerelease tag", () => {
  const metadata = getReleaseMetadata({ channel: "alpha", manifest: alphaManifest });
  assert.equal(metadata.tagName, "v1.0.0-alpha.2");
  assert.equal(metadata.title, "Plekt v1.0.0-alpha.2");
  assert.equal(metadata.build, 2);
});

test("release notes render categorized changes and shared release guidance", () => {
  const notes = generateReleaseNotes({
    channel: "main",
    manifest: mainManifest,
    repository: "Lasikiewicz/plekt",
    commit: "0123456789abcdef",
  });

  assert.match(notes, /## What changed in this release/);
  assert.match(notes, /### New Features\n\n- Explainable Sync Activity/);
  assert.match(notes, /### Bug Fixes\n\n- Repair provider identity matches/);
  assert.match(notes, /## Start safely/);
  assert.match(notes, /\[Visit the Plekt website\]\(https:\/\/plembfin\.com\)/);
  assert.match(notes, /## Known limitations/);
  assert.match(notes, /ghcr\.io\/lasikiewicz\/plekt:latest/);
  assert.match(notes, /v1\.0\.0/);
  assert.match(notes, /Build commit: \[0123456\]/);
  assert.doesNotMatch(notes, /Plekt v1\.0\.0 is a self-hosted watch-state hub/);
  assert.doesNotMatch(notes, /## Screenshots/);
  assert.doesNotMatch(notes, /!\[/);
});

test("alpha release notes identify the build as prerelease software", () => {
  const notes = generateReleaseNotes({ channel: "alpha", manifest: alphaManifest });
  assert.match(notes, /v1\.0\.0-alpha\.2/);
  assert.match(notes, /Alpha builds are pre-release software/);
  assert.match(notes, /ghcr\.io\/lasikiewicz\/plekt:alpha-2/);
  assert.doesNotMatch(notes, /Plekt v1\.0\.0-alpha\.2 is an alpha build/);
  assert.doesNotMatch(notes, /## Screenshots/);
});
