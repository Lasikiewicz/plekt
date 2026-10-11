#!/usr/bin/env node

// Renders changelog.json into a plain, human-readable CHANGELOG.md at the repo
// root, so release history is readable directly on GitHub without needing to
// log into a running instance. Regenerated automatically by
// promote-alpha-to-main.js on every release; safe to re-run manually at any
// time since it only reads changelog.json and overwrites CHANGELOG.md.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changelogSectionGroups } from "./changelog-sections.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = path.join(root, "changelog.json");
const outputPath = path.join(root, "CHANGELOG.md");

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
}

export function generateChangelogMarkdown() {
  const changelog = JSON.parse(fs.readFileSync(changelogPath, "utf8"));
  const entries = Array.isArray(changelog.entries) ? changelog.entries : [];

  const lines = [
    "# Changelog",
    "",
    "Release history for Plekt. This file covers published releases on `main` only -",
    "for the current pre-release build on `alpha` or `develop`, open **Settings → About**",
    "in a running instance, which lists that channel's build history separately.",
    "",
  ];

  for (const entry of entries) {
    lines.push(`## v${entry.version}${entry.date ? ` - ${formatDate(entry.date)}` : ""}`);
    lines.push("");
    lines.push(entry.message || "Release update");
    const websiteUrl = String(entry.websiteUrl || "").trim();
    if (websiteUrl) {
      lines.push("");
      lines.push(`[Visit the Plekt website](${websiteUrl})`);
    }
    lines.push("");
    const sectionGroups = changelogSectionGroups(entry);
    if (sectionGroups.some((section) => section.groups.length)) {
      for (const section of sectionGroups) {
        if (!section.groups.length) continue;
        lines.push(`### ${section.title}`, "");
        for (const group of section.groups) {
          if (group.title) lines.push(`#### ${group.title}`, "");
          for (const detail of group.details) lines.push(`- ${detail}`);
          lines.push("");
        }
      }
    } else if (Array.isArray(entry.details) && entry.details.length) {
      for (const detail of entry.details) lines.push(`- ${detail}`);
      lines.push("");
    }
  }

  fs.writeFileSync(outputPath, `${lines.join("\n").trimEnd()}\n`);
  return outputPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const written = generateChangelogMarkdown();
  console.log(`Wrote ${written}`);
}
