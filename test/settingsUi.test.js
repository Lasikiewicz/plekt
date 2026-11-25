import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { collectFieldValues, renderFieldRow } from "../public/modules/settings-ui.js";

test("choice fields render accessible radio options", () => {
  const markup = renderFieldRow({
    key: "watchImportMode",
    id: "sync-field-watch_import_mode",
    label: "When you manually mark an item as watched in Plex / Emby / Jellyfin",
    type: "choice",
    value: "review",
    options: [
      { value: "now", label: "Mark as watched now" },
      { value: "review", label: "Require review", description: "Hold it for a decision." },
    ],
  });

  assert.match(markup, /role="radiogroup"/);
  assert.match(markup, /value="review"[\s\S]*checked/);
  assert.match(markup, /Hold it for a decision\./);
});

test("collectFieldValues returns only the checked choice", () => {
  const controls = [
    { type: "radio", checked: false, value: "now", dataset: { modalField: "watchImportMode" } },
    { type: "radio", checked: true, value: "review", dataset: { modalField: "watchImportMode" } },
    { type: "checkbox", checked: true, value: "on", dataset: { modalField: "fastLocalPacing" } },
  ];

  assert.deepEqual(collectFieldValues({ querySelectorAll: () => controls }), {
    watchImportMode: "review",
    fastLocalPacing: true,
  });
});

test("checkbox fields render with their persisted state", () => {
  const markup = renderFieldRow({
    key: "upNextSyncEnabled",
    id: "sync-field-up_next_sync",
    type: "checkbox",
    label: "Sync Up Next to media apps",
    value: true,
  });

  assert.match(markup, /id="sync-field-up_next_sync"/);
  assert.match(markup, /Sync Up Next to media apps/);
  assert.match(markup, /type="checkbox"[^>]*checked/);
});

test("public UI does not reference undefined button-secondary class", () => {
  const publicDir = path.resolve(import.meta.dirname, "../public");
  const modulesDir = path.join(publicDir, "modules");
  const files = [
    path.join(publicDir, "index.html"),
    ...fs.readdirSync(modulesDir).filter((name) => name.endsWith(".js")).map((name) => path.join(modulesDir, name)),
  ];
  const offenders = files.filter((file) => /\bbutton-secondary\b/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "Use button-ghost or button-primary instead of undefined button-secondary");
});

test("Up Next Sync Tuning fields include summaries, help descriptions, and full-width select styling", () => {
  const servicesSrc = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-services.js"), "utf8");
  for (const key of [
    "upNextSort",
    "upNextPartWatched",
    "upNextCustomFallback",
    "upNextMirrorPlex",
    "upNextMirrorEmby",
    "upNextMirrorJellyfin",
  ]) {
    assert.match(servicesSrc, new RegExp(`${key}:\\s*"[^"]+"`), `missing SYNC_TUNING_SUMMARIES entry for ${key}`);
  }
  assert.match(servicesSrc, /key:\s*"upNextSort"[\s\S]*?help:\s*"[^"]+"/);
  assert.match(servicesSrc, /key:\s*"upNextPartWatched"[\s\S]*?help:\s*"[^"]+"/);
  assert.match(servicesSrc, /key:\s*"upNextCustomFallback"[\s\S]*?help:\s*"[^"]+"/);
  assert.match(servicesSrc, /key:\s*"upNextMirrorPlex"[\s\S]*?help:\s*"[^"]+"/);
  assert.match(servicesSrc, /key:\s*"upNextMirrorEmby"[\s\S]*?help:\s*"[^"]+"/);
  assert.match(servicesSrc, /key:\s*"upNextMirrorJellyfin"[\s\S]*?help:\s*"[^"]+"/);

  const css = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  assert.match(css, /#syncTuningFields\s+\.settings-modal-field\s+\.settings-modal-field-control\s+select\.field\s*\{[\s\S]*?width:\s*auto\s*!important;/);
});
