// Recapture website app images from the catalogue using Playwright driving Edge.
//
//   node scripts/recapture.mjs --list
//   node scripts/recapture.mjs <id> [<id> ...]        one or more images
//   node scripts/recapture.mjs --page=<slug>           every image a website page uses
//   node scripts/recapture.mjs --all                   every image
//   node scripts/recapture.mjs --ids-file=<file>       the ids listed in a file, one per line
//   options: --variant=dark,light,modern-dark,modern-light  --out=<dir>  --headed  --install
//            --base-url=<url>                        capture from another running app than the catalogue's
//            --expect-version=<x.y.z> --expect-channel=<channel>   stop unless the app serves that build
//            --local-storage-file=<json>   browser-local keys ({"key": "value"}) set before each page loads
//            --storage-state-file=<json>   reuse a private authenticated Playwright state
//            --live=<state>[,<state>]      the named live states (catalogue `live`) exist in the app now
//            --catalogue=<file>            use another catalogue file (default capture-catalogue.json)
//            --check                       dry run: sign in, check the build, open every entry and
//                                          resolve its framing targets; no screenshots
//            --artwork-threshold=<n>       largest accepted artwork shape difference (default in lib/capture-quality.mjs)
//            --artwork-report=<file>       write every artwork measurement as JSON, for tuning
//
// The sign-in comes from PLEKT_USER and PLEKT_PASSWORD, or else from the Username and
// Password lines of the gitignored .claude/local-environment.md; it is never printed.
// Exit codes: 0 all ok, 1 some FAIL, 2 setup or sign-in error, 3 build mismatch.
// Output goes to .tmp-website-build/captures by default; --install copies the PNGs into
// public/assets/app-captures. Sizes are compared with the catalogue and reported, never forced.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { chromium } from "playwright-core";
import { loadSignIn } from "./lib/capture-signin.mjs";
import { measureArtwork, findEmptyRails, artworkWarnings, PLACEHOLDER_PATTERN, MIN_ARTWORK, DEFAULT_ARTWORK_THRESHOLD } from "./lib/capture-quality.mjs";
import { isAllowedRailSrc } from "./lib/rail-src.mjs";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capturesRoot = path.join(websiteRoot, "public", "assets", "app-captures");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
// --catalogue=<file>: a copy of the catalogue, for testing framing changes before they land.
const catalogue = JSON.parse(await fs.readFile(path.resolve(option("catalogue", path.join(websiteRoot, "capture-catalogue.json"))), "utf8"));
const ids = args.filter((a) => !a.startsWith("--"));

if (flag("list")) {
  for (const [id, e] of Object.entries(catalogue.images)) {
    console.log(`${id}\t${e.framing.type}\t${e.live || ""}\t${e.route}`);
  }
  process.exit(0);
}

let selected = [];
if (flag("all")) selected = Object.keys(catalogue.images);
else if (option("page")) selected = Object.entries(catalogue.images).filter(([, e]) => e.pages.includes(option("page"))).map(([id]) => id);
else if (option("ids-file")) selected = (await fs.readFile(path.resolve(option("ids-file")), "utf8")).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
else selected = ids;
const unknown = selected.filter((id) => !catalogue.images[id]);
if (!selected.length || unknown.length) {
  console.error(unknown.length ? `Unknown image id(s): ${unknown.join(", ")}` : "Nothing selected. Use an id, --page=<slug>, --all or --list.");
  process.exit(2);
}
const wantVariants = option("variant") ? option("variant").split(",") : null;
const extraLocalStorage = option("local-storage-file") ? JSON.parse(await fs.readFile(path.resolve(option("local-storage-file")), "utf8")) : {};
const outDir = path.resolve(option("out", path.join(websiteRoot, "..", ".tmp-website-build", "captures")));
await fs.mkdir(outDir, { recursive: true });

