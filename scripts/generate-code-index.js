#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CODE_INDEX_PATH = "docs/code-index.md";

// Source trees listed in the Modules section, relative to the repository root.
const MODULE_DIRS = ["server/src", "public/modules"];
const ROUTE_FILE = "server/src/index.js";
const ROUTE_DIR = path.posix.dirname(ROUTE_FILE);
// Keeps docs/code-index.md under the 60 KB whole-file Read limit. A file with
// more exports lists the first names alphabetically, then "and N more".
export const MAX_EXPORTS_PER_ROW = 8;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listSourceFiles(rootDir, relativeDir) {
  const start = path.join(rootDir, relativeDir);
  if (!fs.existsSync(start)) return [];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.m?js$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name)) {
        files.push(toPosix(path.relative(rootDir, full)));
      }
    }
  };
  walk(start);
  return files.sort(compare);
}

// Names bound by an `{ a, b as c }` clause: the name after `as` when present.
function clauseNames(clause) {
  return clause
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, alias] = part.split(/\s+as\s+/);
      return (alias || name).trim();
    });
}

function stripVersionQuery(specifier) {
  return specifier.replace(/\?.*$/, "");
}

export function extractExports(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^export\s+default\b/gm)) names.add("default");
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const name of clauseNames(match[1])) names.add(name);
  }
  for (const match of source.matchAll(/^export\s*\*\s*from\s*["']([^"']+)["']/gm)) {
    names.add(`* from ${stripVersionQuery(match[1])}`);
  }
  return [...names].sort(compare);
}

// Maps each imported binding in `source` to the repository path of its file.
export function extractImportMap(source, fromFile) {
  const map = new Map();
  const dir = path.posix.dirname(fromFile);
  for (const match of source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm)) {
    const specifier = stripVersionQuery(match[2]);
    if (!specifier.startsWith(".")) continue;
    const file = path.posix.normalize(path.posix.join(dir, specifier));
    for (const name of clauseNames(match[1])) map.set(name, file);
  }
  return map;
}

function dispatchBody(source) {
  const start = source.search(/^(?:async\s+)?function\s+dispatch\s*\(/m);
  if (start < 0) return "";
  const rest = source.slice(start);
  const end = rest.search(/^\}/m);
  return end < 0 ? rest : rest.slice(0, end);
}

// Path patterns in one `if (...)` condition, in the order written.
function conditionPatterns(condition) {
  const patterns = [];
  const shapes = /path\s*===\s*"([^"]*)"|(\/(?:\\\/|[^/\n])+\/[a-z]*)\.test\(path\)|path\.startsWith\("([^"]*)"\)|\[([^\]]*)\]\.includes\(path\)/g;
  for (const match of condition.matchAll(shapes)) {
    if (match[1] !== undefined) patterns.push(`\`${match[1]}\``);
    else if (match[2] !== undefined) patterns.push(`\`${match[2]}\``);
    else if (match[3] !== undefined) patterns.push(`\`startsWith("${match[3]}")\``);
    else for (const item of match[4].matchAll(/"([^"]*)"/g)) patterns.push(`\`${item[1]}\``);
  }
  return patterns;
}

export function extractRoutes(source, fromFile = ROUTE_FILE) {
  const imports = extractImportMap(source, fromFile);
  const routes = [];
  for (const match of dispatchBody(source).matchAll(/^\s*if \((.+)\) return ([A-Za-z_$][\w$]*)\(/gm)) {
    const patterns = conditionPatterns(match[1]);
    if (!patterns.length) continue;
    const handler = match[2];
    routes.push({ patterns, handler, file: imports.get(handler) || fromFile });
  }
  return routes.sort((a, b) => compare(a.patterns.join(","), b.patterns.join(",")) || compare(a.handler, b.handler));
}

function escapeCell(value) {
  return value.replace(/\|/g, "\\|");
}

function formatExports(names) {
  if (!names.length) return "(no exports)";
  if (names.length <= MAX_EXPORTS_PER_ROW) return names.join(", ");
  return `${names.slice(0, MAX_EXPORTS_PER_ROW).join(", ")} and ${names.length - MAX_EXPORTS_PER_ROW} more`;
}

export function generateCodeIndex({ rootDir = root } = {}) {
  const lines = [
    "# Code index",
    "",
    "Generated by `npm run code-index`. Do not edit by hand. To find a line, Grep the name inside the listed file.",
    "",
    "## Routes",
    "",
    `Each branch of \`dispatch()\` in \`${ROUTE_FILE}\`, sorted by path. Paths are relative to \`/api/\`; files are relative to \`${ROUTE_DIR}/\`. \`dispatch()\` matches the path only; each handler checks the HTTP method, and the first matching branch in \`dispatch()\` wins.`,
    "",
    "| Path or pattern | Handler | File |",
    "| --- | --- | --- |",
  ];
  const routeFile = path.join(rootDir, ROUTE_FILE);
  if (fs.existsSync(routeFile)) {
    for (const route of extractRoutes(fs.readFileSync(routeFile, "utf8"), ROUTE_FILE)) {
      const file = path.posix.relative(ROUTE_DIR, route.file);
      lines.push(`| ${escapeCell(route.patterns.join(", "))} | \`${route.handler}\` | \`${file}\` |`);
    }
  }
  lines.push("", "## Modules", "", `Exported names per source file, sorted. Rows with more than ${MAX_EXPORTS_PER_ROW} exports list the first ${MAX_EXPORTS_PER_ROW}.`);

  const byDir = new Map();
  for (const dir of MODULE_DIRS) {
    for (const file of listSourceFiles(rootDir, dir)) {
      const fileDir = path.posix.dirname(file);
      if (!byDir.has(fileDir)) byDir.set(fileDir, []);
      byDir.get(fileDir).push(file);
    }
  }
  for (const dir of [...byDir.keys()].sort(compare)) {
    lines.push("", `### ${dir}/`, "");
    for (const file of byDir.get(dir)) {
      const names = extractExports(fs.readFileSync(path.join(rootDir, file), "utf8"));
      lines.push(`- \`${path.posix.basename(file)}\`: ${formatExports(names)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = generateCodeIndex();
  fs.writeFileSync(path.join(root, CODE_INDEX_PATH), output);
  console.log(`Wrote ${CODE_INDEX_PATH} (${Buffer.byteLength(output)} bytes).`);
}
