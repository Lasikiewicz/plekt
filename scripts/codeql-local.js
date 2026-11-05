#!/usr/bin/env node
// Runs the same CodeQL scan and High/Critical gate as .github/workflows/security.yml, locally,
// so a finding is caught before alpha or main is pushed. Exit 1 on a blocking finding or when
// the scan cannot run. Install the CodeQL bundle once; see docs/development.md.
// Like CI it scans only the repository files (a clean copy of the tracked and not-ignored files,
// so local dist/, plan/ scratch and node_modules never count) and applies the config's
// query-filters.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = path.join(os.tmpdir(), "plekt-codeql-local");
const source = path.join(work, "src");
const configPath = path.join(root, ".github", "codeql", "codeql-config.yml");
const NUL = String.fromCharCode(0);
const { findBlockingFindings } = await import(pathToFileURL(path.join(root, ".github", "scripts", "check-codeql-severity.mjs")).href);

function findCodeql() {
  const candidates = [
    process.env.CODEQL_PATH,
    path.join(os.homedir(), "tools", "codeql", process.platform === "win32" ? "codeql.exe" : "codeql"),
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["codeql"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean) || null : null;
}

function run(codeql, args) {
  const result = spawnSync(codeql, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`CodeQL local scan failed: codeql ${args.slice(0, 2).join(" ")} exited ${result.status ?? result.signal}.`);
    process.exit(1);
  }
}

const codeql = findCodeql();
if (!codeql) {
  console.error("CodeQL local scan cannot run: the CodeQL CLI was not found. Install the bundle (docs/development.md, CodeQL local scan) or set CODEQL_PATH.");
  process.exit(1);
}

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(source, { recursive: true });
const database = path.join(work, "db");
const sarifDir = path.join(work, "sarif");
fs.mkdirSync(sarifDir, { recursive: true });

const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split(NUL))].filter(Boolean);
for (const file of files) {
  const from = path.join(root, file);
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
  fs.copyFileSync(from, path.join(source, file));
}

console.log(`CodeQL local scan: ${execFileSync(codeql, ["version", "--format=terse"], { encoding: "utf8" }).trim()}, ${files.length} files`);
run(codeql, ["database", "create", database, "--language=javascript", `--source-root=${source}`,
  `--codescanning-config=${configPath}`, "--overwrite", "--threads=0"]);
run(codeql, ["database", "analyze", database, "codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls",
  "--format=sarif-latest", `--output=${path.join(sarifDir, "javascript.sarif")}`, "--sarif-category=/language:javascript", "--threads=0"]);

// The analyze step does not apply the config's query-filters (CI's init action does), so drop the
// excluded rules from the SARIF before the gate reads it.
const excluded = new Set([...fs.readFileSync(configPath, "utf8").matchAll(/^\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1]));
const sarifPath = path.join(sarifDir, "javascript.sarif");
const sarif = JSON.parse(fs.readFileSync(sarifPath, "utf8"));
for (const sarifRun of sarif.runs || []) sarifRun.results = (sarifRun.results || []).filter((result) => !excluded.has(result.ruleId));

// The same severity logic as CI's gate. CI's extra step that asks GitHub for its open alerts needs
// a token and a pushed ref, so it cannot run before the push.
const findings = findBlockingFindings(sarif, "javascript.sarif");
if (findings.length) {
  console.error(`CodeQL local gate failed: ${findings.length} High/Critical finding(s) remain.`);
  for (const finding of findings) console.error(`- [${finding.ruleId}] security-severity=${finding.severity} at ${finding.location}: ${finding.message}`);
  process.exit(1);
}
console.log("CodeQL local gate passed: no unsuppressed High or Critical findings.");