const checkOnly = flag("check");
const artworkThreshold = Number(option("artwork-threshold", DEFAULT_ARTWORK_THRESHOLD));
const artworkReport = option("artwork-report") ? path.resolve(option("artwork-report")) : null;
const artworkRows = {};
let signIn;
try {
  signIn = await loadSignIn({ localEnvironmentFile: path.join(websiteRoot, "..", ".claude", "local-environment.md") });
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const { user, password } = signIn;

const { browser: browserConfig, storage } = catalogue;
const baseUrl = (option("base-url") || catalogue.baseUrl).replace(/\/+$/, "");
const browser = await chromium.launch({ channel: browserConfig.channel, headless: !flag("headed") });

// --expect-version / --expect-channel: read the served build once, signed in, and stop on a mismatch.
let buildChecked = !option("expect-version") && !option("expect-channel");
async function checkBuild(page) {
  const served = await page.evaluate(async () => {
    const response = await fetch("/api/changelog", { cache: "no-store" });
    if (!response.ok) return { status: response.status };
    const data = await response.json();
    const normalize = (value) => {
      const parts = String(value ?? "").replace(/^v/i, "").split(".");
      if (parts.length < 3 || parts.length > 5 || !parts.every((p) => /^\d+$/.test(p))) return null;
      while (parts.length > 3 && Number(parts.at(-1)) === 0) parts.pop();
      return parts.join(".");
    };
    const installed = data.channel === "alpha" ? data.alphaBuild?.version : data.channel === "develop" ? data.developBuild?.version : data.current;
    return { status: response.status, channel: data.channel, buildVersion: normalize(installed), stableVersion: normalize(data.current), sidebarLabel: document.querySelector("#appVersion")?.textContent?.trim() };
  });
  console.log(`Build at ${baseUrl}: ${JSON.stringify(served)}`);
  const wantVersion = option("expect-version");
  const wantChannel = option("expect-channel");
  if ((wantVersion && served.buildVersion !== wantVersion) || (wantChannel && served.channel !== wantChannel)) {
    console.error(`Build mismatch: expected ${wantVersion || "any version"} / ${wantChannel || "any channel"}. Nothing captured.`);
    await browser.close();
    process.exit(3);
  }
  buildChecked = true;
}

// The login route is rate limited (10 per 15 minutes), so sign in once and reuse the session.
let sessionState = option("storage-state-file") ? JSON.parse(await fs.readFile(path.resolve(option("storage-state-file")), "utf8")) : null;

async function newVariantContext(variant) {
  const v = catalogue.variants[variant];
  const context = await browser.newContext({ viewport: browserConfig.viewport, deviceScaleFactor: browserConfig.deviceScaleFactor, colorScheme: v.mode, ...(sessionState ? { storageState: sessionState } : {}) });
  await context.addInitScript(([themeKey, themeValue, styleKey, styleValue, extra]) => {
    try {
      localStorage.setItem(themeKey, themeValue);
      if (styleValue) localStorage.setItem(styleKey, styleValue); else localStorage.removeItem(styleKey);
      for (const [key, value] of Object.entries(extra)) localStorage.setItem(key, value);
    } catch {}
  }, [storage.mode.key, storage.mode.values[v.mode], storage.style.key, storage.style.values[v.style], extraLocalStorage]);
  const page = await context.newPage();
  await page.goto(baseUrl + "/");
  if (await page.locator("#adminEmail").isVisible({ timeout: 4000 }).catch(() => false)) {
    await page.fill("#adminEmail", user);
    await page.fill("#adminToken", password);
    await page.click("#authForm button[type=submit]");
    // One attempt only: the login is rate limited, and retrying a wrong sign-in just locks it out.
    const signedIn = await page.locator("#adminEmail").waitFor({ state: "hidden", timeout: 15000 }).then(() => true, () => false);
    if (!signedIn) {
      const shown = (await page.locator("#message").textContent().catch(() => "")).trim();
      console.error(`Sign-in failed at ${baseUrl}${shown ? `: "${shown}"` : ""}. Username from ${signIn.source} (${user.length} characters). Nothing captured.`);
      await browser.close();
      process.exit(2);
    }
    sessionState = await context.storageState();
  }
  return { context, page };
}

function locatorFor(page, target) {
  if (target.css) return page.locator(target.css).first();
  if (target.subPanel) return page.locator(`[data-sub-panel="${target.subPanel}"]`).first();
  if (target.text) return page.getByText(target.text, { exact: false }).first();
  if (target.heading) {
    // The nearest section around the heading; a div filter matches the title wrapper only.
    return page.getByRole("heading", { name: target.heading }).first().locator("xpath=ancestor::section[1]");
  }
  throw new Error("Target has no css, subPanel, text or heading.");
}

// Strips and galleries lazy-load their images only when scrolled to, which a clipped screenshot
// never does; load them eagerly and wait until each one has decoded (up to 60 s). Only images
// inside the horizontal viewport are loaded: a rail can hold dozens of off-screen images, and
// requesting them all queues the visible ones behind the slow image host.
// Returns the in-view images that never loaded (empty when all did), so the caller can report them.
async function loadAllImages(page) {
  for (let i = 0; i < 120; i++) {
    // Rails keep their artwork in data-rail-src (hidden, no src) until scrolled near, and can
    // render after the first look; promote on every pass and count unpromoted ones as pending.
    // The sources are checked here, in Node, and only the allowed ones are passed into the page.
    const railSrcs = await page.evaluate(() => [...document.querySelectorAll("img[data-rail-src]")].map((img) => img.getAttribute("data-rail-src"))).catch(() => []);
    const allowedRailSrcs = railSrcs.filter((src) => isAllowedRailSrc(src, page.url()));
    const pending = await page.evaluate((allowed) => {
      const inView = (img) => { const r = img.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < innerWidth; };
      // Only a source that passed isAllowedRailSrc is assigned; anything else is left unloaded.
      document.querySelectorAll("img[data-rail-src]").forEach((img) => { if (inView(img)) { const src = img.getAttribute("data-rail-src"); if (allowed.includes(src)) img.src = src; img.removeAttribute("data-rail-src"); } });
      document.querySelectorAll("img[loading=lazy]").forEach((img) => { if (inView(img)) img.loading = "eager"; });
      // Async decoding lets a frame paint before the bitmap is ready, leaving tiles blank in the shot.
      document.querySelectorAll("img[decoding=async]").forEach((img) => { img.decoding = "sync"; });
      return [...document.images].filter((img) => inView(img) && (img.hasAttribute("data-rail-src") || (img.src && !(img.complete && img.naturalWidth > 0)))).length;
    }, allowedRailSrcs).catch(() => 0);
    if (!pending) {
      // Loaded is not painted: wait for decode so async-decoded tiles are not captured blank.
      await page.evaluate(() => Promise.all([...document.images].filter((img) => img.complete && img.naturalWidth > 0).map((img) => img.decode().catch(() => {})))).catch(() => {});
      await page.waitForTimeout(700);
      return [];
    }
    // The image host sometimes stalls a request for good; restart any still pending every 10 s.
    if (i % 20 === 19) {
      await page.evaluate(() => [...document.images].forEach((img) => {
        const r = img.getBoundingClientRect();
        if (img.src && r.width > 0 && r.right > 0 && r.left < innerWidth && !(img.complete && img.naturalWidth > 0)) { const s = img.src; img.src = ""; img.src = s; }
      })).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => [...document.images].filter((img) => {
    const r = img.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < innerWidth && (img.hasAttribute("data-rail-src") || !(img.complete && img.naturalWidth > 0));
  }).map((img) => (img.getAttribute("data-rail-src") || img.src).split("/").pop())).catch(() => []);
}

// Loaded and decoded is still not painted: tiles near the viewport edge can be captured as flat
// placeholders. Retake until no loaded image inside the shot is a single flat colour (about 15 s),
// then record the ones still flat so the run reports them.
async function shoot(page, file, clip = null) {
  const vp = page.viewportSize();
  const area = clip || { x: 0, y: 0, width: vp.width, height: vp.height };
  let flat = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    // A horizontal rail is its own scrolling layer and can keep a stale paint with its tiles
    // empty even after every image decoded; scrolling it by a pixel and back repaints it.
    await page.evaluate(async () => {
      const frames = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const rails = [...document.querySelectorAll("*")].filter((el) => el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX) && el.querySelector("img"));
      const lefts = rails.map((el) => el.scrollLeft);
      rails.forEach((el) => { el.scrollLeft += 1; });
      await frames();
      rails.forEach((el, i) => { el.scrollLeft = lefts[i]; });
      await frames();
    }).catch(() => {});
    const buf = await page.screenshot(clip ? { clip } : {});
    const rects = await page.evaluate((a) => [...document.images].map((img) => {
      const r = img.getBoundingClientRect();
      const x0 = Math.max(r.left, a.x, 0), y0 = Math.max(r.top, a.y, 0);
      const x1 = Math.min(r.right, a.x + a.width, innerWidth), y1 = Math.min(r.bottom, a.y + a.height, innerHeight);
      // A spoiler mask is flat on purpose, so it is never reported as unpainted.
      const visible = img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility !== "hidden" && getComputedStyle(img).opacity !== "0" && !new RegExp(a.placeholder).test(`${img.className} ${img.src}`);
      return visible && x1 - x0 >= 40 && y1 - y0 >= 40 ? { left: Math.round(x0 - a.x), top: Math.round(y0 - a.y), width: Math.floor(x1 - x0) - 1, height: Math.floor(y1 - y0) - 1, name: img.src.split("/").pop() } : null;
    }).filter(Boolean), { ...area, placeholder: PLACEHOLDER_PATTERN }).catch(() => []);
    flat = [];
    for (const r of rects) {
      const { channels } = await sharp(buf).extract({ left: r.left, top: r.top, width: r.width, height: r.height }).stats();
      // Translucent cards let a blurred backdrop through, so a blank tile is near-flat, not flat.
      if (channels.slice(0, 3).every((c) => c.stdev < 6)) flat.push(r.name);
    }
    if (!flat.length || attempt === 9) { await fs.writeFile(file, buf); break; }
    await page.waitForTimeout(1500);
  }
  missingImages.push(...flat.map((n) => `${n} (unpainted)`));
  await checkArtwork(page, file, area, Boolean(clip));
}

