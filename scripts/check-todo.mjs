#!/usr/bin/env node
// Checks that the local todo.md matches the plan folder. Run as `npm run todo:check`, or as the
// Stop hook in .claude/settings.json with --stop-hook, which blocks ending a turn while the TODO
// is stale. Both files are git-ignored, so no git hook can see them.
// Exits 0 silently when todo.md or plan/ is absent (fresh clones, CI, Docker).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPlanLayouts } from "./plan-layout.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planDir = path.join(root, "plan");
const todoPath = path.join(root, "todo.md");
const SECTION_PATTERNS = [
  ["Post Release", /^Post Release \(v[^)]+\)$/],
  ["Release", /^Release: v[^)]+ \(Expected\)$/],
  ["Future Release", /^Future Release$/],
];
// Optional, and always first when present: a small bug-fix release, the next patch version.
const HOTFIX_PATTERN = /^Hotfix: v[^)]+ \(Expected\)$/;
const STATUS_SECTIONS = ["Work in Progress", "Requires Remote Testing", "Not Started"];
// A plan entry is two lines, the first ending in two spaces (a hard line break):
// `- [ ] [Title](plan/<name>.md) - <date>` (`- [-]` in progress, `Issue #54: ` before the link
// for an issue), then a very brief summary.
const ENTRY = /^- \[[ x-]\] (?:Issue #\d+: )?\[[^\]]+\]\(plan\//;
// The date on the entry line: `16 October 2026` or, when the time is known, `16 October 2026, 18:42`.
const DATE_LINE = /\]\(plan\/[^)\s]+\) - (\d{1,2} \w+ \d{4})(?:, (\d{1,2}:\d{2}))?/m;
const NOT_PLANS = new Set(["README.md", "updates.md"]);

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

