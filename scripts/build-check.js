#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const REGEX_PREV_KEYWORDS = new Set([
  "return", "throw", "case", "in", "of", "instanceof", "typeof", "void",
  "delete", "new", "await", "yield", "else", "do",
]);

function canStartRegex(prevToken) {
  if (!prevToken) return true;
  if (prevToken.type === "word") return REGEX_PREV_KEYWORDS.has(prevToken.value);
  if (prevToken.type === "punct") return !" )]}++--".includes(prevToken.value) && prevToken.value !== ")" && prevToken.value !== "]" && prevToken.value !== "}" && prevToken.value !== "++" && prevToken.value !== "--";
  return false;
}

// Replace comments (and optionally string/template/regex literals) with spaces
// while preserving newlines and exact character offsets (1-to-1 length).
export function stripJs(source, { stripStrings = true } = {}) {
  const out = [];
  const length = source.length;
  let i = 0;
  let prevToken = null;
  const templateBraceDepths = [];

  const pushBlank = (text) => {
    for (let k = 0; k < text.length; k += 1) {
      out.push(text[k] === "\n" ? "\n" : " ");
    }
  };

  while (i < length) {
    const ch = source[i];
    const next = source[i + 1];

    // Single-line comment
    if (ch === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < length && source[i] !== "\n") i += 1;
      pushBlank(source.slice(start, i));
      continue;
    }

    // Block comment
    if (ch === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(length, i + 2);
      pushBlank(source.slice(start, i));
      continue;
    }

    // String literal ('...' or "...")
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      const slice = source.slice(start, i);
      if (stripStrings) pushBlank(slice);
      else out.push(slice);
      prevToken = { type: "literal", value: quote };
      continue;
    }

    // Template literal (`...${expr}...`)
    if (ch === "`") {
      const start = i;
      i += 1;
      while (i < length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "$" && source[i + 1] === "{") {
          const chunk = source.slice(start, i + 2);
          if (stripStrings) {
            pushBlank(chunk.slice(0, -2));
            out.push("${");
          } else {
            out.push(chunk);
          }
          i += 2;
          templateBraceDepths.push(1);
          prevToken = { type: "punct", value: "{" };
          break;
        }
        if (source[i] === "`") {
          i += 1;
          const chunk = source.slice(start, i);
          if (stripStrings) pushBlank(chunk);
          else out.push(chunk);
          prevToken = { type: "literal", value: "`" };
          break;
        }
        i += 1;
      }
      continue;
    }

    // Inside template `${...}` expression
    if (templateBraceDepths.length > 0 && (ch === "{" || ch === "}")) {
      if (ch === "{") {
        templateBraceDepths[templateBraceDepths.length - 1] += 1;
        out.push(ch);
        prevToken = { type: "punct", value: "{" };
        i += 1;
        continue;
      }
      templateBraceDepths[templateBraceDepths.length - 1] -= 1;
      if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
        templateBraceDepths.pop();
        out.push("}");
        i += 1;
        // Resume scanning the remainder of the enclosing template literal
        const resumeStart = i;
        while (i < length) {
          if (source[i] === "\\") {
            i += 2;
            continue;
          }
          if (source[i] === "$" && source[i + 1] === "{") {
            const chunk = source.slice(resumeStart, i + 2);
            if (stripStrings) {
              pushBlank(chunk.slice(0, -2));
              out.push("${");
            } else {
              out.push(chunk);
            }
            i += 2;
            templateBraceDepths.push(1);
            prevToken = { type: "punct", value: "{" };
            break;
          }
          if (source[i] === "`") {
            i += 1;
            const chunk = source.slice(resumeStart, i);
            if (stripStrings) pushBlank(chunk);
            else out.push(chunk);
            prevToken = { type: "literal", value: "`" };
            break;
          }
          i += 1;
        }
        continue;
      }
      out.push(ch);
      prevToken = { type: "punct", value: "}" };
      i += 1;
      continue;
    }

    // Regex literal
    if (ch === "/" && canStartRegex(prevToken)) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) {
          i += 1;
          while (i < length && /[a-z]/i.test(source[i])) i += 1;
          break;
        } else if (source[i] === "\n") {
          break;
        }
        i += 1;
      }
      const slice = source.slice(start, i);
      if (stripStrings) pushBlank(slice);
      else out.push(slice);
      prevToken = { type: "literal", value: "/" };
      continue;
    }

    // Identifiers / keywords
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      const word = source.slice(start, i);
      out.push(word);
      prevToken = { type: "word", value: word };
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < length && /[0-9a-zA-Z._]/.test(source[i])) i += 1;
      const num = source.slice(start, i);
      out.push(num);
      prevToken = { type: "literal", value: num };
      continue;
    }

    // Whitespace
    if (/\s/.test(ch)) {
      out.push(ch);
      i += 1;
      continue;
    }

    // Multi-char punctuators relevant to regex disambiguation
    if ((ch === "+" && next === "+") || (ch === "-" && next === "-")) {
      out.push(ch, next);
      prevToken = { type: "punct", value: ch + next };
      i += 2;
      continue;
    }

    out.push(ch);
    prevToken = { type: "punct", value: ch };
    i += 1;
  }

  return out.join("");
}

