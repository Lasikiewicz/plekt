import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getImageVariantPath, getImageVariantWidths, isOptimizableRasterPath } from "../src/utils/image-variants.js";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetsRoot = path.join(websiteRoot, "public", "assets");
const optimizedRoot = path.join(assetsRoot, "optimized");
const docsRoot = path.join(websiteRoot, "src", "content", "docs");
const failures = [];
const headerLogoPattern = /^plembfin_header_logo_(?:dark|light)\.(?:png|jpe?g|webp)$/i;
const generatedFormats = ["webp", "png"];

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolutePath));
    else files.push(absolutePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function relativeAssetPath(absolutePath) {
  return path.relative(assetsRoot, absolutePath).replaceAll(path.sep, "/");
}

function assetUrl(relativePath) {
  return `/assets/${relativePath}`;
}

function localPathFromAssetUrl(url) {
  return path.join(assetsRoot, url.replace(/^\/assets\//, ""));
}

function targetWidths(relativePath, sourceWidth) {
  if (headerLogoPattern.test(path.basename(relativePath))) return [376];
  return getImageVariantWidths(sourceWidth);
}

function expectedWidth(sourceWidth, requestedWidth) {
  return Math.min(sourceWidth, requestedWidth);
}

const sourceAssets = walkFiles(assetsRoot)
  .filter((absolutePath) => !absolutePath.startsWith(`${optimizedRoot}${path.sep}`))
  .filter((absolutePath) => isOptimizableRasterPath(assetUrl(relativeAssetPath(absolutePath))));

let generatedVariantCount = 0;
for (const sourcePath of sourceAssets) {
  const relativePath = relativeAssetPath(sourcePath);
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width || !metadata.height) {
    failures.push(`${relativePath} has no readable intrinsic dimensions`);
    continue;
  }

  for (const width of targetWidths(relativePath, metadata.width)) {
    for (const format of generatedFormats) {
      const generatedUrl = getImageVariantPath(assetUrl(relativePath), width, format);
      const generatedPath = localPathFromAssetUrl(generatedUrl);
      generatedVariantCount += 1;
      if (!fs.existsSync(generatedPath)) {
        failures.push(`missing generated asset ${generatedUrl}`);
        continue;
      }

      const generatedMetadata = await sharp(generatedPath).metadata();
      const expected = expectedWidth(metadata.width, width);
      if (generatedMetadata.width !== expected || !generatedMetadata.height) {
        failures.push(`${generatedUrl} is missing expected dimensions (${expected}px wide)`);
      }
    }
  }
}

const byteBudgets = [
  [getImageVariantPath("/assets/app-captures/dashboard-home-dark.png", 1440, "webp"), 250_000],
  [getImageVariantPath("/assets/app-captures/dashboard-home-light.png", 1440, "webp"), 250_000],
  [getImageVariantPath("/assets/plembfin_header_logo_dark.png", 376, "webp"), 24_000],
  [getImageVariantPath("/assets/plembfin_header_logo_light.png", 376, "webp"), 24_000],
  ["/assets/og-card.png", 600_000],
  ["/assets/optimized/plembfin-hub.svg", 300_000],
];

const socialCardPath = path.join(assetsRoot, "og-card.png");
if (fs.existsSync(socialCardPath)) {
  const socialCard = await sharp(socialCardPath).metadata();
  if (socialCard.width !== 1200 || socialCard.height !== 630) {
    failures.push(`og-card.png must be exactly 1200x630 (found ${socialCard.width}x${socialCard.height})`);
  }
} else {
  failures.push("missing public/assets/og-card.png");
}

for (const [url, maximumBytes] of byteBudgets) {
  const absolutePath = localPathFromAssetUrl(url);
  if (!fs.existsSync(absolutePath)) continue;
  const bytes = fs.statSync(absolutePath).size;
  if (bytes > maximumBytes) failures.push(`${url} is ${bytes} bytes; budget is ${maximumBytes} bytes`);
}

for (const sourcePath of sourceAssets.filter((value) => relativeAssetPath(value).startsWith("app-captures/"))) {
  const relativePath = relativeAssetPath(sourcePath);
  const metadata = await sharp(sourcePath).metadata();
  if (!metadata.width) continue;
  const largestWidth = targetWidths(relativePath, metadata.width).at(-1);
  const generatedUrl = getImageVariantPath(assetUrl(relativePath), largestWidth, "webp");
  const generatedPath = localPathFromAssetUrl(generatedUrl);
  if (fs.existsSync(generatedPath) && fs.statSync(generatedPath).size > 500_000) {
    failures.push(`${generatedUrl} is larger than the 500 KB documentation-image budget`);
  }
}

const figureSource = fs.readFileSync(path.join(websiteRoot, "src", "components", "ScreenshotFigure.astro"), "utf8");
const indexSource = fs.readFileSync(path.join(websiteRoot, "src", "pages", "index.astro"), "utf8");
const headerSource = fs.readFileSync(path.join(websiteRoot, "src", "components", "SiteHeader.astro"), "utf8");
const stylesSource = fs.readFileSync(path.join(websiteRoot, "src", "styles", "site.css"), "utf8");
if (!figureSource.includes("optimized = true")) failures.push("ScreenshotFigure.astro does not default raster images to optimized sources");
if (!indexSource.includes('fetchpriority="high"')) failures.push("the landing-page dashboard figure is missing fetchpriority=high");
if (!indexSource.includes('loading="lazy"')) failures.push("the landing-page hub figure is missing loading=lazy");
if (!headerSource.includes("/assets/optimized/plembfin_header_logo_dark-376.webp")) {
  failures.push("the header is not using the optimized logo source");
}
if (!headerSource.includes('!logo.closest("picture")') || !headerSource.includes('!image.closest("picture")')) {
  failures.push("theme switching can override a picture element's optimized source");
}
if (/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(stylesSource)) {
  failures.push("site.css still depends on third-party Google Fonts assets");
}

const headersSource = fs.readFileSync(path.join(websiteRoot, "public", "_headers"), "utf8");
if (!/\/_astro\/\*\s*\r?\n\s*Cache-Control:\s*public, max-age=31536000, immutable/i.test(headersSource)) {
  failures.push("public/_headers does not cache hashed Astro assets for one year");
}

for (const docPath of walkFiles(docsRoot).filter((value) => value.endsWith(".mdx"))) {
  const source = fs.readFileSync(docPath, "utf8");
  if (/<ScreenshotFigure\b[\s\S]*?optimized=\{false\}/i.test(source)) {
    failures.push(`${path.relative(websiteRoot, docPath)} disables automatic image optimization`);
  }
}

const distRoot = path.join(websiteRoot, "dist");
if (fs.existsSync(distRoot)) {
  for (const htmlPath of walkFiles(distRoot).filter((value) => value.endsWith(".html"))) {
    const html = fs.readFileSync(htmlPath, "utf8");
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      const image = match[0];
      if (!/\bwidth="\d+"/.test(image) || !/\bheight="\d+"/.test(image)) {
        failures.push(`${path.relative(websiteRoot, htmlPath)} contains an image without intrinsic dimensions`);
      }
      const source = image.match(/\bsrc="([^\"]+)"/i)?.[1] || "";
      if (/\/assets\/(?:app-captures\/|optimized\/).*\.(?:png|jpe?g)$/i.test(source)) {
        failures.push(`${path.relative(websiteRoot, htmlPath)} uses a raster PNG/JPEG as an image src: ${source}`);
      }
    }
  }
}

const hubSvg = path.join(optimizedRoot, "plembfin-hub.svg");
if (fs.existsSync(hubSvg)) {
  const source = fs.readFileSync(hubSvg, "utf8");
  if (!/<svg[^>]*\bviewBox="0 0 1200 540"/.test(source)) failures.push("optimized/plembfin-hub.svg is missing its 1200x540 viewBox");
  if (!/<svg[^>]*\bwidth="1200"/.test(source) || !/<svg[^>]*\bheight="540"/.test(source)) {
    failures.push("optimized/plembfin-hub.svg is missing explicit intrinsic dimensions");
  }
}

if (failures.length) {
  console.error(`Website asset check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Website asset check passed (${sourceAssets.length} raster sources, ${generatedVariantCount} variants, and ${byteBudgets.length} budgets).`);
}
