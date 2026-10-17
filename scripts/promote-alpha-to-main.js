#!/usr/bin/env node

// Consolidates every alpha build entry accumulated this cycle (see
// promoteDevelopToAlpha - alpha holds one entry per "Force to alpha" call,
// not a single rolling entry) into one clean, permanent Main release entry,
// bumps the real semver, and regenerates every derived file (package.json,
// package-lock.json, CHANGELOG.md) - then resets alpha and develop for the
// next cycle. Run locally as part of "Force to main", before the force-push,
// so the pushed commit already carries the finished release; CI no longer
// needs to generate or fix up changelog content afterward.
//
// Passing --preview runs the same release computation read-only (no files are
// written or reset) and prints the version + release entry that would be committed
// to main. The mutating command requires --confirm, which is only run after a human
// has approved that exact preview in the "Force to main" workflow.
//
// The website content-impact gate does not block --preview: the release is settled
// before any website work, so the preview lists the guides still outstanding as
// information. --confirm still refuses while any remain, except --defer-website-gate:
// the disposable candidate build uses it, because the reviewed website is carried in
// only after that build, and the final --confirm on the carried release enforces the gate.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogEntryQualityViolations, changelogEntryProcessViolations, filterChangelogEntries } from "./changelog-message.js";
import { buildChangelogSectionGroups, changelogSectionGroups } from "./changelog-sections.js";
import { formatSections, mergeSections } from "./promote-develop-to-alpha.js";
import { generateChangelogMarkdown } from "./generate-changelog-md.js";
import { fileAtRef, gitHeadAuthor, gitHeadCommit } from "./changelog-git-helpers.js";
import { websiteContentImpactViolations } from "./site-impact.js";
import { buildVersion, compareBuildVersions } from "./version.js";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const alphaChangelogPath = path.join(root, "changelog.alpha.json");
const developChangelogPath = path.join(root, "changelog.develop.json");
const packagePath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const PUBLIC_WEBSITE_URL = "https://plekt.net";