// Measures the artwork in the finished shot and records cut-off or misshapen posters, and rails
// left empty, as WARNs.
async function checkArtwork(page, file, area, vertical) {
  const rows = [
    ...await page.evaluate(measureArtwork, { area, vertical, placeholder: PLACEHOLDER_PATTERN, minSize: MIN_ARTWORK }).catch(() => []),
    ...await page.evaluate(findEmptyRails, { area, minSize: MIN_ARTWORK }).catch(() => []),
  ];
  artworkRows[path.basename(file)] = rows;
  artworkIssues.push(...artworkWarnings(rows, { threshold: artworkThreshold }));
}

// A rail fills after the panel around it renders (the dashboard history rows are deferred
// startup work), and until then it has no "Loading" text or images for settle() and
// loadAllImages() to wait on. Give empty rails in the shot area up to 20 s to fill; one still
// empty is reported by checkArtwork. `areaOf` returns the area, or null for the viewport.
async function waitForRails(page, areaOf = async () => null) {
  for (let i = 0; i < 40; i++) {
    const vp = page.viewportSize();
    const area = (await areaOf().catch(() => null)) || { x: 0, y: 0, width: vp.width, height: vp.height };
    const empty = await page.evaluate(findEmptyRails, { area, minSize: MIN_ARTWORK }).catch(() => []);
    if (!empty.length) return;
    await page.waitForTimeout(500);
  }
}

