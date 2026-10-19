#!/usr/bin/env node
// Phase B of Force to main in one command: take a release run's images and write the
// results table and contact sheet for phase C.
//
//   npm run captures:release -- --run=<run folder>
//
// <run>/capture-run.json (written by phase A):
//   { "baseUrl": "http://localhost:5056", "expectVersion": "2.1.0", "expectChannel": "release",
//     "ids": ["dashboard", ...], "live": [] }
// Writes <run>/captures/auto/*.png, <run>/captures/results.md, <run>/captures/contact-sheet.html.
// Exit codes follow recapture.mjs: 0 all ok, 1 some FAIL, 2 setup error, 3 build mismatch.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseToolOutput, resultsMarkdown, contactSheetHtml, summarize } from "./lib/capture-results.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const websiteRoot = path.join(scriptsDir, "..");

function fail(message) {
  console.error(message);
  process.exit(2);
}

const runArg = process.argv.slice(2).find((a) => a.startsWith("--run="));
if (!runArg) fail("Usage: npm run captures:release -- --run=<run folder>");
// npm runs scripts from website/, so a relative run folder is taken from where npm was started.
const runDir = path.resolve(process.env.INIT_CWD || process.cwd(), runArg.slice("--run=".length));

let config;
try {
  config = JSON.parse(await fs.readFile(path.join(runDir, "capture-run.json"), "utf8"));
} catch (error) {
  fail(`Cannot read ${path.join(runDir, "capture-run.json")}: ${error.message}`);
}
const { baseUrl, expectVersion, expectChannel, ids = [], live = [] } = config;
if (!Array.isArray(ids) || !ids.length) fail("capture-run.json has no `ids` to capture.");
if (!expectVersion || !expectChannel) fail("capture-run.json needs `expectVersion` and `expectChannel`; phase B always checks the served build.");

const capturesDir = path.join(runDir, "captures");
const autoDir = path.join(capturesDir, "auto");
await fs.mkdir(autoDir, { recursive: true });

// Phase A creates the live states and names them in `live`; the tool only takes the entries that
// need one when it is told the state exists, so the list is passed through. Without it those
// entries FAIL even though the state is in place.
const liveNote = live.length ? `Live states passed to the capture tool (created by phase A): ${live.join(", ")}` : "";

const toolArgs = [path.join(scriptsDir, "recapture.mjs"), ...ids, `--out=${autoDir}`, `--expect-version=${expectVersion}`, `--expect-channel=${expectChannel}`];
if (baseUrl) toolArgs.push(`--base-url=${baseUrl}`);
if (live.length) toolArgs.push(`--live=${live.join(",")}`);

let output = "";
const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, toolArgs, { cwd: websiteRoot, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  child.stderr.on("data", (chunk) => { output += chunk; process.stderr.write(chunk); });
  child.on("close", (code) => resolve(code ?? 2));
});

const catalogue = JSON.parse(await fs.readFile(path.join(websiteRoot, "capture-catalogue.json"), "utf8"));
const parsed = parseToolOutput(output);
const resultsFile = path.join(capturesDir, "results.md");
await fs.writeFile(resultsFile, resultsMarkdown({ ...parsed, expect: { version: expectVersion, channel: expectChannel }, exitCode, liveNote }));
await fs.writeFile(path.join(capturesDir, "contact-sheet.html"), contactSheetHtml({ rows: parsed.rows, variants: Object.keys(catalogue.variants), title: `Captures for v${expectVersion}` }));

const { captured, failed, warnings } = summarize(parsed.rows);
console.log(`\n${captured} captured, ${failed} failed, ${warnings} warnings. Results: ${resultsFile}`);
if (liveNote) console.log(liveNote);
// Setup errors and a wrong build captured nothing, so there is nothing for phase C yet.
if (exitCode === 0 || exitCode === 1) console.log(`Force to main v${expectVersion}, phase C: read the run summary.`);
else console.log(`Stopped before capturing (exit ${exitCode}). Report this to the user; no phase C handoff.`);
process.exit(exitCode);