export function bumpPatchVersion(currentVersion = "0.0.0") {
  const parts = currentVersion.split(".").map((n) => Number(n) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = (parts[2] ?? 0) + 1;
  return `${major}.${minor}.${patch}`;
}

// The dev counter returns to 0 so the first "Push to git" of the new cycle is
// <release>.0.1, and the recorded version is the five-segment release itself,
// which is also what the freshly stamped public assets carry.
export function createDevelopReset({ version = "0.0.0", resetCommit = "", updatedAt = "" } = {}) {
  return {
    version: buildVersion(version, 0, 0),
    build: 0,
    resetCommit: String(resetCommit || ""),
    updatedAt,
    entries: [],
  };
}

// Five-segment aware. The old implementation split on "." and read only three
// positions, so anything past the patch was silently dropped and a non-numeric
// segment became NaN, which `(NaN || 0)` then collapsed to 0. This feeds the
// release-version decision below, so a wrong answer here picks the wrong version
// to publish to every user.
function semverGt(a, b) {
  return compareBuildVersions(a, b) > 0;
}

// Pure step shared by preview and the real promotion: read the current
// changelog, alpha, and package.json and return the release entry that would
// be written (new version + the merged main entry), refusing to proceed if the
// assembled entry still contains recognized release-process text. Nothing here
// touches disk other than reading the source files, so it can back a
// non-mutating --preview pass used to show the changelog to a human before
// "Force to main" is allowed to stage and push it.
//
// `sources` ({ changelog, alpha, manualVersion }) and `impactViolations` exist
// for tests: they replace the file reads and the git-backed website gate.
function computeAlphaToMainRelease({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "", sources = null, impactViolations = websiteContentImpactViolations } = {}) {
  // The released history must come from origin/main, not the working tree.
  //
  // This promotion runs from alpha's checkout. Alpha's tree came from develop,
  // and the release commit is never merged back into develop, so neither branch
  // holds main's release history. Reading the working tree would publish a
  // changelog containing only this release - and the loss compounds silently:
  // release N is absent from develop, so next cycle's alpha carries a file
  // missing release N, and release N+1 is appended to that. Every release would
  // erase the one before it, in the shipped image and on the website.
  //
  // CHANGELOG.md needs no separate handling: generateChangelogMarkdown() renders
  // it from changelog.json, so restoring the history here restores both files.
  //
  // The working tree is the fallback for a first release or a clone with no
  // remote-tracking refs. promoteAlphaToMain() gates on the result either way.
  let changelog = { version: "0.8.6", entries: [] };
  let historySource = "origin/main";
  if (sources) {
    changelog = structuredClone(sources.changelog || changelog);
    historySource = "test sources";
  } else {
    const remoteChangelog = fileAtRef(root, "origin/main", "changelog.json");
    try {
      changelog = JSON.parse(remoteChangelog ?? fs.readFileSync(changelogPath, "utf8"));
      if (!remoteChangelog) historySource = "working tree";
    } catch {
      try {
        changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
        historySource = "working tree";
      } catch { }
    }
  }
  if (!Array.isArray(changelog.entries)) changelog.entries = [];

  let alpha = { baseVersion: changelog.version, build: 0, releaseMessage: "", entries: [] };
  if (sources) {
    alpha = structuredClone(sources.alpha || alpha);
  } else {
    try {
      alpha = JSON.parse(fs.readFileSync(alphaChangelogPath, "utf8"));
    } catch { }
  }
  if (!Array.isArray(alpha.entries)) alpha.entries = [];

  // If package.json was manually set to a higher version (a deliberate
  // major/minor bump), honour that instead of overwriting it with a patch
  // increment - same rule update-changelog.js used to apply in CI.
  const patchBumped = bumpPatchVersion(changelog.version);
  let manualVersion = sources ? String(sources.manualVersion || "") : "";
  if (!sources) {
    try {
      manualVersion = JSON.parse(fs.readFileSync(packagePath, "utf8")).version || "";
    } catch { }
  }
  const newMainVersion = targetVersion || (semverGt(manualVersion, patchBumped) ? manualVersion : patchBumped);
  const new5DigitVersion = `${newMainVersion}.0.0`;

  const publicEntries = filterChangelogEntries(alpha.entries);
  if (!publicEntries.length) {
    throw new Error("Refusing to promote alpha to main: there are no user-facing alpha builds to consolidate.");
  }

  // Each alpha build entry already carries its own correctly categorized `sections`
  // (categorizeEntries ran once, in promoteDevelopToAlpha, over that build's own raw
  // develop commits) - merge those directly rather than re-running categorizeEntries
  // over the entries themselves, which would treat each entry's synthesized `message`
  // sentence as an uncategorized bullet and land it in tweaks as a garbled duplicate.
  const sections = publicEntries.reduce(
    (acc, entry) => mergeSections(acc, entry.sections || {}),
    { newFeatures: [], majorBugFixes: [], tweaks: [] },
  );
  const brandMigration = !changelog.entries.some((entry) => entry.brandMigration === "plekt");
  if (brandMigration) {
    sections.tweaks.push("Plembfin is now Plekt. Docker users: change the image to ghcr.io/lasikiewicz/plekt or plembfin/plekt, keep the same tag, volumes and settings. Both old image names receive updates for at least six months after this release.");
  }
  const simplifiedDetails = formatSections(sections);
  // Alpha entries remain detailed and build-specific, but the final Main release
  // must carry one concise, human-approved headline instead of concatenating every
  // alpha build into a paragraph. The Force-to-main workflow writes this field after
  // reviewing the accumulated sections and before showing the preview.
  const configuredReleaseMessage = String(alpha.releaseMessage || "").trim();
  if (!configuredReleaseMessage) {
    throw new Error("Refusing to promote alpha to main: changelog.alpha.json must contain a concise releaseMessage after review.");
  }
  if (configuredReleaseMessage.length > 240 || /[\r\n]/.test(configuredReleaseMessage)) {
    throw new Error("Refusing to promote alpha to main: releaseMessage must be one line and at most 240 characters.");
  }
  const mainMessage = configuredReleaseMessage;

  const mainEntry = {
    version: newMainVersion,
    version5Digit: new5DigitVersion,
    date: sourceDate,
    commit: commit || publicEntries[0]?.commit || "",
    message: mainMessage,
    websiteUrl: PUBLIC_WEBSITE_URL,
    ...(brandMigration ? { brandMigration: "plekt" } : {}),
    author: sourceAuthor,
    details: simplifiedDetails,
    sections,
    sectionGroups: buildChangelogSectionGroups(sections),
  };

  // Safety net: filterChangelogEntries above, and categorizeEntries when each alpha
  // build entry was originally built, already filter recognized release-process text,
  // but check the assembled entry directly before it is ever written, rather than
  // relying only on a separate step run afterward that could be skipped.
  const violations = changelogEntryProcessViolations(mainEntry);
  if (violations.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the entry contains release-process notes:\n${violations.map((v) => `- ${v}`).join("\n")}`);
  }

  // This entry becomes the GitHub Release, the in-app changelog, and the public
  // website's release notes. It has to read as release notes.
  const quality = changelogEntryQualityViolations(mainEntry);
  if (quality.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the entry is not publishable:\n${quality.map((v) => `- ${v}`).join("\n")}`);
  }

  // The website content-impact gate (scripts/site-impact.js): every guide the
  // release's commits need, by their `site-impact:` note or else by the
  // app-surface.json file mapping, must differ from the previous release in
  // the website tree being released - the develop tree skill step 1a stages,
  // not only alpha's commits. Walks from the previous main release's own
  // commit to this checkout's HEAD, so it covers every alpha build folded into
  // this promotion. Silently a no-op when there is no previous release commit
  // to anchor from (first release, or a working-tree fallback).
  //
  // Only reported here. The release is settled before any website work, so
  // --preview shows the outstanding guides as information; promoteAlphaToMain
  // (--confirm) is the one that refuses on them.
  const websiteImpactOutstanding = impactViolations({
    fromCommit: changelog.entries[0]?.commit || "",
    toCommit: gitHeadCommit(root),
  });

  return { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry, historySource, websiteImpactOutstanding };
}