export function findMatchingBrace(strippedSource, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < strippedSource.length; index += 1) {
    const char = strippedSource[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function extractFunctionBodies(source) {
  const stripped = stripJs(source, { stripStrings: true });
  const bodies = new Map();
  const functionPattern = /(?:export\s+)?(?:async\s+)?function\s+(handle[A-Z]\w*)\s*\([^)]*\)\s*\{/g;
  const constPattern = /(?:export\s+)?const\s+(handle[A-Z]\w*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g;
  for (const pattern of [functionPattern, constPattern]) {
    let match;
    while ((match = pattern.exec(stripped))) {
      const openIndex = stripped.indexOf("{", pattern.lastIndex - 1);
      const closeIndex = findMatchingBrace(stripped, openIndex);
      if (closeIndex === -1) continue;
      bodies.set(match[1], stripped.slice(openIndex + 1, closeIndex));
    }
  }
  return bodies;
}

export function hasRequiredAuthGuard(strippedBody) {
  return (
    /\bawait\s+requireAdmin\s*\(/.test(strippedBody) ||
    /\bawait\s+requireInstallAdmin\s*\(/.test(strippedBody) ||
    /\bverifyWebhookToken\s*\(/.test(strippedBody)
  );
}

const ALLOWED_DIRECT_SERVER_ROUTES = new Set([
  // Public demo analytics config & first-party demo analytics proxy
  "/analytics-config.json",
  "/robots.txt",
  "/t",
  "/api/event",
  // Main API dispatchers (handlers inside are verified by checkRoutedHandlersAuthenticate)
  "/api/*path",
  "/u/:tenant/api/*path",
  // Cached media restore fallback, static metadata, OAuth return landing page, health & SPA fallback
  "/media/*name",
  "/changelog.json",
  "/favicon.ico",
  "/version.json",
  "/auth/plex/return",
  "/health",
  "/health/",
  "/*name",
]);

export function checkDirectServerRoutes(serverSource) {
  const noComments = stripJs(serverSource, { stripStrings: false });
  const offenders = [];
  // Require a comma after the first argument so Express settings lookups like
  // `app.get("trust proxy")` are not misread as HTTP route registrations.
  const routePattern = /\bapp\.(get|post|put|patch|delete|all)\s*\(\s*(\[[^\]]*\]|["'][^"']+["'])\s*,/g;
  let match;
  while ((match = routePattern.exec(noComments))) {
    const method = match[1].toUpperCase();
    const rawTarget = match[2];
    const paths = [...rawTarget.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
    for (const routePath of paths) {
      if (!ALLOWED_DIRECT_SERVER_ROUTES.has(routePath)) {
        offenders.push(`${method} ${routePath}`);
      }
    }
  }
  return offenders;
}

export function checkOutboundSource(file, source) {
  const normalized = file.replace(/\\/g, "/");
  const isOutbound = normalized.endsWith("utils/outbound.js");
  const isServerEntry = normalized === "server/server.js";
  const isPlexListener = normalized.endsWith("utils/plexNotificationListener.js");
  const offenders = [];

  const strippedCode = stripJs(source, { stripStrings: true });
  const strippedComments = stripJs(source, { stripStrings: false });

  if (!isOutbound) {
    const codeLines = strippedCode.split("\n");
    codeLines.forEach((line, index) => {
      if (/(?<![A-Za-z0-9_$.])fetch\s*\(/.test(line) && !/\bfunction\s+fetch\s*\(/.test(line)) {
        offenders.push(`${file}:${index + 1} (bare fetch)`);
      } else if (/\b(?:globalThis|global)\.fetch\b/.test(line)) {
        offenders.push(`${file}:${index + 1} (global fetch)`);
      }
    });

    const commentLines = strippedComments.split("\n");
    commentLines.forEach((line, index) => {
      if (/\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?https?["']/.test(line)) {
        offenders.push(`${file}:${index + 1} (direct node:http/https)`);
      }
      if (!isServerEntry && !isPlexListener && /\b(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']undici["']/.test(line)) {
        offenders.push(`${file}:${index + 1} (direct undici import)`);
      }
    });
  }

  if (!isPlexListener) {
    const codeLines = strippedCode.split("\n");
    codeLines.forEach((line, index) => {
      if (/\bnew\s+WebSocket\s*\(/.test(line)) {
        offenders.push(`${file}:${index + 1} (bare WebSocket)`);
      }
    });
  }

  return offenders;
}

function checkRoutedHandlersAuthenticate() {
  const indexSource = fs.readFileSync(path.join(root, "server/src/index.js"), "utf8");
  const indexStripped = stripJs(indexSource, { stripStrings: true });
  const routedHandlers = new Set();
  for (const match of indexStripped.matchAll(/return\s+(handle[A-Z]\w*)\s*\(\s*req\s*,\s*res/g)) {
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
    "handleUpgradeStatus",
    "handleChangelog",
    "handleLogin",
    "handleLogout",
    "handleAuthStatus",
    "handleAuthClaim",
    // Calendar clients cannot send login cookies; this route authenticates
    // with its private, revocable feed token instead.
    "handleCalendarFeed",
  ]);
  const offenders = [];
  const missing = [];
  for (const handler of routedHandlers) {
    const definition = handlerBodies.get(handler);
    if (!definition) {
      missing.push(handler);
      continue;
    }
    if (publicHandlers.has(handler)) continue;
    if (!hasRequiredAuthGuard(definition.body)) {
      offenders.push(`${definition.file}: ${handler}`);
    }
  }

  const serverSource = fs.readFileSync(path.join(root, "server/server.js"), "utf8");
  const directOffenders = checkDirectServerRoutes(serverSource);

  if (missing.length || offenders.length || directOffenders.length) {
    if (missing.length) {
      console.error("Routed handlers without definitions found by build check:");
      for (const handler of missing) console.error(`  ${handler}`);
    }
    if (offenders.length) {
      console.error("Routed handlers without an auth guard found:");
      for (const offender of offenders) console.error(`  ${offender}`);
      console.error("Add await requireAdmin(), await requireInstallAdmin(), verifyWebhookToken(), or document the handler in the public whitelist.");
    }
    if (directOffenders.length) {
      console.error("Direct Express routes in server/server.js outside the explicit whitelist:");
      for (const offender of directOffenders) console.error(`  ${offender}`);
    }
    process.exit(1);
  }
}

function main() {
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
  // URLs, checks DNS against private metadata endpoints, and prevents credentials
  // from crossing origins.
  {
    const offenders = [];
    for (const file of javascriptFiles("server")) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      offenders.push(...checkOutboundSource(file, source));
    }
    if (offenders.length) {
      console.error("Outbound security boundary violation - use fetchWithTimeout (server/src/utils/outbound.js) or plexNotificationListener:");
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
