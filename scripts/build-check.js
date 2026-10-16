#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["public", "server", "scripts"];

function javascriptFiles(directory) {
  const absolute = path.join(root, directory);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(relative);
    return entry.isFile() && entry.name.endsWith(".js") ? [relative] : [];
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function extractFunctionBodies(source) {
  const bodies = new Map();
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(handle[A-Z]\w*)\s*\([^)]*\)\s*\{/g;
  const constPattern = /(?:export\s+)?const\s+(handle[A-Z]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const pattern of [functionPattern, constPattern]) {
    let match;
    while ((match = pattern.exec(source))) {
      const openIndex = source.indexOf("{", pattern.lastIndex - 1);
      const closeIndex = findMatchingBrace(source, openIndex);
      if (closeIndex === -1) continue;
      bodies.set(match[1], source.slice(openIndex + 1, closeIndex));
    }
  }
  return bodies;
}

function checkRoutedHandlersAuthenticate() {
  const indexSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
  const routedHandlers = new Set();
  for (const match of indexSource.matchAll(/return\s+(handle[A-Z]\w*)\s*\(\s*req\s*,\s*res/g)) {
    routedHandlers.add(match[1]);
  }

  const handlerFiles = new Set([
    "server/src/index.js",
    "server/src/utils/auth.js",
    ...javascriptFiles("server").filter((file) => file.replace(/\\/g, "/").startsWith("server/src/routes/")),
  ]);
  const handlerBodies = new Map();
  for (const file of handlerFiles) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const bodies = extractFunctionBodies(fs.readFileSync(path.join(root, file), "utf8"));
    for (const [name, body] of bodies) handlerBodies.set(name, { file, body });
  }

  const publicHandlers = new Set([
    "handlePing",
    "handleChangelog",
    "handleLogin",
    "handleLogout",
    "handleAuthStatus",
    "handleAuthClaim",
  ]);
  const allowedChecks = ["requireAdmin(", "resolveAdminPrincipal(", "verifyWebhookToken("];
  const offenders = [];
  const missing = [];
  for (const handler of routedHandlers) {
    const definition = handlerBodies.get(handler);
    if (!definition) {
      missing.push(handler);
      continue;
    }
    if (publicHandlers.has(handler)) continue;
    if (!allowedChecks.some((check) => definition.body.includes(check))) {
      offenders.push(`${definition.file}: ${handler}`);
    }
  }
  if (missing.length || offenders.length) {
    if (missing.length) {
      console.error("Routed handlers without definitions found by build check:");
      for (const handler of missing) console.error(`  ${handler}`);
    }
    if (offenders.length) {
      console.error("Routed handlers without an auth guard found:");
      for (const offender of offenders) console.error(`  ${offender}`);
      console.error("Add requireAdmin(), resolveAdminPrincipal(), verifyWebhookToken(), or document the handler in the public whitelist.");
    }
    process.exit(1);
  }
}

for (const file of sourceRoots.flatMap(javascriptFiles)) {
  run(process.execPath, ["--check", file]);
}

run(process.execPath, ["scripts/docs-check.js"]);
run(process.execPath, ["scripts/asset-versions.js"]);
run(process.execPath, ["scripts/rebrand-name-check.js"]);

run(process.execPath, ["scripts/run-tests.js"]);

for (const file of ["package.json", "package-lock.json", "changelog.json"]) {
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

checkRoutedHandlersAuthenticate();

// Guard: every outbound call in server code must use the shared request boundary.
// Besides enforcing a timeout, fetchWithTimeout validates initial and redirected
// URLs and prevents credentials from crossing origins.
{
  const barePattern = /(?:await|return)\s+fetch\(/;
  const offenders = [];
  for (const file of javascriptFiles("server")) {
    if (file.replace(/\\/g, "/").endsWith("utils/outbound.js")) continue;
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!barePattern.test(line)) return;
      offenders.push(`${file}:${index + 1}`);
    });
  }
  if (offenders.length) {
    console.error("Bare fetch() bypasses outbound security checks - use fetchWithTimeout (server/src/utils/outbound.js):");
    for (const offender of offenders) console.error(`  ${offender}`);
    process.exit(1);
  }
}

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-build-check-"));
try {
  run(process.execPath, ["server/server.js"], {
    env: {
      ...process.env,
      DATA_DIR: temporaryData,
      PORT: "0",
      PLEKT_BUILD_CHECK: "1",
    },
  });
} finally {
  fs.rmSync(temporaryData, { recursive: true, force: true });
}

console.log("Plekt build check passed.");