// The --preview pass: the would-be release plus any guides the website gate
// still needs. Never throws on the website gate.
export function previewAlphaToMainRelease(options = {}) {
  return computeAlphaToMainRelease(options);
}

// Renders the would-be release for a human review pass. Used by --preview so
// the changelog can be confirmed before "Force to main" actually promotes.
function renderReleasePreview({ newMainVersion, new5DigitVersion, mainEntry, websiteImpactOutstanding = [] }) {
  const lines = [];
  lines.push("=== PREVIEW: Force-to-main release (nothing written yet) ===");
  lines.push(`Version: v${newMainVersion}  (5-digit: ${new5DigitVersion})`);
  lines.push("");
  lines.push("Message:");
  lines.push(`  ${mainEntry.message}`);
  lines.push(`  Website: ${mainEntry.websiteUrl}`);
  lines.push("");
  const renderSection = (section) => {
    if (!section.groups.length) return;
    lines.push(`${section.title}:`);
    for (const group of section.groups) {
      if (group.title) lines.push(`  ${group.title}:`);
      for (const value of group.details) lines.push(`    - ${value}`);
    }
    lines.push("");
  };
  for (const section of changelogSectionGroups(mainEntry)) renderSection(section);
  lines.push("(details[] carries the same items each prefixed Feature:/Fix:/Tweak:.)");
  lines.push("");
  if (websiteImpactOutstanding.length > 0) {
    lines.push("Website guides still outstanding (--confirm refuses until these are resolved):");
    for (const value of websiteImpactOutstanding) lines.push(`  - ${value}`);
  } else {
    lines.push("Website guides: none outstanding.");
  }
  console.log(lines.join("\n"));
}

// Writing the merged history is not enough; it has to be checked before the
// force-push. A release that drops history cannot be recovered from the
// published image once users have pulled it, so this refuses the promotion
// rather than shipping a truncated changelog.
//
// Exported pure so it can be tested without touching disk or the network.
export function verifyReleaseHistory({ priorVersions = [], newVersions = [], newMainVersion = "" } = {}) {
  const failures = [];
  const present = new Set(newVersions.map((v) => String(v)));

  const missing = priorVersions.map(String).filter((v) => !present.has(v));
  if (missing.length > 0) {
    failures.push(`releases missing from the new history: ${missing.join(", ")}`);
  }

  const added = newVersions.map(String).filter((v) => !priorVersions.map(String).includes(v));
  if (added.length !== 1) {
    failures.push(`expected exactly one new release, found ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`);
  } else if (added[0] !== String(newMainVersion)) {
    failures.push(`the one new release is ${added[0]}, expected ${newMainVersion}`);
  }

  if (newVersions.length !== priorVersions.length + 1) {
    failures.push(`history length went from ${priorVersions.length} to ${newVersions.length}, expected ${priorVersions.length + 1}`);
  }

  return failures;
}