async function box(locator, what, noScroll = false) {
  await locator.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
    throw new Error(`Element not found or hidden: ${what}`);
  });
  if (!noScroll) await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error(`No bounding box: ${what}`);
  return b;
}

async function runSteps(page, steps = []) {
  for (const step of steps) {
    if (step.click) await page.locator(step.click).first().click();
    else if (step.forceClick) await page.locator(step.forceClick).first().click({ force: true });
    else if (step.clickText) await page.getByText(step.clickText, { exact: false }).first().click();
    else if (step.setChecked) await page.locator(step.setChecked.css).first().setChecked(step.setChecked.value, { force: true });
    else if (step.hover) await page.locator(step.hover).first().hover();
    else if (step.fill) await page.locator(step.fill.css).first().fill(step.fill.value);
    else if (step.press) await page.keyboard.press(step.press);
    else if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ state: "visible", timeout: 15000 });
    else if (step.wait) await page.waitForTimeout(step.wait);
    else throw new Error(`Unknown step ${JSON.stringify(step)}`);
  }
}

async function settle(page) {
  // The app polls, so the network never goes idle; wait for images by polling, capped.
  await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const pending = await page.evaluate(() => [...document.images].filter((img) => !img.complete).length).catch(() => 0);
    if (!pending) break;
    await page.waitForTimeout(500);
  }
  // Panels fetch after load and show "Loading ..." placeholders meanwhile; wait them out.
  // Require three clean polls in a row, since a panel can start loading just after the first look.
  let clean = 0;
  for (let i = 0; i < 180 && clean < 3; i++) {
    const loading = await page.evaluate(() => [...document.querySelectorAll("body *")]
      .some((el) => el.children.length === 0 && /^\s*Loading\b/i.test(el.textContent || "") && el.getClientRects().length > 0)).catch(() => false);
    clean = loading ? 0 : clean + 1;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);
}

