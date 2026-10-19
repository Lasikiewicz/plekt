#!/usr/bin/env node
// Checks that the local todo.md matches the plan folder. Run as `npm run todo:check`, or as the
// Stop hook in .claude/settings.json with --stop-hook, which blocks ending a turn while the TODO
// is stale. Both files are git-ignored, so no git hook can see them.
// Exits 0 silently when todo.md or plan/ is absent (fresh clones, CI, Docker).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const planDir = path.join(root, "plan");
const todoPath = path.join(root, "todo.md");
const SECTIONS = ["Last edited", "Outstanding", "Future features", "Deferred"];
// An entry is two lines, the first ending in a `\` line break:
// `**Title** - [](plan/<name>.md) - <date>`, then a very brief summary. The link has no text;
// the desktop app shows it as the plan file's chip.
const ENTRY = /^\*\*[^*]+\*\* - \[[^\]]*\]\(plan\//;
// The date on the entry line: `16 October 2026` or, when the time is known, `16 October 2026, 18:42`.
const DATE_LINE = /^\*\*.*\) - (\d{1,2} \w+ \d{4})(?:, (\d{1,2}:\d{2}))?/m;
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

// Local calendar date as YYYY-MM-DD, so the comparison ignores time zones.
function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function check() {
  if (!fs.existsSync(todoPath) || !fs.existsSync(planDir)) return [];
  const errors = [];
  const todo = fs.readFileSync(todoPath, "utf8").replace(/\r\n/g, "\n");
  const todoMtime = fs.statSync(todoPath).mtimeMs;

  // Summaries are the top-level plan/*.md files; step files live under plan/active/.
  // Only markdown counts there: tools also write run output into active folders (check logs,
  // id chunks, run JSON, and the capture tool's captures/ folder with its own results.md),
  // and those writes are not plan changes, so they must not make todo.md stale mid-run.
  const summaries = fs
    .readdirSync(planDir)
    .filter((f) => f.endsWith(".md") && !NOT_PLANS.has(f))
    .map((f) => `plan/${f}`);
  const activeFiles = fs.existsSync(path.join(planDir, "active"))
    ? walk(path.join(planDir, "active"))
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((f) => f.endsWith(".md") && !f.split("/").includes("captures"))
    : [];

  // 1. The "Last edited" entry's date must not be older than the newest plan change.
  const section = (name) => {
    const m = todo.match(new RegExp(String.raw`## ${name}\n([\s\S]*?)(?=\n## |$)`));
    return m ? m[1] : null;
  };
  const newest = Math.max(0, ...[...summaries, ...activeFiles].map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  for (const name of SECTIONS) {
    if (section(name) === null) errors.push(`todo.md has no "## ${name}" section`);
  }
  const lastEdited = section("Last edited") || "";
  const lastEntries = lastEdited.split("\n").filter((l) => ENTRY.test(l));
  if (lastEntries.length !== 1) errors.push(`"Last edited" lists ${lastEntries.length} plans; list exactly one`);
  const latest = lastEdited.match(DATE_LINE);
  if (!latest) {
    errors.push('the "Last edited" entry has no date');
  } else if (new Date(latest[1]).getTime() && localDay(new Date(latest[1]).getTime()) < localDay(newest)) {
    errors.push(`the "Last edited" date is ${latest[1]}, but a plan file changed on ${localDay(newest)}`);
  }

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
    const heading = line.match(/^## (.+)/);
    if (heading) {
      sectionName = heading[1];
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
  "\nUpdate todo.md (the plan's entry and date, the plan under Last edited, each plan listed once) and the owning plan summary, then finish the turn.";
console.error(message);
// The Stop hook is re-run after a block. If it is still stale on that retry, let the turn end
// so it cannot loop; the message above is the record of what is outstanding.
process.exit(input.stop_hook_active ? 0 : 2);