// Stamps every website documentation page with the version being released.
//
// Each page's frontmatter carries a `sourceVersion` marker recording the released
// application version its content was verified against. Before this, the marker
// was written by hand during the website update gate, and drifted: the v1.1.0
// release shipped a site whose 36 pages all still claimed 1.0.2, so the published
// documentation described one release while the site displayed another.
//
// It cannot be stamped at gate time, because that gate runs before this script
// decides the new version. Writing it here makes the drift structurally
// impossible. The mandatory website gate in "Force to main" remains the thing
// that proves a human actually reviewed the pages; this only records which
// release the reviewed content shipped with.
//
// website/scripts/check-doc-baseline.mjs enforces the same equality, so a page
// left behind fails the website checks rather than publishing silently.
export function stampDocumentationBaseline(version, { docsDir, readFile, writeFile, listFiles } = {}) {
  const dir = docsDir || path.join(root, "website", "src", "content", "docs");
  const read = readFile || ((file) => fs.readFileSync(file, "utf8"));
  const write = writeFile || ((file, contents) => fs.writeFileSync(file, contents));
  const list = listFiles || ((base) => {
    const found = [];
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const full = path.join(base, entry.name);
      if (entry.isDirectory()) found.push(...list(full));
      else if (entry.name.endsWith(".mdx") || entry.name.endsWith(".md")) found.push(full);
    }
    return found;
  });

  const stamped = [];
  for (const file of list(dir)) {
    const contents = read(file);
    const updated = contents.replace(/^sourceVersion:\s*["']?[^"'\s]+["']?\s*$/m, `sourceVersion: "${version}"`);
    if (updated !== contents) {
      write(file, updated);
      stamped.push(file);
    }
  }
  return stamped;
}

