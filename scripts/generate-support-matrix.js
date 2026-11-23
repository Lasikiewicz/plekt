#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SUPPORT_MATRIX_PATH = "docs/support-matrix.md";

// What each tracker row shows, in page order. `key` is a capability name in the
// tracker adapter's table (listTrackerCapabilities()); capabilities that are not
// listed here (historyWindow, existingDateMutation) are internal and stay off
// the page.
export const TRACKER_FEATURES = Object.freeze([
  { key: "watchedSnapshot", label: "Watched state into Plekt" },
  { key: "playHistory", label: "Play history into Plekt, each play with its date" },
  { key: "watchedWrite", label: "Mark watched from Plekt" },
  { key: "unwatchedWrite", label: "Mark unwatched from Plekt" },
  { key: "datedHistoryWrite", label: "Send a play with its original date" },
  { key: "repeatHistoryWrite", label: "Send repeat plays" },
  { key: "ratingSnapshot", label: "Ratings into Plekt" },
  { key: "ratingSet", label: "Set a rating from Plekt" },
  { key: "ratingClear", label: "Clear a rating from Plekt" },
  { key: "resumeProgress", label: "Resume position" },
  { key: "watchlist", label: "Watchlist" },
]);

// The two things the capability table does not hold. Both are checked against
// the code by test/supportMatrixDocs.test.js (full-sync directions and the
// adapter's device-authorization functions), so a change there fails the test.
export const TRACKER_META = Object.freeze({
  trakt: {
    label: "Trakt",
    direction: "Both ways: Plekt reads your Trakt history and sends new watches, ratings and unwatches back",
    signIn: "Device code: Plekt shows a code and you approve it on trakt.tv",
  },
  simkl: {
    label: "Simkl",
    direction: "Both ways: Plekt reads your Simkl library and sends new watches and ratings back",
    signIn: "Device code: Plekt shows a code and you approve it on simkl.com",
  },
});

const MEDIA_ORDER = ["movie", "show", "episode"];
const MEDIA_LABEL = { movie: "movies", show: "shows", episode: "episodes" };
const TRIGGER_ORDER = ["scheduled", "event", "user"];
const TRIGGER_LABEL = {
  scheduled: "scheduled sync",
  event: "media-server events",
  user: "your own actions (Check now, Sync now)",
};

// Adapters list some types twice or under an alias ("tv" is a show). Unknown
// types are kept after the known ones so a new type shows up instead of hiding.
export function itemTypeLabels(mediaTypes = []) {
  const normalized = [...new Set(mediaTypes.map((type) => (type === "tv" ? "show" : type)))];
  const known = MEDIA_ORDER.filter((type) => normalized.includes(type));
  const other = normalized.filter((type) => !MEDIA_ORDER.includes(type)).sort();
  return [...known, ...other].map((type) => MEDIA_LABEL[type] || type);
}

export function arrivalLabels(capabilities = {}) {
  const used = new Set();
  for (const capability of Object.values(capabilities)) {
    if (capability?.supported) for (const trigger of capability.triggers || []) used.add(trigger);
  }
  const known = TRIGGER_ORDER.filter((trigger) => used.has(trigger));
  const other = [...used].filter((trigger) => !TRIGGER_ORDER.includes(trigger)).sort();
  return [...known, ...other].map((trigger) => TRIGGER_LABEL[trigger] || trigger);
}

export const generatedMarkers = (id) => ({
  start: `<!-- generated:tracker:${id}:start - run \`npm run support-matrix\`, do not edit by hand -->`,
  end: `<!-- generated:tracker:${id}:end -->`,
});

// Pure: one tracker's registry entry in, Markdown out.
export function renderTrackerBlock({ id, capabilities }, meta = TRACKER_META[id]) {
  if (!meta) throw new Error(`No hand-written direction and sign-in for tracker "${id}" in TRACKER_META`);
  const lines = [
    "| | |",
    "| --- | --- |",
    `| Direction | ${meta.direction} |`,
    `| Sign-in | ${meta.signIn} |`,
    `| Changes arrive by | ${arrivalLabels(capabilities).join(", ") || "nothing yet"} |`,
    "",
    "| What syncs | Status | Item types |",
    "| --- | --- | --- |",
  ];
  for (const { key, label } of TRACKER_FEATURES) {
    const capability = capabilities?.[key];
    if (capability?.supported) lines.push(`| ${label} | Yes | ${itemTypeLabels(capability.mediaTypes).join(", ") || "-"} |`);
    else lines.push(`| ${label} | Not yet | - |`);
  }
  return lines.join("\n");
}

// Replaces the text between a tracker's markers, leaving the rest of the page
// alone. Throws when a marker pair is missing so the page cannot silently lose
// its generated section.
export function applyTrackerBlocks(markdown, trackers, metaById = TRACKER_META) {
  let result = markdown.replace(/\r\n/g, "\n");
  for (const tracker of trackers) {
    const { start, end } = generatedMarkers(tracker.id);
    const from = result.indexOf(start);
    const to = result.indexOf(end);
    if (from === -1 || to === -1 || to < from) {
      throw new Error(`${SUPPORT_MATRIX_PATH} is missing the generated markers for "${tracker.id}"`);
    }
    result = `${result.slice(0, from + start.length)}\n\n${renderTrackerBlock(tracker, metaById[tracker.id])}\n\n${result.slice(to)}`;
  }
  return result;
}

// Importing the tracker registry opens the SQLite data folder, so the command
// line tool points DATA_DIR at a throwaway folder first. The tests already run
// with their own DATA_DIR (scripts/test-data-setup.js).
async function loadTrackers() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "support-matrix-"));
  process.env.DATA_DIR = scratch;
  process.on("exit", () => {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* an open SQLite file can keep it on Windows */ }
  });
  const registry = await import(pathToFileURL(path.join(root, "server/src/utils/trackers/registry.js")).href);
  return registry.listTrackerCapabilities();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.join(root, SUPPORT_MATRIX_PATH);
  const current = fs.readFileSync(file, "utf8");
  const next = applyTrackerBlocks(current, await loadTrackers());
  if (next === current.replace(/\r\n/g, "\n")) {
    console.log(`${SUPPORT_MATRIX_PATH} is already current.`);
  } else {
    fs.writeFileSync(file, next);
    console.log(`Updated ${SUPPORT_MATRIX_PATH}.`);
  }
  process.exit(0);
}
