#!/usr/bin/env node

// Refuses a develop push that still carries more than one product commit.
//
// The develop changelog folds every pending product commit into one rolling
// entry, and synthesizeHeadline concatenates each of their subjects. Four
// unconsolidated commits once produced a 290-character run-on headline over 24
// bullets, and the same drift reappeared later when a single extra `docs:`
// commit was added. Step 7 of the push-to-git workflow exists to prevent this by
// squashing to one product commit, but nothing enforced it, so it was only
// caught by reading the generated entry.
//
// Tooling commits are excluded. `chore:` work contributes no bullets and is kept
// deliberately separate from product commits, so any number of those is fine.
//
// Commits already on origin/main are excluded too. After "Force to main", local
// develop is moved onto the release commit (decisions.md entry 18), so the next
// push carries published main history. Those commits cannot be squashed without
// detaching develop from main, so they are not part of the shape being checked.
//
// This is a shape check on the push, not a judgement about the content. It says
// "these should be one commit", and the fix is the reset-and-recommit in step 7.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isChangelogProcessMessage, isNoiseCommitMessage, isReleaseTypeCommitMessage } from "./changelog-message.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Exported pure so the counting rule can be tested without a repository.
export function productCommitSubjects(subjects = []) {
  return subjects.filter((subject) =>
    subject
    && !isNoiseCommitMessage(subject)
    && !isChangelogProcessMessage(subject)
    && isReleaseTypeCommitMessage(subject));
}

// Exported pure so the exclusion can be tested without a repository.
export function pendingLogArgs(range, { excludeRef = "" } = {}) {
  return ["log", range, ...(excludeRef ? ["--not", excludeRef] : []), "--format=%s"];
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pendingSubjects(range) {
  // Without a fetched origin/main nothing is excluded, so the check stays strict.
  const excludeRef = refExists("origin/main") ? "origin/main" : "";
  try {
    return execFileSync("git", pendingLogArgs(range, { excludeRef }), { cwd: root, encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const range = process.argv[2] || "origin/develop..HEAD";
  const product = productCommitSubjects(pendingSubjects(range));

  if (product.length > 1) {
    console.error(`Refusing the push: ${product.length} product commits are pending on develop.`);
    for (const subject of product) console.error(`  - ${subject}`);
    console.error("");
    console.error("The develop changelog folds these into one entry and concatenates every");
    console.error("subject into one headline, which reads as a run-on and carries into the");
    console.error("alpha entry. Consolidate them first (push-to-git step 7):");
    console.error("");
    console.error("  git reset --soft origin/develop");
    console.error("  # recommit as one product commit, keeping tooling in its own chore commit");
    console.error("  node scripts/rebuild-develop-changelog.js");
    console.error("");
    process.exit(1);
  }

  console.log(`Pending commit check passed (${product.length} product commit).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
