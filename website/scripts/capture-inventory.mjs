import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(websiteRoot, "src", "content", "docs");
const assetsRoot = path.join(websiteRoot, "public", "assets");
const outputPath = path.join(websiteRoot, "src", "generated", "capture-manifest.json");
const rasterExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const imageExtensions = new Set([...rasterExtensions, ".svg"]);
const writeOutput = process.argv.includes("--write");

function readPreviousManifest() {
  if (!fs.existsSync(outputPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(outputPath, "utf8"));
  } catch {
    return null;
  }
}

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

function websiteRelative(absolutePath) {
  return path.relative(websiteRoot, absolutePath).replaceAll(path.sep, "/");
}

function parseSourceVersion(text) {
  return text.match(/^sourceVersion:\s*["']([^"']+)["']\s*$/m)?.[1] || null;
}

function parseDocSlug(absolutePath) {
  return path.relative(docsRoot, absolutePath).replaceAll(path.sep, "/").replace(/\.mdx$/, "");
}

function pngDimensions(buffer) {
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda || offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (sofMarkers.has(marker) && segmentLength >= 7) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += segmentLength;
  }
  return null;
}

function imageDimensions(buffer) {
  return pngDimensions(buffer) || jpegDimensions(buffer);
}

const docs = [];
const assetReferences = new Map();

for (const absolutePath of walkFiles(docsRoot).filter((file) => file.endsWith(".mdx"))) {
  const text = fs.readFileSync(absolutePath, "utf8");
  const references = [...text.matchAll(/\/assets\/((?:app-captures|icons)\/[^\s"')>]+\.(?:gif|jpeg|jpg|png|webp|svg))/gi)]
    .map((match) => `public/assets/${match[1]}`)
    .sort();
  const uniqueReferences = [...new Set(references)];
  const doc = {
    slug: parseDocSlug(absolutePath),
    sourceVersion: parseSourceVersion(text),
    screenshots: uniqueReferences,
  };
  docs.push(doc);
  for (const asset of uniqueReferences) {
    const pages = assetReferences.get(asset) || [];
    pages.push(doc.slug);
    assetReferences.set(asset, pages);
  }
}

// Site pages (the homepage and other Astro pages) also show captures; count them as references
// so a page-only image is not reported as unreferenced and dropped from the release pipeline.
const pagesRoot = path.join(websiteRoot, "src", "pages");
for (const absolutePath of walkFiles(pagesRoot).filter((file) => file.endsWith(".astro"))) {
  const text = fs.readFileSync(absolutePath, "utf8");
  const slug = path.relative(pagesRoot, absolutePath).replaceAll(path.sep, "/").replace(/\.astro$/, "").replace(/(^|\/)index$/, "") || "index";
  const references = [...text.matchAll(/\/assets\/((?:app-captures|icons)\/[^\s"')>]+\.(?:gif|jpeg|jpg|png|webp|svg))/gi)]
    .map((match) => `public/assets/${match[1]}`);
  for (const asset of new Set(references)) {
    const pages = assetReferences.get(asset) || [];
    pages.push(slug);
    assetReferences.set(asset, pages);
  }
}

const assets = walkFiles(assetsRoot)
  .filter((file) => imageExtensions.has(path.extname(file).toLowerCase()))
  .filter((file) => !websiteRelative(file).startsWith("public/assets/optimized/"))
  .map((absolutePath) => {
    const buffer = fs.readFileSync(absolutePath);
    const relativePath = websiteRelative(absolutePath);
    const dimensions = imageDimensions(buffer);
    return {
      path: relativePath,
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      dimensions,
      // A Modern capture is shown wherever its Classic partner is referenced.
      referencedBy: assetReferences.get(relativePath)
        || assetReferences.get(relativePath.replace(/-modern-(dark|light)(\.[a-z]+)$/i, "-$1$2"))
        || [],
    };
  });

const previousManifest = readPreviousManifest();
const previousAssets = new Map((previousManifest?.assets || []).map((asset) => [asset.path, asset]));
const currentAssetPaths = new Set(assets.map((asset) => asset.path));
const changes = {
  added: assets.filter((asset) => !previousAssets.has(asset.path)).map((asset) => asset.path),
  changed: assets
    .filter((asset) => previousAssets.get(asset.path)?.sha256 && previousAssets.get(asset.path).sha256 !== asset.sha256)
    .map((asset) => asset.path),
  removed: [...previousAssets.keys()].filter((asset) => !currentAssetPaths.has(asset)).sort(),
  unreferenced: assets.filter((asset) => asset.referencedBy.length === 0).map((asset) => asset.path),
};

const manifest = {
  schemaVersion: 1,
  generatedBy: "website/scripts/capture-inventory.mjs",
  changes,
  docs,
  assets,
};

const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (writeOutput) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json);
  console.log(
    `Wrote ${websiteRelative(outputPath)} (${assets.length} image assets, ${assetReferences.size} referenced; `
      + `${changes.added.length} added, ${changes.changed.length} changed, ${changes.removed.length} removed).`,
  );
} else {
  process.stdout.write(json);
}
