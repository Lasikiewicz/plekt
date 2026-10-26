import fs from "node:fs";
import path from "node:path";

// Keep current status brief and historical detail in the associated history file.
export function validatePlanLayout(markdown, { file = "plan.md", exists = fs.existsSync } = {}) {
  const errors = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const visible = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const marker = lines[i].match(/^\s*(```+|~~~+)/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      visible.push("");
      continue;
    }
    visible.push(fence ? "" : lines[i]);
  }
  const headings = new Map();
  visible.forEach((line, i) => {
    const match = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (match) {
      if (headings.has(match[1])) errors.push(`duplicate summary section: "${match[1]}"`);
      else headings.set(match[1], i);
    }
  });
  const where = headings.get("Where we are");
  const background = headings.get("Background and history");
  const steps = headings.get("Steps");
  if (where === undefined) errors.push('summary must include "Where we are"');
  if (background === undefined) errors.push('summary must include "Background and history" with a history.md link');
  if (steps !== undefined && where !== undefined && steps > where) {
    errors.push('"Steps" must come before "Where we are"');
  }
  if (where !== undefined && background !== undefined && where > background) {
    errors.push('"Where we are" must come before "Background and history"');
  }

  if (where !== undefined) {
    const end = [...headings.values()].filter((i) => i > where).sort((a, b) => a - b)[0] ?? visible.length;
    const body = visible.slice(where + 1, end).filter((line) => line.trim() !== "---").join("\n").trim();
    const charCount = body.length;
    const wordCount = body ? body.split(/\s+/).length : 0;
    if (!body) errors.push('"Where we are" must contain current status');
    if (/(?:…|\.{3})$/.test(body)) errors.push('"Where we are" must use complete sentences, not clipped source text');
    if (charCount > 900) errors.push(`"Where we are" is ${charCount} characters; maximum is 900`);
    if (wordCount > 120) errors.push(`"Where we are" is ${wordCount} words; maximum is 120`);
    const paragraphs = body.split(/\n\s*\n/).filter(Boolean);
    if (paragraphs.length > 1 || /^\s*(?:[-*+]\s|\d+[.)]\s)/m.test(body)) {
      errors.push('"Where we are" must be one concise paragraph, not a list or journal');
    }
  }

  if (background !== undefined) {
    const end = [...headings.values()].filter((i) => i > background).sort((a, b) => a - b)[0] ?? visible.length;
    const bodyLines = visible.slice(background + 1, end).map((line) => line.trim()).filter((line) => line && !/^Last updated:\s*/i.test(line));
    if (bodyLines.length !== 1 || !/^\[[^\]]*\]\(([^)]+)\)$/.test(bodyLines[0] || "")) {
      errors.push('"Background and history" must contain only one Markdown link line to history.md');
    } else {
      const target = bodyLines[0].match(/^\[[^\]]*\]\(([^)]+)\)$/)[1];
      if (path.basename(target).toLowerCase() !== "history.md") {
        errors.push('"Background and history" link must target history.md');
      } else {
        const resolved = path.resolve(path.dirname(file), target.split("#")[0]);
        if (!exists(resolved)) errors.push(`history.md link target does not exist: ${target}`);
      }
    }
  }
  return errors;
}

export function checkPlanLayouts(root) {
  const planDir = path.join(root, "plan");
  if (!fs.existsSync(planDir)) return [];
  const files = fs.readdirSync(planDir).filter((name) => name.endsWith(".md") && !["README.md", "updates.md"].includes(name)).map((name) => path.join(planDir, name));
  const archiveDir = path.join(planDir, "archive");
  if (fs.existsSync(archiveDir)) {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : entry.name === "summary.md" ? [full] : [];
    });
    files.push(...walk(archiveDir));
  }
  return files.flatMap((file) => validatePlanLayout(fs.readFileSync(file, "utf8"), { file }).map((error) => `${path.relative(root, file).split(path.sep).join("/")}: ${error}`));
}