// Every file under a folder, recursively.
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function check() {
  if (!fs.existsSync(todoPath) || !fs.existsSync(planDir)) return checkPlanLayouts(root);
  const errors = [];
  errors.push(...checkPlanLayouts(root));
  const todo = fs.readFileSync(todoPath, "utf8").replace(/\r\n/g, "\n");
  const todoMtime = fs.statSync(todoPath).mtimeMs;

  // Summaries are the top-level plan/*.md files; step files live under plan/active/.
  // Only markdown counts there: tools also write run output into active folders (check logs,
  // id chunks, run JSON, and the capture tool's captures/ folder with its own results.md),
  // and those writes are not plan changes, so they must not make todo.md stale mid-run.
  const bugsPlanPath = path.join(planDir, "bugs.md");
  const bugsPlan = fs.existsSync(bugsPlanPath) ? fs.readFileSync(bugsPlanPath, "utf8") : "";
  const bugSteps = bugsPlan.split(/^## Steps\s*$/m)[1]?.split(/^## /m)[0] || "";
  const emptyBugBacklog = /^\s*No open bugs\./m.test(bugSteps) && !/^\s*-\s*\[[ x]\]/m.test(bugSteps);
  const summaries = fs
    .readdirSync(planDir)
    .filter((f) => f.endsWith(".md") && !NOT_PLANS.has(f))
    .filter((f) => f !== "bugs.md" || !emptyBugBacklog)
    .map((f) => `plan/${f}`);
  const activeFiles = fs.existsSync(path.join(planDir, "active"))
    ? walk(path.join(planDir, "active"))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((f) => f.endsWith(".md") && !f.split("/").includes("captures"))
    : [];

  // 1. Release assignment and TODO freshness.
  const headings = [...todo.matchAll(/^## (.+)$/gm)].map((m) => ({ name: m[1], index: m.index }));
  const section = (pattern) => {
    const headingIndex = headings.findIndex(({ name }) => pattern.test(name));
    if (headingIndex < 0) return null;
    const start = headings[headingIndex].index;
    const end = headings[headingIndex + 1]?.index ?? todo.length;
    return todo.slice(start, end);
  };
  const newest = Math.max(0, ...[...summaries, ...activeFiles].map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  for (const [name, pattern] of SECTION_PATTERNS) {
    const matches = headings.filter(({ name: heading }) => pattern.test(heading));
    if (matches.length !== 1) errors.push(`todo.md needs exactly one "${name}" section`);
  }
  const postPattern = SECTION_PATTERNS[0][1];
  const releasePattern = SECTION_PATTERNS[1][1];
  const futurePattern = SECTION_PATTERNS[2][1];
  const releaseSection = section(releasePattern) || "";
  for (const name of STATUS_SECTIONS) {
    const count = (releaseSection.match(new RegExp(`^### ${name}$`, "gm")) || []).length;
    if (count !== 1) errors.push(`Release needs exactly one "${name}" subsection`);
  }

  const postIndex = headings.findIndex(({ name }) => postPattern.test(name));
  const releaseIndex = headings.findIndex(({ name }) => releasePattern.test(name));
  const postHasEntries = (section(postPattern) || "").split("\n").some((line) => ENTRY.test(line));
  const postVersion = headings.find(({ name }) => postPattern.test(name))?.name.match(/v([0-9]+(?:\.[0-9]+)*)/)?.[1];
  const releaseVersion = headings.find(({ name }) => releasePattern.test(name))?.name.match(/v([0-9]+(?:\.[0-9]+)*)/)?.[1];
  const compareVersions = (a, b) => {
    const left = a?.split(".").map(Number) || [];
    const right = b?.split(".").map(Number) || [];
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
    }
    return 0;
  };
  // Post-release tasks are active only after their version has been released,
  // so they rise above Release only when that version is older than the expected version.
  const postShouldBeFirst = postHasEntries && compareVersions(postVersion, releaseVersion) < 0;
  if (postIndex >= 0 && releaseIndex >= 0 && ((postIndex < releaseIndex) !== postShouldBeFirst)) {
    errors.push(postShouldBeFirst
      ? "Active Post Release must appear above Release"
      : "Release must appear above Post Release until its version has been released");
  }
  const hotfixCount = headings.filter(({ name }) => HOTFIX_PATTERN.test(name)).length;
  if (hotfixCount > 1) errors.push('todo.md needs at most one "Hotfix" section');
  const expectedOrder = [
    ...(hotfixCount ? [HOTFIX_PATTERN] : []),
    ...(postShouldBeFirst
      ? [postPattern, releasePattern, futurePattern]
      : [releasePattern, postPattern, futurePattern]),
  ];
  const orderedHeadings = headings
    .filter(({ name }) => [HOTFIX_PATTERN, ...SECTION_PATTERNS.map(([, pattern]) => pattern)].some((pattern) => pattern.test(name)))
    .map(({ name }) => name);
  const orderIsValid = expectedOrder.every((pattern, index) => pattern.test(orderedHeadings[index] || ""))
    && orderedHeadings.length === expectedOrder.length;
  if (!orderIsValid) errors.push("todo.md sections are not in the requested release order");
  // 2. A plan file changed after todo.md was last saved means the TODO was not updated with it.
  if (newest > todoMtime) {
    errors.push("a plan file was changed after todo.md was last saved");
  }

  // 3. Every link must point at an existing, non-archived summary.
  const links = [...todo.matchAll(/\]\((plan\/[^)\s]+)\)/g)].map((m) => m[1]);
  for (const link of new Set(links)) {
    if (link.startsWith("plan/archive/")) errors.push(`${link} is archived but still listed in todo.md`);
    else if (!fs.existsSync(path.join(root, link))) errors.push(`${link} is linked in todo.md but does not exist`);
  }

  // 4. Every open summary must be listed, and nothing else.
  for (const summary of summaries) {
    if (!links.includes(summary)) errors.push(`${summary} is not listed in todo.md`);
  }

  // 5. Each plan has exactly one entry: title, link and date, then a summary line.
  //    Within each section, entries are ordered by that date, newest first.
  const lines = todo.split("\n");
  const counts = new Map();
  let sectionName = "";
  let previous = Infinity;
  lines.forEach((line, i) => {
    const heading = line.match(/^(#{2,3}) (.+)/);
    if (heading) {
      sectionName = heading[2];
      previous = Infinity;
    }
    if (!ENTRY.test(line)) return;
    const link = line.match(/\]\((plan\/[^)\s]+)\)/);
    if (link) counts.set(link[1], (counts.get(link[1]) || 0) + 1);
    const summaryLine = (lines[i + 1] || "").trim();
    if (!summaryLine || ENTRY.test(summaryLine)) errors.push(`the entry on line ${i + 1} has no summary line under it`);
    const date = line.match(DATE_LINE);
    if (!date) {
      errors.push(`the entry on line ${i + 1} has no date after its plan link`);
      return;
    }
    const time = new Date(`${date[1]} ${date[2] || "00:00"}`).getTime();
    if (time > previous) errors.push(`"${sectionName}" is not ordered newest first at line ${i + 1}`);
    previous = time;
  });
  for (const [link, count] of counts) {
    if (count > 1) errors.push(`${link} has ${count} entries in todo.md; list it once`);
  }

  return errors;
}

const errors = check();
if (errors.length === 0) {
  if (!process.argv.includes("--stop-hook")) console.log("todo.md matches the plan folder.");
  process.exit(0);
}

const input = process.argv.includes("--stop-hook") ? readStdin() : {};
const message =
  "todo.md is stale, so this turn cannot end yet:\n" +
  errors.map((e) => `- ${e}`).join("\n") +
  "\nUpdate todo.md with current plan assignments and summaries, then finish the turn.";
console.error(message);
// The Stop hook is re-run after a block. If it is still stale on that retry, let the turn end
// so it cannot loop; the message above is the record of what is outstanding.
process.exit(input.stop_hook_active ? 0 : 2);