// Long pages scroll inside the container with the sidebar fixed: take viewport frames at evenly
// spaced scroll positions and stack the container region of each onto the first frame.
async function composeScroll(page, f, file) {
  const container = page.locator(f.container).first();
  await container.waitFor({ state: "visible", timeout: 10000 });
  await settle(page);
  await waitForRails(page, async () => ({ x: 0, y: -1e7, width: page.viewportSize().width, height: 2e7 }));
  // Wait for the detail content to render (a loading page is only a header and a blank body).
  for (let i = 0; i < 20; i++) {
    const ready = await container.evaluate((el) => el.scrollHeight * (el.getBoundingClientRect().height / el.clientHeight || 1) > el.getBoundingClientRect().height + 100);
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  await page.addStyleTag({ content: "*, html { scroll-behavior: auto !important; }" });
  const vp = page.viewportSize();
  const measure = () => container.evaluate((el) => {
    const r = el.getBoundingClientRect();
    // The shell can be CSS-zoomed, so scrollTop units differ from screen pixels.
    const z = r.height / el.clientHeight || 1;
    let fixed = 0;
    for (const c of el.querySelectorAll("*")) {
      const st = getComputedStyle(c);
      if (st.position === "sticky" || st.position === "fixed") {
        const cr = c.getBoundingClientRect();
        if (Math.abs(cr.top - r.top) < 2 && cr.width > r.width / 2) fixed = Math.max(fixed, Math.round(cr.height));
      }
    }
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), total: Math.round(el.scrollHeight * z), fixed, z };
  });
  let geo = await measure();
  const maxScroll0 = Math.max(0, geo.total - geo.h);
  // Walk the page so lazy images load, waiting for each stretch's images, then return to the top.
  for (let y = 0; y <= maxScroll0 + geo.h; y += Math.max(200, geo.h - 100)) {
    await container.evaluate((el, top) => { el.scrollTop = top / (el.getBoundingClientRect().height / el.clientHeight || 1); }, Math.min(y, maxScroll0));
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(400);
      const pending = await page.evaluate(() => [...document.images].filter((img) => img.loading !== "lazy" ? !img.complete : (img.getBoundingClientRect().top < innerHeight + 200 && !img.complete)).length).catch(() => 0);
      if (!pending) break;
    }
  }
  // Lazy content changes the page height while walking, so measure again before framing.
  await container.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(500);
  geo = await measure();
  // The composed shot spans the whole page height, so only sideways cut-offs count.
  await checkArtwork(page, file, { x: 0, y: -1e7, width: vp.width, height: 2e7 }, false);
  const maxScroll = Math.max(0, geo.total - geo.h);
  const step = geo.h - geo.fixed;
  const count = Math.max(1, Math.ceil(maxScroll / step) + 1);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const pos = Math.min(maxScroll, i * step);
    await container.evaluate((el, top) => { el.scrollTop = top / (el.getBoundingClientRect().height / el.clientHeight || 1); }, pos);
    await page.waitForTimeout(900);
    const buf = await page.screenshot();
    const actual = await container.evaluate((el) => Math.round(el.scrollTop * (el.getBoundingClientRect().height / el.clientHeight || 1)));
    frames.push({ pos: actual, buf });
  }
  await container.evaluate((el) => { el.scrollTop = 0; });
  const height = geo.y + geo.total;
  const bg = await sharp(frames[0].buf).extract({ left: 0, top: vp.height - 8, width: 1, height: 1 }).raw().toBuffer();
  const layers = [{ input: frames[0].buf, left: 0, top: 0 }];
  for (const fr of frames.slice(1)) {
    const top = geo.y + fr.pos;
    const h = Math.min(geo.h - geo.fixed, height - top - geo.fixed);
    if (h <= 0) continue;
    layers.push({ input: await sharp(fr.buf).extract({ left: geo.x, top: geo.y + geo.fixed, width: vp.width - geo.x, height: h }).toBuffer(), left: geo.x, top: top + geo.fixed });
  }
  const background = { r: bg[0], g: bg[1], b: bg[2], alpha: 1 };
  await sharp({ create: { width: vp.width, height: Math.max(height, vp.height), channels: 4, background } })
    .composite(layers).flatten({ background }).png({ compressionLevel: 9 }).toFile(file);
}

