#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_INDEX_PATH, generateCodeIndex } from "./generate-code-index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readRootFile(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

function minimumNodeVersion(engineRange) {
  const match = String(engineRange || "").match(/>=\s*(\d+(?:\.\d+){0,2})/);
  if (!match) {
    throw new Error(`Could not derive a minimum Node.js version from engines.node: ${engineRange || "missing"}`);
  }
  return match[1];
}

// Claims that went stale once and would mislead a future reader of the release
// procedure. These are checked by content because there is no other signal: the
// `paths-ignore` comment in docker-publish-develop.yml described a push that had
// already been removed, and stayed wrong for weeks because nothing compared prose
// against behaviour. `docs/decisions.md` is exempt - a superseded entry must keep
// its original wording verbatim, which is the point of the record.
//
// This is a banned-phrase check, not a correctness proof. It catches regressions
// of claims already known to have drifted, and nothing else. Add an entry only
// when a wrong claim in that file would cost real time or trust.
export const STALE_RELEASE_CLAIMS = [
  {
    pattern: /Build <n>/,
    why: "the develop label is the five-segment version itself, with trailing zeros trimmed",
  },
  {
    pattern: /starts each release cycle at build 1/,
    why: "the develop build counter starts at 0; the first build of a cycle is <release>.0.1",
  },
  {
    pattern: /push develop's own\s+reset state to `origin\/develop`/,
    why: "no force command pushes origin/develop; see docs/decisions.md entry 18",
  },
  {
    pattern: /pushes the synchronized state to `origin\/develop`/,
    why: "Force to main does not merge main into develop or push it; see entry 18",
  },
];

export function checkStaleReleaseClaims(files = []) {
  const failures = [];
  for (const { path: filePath, contents } of files) {
    for (const { pattern, why } of STALE_RELEASE_CLAIMS) {
      if (pattern.test(contents)) {
        failures.push(`${filePath} still says ${pattern.source} - ${why}`);
      }
    }
  }
  return failures;
}

export function checkDocumentationConsistency({ packageJson, readme } = {}) {
  const pkg = packageJson || JSON.parse(readRootFile("package.json"));
  const markdown = readme || readRootFile("README.md");
  const nodeMinimum = minimumNodeVersion(pkg.engines?.node);
  const failures = [];

  if (!markdown.includes(`Node.js-%3E%3D${nodeMinimum}-blue`)) {
    failures.push(`README Node.js badge does not match package.json engines.node (>=${nodeMinimum})`);
  }

  const releaseMarker = markdown.match(/^>\s+\*\*v([^*\s]+)\.\*\*/m);
  if (!releaseMarker) {
    failures.push("README does not declare its current released version");
  } else if (releaseMarker[1] !== String(pkg.version)) {
    failures.push(`README released-version marker (${releaseMarker[1]}) does not match package.json (${pkg.version})`);
  }

  if (!markdown.includes(`Requires Node.js ${nodeMinimum}+`)) {
    failures.push(`README bare-metal setup does not state Node.js ${nodeMinimum}+`);
  }

  if (/ADMIN_PASSWORD\s*[:=]\s*(?:changeme|password|admin)\b/i.test(markdown)) {
    failures.push("README contains a weak/default ADMIN_PASSWORD example");
  }

  const requiredComposePassword = /ADMIN_PASSWORD:\s*"\$\{ADMIN_PASSWORD:\?[^"}]+\}"/;
  if (!requiredComposePassword.test(markdown)) {
    failures.push("README Docker Compose setup does not require ADMIN_PASSWORD from a local .env file");
  }

  if (failures.length) {
    throw new Error(`Documentation consistency check failed:\n- ${failures.join("\n- ")}`);
  }

  return { nodeMinimum };
}

// The tool-guard hook denies whole-file Reads over this size, and the index is
// only useful if an agent can read it in one call.
export const CODE_INDEX_MAX_BYTES = 60 * 1024;

// docs/code-index.md is generated. It carries no line numbers, so it only goes
// stale when a route, a source file or an export name changes.
export function checkCodeIndex({ rootDir = root, committed } = {}) {
  const failures = [];
  const expected = generateCodeIndex({ rootDir });
  const indexPath = path.join(rootDir, CODE_INDEX_PATH);
  const current = committed ?? (fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : null);
  if (current === null) {
    failures.push(`${CODE_INDEX_PATH} is missing - run \`npm run code-index\``);
  } else if (current.replace(/\r\n/g, "\n") !== expected) {
    failures.push(`${CODE_INDEX_PATH} is out of date with the source - run \`npm run code-index\` and commit the result`);
  }
  const size = Buffer.byteLength(expected);
  if (size > CODE_INDEX_MAX_BYTES) {
    failures.push(`${CODE_INDEX_PATH} would be ${size} bytes, over the ${CODE_INDEX_MAX_BYTES}-byte whole-file Read limit - lower MAX_EXPORTS_PER_ROW in scripts/generate-code-index.js`);
  }
  return failures;
}

// Files whose release-procedure prose is read before someone changes the
// promotion scripts. decisions.md is deliberately absent: its superseded entries
// must keep the wording they were written with.
const RELEASE_PROSE_FILES = [
  "CLAUDE.md",
  "README.md",
  "docs/development.md",
  "docs/architecture.md",
  ".github/workflows/docker-publish-develop.yml",
  ".claude/skills/push-to-git/SKILL.md",
  ".claude/skills/force-to-alpha/SKILL.md",
  ".claude/skills/force-to-main/SKILL.md",
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { nodeMinimum } = checkDocumentationConsistency();

  const files = RELEASE_PROSE_FILES
    .map((relative) => ({ path: relative, full: path.join(root, relative) }))
    .filter(({ full }) => fs.existsSync(full))
    .map(({ path: relative, full }) => ({ path: relative, contents: fs.readFileSync(full, "utf8") }));

  const staleFailures = checkStaleReleaseClaims(files);
  if (staleFailures.length) {
    console.error("Release documentation is out of date:");
    for (const failure of staleFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  const codeIndexFailures = checkCodeIndex();
  if (codeIndexFailures.length) {
    console.error("Code index check failed:");
    for (const failure of codeIndexFailures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log(`Documentation consistency check passed (Node.js >=${nodeMinimum}, ${files.length} release docs scanned, code index current).`);
}
