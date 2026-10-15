#!/usr/bin/env node

// Rebuilds plan/updates.md from the committed local history since the current
// stable main ref. The file is deliberately a local planning artifact: plan/
// is gitignored, so it can be refreshed after every commit without creating a
// second bookkeeping commit or changing the product commit's contents.
//
// This is a projection, not a second changelog. It is regenerated rather than
// appended, which means amended, squashed, and superseded commits cannot leave
// duplicate entries behind. Website targets are grouped from the existing
// app-surface map so Force to main can review the smallest relevant guides and
// captures first.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  bulletPointsFrom,
  dedupeChangelogDetails,
  filterChangelogDetails,
  formatChangelogMessage,
  isChangelogProcessMessage,
  isNoiseCommitMessage,
  isReleaseTypeCommitMessage,
} from "./changelog-message.js";
import { changeAreaDetails } from "./changelog-git-helpers.js";
import { findStaleCaptures, loadCatalogue } from "../website/scripts/stale-captures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const updatesPath = path.join(root, "plan", "updates.md");
const surfacePath = path.join(root, "website", "src", "data", "app-surface.json");
const updatesRelativePath = "plan/updates.md";
const recordSeparator = "\x1e";
const unitSeparator = "\x1f";

function normalisePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function normaliseText(value) {
  return String(value || "")
    .replace(/^[a-zA-Z]+(?:\([^)]*\))?:\s*/, "")
    .replace(/^[a-zA-Z]+\s+-\s+/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueByText(values) {
  return dedupeChangelogDetails(values);
}

function firstLine(message) {
  return String(message || "").split(/\r?\n/, 1)[0].trim();
}

function commitDetails(commit) {
  const bullets = filterChangelogDetails(bulletPointsFrom(commit.message));
  if (bullets.length) return uniqueByText(bullets);

  const generated = filterChangelogDetails(changeAreaDetails(commit.files));
  if (generated.length) return uniqueByText(generated);

  const subject = firstLine(commit.message);
  return subject ? [formatChangelogMessage(subject)] : [];
}

function commitIsReleaseVisible(commit) {
  return isReleaseTypeCommitMessage(commit.message)
    && !isNoiseCommitMessage(commit.message)
    && !isChangelogProcessMessage(commit.message);
}

function pathMatches(sourcePath, changedPath) {
  const source = normalisePath(sourcePath);
  const changed = normalisePath(changedPath);
  return Boolean(source && changed && (source === changed || changed.startsWith(`${source}/`)));
}

export function loadSurfaces(surfaces = null) {
  if (Array.isArray(surfaces)) return surfaces;
  try {
    return JSON.parse(fs.readFileSync(surfacePath, "utf8"));
  } catch {
    return [];
  }
}

function websiteDocPath(surface) {
  const slug = normalisePath(surface?.docSlug);
  return slug ? `website/src/content/docs/${slug}.mdx` : "";
}

function targetKey(surface) {
  return normalisePath(surface?.docSlug) || normalisePath(surface?.id) || "unknown";
}

// Returns one target per website guide, even when app-surface.json intentionally
// contains several named surfaces for the same guide. This is the key that
// prevents a later commit touching the same app area from duplicating a guide
// in the Force to main checklist.
export function mapWebsiteTargets(changedFiles, surfaces = null) {
  const available = loadSurfaces(surfaces);
  const targets = new Map();

  for (const surface of available) {
    const sourcePaths = Array.isArray(surface?.sourcePaths) ? surface.sourcePaths.map(normalisePath).filter(Boolean) : [];
    const docPath = websiteDocPath(surface);
    const matchingFiles = unique(changedFiles.map(normalisePath).filter((file) =>
      sourcePaths.some((sourcePath) => pathMatches(sourcePath, file))
      || (docPath && pathMatches(docPath, file))));
    if (!matchingFiles.length) continue;

    const key = targetKey(surface);
    const current = targets.get(key) || {
      key,
      labels: [],
      docSlug: normalisePath(surface?.docSlug),
      files: [],
    };
    if (surface?.label) current.labels.push(String(surface.label).trim());
    current.files.push(...matchingFiles);
    targets.set(key, current);
  }

  const websiteFiles = changedFiles.map(normalisePath).filter((file) => file.startsWith("website/"));
  const mappedWebsiteFiles = new Set([...targets.values()].flatMap((target) => target.files));
  const unmappedWebsiteFiles = websiteFiles.filter((file) => !mappedWebsiteFiles.has(file));
  if (unmappedWebsiteFiles.length) {
    targets.set("website-infrastructure", {
      key: "website-infrastructure",
      labels: ["Website infrastructure and shared layout"],
      docSlug: "",
      files: unmappedWebsiteFiles,
    });
  }

  const globalFiles = changedFiles.map(normalisePath).filter((file) =>
    file === "README.md"
    || file === "package.json"
    || file === "package-lock.json"
    || file === "CHANGELOG.md"
    || /^changelog(?:\.|$)/.test(file)
    || file === "public/styles.css");
  if (globalFiles.length) {
    targets.set("release-and-site-surface", {
      key: "release-and-site-surface",
      labels: ["Release metadata and shared visual surface"],
      docSlug: "",
      files: globalFiles,
    });
  }

  return [...targets.values()]
    .map((target) => ({
      ...target,
      labels: unique(target.labels),
      files: unique(target.files).sort(),
    }))
    .sort((left, right) => (left.labels[0] || left.key).localeCompare(right.labels[0] || right.key));
}

function normaliseCommit(commit) {
  const files = unique((commit.files || []).map(normalisePath).filter((file) => file && file !== updatesRelativePath)).sort();
  if (!files.length) return null;
  const subject = firstLine(commit.message);
  return {
    id: String(commit.id || "").trim(),
    shortId: String(commit.id || "").trim().slice(0, 7),
    date: String(commit.date || "").trim().slice(0, 10),
    message: String(commit.message || "").trim(),
    subject,
    files,
    details: commitDetails({ ...commit, files }),
    releaseVisible: commitIsReleaseVisible(commit),
  };
}

function addUniqueChange(map, text, shortId) {
  const value = String(text || "").trim();
  const key = normaliseText(value);
  if (!key) return;
  const current = map.get(key) || { text: value, commits: [] };
  if (shortId && !current.commits.includes(shortId)) current.commits.push(shortId);
  map.set(key, current);
}

function targetData(target, commits) {
  const targetFiles = new Set(target.files);
  const matchingCommits = commits.filter((commit) => commit.files.some((file) => targetFiles.has(file)));
  const changes = new Map();
  for (const commit of matchingCommits) {
    for (const detail of commit.details) addUniqueChange(changes, detail, commit.shortId);
  }
  return {
    ...target,
    commits: matchingCommits.map((commit) => commit.shortId).filter(Boolean),
    changes: [...changes.values()],
  };
}

// Website images whose catalogued source files changed, with the commits that touched them.
// A missing or unreadable catalogue leaves the section out rather than failing the commit hook.
function captureData(changedFiles, commits, catalogue) {
  let result;
  try {
    result = findStaleCaptures(changedFiles, catalogue || loadCatalogue());
  } catch {
    return null;
  }
  const images = result.images.map((image) => ({
    ...image,
    commits: commits.filter((commit) => commit.files.some((file) => image.files.includes(file))).map((commit) => commit.shortId).filter(Boolean),
  }));
  return { ...result, images };
}

export function buildUpdatesModel({ baseline, head, commits = [], surfaces = null, catalogue = null, generatedAt = new Date().toISOString() } = {}) {
  const normalisedCommits = commits.map(normaliseCommit).filter(Boolean);
  const changedFiles = unique(normalisedCommits.flatMap((commit) => commit.files));
  const targets = mapWebsiteTargets(changedFiles, surfaces).map((target) => targetData(target, normalisedCommits));
  const changelogChanges = new Map();
  for (const commit of normalisedCommits.filter((item) => item.releaseVisible)) {
    for (const detail of filterChangelogDetails(commit.details)) addUniqueChange(changelogChanges, detail, commit.shortId);
  }

  const targetFiles = new Set(targets.flatMap((target) => target.files));
  const websiteRelevantFiles = new Set([
    ...changedFiles.filter((file) => /^(?:public|server|docs)\//.test(file) || /^(?:README|CHANGELOG|changelog|package)/.test(file)),
    ...changedFiles.filter((file) => file.startsWith("website/")),
  ]);
  const unmappedFiles = [...websiteRelevantFiles].filter((file) => !targetFiles.has(file)).sort();

  return {
    baseline: baseline || { ref: "unknown", sha: "" },
    head: String(head || "").trim(),
    generatedAt,
    commits: normalisedCommits,
    changedFiles,
    changelogChanges: [...changelogChanges.values()],
    targets,
    unmappedFiles,
    captures: captureData(changedFiles, normalisedCommits, catalogue),
  };
}

function inline(value) {
  return String(value || "").replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function markdownList(values, prefix = "- ") {
  return values.length ? values.map((value) => `${prefix}${value}`).join("\n") : "- None";
}

export function buildUpdatesMarkdown(model) {
  const baseline = model.baseline || {};
  const baselineLabel = baseline.ref || "unknown baseline";
  const baselineSha = baseline.sha ? `\`${baseline.sha.slice(0, 12)}\`` : "unresolved";
  const head = model.head ? `\`${model.head.slice(0, 12)}\`` : "unresolved";
  const lines = [
    "# Local updates",
    "",
    "> Generated from committed local history. Refresh with `npm run updates:refresh`; do not edit this file by hand.",
    "> The document is rebuilt, not appended: amended, squashed, and superseded commits replace the previous projection.",
    "",
    `- Baseline: **${baselineLabel}** (${baselineSha})`,
    `- Head: ${head}`,
    `- Refreshed: ${model.generatedAt}`,
    `- Local commits covered: **${model.commits.length}**`,
    "",
    "## Changelog-ready changes",
    "",
  ];

  if (model.changelogChanges.length) {
    for (const change of model.changelogChanges) {
      const commits = change.commits.length ? ` [${change.commits.join(", ")}]` : "";
      lines.push(`- ${inline(change.text)}${commits}`);
    }
  } else {
    lines.push("- No release-visible local changes are ahead of the baseline.");
  }

  lines.push("", "## Website check targets", "", "Review these targets first during **Force to main**. A target appears once even when several commits touch the same guide.", "");
  if (model.targets.length) {
    for (const target of model.targets) {
      const label = target.labels.join(" / ") || target.key;
      const guide = target.docSlug ? ` [website guide](../website/src/content/docs/${target.docSlug}.mdx)` : "";
      lines.push(`### ${label}${guide}`);
      if (target.commits.length) lines.push(`- Commits: ${target.commits.join(", ")}`);
      lines.push(`- Changed app/site paths: ${target.files.map((file) => `\`${file}\``).join(", ") || "none"}`);
      if (target.changes.length) {
        lines.push("- Related changes:");
        for (const change of target.changes) lines.push(`  - ${inline(change.text)}`);
      }
      lines.push("");
    }
  } else {
    lines.push("- No mapped website targets.", "");
  }

  if (model.unmappedFiles.length) {
    lines.push("### Unmapped application/site paths", "", "No website guide covers these paths; check them during the Force to main review:", "");
    lines.push(...model.unmappedFiles.map((file) => `- \`${file}\``));
    lines.push("");
  }

  const captures = model.captures;
  if (captures) {
    lines.push("## Website images to retake", "", "Review candidates whose catalogued source paths changed (`website/capture-catalogue.json`). Compare existing images with the approved candidate; retake only visibly changed variants. Source changes and asset stamps alone do not require a retake.", "");
    if (captures.shared.length) lines.push(`- Shared source paths changed, so every image is a review candidate (not a required retake): ${captures.shared.map((file) => `\`${file}\``).join(", ")}`, "");
    if (captures.images.length) {
      for (const image of captures.images) {
        const commits = image.commits.length ? ` [${image.commits.join(", ")}]` : "";
        const live = image.live ? ` (needs live state: ${image.live})` : "";
        const files = image.files.filter((file) => !captures.shared.includes(file));
        lines.push(`- \`${image.id}\` (${image.variants.join(", ")})${live}${commits}${files.length ? `: ${files.map((file) => `\`${file}\``).join(", ")}` : ""}`);
      }
      lines.push("", ...captures.commands.map((command) => `Candidate command from \`website/\` (narrow to confirmed retakes first): \`${command}\``), "");
    } else {
      lines.push("- No website images to retake.", "");
    }
  }

  lines.push("## Commit inventory", "");
  if (model.commits.length) {
    for (const commit of model.commits) {
      const date = commit.date ? `${commit.date} — ` : "";
      lines.push(`### ${date}\`${commit.shortId || commit.id || "unknown"}\` — ${inline(commit.subject)}`);
      if (commit.details.length) lines.push(...commit.details.map((detail) => `- ${inline(detail)}`));
      lines.push(`- Files: ${commit.files.map((file) => `\`${file}\``).join(", ")}`, "");
    }
  } else {
    lines.push("No committed local changes are ahead of the selected baseline.", "");
  }

  lines.push("## Changed paths", "");
  lines.push(markdownList(model.changedFiles.map((file) => `\`${file}\``).sort()));
  lines.push("");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", allowFailure ? "ignore" : "pipe"] }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function refExists(ref) {
  return Boolean(git(["rev-parse", "--verify", "--quiet", ref], { allowFailure: true }));
}