// Images still unloaded when the last capture was taken; reported on the result line.
let missingImages = [];
// Artwork cut off or misshapen in the last capture; reported on the result line.
let artworkIssues = [];

async function capture(page, entry, file) {
  const f = entry.framing;
  missingImages = [];
  artworkIssues = [];
  if (f.type === "scroll-compose") return composeScroll(page, f, file);
  if (f.type === "viewport") { await waitForRails(page); missingImages = await loadAllImages(page); return shoot(page, file); }
  if (f.type === "full-page") return page.screenshot({ path: file, fullPage: true });
  if (f.type === "element" || f.type === "crop") {
    const target = f.target;
    // Sections render after their data arrives, so let the target appear before loading images.
    await locatorFor(page, target).waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    await waitForRails(page, async () => {
      const a = await locatorFor(page, target).boundingBox();
      const e = f.through ? await locatorFor(page, f.through).boundingBox() : null;
      if (!a || !e) return a;
      const x = Math.min(a.x, e.x), y = Math.min(a.y, e.y);
      return { x, y, width: Math.max(a.x + a.width, e.x + e.width) - x, height: Math.max(a.y + a.height, e.y + e.height) - y };
    });
    missingImages = await loadAllImages(page);
    let b = await box(locatorFor(page, target), JSON.stringify(target), f.noScroll);
    if (f.through && f.noScroll) {
      // An open menu closes on scroll, so measure both ends where they already are.
      const end = await box(locatorFor(page, f.through), JSON.stringify(f.through), true);
      const x0 = Math.min(b.x, end.x);
      const y0 = Math.min(b.y, end.y);
      b = { x: x0, y: y0, width: Math.max(b.x + b.width, end.x + end.width) - x0, height: Math.max(b.y + b.height, end.y + end.height) - y0 };
    } else if (f.through) {
      // Put the start at the top, then measure both ends from the same scroll position;
      // scrolling to the end target would move the start out from under its measurement.
      // Leave room above for the sticky top bar, which would otherwise cover the start.
      await locatorFor(page, target).evaluate((el) => {
        el.scrollIntoView({ block: "start" });
        let p = el.parentElement;
        while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
        if (p) p.scrollTop -= 70 / (p.getBoundingClientRect().height / p.clientHeight || 1);
      });
      await page.waitForTimeout(500);
      b = await locatorFor(page, target).boundingBox();
      const end = await locatorFor(page, f.through).boundingBox();
      if (!end) throw new Error(`No bounding box: ${JSON.stringify(f.through)}`);
      b = { x: Math.min(b.x, end.x), y: Math.min(b.y, end.y), width: Math.max(b.x + b.width, end.x + end.width) - Math.min(b.x, end.x), height: Math.max(b.y + b.height, end.y + end.height) - Math.min(b.y, end.y) };
    }
    const pad = target.padding ?? f.padding ?? 0;
    const vp = page.viewportSize();
    const x = Math.max(0, b.x - pad);
    const y = Math.max(0, b.y - pad);
    // `size` frames a fixed region from the target's top-left (context around an open menu).
    const want = f.size || { width: b.width + pad * 2, height: b.height + pad * 2 };
    const clip = { x, y, width: Math.min(vp.width - x, want.width), height: Math.min(vp.height - y, want.height) };
    return shoot(page, file, clip);
  }
  throw new Error(`Framing "${f.type}" is not automated by this script yet`);
}

