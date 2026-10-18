#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedPublicDir = process.argv.find((argument) => argument.startsWith("--public-dir="))?.slice("--public-dir=".length);
const publicDir = requestedPublicDir ? path.resolve(requestedPublicDir) : path.join(root, "public");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Versioned assets are cached immutably for a year, so the query has to change
// whenever the served files change or a browser keeps the old module forever.
// package.json only moves on a release to main, which left every build between
// releases sharing one asset version: a tester who pulled a new image could
// still be running the previous build's JavaScript.
//
// So the expected version is the most specific build version available for the
// current release, in order: develop's five-segment build, then alpha's, then
// the bare package version. All three are gated on matching the current release
// so a manifest left over from a previous cycle cannot hold the assets back.
//
// This function is also what `npm run build` checks against
// (scripts/build-check.js runs this file with no --version), so it must agree
// with whatever the last write stamped. "Push to git", "Force to alpha", and
// "Force to main" each stamp their own build version, and each is recognized
// here.
export function currentAssetVersion() {
  const packageVersion = String(packageJson.version || "dev").trim();

  const readManifestVersion = (file) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      const version = String(manifest?.version || "").trim();
      // A manifest is only trusted while it is still building on this release.
      // `1.1.0` must match, and the build version must extend it, so a stale
      // `1.0.2.3` from before the last release is ignored.
      if (version && version.startsWith(`${packageVersion}.`)) return version;
    } catch { /* manifest absent or unreadable: try the next source */ }
    return "";
  };

  // develop first: it is the most specific, and a develop build is always at or
  // ahead of the alpha build it was reset from.
  return readManifestVersion("changelog.develop.json")
    || readManifestVersion("changelog.alpha.json")
    || packageVersion;
}

const requestedVersion = process.argv.find((argument) => argument.startsWith("--version="))?.slice("--version=".length);
const assetVersion = String(requestedVersion || process.env.ASSET_VERSION || currentAssetVersion()).trim();
const write = process.argv.includes("--write");

if (!/^[A-Za-z0-9._-]+$/.test(assetVersion)) {
  throw new Error(`Invalid asset version: ${assetVersion}`);
}

const assetReferencePattern = /(["'`])((?:\/|\.{1,2}\/)[^"'`)\s]+?\.(?:m?js|css|svg|png|jpe?g|webp|gif|ico|webmanifest|woff2?))(?:\?([^"'`)\s]*))?(["'`])/gi;

// The pattern above only recognizes a URL written as one complete literal, so a
// path assembled at runtime - `/icons/${target}.svg?v=...` - was invisible to
// both the check and the rewrite. Two of those kept a hardcoded token through
// several releases, and the browser then fetched the same icon under both that
// token and the canonical one. This second pass reads the version query alone,
// wherever it appears on a managed path, so a dynamic reference cannot drift.
const dynamicVersionPattern = /(\/(?:icons|modules)\/[^"'`\s>]*?|\/app\.js|\/styles(?:-modern)?\.css)\?v=([A-Za-z0-9._-]+)/g;

function textFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return textFiles(absolute);
    if (!entry.isFile() || !/\.(?:js|html|css|webmanifest)$/i.test(entry.name)) return [];
    return [absolute];
  });
}

function managesAsset(assetPath) {
  if (assetPath.startsWith("/media/")) return false;
  return assetPath.startsWith("/modules/")
    || assetPath.startsWith("/icons/")
    || assetPath === "/app.js"
    || assetPath === "/styles.css"
    || assetPath === "/manifest.webmanifest"
    || assetPath === "/theme-boot.js"
    || assetPath.startsWith("/fonts/")
    || /^\/plekt_header_logo_(?:dark|light)\.png$/.test(assetPath)
    || assetPath.startsWith("./")
    || assetPath.startsWith("../");
}

function inspectFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const references = [];
  let match;
  while ((match = assetReferencePattern.exec(source))) {
    const [, quote, assetPath, query, closingQuote] = match;
    if (!managesAsset(assetPath)) continue;
    references.push({
      assetPath,
      query: query || "",
      start: match.index,
      end: assetReferencePattern.lastIndex,
      quote,
      closingQuote,
    });
  }
  assetReferencePattern.lastIndex = 0;
  return { source, references };
}

const files = textFiles(publicDir);
const violations = [];
let references = 0;
let dynamicVersions = 0;
let changedFiles = 0;
for (const filePath of files) {
  const { source, references: fileReferences } = inspectFile(filePath);
  references += fileReferences.length;
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  for (const reference of fileReferences) {
    if (reference.query !== `v=${assetVersion}`) {
      violations.push(`${relative}: ${reference.assetPath}${reference.query ? `?${reference.query}` : " (unversioned)"}`);
    }
  }
  let dynamicMatch;
  while ((dynamicMatch = dynamicVersionPattern.exec(source))) {
    const [, assetPath, version] = dynamicMatch;
    dynamicVersions += 1;
    if (version !== assetVersion) violations.push(`${relative}: ${assetPath}?v=${version}`);
  }
  dynamicVersionPattern.lastIndex = 0;

  if (!write) continue;

  let rewritten = source.replace(assetReferencePattern, (full, quote, assetPath, query, closingQuote) => {
    if (!managesAsset(assetPath)) return full;
    return `${quote}${assetPath}?v=${assetVersion}${closingQuote}`;
  });
  assetReferencePattern.lastIndex = 0;
  rewritten = rewritten.replace(dynamicVersionPattern, (full, assetPath) => `${assetPath}?v=${assetVersion}`);
  dynamicVersionPattern.lastIndex = 0;
  if (rewritten !== source) {
    fs.writeFileSync(filePath, rewritten);
    changedFiles += 1;
  }
}

if (write) {
  console.log(`Updated ${references + dynamicVersions} local public asset references in ${changedFiles} files to ?v=${assetVersion}.`);
  process.exit(0);
}

if (violations.length) {
  console.error(`Found ${violations.length} public asset references that do not use ?v=${assetVersion}:`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}

console.log(`Public asset version check passed: ${references} literal and ${dynamicVersions} dynamic references use ?v=${assetVersion}.`);
