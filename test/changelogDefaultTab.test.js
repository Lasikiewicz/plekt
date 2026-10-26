import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
globalThis.document ??= { addEventListener() {}, querySelector: () => null, documentElement: { getAttribute: () => null } };

const {
  defaultChangelogChannel,
  selectedChangelogChannel,
  setSelectedChangelogChannel,
} = await import("../public/modules/changelog-channels.js");

test("changelog text renders HTTPS markdown links while escaping unsafe content", async () => {
  const { renderChangelogText } = await import("../public/modules/changelog-channels.js");
  assert.equal(renderChangelogText('Drop (<img> [bequbed](https://github.com/bequbed))'),
    'Drop (&lt;img&gt; <a href="https://github.com/bequbed" target="_blank" rel="noopener noreferrer">bequbed</a>)');
  assert.equal(renderChangelogText('[bad](javascript:alert(1))'), '[bad](javascript:alert(1))');
});

test("changelog opens on the tab matching the install until a tab is picked", () => {
  assert.equal(defaultChangelogChannel("alpha"), "alpha");
  assert.equal(defaultChangelogChannel("develop"), "alpha");
  assert.equal(defaultChangelogChannel("release"), "main");
  assert.equal(defaultChangelogChannel(undefined), "main");

  assert.equal(selectedChangelogChannel("alpha"), "alpha");
  assert.equal(selectedChangelogChannel("release"), "main");

  setSelectedChangelogChannel("main");
  assert.equal(selectedChangelogChannel("alpha"), "main");
  setSelectedChangelogChannel("alpha");
  assert.equal(selectedChangelogChannel("release"), "alpha");
});
