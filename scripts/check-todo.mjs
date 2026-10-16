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
const MAX_NOW = 3;
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

  // 1. The newest Change log line must not be older than the newest plan change.
  const newest = Math.max(0, ...[...summaries, ...activeFiles].map((f) => fs.statSync(path.join(root, f)).mtimeMs));
  const changeLog = todo.match(/## Change log\n([\s\S]*?)(?=\n## |$)/);
  const latest = changeLog && changeLog[1].match(/^- (\d{1,2} \w+ \d{4})/m);
  if (!latest) {
    errors.push("todo.md has no dated \"## Change log\" entry");
  } else if (new Date(latest[1]).getTime() && localDay(new Date(latest[1]).getTime()) < localDay(newest)) {
    errors.push(`the newest Change log line is dated ${latest[1]}, but a plan file changed on ${localDay(newest)}`);
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

  // 5. Each plan has exactly one numbered entry (Waiting on Jason may link a plan again).
  const entries = todo.split("\n").filter((l) => /^\d+\. /.test(l));
  const counts = new Map();
  for (const line of entries) {
    const link = [...line.matchAll(/\]\((plan\/[^)\s]+)\)/g)].pop();
    if (link) counts.set(link[1], (counts.get(link[1]) || 0) + 1);
  }
  for (const [link, count] of counts) {
    if (count > 1) errors.push(`${link} has ${count} numbered entries in todo.md; list it once`);
  }

  // 6. "Now" holds at most three plans.
  const now = todo.match(/## Now\n([\s\S]*?)(?=\n## )/);
  const nowItems = now ? now[1].split("\n").filter((l) => /^\d+\. /.test(l)) : [];
  if (!now) errors.push("todo.md has no \"## Now\" section");
  else if (nowItems.length > MAX_NOW) {
    errors.push(`"Now" lists ${nowItems.length} plans; keep at most ${MAX_NOW}`);
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
  "\nUpdate todo.md (the plan's Now line, a dated Change log line, its entry listed once) and the owning plan summary, then finish the turn.";
console.error(message);
// The Stop hook is re-run after a block. If it is still stale on that retry, let the turn end
// so it cannot loop; the message above is the record of what is outstanding.
process.exit(input.stop_hook_active ? 0 : 2);
