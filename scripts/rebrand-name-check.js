#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = "test/fixtures/plekt-name-allowlist.json";
const inventory = JSON.parse(fs.readFileSync(path.join(root, inventoryPath), "utf8"));
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).split("\0"))];
const violations = [];
let checked = 0;
for (const file of files) {
  if (!file || file === inventoryPath || /^(?:node_modules|dist|data|plan)\//.test(file)) continue;
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) continue;
  const approved = inventory.files[file];
  // Asset version stamps change on every develop build, so they are ignored when matching lines.
  const versionless = (text) => text.trim().replace(/\?v=[\d.]+/g, "?v=*");
  const remaining = new Map();
  for (const [line, count] of approved?.lines || []) remaining.set(versionless(line), (remaining.get(versionless(line)) || 0) + count);
  buffer.toString("utf8").split(/\r?\n/).forEach((line, index) => {
    if (!/plembfin/i.test(line)) return;
    checked++;
    const normalized = versionless(line);
    const count = remaining.get(normalized) || 0;
    if (!approved?.reason || !inventory.reasons[approved.reason] || count < 1) {
      violations.push(`${file}:${index + 1}: ${normalized.slice(0, 200)}`);
    } else remaining.set(normalized, count - 1);
  });
}
if (violations.length) {
  console.error(`Rebrand guard: ${violations.length} unapproved old-name reference(s):\n${violations.join("\n")}`);
  process.exitCode = 1;
} else console.log(`Rebrand guard passed: ${checked} approved compatibility, internal, migration or historical lines.`);
