#!/usr/bin/env node

// Posts an embed to DISCORD_RELEASES_WEBHOOK describing the newest changelog
// entry. Run with "main" (reads changelog.json) or "alpha" (reads
// changelog.alpha.json) as the only argument. Silently no-ops when the
// webhook secret isn't configured, so forks and local runs never fail on it.

import fs from "node:fs";
import { changelogSectionGroups } from "./changelog-sections.js";

const channel = process.argv[2];
if (channel !== "main" && channel !== "alpha") {
  console.error('Usage: node scripts/notify-discord-release.js <"main"|"alpha"> [--dry-run]');
  process.exit(1);
}
const dryRun = process.argv.includes("--dry-run");

const webhookUrl = String(process.env.DISCORD_RELEASES_WEBHOOK || "").trim();
if (!webhookUrl && !dryRun) {
  console.log("DISCORD_RELEASES_WEBHOOK is not set, skipping Discord release notification.");
  process.exit(0);
}

const repo = process.env.GITHUB_REPOSITORY || "";
const sha = process.env.GITHUB_SHA || "";
const commitUrl = repo && sha ? `https://github.com/${repo}/commit/${sha}` : undefined;

function bulletList(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const lines = [];
  let used = 0;
  let shown = 0;
  for (const item of items) {
    const line = `- ${item}`;
    if (used + line.length + 1 > 950) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < items.length) lines.push(`- …and ${items.length - shown} more`);
  return lines.join("\n");
}

function sectionBulletList(entry, key) {
  const section = changelogSectionGroups(entry).find((candidate) => candidate.key === key);
  if (!section?.groups.length) return null;
  const items = [];
  for (const group of section.groups) {
    if (group.title) items.push(`**${group.title}**`);
    items.push(...group.details.map((detail) => `- ${detail}`));
  }
  return bulletList(items);
}

function buildMainEmbed() {
  const changelog = JSON.parse(fs.readFileSync("changelog.json", "utf8"));
  const entry = changelog.entries?.[0];
  if (!entry) return null;

  const sectionLabels = [
    ["newFeatures", "New Features"],
    ["majorBugFixes", "Bug Fixes"],
    ["tweaks", "Tweaks"],
  ];
  const fields = [];
  for (const [key, label] of sectionLabels) {
    const list = sectionBulletList(entry, key);
    if (list) fields.push({ name: label, value: list });
  }
  if (fields.length === 0) {
    const list = bulletList(entry.details);
    if (list) fields.push({ name: "Changes", value: list });
  }
  if (entry.websiteUrl) fields.push({ name: "Website", value: String(entry.websiteUrl).slice(0, 1024) });

  return {
    title: `Plekt v${entry.version} released`.slice(0, 256),
    description: String(entry.message || "").slice(0, 4096),
    url: commitUrl,
    color: 0x57f287,
    fields,
    timestamp: entry.date,
  };
}

function buildAlphaEmbed() {
  const alpha = JSON.parse(fs.readFileSync("changelog.alpha.json", "utf8"));
  const entry = alpha.entries?.[0];
  if (!entry) return null;

  const fields = [];
  const list = bulletList(entry.details);
  if (list) fields.push({ name: "Changes", value: list });

  return {
    title: `Plekt v${entry.version} alpha (build ${entry.build})`.slice(0, 256),
    description: String(entry.message || "").slice(0, 4096),
    url: commitUrl,
    color: 0xfaa61a,
    fields,
    timestamp: entry.date,
  };
}

const embed = channel === "alpha" ? buildAlphaEmbed() : buildMainEmbed();
if (!embed) {
  console.log("No changelog entry found, skipping Discord release notification.");
  process.exit(0);
}

if (dryRun) {
  console.log(JSON.stringify({ embeds: [embed] }, null, 2));
  process.exit(0);
}

const response = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ embeds: [embed] }),
});

if (!response.ok) {
  const body = await response.text();
  console.error(`Discord webhook request failed: ${response.status} ${body}`);
  process.exit(1);
}

console.log(`Posted ${channel} release notification to Discord.`);
