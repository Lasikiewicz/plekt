#!/usr/bin/env node
// Print the website app images to retake for a set of changed application files.
//
//   node scripts/stale-captures.mjs                      files changed since origin/main (committed and uncommitted)
//   node scripts/stale-captures.mjs --since=<ref>        files changed since another ref
//   node scripts/stale-captures.mjs <file> [<file> ...]  these files (paths from the repository root)
//
// Source-path matches are review candidates only. Compare each existing image with the
// approved release candidate before choosing which variants actually need retaking.
// Shared paths and asset restamps can flag unchanged images.
// findStaleCaptures() also supplies scripts/update-local-updates.js.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");

export function loadCatalogue() {
  return JSON.parse(fs.readFileSync(path.join(websiteRoot, "capture-catalogue.json"), "utf8"));
}

// Returns { shared, images: [{ id, variants, files, live }], unmapped, commands } for changed
// repository-relative paths.
export function findStaleCaptures(changedFiles, catalogue = loadCatalogue()) {
  const changedSet = new Set(changedFiles);
  const modernViews = (variants) => variants.filter((v) => catalogue.variants[v]?.style === "modern");
  const stale = new Map();
  const mark = (id, variants, file) => {
    if (!variants.length) return;
    const hit = stale.get(id) || { variants: new Set(), files: new Set() };
    variants.forEach((v) => hit.variants.add(v));
    hit.files.add(file);
    stale.set(id, hit);
  };

  const sharedAll = (catalogue.commonSources.all || []).filter((f) => changedSet.has(f));
  const sharedModern = (catalogue.commonSources.modern || []).filter((f) => changedSet.has(f));
  const used = new Set([...(catalogue.commonSources.all || []), ...(catalogue.commonSources.modern || [])]);

  for (const [id, entry] of Object.entries(catalogue.images)) {
    for (const file of entry.sources || []) {
      used.add(file);
      if (changedSet.has(file)) mark(id, entry.variants, file);
    }
    for (const file of sharedAll) mark(id, entry.variants, file);
    for (const file of sharedModern) mark(id, modernViews(entry.variants), file);
  }

  const images = [...stale.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, hit]) => ({ id, variants: [...hit.variants], files: [...hit.files], live: catalogue.images[id].live || null }));

  // Group partial selections by their actual catalogue variant names.
  const whole = images.filter((i) => i.variants.length === catalogue.images[i.id].variants.length).map((i) => i.id);
  const partial = new Map();
  for (const image of images.filter((i) => !whole.includes(i.id))) {
    const variants = image.variants.join(",");
    const ids = partial.get(variants) || [];
    ids.push(image.id);
    partial.set(variants, ids);
  }
  const commands = [];
  if (whole.length) commands.push(`npm run captures:retake -- ${whole.join(" ")}`);
  for (const [variants, ids] of partial) {
    commands.push(`npm run captures:retake -- --variant=${variants} ${ids.join(" ")}`);
  }

  return {
    shared: [...sharedAll, ...sharedModern],
    images,
    unmapped: changedFiles.filter((f) => /^(public|server)\//.test(f) && !used.has(f)),
    commands,
  };
}

function main() {
  const args = process.argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith("--since="));
  const fileArgs = args.filter((a) => !a.startsWith("--"));

  const git = (...gitArgs) =>
    execFileSync("git", gitArgs, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => l.trim()).filter(Boolean);
  const normalize = (file) => path.relative(repositoryRoot, path.resolve(repositoryRoot, file)).split(path.sep).join("/");

  let changed;
  let label;
  if (fileArgs.length) {
    changed = fileArgs.map(normalize);
    label = "the given files";
  } else {
    const since = sinceArg ? sinceArg.slice("--since=".length) : "origin/main";
    try {
      const base = git("merge-base", since, "HEAD")[0];
      changed = [...new Set([...git("diff", "--name-only", base), ...git("ls-files", "--others", "--exclude-standard")])];
    } catch {
      console.error(`Cannot resolve ${since}. Pass --since=<ref> or a list of files.`);
      process.exit(2);
    }
    label = `files changed since ${since}`;
  }

  const result = findStaleCaptures(changed);
  console.log(`Checked ${label}: ${changed.length} file(s).`);
  if (result.shared.length) console.log(`Shared source paths changed (all images need review, not automatic retakes): ${result.shared.join(", ")}`);
  if (!result.images.length) {
    console.log("No website images to retake.");
  } else {
    const views = result.images.reduce((n, i) => n + i.variants.length, 0);
    console.log(`\n${result.images.length} image(s), ${views} view(s) to review against existing website images:`);
    for (const image of result.images) {
      const live = image.live ? `  [needs live state: ${image.live}]` : "";
      const shownFiles = image.files.filter((f) => !result.shared.includes(f));
      console.log(`  ${image.id} (${image.variants.join(", ")})${live}\n      ${shownFiles.length ? shownFiles.join(", ") : "shared files"}`);
    }
  }
  if (result.unmapped.length) {
    console.log(`\nChanged app files no image lists (review whether any image shows them):`);
    for (const file of result.unmapped) console.log(`  ${file}`);
  }
  if (result.commands.length) console.log("");
  for (const command of result.commands) console.log(`Candidate command (narrow to confirmed retakes before running): ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
