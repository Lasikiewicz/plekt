import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUPPORT_MATRIX_PATH,
  TRACKER_FEATURES,
  TRACKER_META,
  applyTrackerBlocks,
  arrivalLabels,
  generatedMarkers,
  itemTypeLabels,
  renderTrackerBlock,
} from "../scripts/generate-support-matrix.js";
import { getTrackerAdapter, listTrackerCapabilities } from "../server/src/utils/trackers/registry.js";
import { trackerFullSyncDirections } from "../server/src/utils/trackers/fullSync.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = () => fs.readFileSync(path.join(root, SUPPORT_MATRIX_PATH), "utf8").replace(/\r\n/g, "\n");

test("the support matrix page matches the tracker registry", () => {
  const current = page();
  const expected = applyTrackerBlocks(current, listTrackerCapabilities());
  assert.equal(current, expected, `${SUPPORT_MATRIX_PATH} is out of date with the tracker capability tables - run \`npm run support-matrix\` and commit the result`);
});

test("every registered tracker has hand-written direction and sign-in text and a marked block", () => {
  const trackers = listTrackerCapabilities();
  assert.deepEqual(Object.keys(TRACKER_META).sort(), trackers.map(({ id }) => id).sort());
  const current = page();
  for (const { id } of trackers) {
    const { start, end } = generatedMarkers(id);
    assert.ok(current.includes(start) && current.includes(end), `${SUPPORT_MATRIX_PATH} has no generated block for ${id}`);
    assert.ok(current.includes(`## ${TRACKER_META[id].label}\n`), `${SUPPORT_MATRIX_PATH} has no section heading for ${id}`);
  }
});

test("the hand-written direction and sign-in text agree with the code", () => {
  for (const { id } of listTrackerCapabilities()) {
    const directions = trackerFullSyncDirections(id);
    assert.ok(
      directions.includes("import") && directions.includes("push"),
      `${id} no longer syncs both ways; update its direction text in TRACKER_META`,
    );
    assert.match(TRACKER_META[id].direction, /^Both ways/);
    const { auth } = getTrackerAdapter(id);
    assert.equal(typeof auth.startDeviceAuth, "function", `${id} no longer signs in with a device code; update its sign-in text in TRACKER_META`);
    assert.match(TRACKER_META[id].signIn, /^Device code/);
  }
});

test("a capability change in code changes the generated block", () => {
  const trackers = listTrackerCapabilities();
  const simkl = trackers.find(({ id }) => id === "simkl");
  const enabled = structuredClone(simkl);
  enabled.capabilities.watchlist = { supported: true, mediaTypes: ["movie", "show"], triggers: ["user"], preconditions: [], sideEffects: [] };
  assert.match(renderTrackerBlock(simkl), /\| Watchlist \| Not yet \| - \|/);
  assert.match(renderTrackerBlock(enabled), /\| Watchlist \| Yes \| movies, shows \|/);
  assert.notEqual(applyTrackerBlocks(page(), trackers), applyTrackerBlocks(page(), [enabled, ...trackers.filter(({ id }) => id !== "simkl")]));
});

test("item types and arrival channels render in a fixed order with aliases folded", () => {
  assert.deepEqual(itemTypeLabels(["episode", "tv", "movie", "show"]), ["movies", "shows", "episodes"]);
  assert.deepEqual(itemTypeLabels(["episode", "special"]), ["episodes", "special"]);
  assert.deepEqual(itemTypeLabels([]), []);
  assert.deepEqual(
    arrivalLabels({
      a: { supported: true, triggers: ["user", "event"] },
      b: { supported: false, triggers: ["scheduled"] },
    }),
    ["media-server events", "your own actions (Check now, Sync now)"],
  );
});

test("every feature row names a capability the registry defines", () => {
  const known = new Set(listTrackerCapabilities().flatMap(({ capabilities }) => Object.keys(capabilities)));
  for (const { key } of TRACKER_FEATURES) assert.ok(known.has(key), `${key} is not a tracker capability`);
});

test("a page missing a block marker is rejected instead of losing the section", () => {
  assert.throws(() => applyTrackerBlocks("# Empty page\n", listTrackerCapabilities()), /missing the generated markers/);
});

test("the page uses no em dash", () => {
  assert.ok(!page().includes("—"));
});
