#!/usr/bin/env node

// One command for everything that must happen between the last product commit
// and `git push origin develop`.
//
// This exists because the three-command version was skipped. An agent reported
// "the worktree is clean, with one commit ready to push" and went straight for
// the push, leaving the develop changelog stale for the commit it was about to
// publish. The pre-push hook would have rejected it, so nothing broken reaches
// the remote, but the failure only surfaces at the push itself.
//
// Collapsing it to one step removes the three separate things there were to
// forget: running the rebuild, staging `public` alongside the manifest, and
// committing the result.
//
// Safe to run repeatedly. When the changelog is already current it commits
// nothing and says so.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

function run(label, args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n${label} failed. Fix it before pushing; do not bypass it.`);
    process.exit(1);
  }
}

function main() {
  // A dirty worktree here means uncommitted product work. Committing it inside
  // the changelog commit would bury it in a chore entry that contributes no
  // bullets, so it is refused rather than swept up.
  const dirty = git(["status", "--porcelain", "--", ":!changelog.develop.json", ":!public"])
    .split("\n")
    .filter(Boolean);
  if (dirty.length > 0) {
    console.error("Refusing to prepare the push: uncommitted changes outside the changelog and public assets.");
    for (const line of dirty.slice(0, 10)) console.error(`  ${line}`);
    if (dirty.length > 10) console.error(`  ...and ${dirty.length - 10} more`);
    console.error("\nCommit your product work first, with bullet details, then run this again.");
    process.exit(1);
  }

  // Keep the local change inventory current before the changelog is rebuilt.
  // It is a planning artifact, not a commit input, and gives the operator one
  // deduplicated view of the work that the push is about to publish.
  run("The local update ledger", [path.join(root, "scripts", "update-local-updates.js")]);

  // Check before rebuilding. rebuild-develop-changelog.js increments the build
  // counter on every run that finds user-facing commits, so calling it when the
  // changelog is already current burns a build number and produces a second,
  // pointless "rebuild develop changelog" commit. The first version of this
  // script did exactly that on its second run.
  const current = spawnSync(process.execPath, [path.join(root, "scripts", "rebuild-develop-changelog.js"), "--check"], {
    cwd: root,
    encoding: "utf8",
  });

  if (current.status === 0) {
    console.log("Develop changelog already covers the commits being pushed; nothing to rebuild.");
  } else {
    console.log("Rebuilding the develop changelog...");
    run("The changelog rebuild", [path.join(root, "scripts", "rebuild-develop-changelog.js")]);
  }

  const changed = git(["status", "--porcelain", "--", "changelog.develop.json", "public"])
    .split("\n")
    .filter(Boolean);

  if (changed.length === 0) {
    console.log("\nChangelog already current; nothing to commit.");
  } else {
    // `public` must go in with the manifest: the rebuild restamps every ?v=
    // asset reference to this build's version, and asset-versions.js checks them
    // against the committed manifest during the build gate.
    git(["add", "changelog.develop.json", "public"]);
    git([
      "commit",
      "-m", "chore: rebuild develop changelog",
      "-m", "site-impact: none",
      "-m", "Website review: not required - generated develop changelog data and app asset cache stamps; no website pages or guides change.",
    ]);
    console.log(`\nCommitted the rebuilt changelog and ${changed.length - 1} restamped asset file(s).`);
  }

  console.log("\nVerifying what will be pushed...");
  run("The pending commit check", [path.join(root, "scripts", "check-pending-commits.js")]);
  run("The committed changelog check", [path.join(root, "scripts", "rebuild-develop-changelog.js"), "--check"]);

  const pending = git(["log", "origin/develop..HEAD", "--oneline"], { allowFailure: true });
  console.log("\nReady to push:");
  for (const line of pending.split("\n").filter(Boolean)) console.log(`  ${line}`);
  console.log("\n  git push origin develop");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
