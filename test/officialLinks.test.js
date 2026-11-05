import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, documentElement: { getAttribute: () => null } };

const { OFFICIAL_LINKS: scriptLinks, officialLinksMarkdown } = await import("../scripts/official-links.js");
const { OFFICIAL_LINKS: appLinks } = await import("../public/modules/changelog-channels.js");
const { generateReleaseNotes } = await import("../scripts/generate-release-notes.js");

test("the in-app changelog and the release scripts list the same official places", () => {
  assert.deepEqual(appLinks, scriptLinks);
  assert.deepEqual(scriptLinks.map((link) => link.label), ["Plekt.net", "Discord", "Reddit", "GitHub"]);
  for (const { url } of scriptLinks) assert.match(url, /^https:\/\//);
});

test("official links render as one markdown row", () => {
  assert.equal(officialLinksMarkdown(),
    "[Plekt.net](https://plekt.net) · [Discord](https://discord.gg/7ZmEGKcRC5) · [Reddit](https://www.reddit.com/r/plekt/) · [GitHub](https://github.com/Lasikiewicz/plekt)");
});

test("release notes carry the official links row instead of a single website link", () => {
  const notes = generateReleaseNotes({
    channel: "main",
    manifest: {
      version: "1.0.0",
      entries: [{ version: "1.0.0", message: "Release", websiteUrl: "https://plekt.net", sections: { newFeatures: ["A thing"], majorBugFixes: [], tweaks: [] } }],
    },
    repository: "Lasikiewicz/plekt",
    commit: "0123456789abcdef",
  });
  assert.ok(notes.includes(officialLinksMarkdown()));
  assert.doesNotMatch(notes, /Visit the Plekt website/);
});
