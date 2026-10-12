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
const MAX_LAST_WORKED = 3;
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
  const todo = fs.readFileSync(todoPath, "utf8");
  const todoMtime = fs.statSync(todoPath).mtimeMs;

  // Summaries are the top-level plan/*.md files; step files live under plan/active/.
  const summaries = fs
    .readdirSync(planDir)
    .filter((f) => f.endsWith(".md") && !NOT_PLANS.has(f))
    .map((f) => `plan/${f}`);
  const activeFiles = fs.existsSync(path.join(planDir, "active"))
    ? walk(path.join(planDir, "active")).map((f) => path.relative(root, f).split(path.sep).join("/"))
    : [];

  // 1. Header date must not be older than the newest plan change.
  const newest = Math.max(0, ...[...summaries, ...activeFiles].map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  const updated = todo.match(/\*\*Updated:\*\*\s*(\d{1,2} \w+ \d{4})/);
  if (!updated) {
    errors.push("todo.md has no \"**Updated:**\" date in its header");
  } else if (new Date(updated[1]).getTime() && localDay(new Date(updated[1]).getTime()) < localDay(newest)) {
    errors.push(`the header says Updated ${updated[1]}, but a plan file changed on ${localDay(newest)}`);
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

  // 5. "Last worked on" holds at most the last three plans.
  const lastWorked = todo.match(/## Last worked on\n([\s\S]*?)(?=\n## )/);
  const lastWorkedItems = lastWorked ? lastWorked[1].split("\n").filter((l) => /^\d+\. /.test(l)) : [];
  if (!lastWorked) errors.push("todo.md has no \"## Last worked on\" section");
  else if (lastWorkedItems.length > MAX_LAST_WORKED) {
    errors.push(`"Last worked on" lists ${lastWorkedItems.length} plans; keep the newest ${MAX_LAST_WORKED}`);
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
  "\nUpdate todo.md (header date, Last worked on with the plan moved to the top, Open entries) and the owning plan summary, then finish the turn.";
console.error(message);
// The Stop hook is re-run after a block. If it is still stale on that retry, let the turn end
// so it cannot loop; the message above is the record of what is outstanding.
process.exit(input.stop_hook_active ? 0 : 2);