// --check: the entry opens and its framing targets are on the page, without a screenshot.
async function checkEntry(page, entry) {
  const f = entry.framing;
  if (f.type === "scroll-compose") {
    await page.locator(f.container).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => { throw new Error(`Container not found or hidden: ${f.container}`); });
    return "container found";
  }
  if (f.type === "element" || f.type === "crop") {
    await locatorFor(page, f.target).waitFor({ state: "attached", timeout: 30000 }).catch(() => {});
    const b = await box(locatorFor(page, f.target), JSON.stringify(f.target), f.noScroll);
    if (f.through) await box(locatorFor(page, f.through), JSON.stringify(f.through), true);
    return `target ${Math.round(b.width)}x${Math.round(b.height)}`;
  }
  if (f.type === "viewport" || f.type === "full-page") return "route opened";
  throw new Error(`Framing "${f.type}" is not automated by this script yet`);
}

const results = [];
for (const variant of Object.keys(catalogue.variants)) {
  if (wantVariants && !wantVariants.includes(variant)) continue;
  const todo = selected.filter((id) => catalogue.images[id].variants.includes(variant));
  if (!todo.length) continue;
  const { context, page } = await newVariantContext(variant);
  if (!buildChecked) await checkBuild(page);
  for (const id of todo) {
    const entry = catalogue.images[id];
    const name = `${id}-${variant}.png`;
    const file = path.join(outDir, name);
    const row = { name, status: "ok", note: "" };
    try {
      // --live=playback,sync-issue: the operator has put the app in those states first.
      if (checkOnly && entry.live && !(option("live") || "").split(",").includes(entry.live)) {
        row.status = "skip";
        row.note = `needs live state "${entry.live}"`;
        results.push(row);
        console.log(`${row.status}\t${row.name}\t${row.note}`);
        continue;
      }
      if (entry.live && !(option("live") || "").split(",").includes(entry.live)) throw new Error(`needs live state "${entry.live}" (${catalogue.live[entry.live]}); the local app does not have it, and the script does not fabricate one`);
      if (!entry.steps && /click|open|expanded|toggle|menu|dialog|tab|press/i.test(entry.state)) {
        row.note = "state has interactions but the entry has no `steps`; captured at the route only. ";
      }
      // An entry can name its own `viewport` when its published frame is not the standard size.
      await page.setViewportSize(entry.viewport || browserConfig.viewport);
      await page.goto(baseUrl + entry.route + (entry.hash ? `#${entry.hash}` : ""));
      await settle(page);
      await runSteps(page, entry.steps);
      if (entry.steps) await settle(page);
      if (checkOnly) {
        row.note += await checkEntry(page, entry);
        results.push(row);
        console.log(`${row.status}\t${row.name}\t${row.note}`);
        continue;
      }
      await capture(page, entry, file);
      const { width, height } = await sharp(file).metadata();
      const want = entry.sizes[variant];
      row.note += `${width}x${height}`;
      if (want && (want.width !== width || want.height !== height)) row.note += ` (catalogue ${want.width}x${want.height})`;
      const warnings = [...(missingImages.length ? [`${missingImages.length} image(s) never loaded: ${missingImages.slice(0, 5).join(", ")}`] : []), ...artworkIssues];
      if (warnings.length) row.note += ` WARN ${warnings.join("; ")}`;
      if (flag("install")) await fs.copyFile(file, path.join(capturesRoot, name));
    } catch (error) {
      row.status = "FAIL";
      row.note += error.message.split("\n")[0];
    }
    results.push(row);
    console.log(`${row.status}\t${row.name}\t${row.note}`);
  }
  await context.close();
}
await browser.close();
if (artworkReport) await fs.writeFile(artworkReport, JSON.stringify(artworkRows, null, 2));
const failed = results.filter((r) => r.status === "FAIL").length;
const skipped = results.filter((r) => r.status === "skip").length;
if (checkOnly) console.log(`\n${results.length - failed - skipped} ready, ${failed} failed, ${skipped} need a live state. Check only, nothing captured.`);
else console.log(`\n${results.length - failed} captured, ${failed} failed. Output: ${outDir}`);
process.exit(failed ? 1 : 0);