export function promoteAlphaToMain({ targetVersion = "", sourceDate = new Date().toISOString(), sourceAuthor = "system", commit = "", sources = null, impactViolations, deferWebsiteGate = false } = {}) {
  const { changelog, alpha, newMainVersion, new5DigitVersion, mainEntry, historySource, websiteImpactOutstanding } = computeAlphaToMainRelease({ targetVersion, sourceDate, sourceAuthor, commit, sources, impactViolations });

  // The website content-impact gate blocks the real promotion (never the
  // preview). Checked before anything is written. A candidate build defers it
  // because its website/ tree is still alpha's; the final promotion enforces it.
  if (websiteImpactOutstanding.length > 0) {
    if (!deferWebsiteGate) throw new Error(`Refusing to promote alpha to main: the website content-impact gate failed:\n${websiteImpactOutstanding.map((v) => `- ${v}`).join("\n")}`);
    console.log(`Website content-impact gate deferred for a candidate build (${websiteImpactOutstanding.length} guide(s) outstanding); the final --confirm enforces it.`);
  }
  // Injected test sources must never reach the real files below.
  if (sources) throw new Error("Refusing to write a promotion computed from test sources.");

  const priorVersions = changelog.entries.map((entry) => entry.version);

  changelog.version = newMainVersion;
  changelog.updatedAt = sourceDate;
  changelog.entries.unshift(mainEntry);

  const historyFailures = verifyReleaseHistory({
    priorVersions,
    newVersions: changelog.entries.map((entry) => entry.version),
    newMainVersion,
  });
  if (historyFailures.length > 0) {
    throw new Error(`Refusing to promote alpha to main: the release history is not intact (source: ${historySource}):\n${historyFailures.map((f) => `- ${f}`).join("\n")}`);
  }

  // Update package.json and package-lock.json
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    pkg.version = newMainVersion;
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch { }
  try {
    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
    packageLock.version = newMainVersion;
    if (packageLock.packages?.[""]) packageLock.packages[""].version = newMainVersion;
    fs.writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  } catch { }

  // Reset alpha changelog for the new release cycle
  const resetAlpha = {
    baseVersion: newMainVersion,
    build: 0,
    version: buildVersion(newMainVersion, 0, 0),
    updatedAt: sourceDate,
    releaseMessage: "",
    entries: [],
  };

  // Start local develop at the released version's first build for the new
  // cycle. The rebuild anchor moves to this promotion commit, so the next
  // rebuild only walks commits made after it.
  let develop = { build: 0, resetCommit: "", entries: [] };
  try {
    develop = JSON.parse(fs.readFileSync(developChangelogPath, "utf8"));
  } catch { }
  develop = createDevelopReset({
    version: newMainVersion,
    resetCommit: commit || develop.resetCommit || "",
    updatedAt: sourceDate,
  });

  fs.writeFileSync(changelogPath, `${JSON.stringify(changelog, null, 2)}\n`);
  fs.writeFileSync(alphaChangelogPath, `${JSON.stringify(resetAlpha, null, 2)}\n`);
  fs.writeFileSync(developChangelogPath, `${JSON.stringify(develop, null, 2)}\n`);
  generateChangelogMarkdown();

  // Keep the no-JavaScript fallback on the About page aligned with the
  // installed release. The client updates this value from /api/changelog once
  // it boots, but the static HTML is also covered by startup smoke tests and
  // is what a disabled or delayed script initially shows.
  const indexPath = path.join(root, "public", "index.html");
  const indexSource = fs.readFileSync(indexPath, "utf8");
  const updatedIndexSource = indexSource.replace(
    /(id="aboutCurrentVersion">)v[^<]+/,
    `$1v${newMainVersion}`,
  );
  if (updatedIndexSource === indexSource) {
    throw new Error("Could not update the About page's installed version fallback.");
  }
  fs.writeFileSync(indexPath, updatedIndexSource);

  // Alpha's build number is gone once this release resets it, so the public
  // assets have to move to the new release version here or the version check
  // fails and browsers keep serving the last alpha build's JavaScript.
  const assetResult = spawnSync(process.execPath, [path.join(root, "scripts", "asset-versions.js"), "--write", `--version=${new5DigitVersion}`], {
    cwd: root,
    encoding: "utf8",
  });
  if (assetResult.status !== 0) {
    throw new Error(`Failed to stamp public assets with ${new5DigitVersion}: ${assetResult.stderr || assetResult.stdout}`);
  }
  console.log(String(assetResult.stdout || "").trim());

  // Record which release the reviewed documentation shipped with. See the
  // function's own comment for why this is written here and not at gate time.
  const stampedDocs = stampDocumentationBaseline(newMainVersion);
  console.log(`Stamped ${stampedDocs.length} documentation page(s) as verified against v${newMainVersion}.`);

  console.log(`Promoted Alpha to Main release v${newMainVersion} (${new5DigitVersion})`);
  console.log(`Release history: ${changelog.entries.length} entries, read from ${historySource}.`);
  return { changelog, alpha: resetAlpha, develop };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const preview = args.includes("--preview");
  const targetArg = args.find((arg) => arg && !arg.startsWith("--"));
  const targetVersion = targetArg || process.env.TARGET_VERSION || "";

  if (preview) {
    // Non-mutating review pass: show exactly what "Force to main" would write
    // (version + the merged release entry) so the operator can confirm the
    // changelog with the user before anything is staged or pushed.
    const pending = previewAlphaToMainRelease({ targetVersion });
    renderReleasePreview(pending);
    console.log("\n[preview only - nothing written. After explicit approval, rerun with --confirm to promote.]");
  } else if (!args.includes("--confirm")) {
    console.error("Refusing to promote alpha to main without explicit confirmation.");
    console.error("Run --preview, obtain approval for that exact changelog, then rerun with --confirm.");
    process.exitCode = 1;
  } else {
    promoteAlphaToMain({
      targetVersion,
      commit: gitHeadCommit(root),
      sourceAuthor: gitHeadAuthor(root),
      deferWebsiteGate: args.includes("--defer-website-gate"),
    });
  }
}
