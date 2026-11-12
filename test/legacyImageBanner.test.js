import test from "node:test";
import assert from "node:assert/strict";
import "./domStubs.js";

// Minimal element tree: enough for the banner's createElement/append/remove use.
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; }
  append(...kids) { for (const kid of kids) { kid.parent = this; this.children.push(kid); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  get text() { return [this.textContent || "", ...this.children.map((c) => c.text)].join(" "); }
  find(tag) { return this.children.flatMap((c) => (c.tag === tag ? [c] : []).concat(c.find(tag))); }
}
const body = new FakeNode("body");
const head = new FakeNode("head");
const byId = () => new Map([...head.children, ...body.children].filter((n) => n.id).map((n) => [n.id, n]));
document.createElement = (tag) => new FakeNode(tag);
document.getElementById = (id) => byId().get(id) || null;
document.querySelector = () => null;
document.head = head;
document.body = body;

const { renderLegacyImageBanner } = await import("../public/modules/legacy-image-banner.js");
const notice = {
  legacyImage: true, version: "2.0.1", supportedUntil: "2027-04-11",
  newImages: ["ghcr.io/lasikiewicz/plekt", "plembfin/plekt"],
  switchUrl: "https://plekt.net/docs/upgrading-from-plembfin/#switching-from-the-plembfin-docker-image",
};
const reset = () => { body.children = []; head.children = []; localStorage.clear(); };

test("no banner when the server says this is not the legacy image", () => {
  reset();
  assert.equal(renderLegacyImageBanner({ legacyImage: false }, body), null);
  assert.equal(body.children.length, 0);
});

test("banner names both Plekt images and links to the guide", () => {
  reset();
  const banner = renderLegacyImageBanner(notice, body);
  assert.ok(banner);
  assert.match(banner.text, /ghcr\.io\/lasikiewicz\/plekt/);
  assert.match(banner.text, /plembfin\/plekt \(Docker Hub\)/);
  // The banner formats the date in the viewer's locale: "11 April 2027" (en-GB) or "April 11, 2027" (en-US, as on CI).
  assert.match(banner.text, /(?:11 April|April 11,) 2027/);
  assert.equal(banner.find("a")[0].href, notice.switchUrl);
  assert.equal(renderLegacyImageBanner(notice, body), null, "never drawn twice");
});

test("Dismiss hides it for this version and it returns after the version changes", () => {
  reset();
  const banner = renderLegacyImageBanner(notice, body);
  banner.find("button")[0].listeners.click();
  assert.equal(body.children.length, 0);
  assert.equal(renderLegacyImageBanner(notice, body), null, "same version stays hidden");
  assert.ok(renderLegacyImageBanner({ ...notice, version: "2.0.2" }, body), "new version shows again");
});