function selectBaseline(requestedRef) {
  const candidates = requestedRef ? [requestedRef] : ["origin/main", "main", "origin/develop", "develop"];
  for (const ref of candidates) {
    if (!ref || !refExists(ref)) continue;
    return { ref, sha: git(["rev-parse", ref]) };
  }
  return { ref: "no stable ref found", sha: "" };
}

function readCommits(baseline, head) {
  if (!baseline?.sha || !head || baseline.sha === head) return [];
  const raw = git(["log", "--reverse", `--pretty=format:%H${unitSeparator}%aI${unitSeparator}%B${recordSeparator}`, `${baseline.sha}..${head}`], { allowFailure: true });
  return raw
    .split(recordSeparator)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [id, date, ...messageParts] = record.split(unitSeparator);
      const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", id], { allowFailure: true })
        .split(/\r?\n/)
        .map(normalisePath)
        .filter(Boolean);
      return { id, date, message: messageParts.join(unitSeparator).trim(), files };
    });
}

function parseArgs(argv) {
  const args = { quiet: false, from: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--quiet") args.quiet = true;
    if (argv[index] === "--from") args.from = argv[index + 1] || "";
  }
  return args;
}

export function refreshLocalUpdates({ baselineRef = "", generatedAt = new Date().toISOString() } = {}) {
  if (!fs.existsSync(path.join(root, ".git"))) return { skipped: true, path: updatesPath };
  fs.mkdirSync(path.dirname(updatesPath), { recursive: true });
  const head = git(["rev-parse", "HEAD"]);
  const baseline = selectBaseline(baselineRef);
  const model = buildUpdatesModel({
    baseline,
    head,
    commits: readCommits(baseline, head),
    generatedAt,
  });
  fs.writeFileSync(updatesPath, buildUpdatesMarkdown(model), "utf8");
  return { ...model, path: updatesPath };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const model = refreshLocalUpdates({ baselineRef: args.from });
    if (!args.quiet && !model.skipped) {
      console.log(`Refreshed plan/updates.md: ${model.commits.length} local commit(s), ${model.changelogChanges.length} unique changelog change(s), ${model.targets.length} website target(s).`);
    }
  } catch (error) {
    // A post-commit hook must not turn a completed commit into a misleading
    // failure when a remote-tracking ref is temporarily unavailable. Leave a
    // useful diagnostic; the push/release workflows refresh explicitly later.
    console.error(`Could not refresh plan/updates.md: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
