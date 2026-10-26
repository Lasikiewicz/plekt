import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { parseSettingsRoute, settingsHelpLayout, settingsPathForLegacy, SETTINGS_SECTIONS } from "../public/modules/settings-shell.js";

test("settings routes resolve flat sections and panels", () => {
  assert.equal(parseSettingsRoute("/settings").kind, "overview");
  assert.equal(parseSettingsRoute("/settings/media-servers").group, "media-servers");
  assert.equal(parseSettingsRoute("/settings/media-servers").panel, "apps");
  assert.equal(parseSettingsRoute("/settings/metadata").panel, "api-keys");
  assert.equal(parseSettingsRoute("/settings/storage").panel, "general");
  assert.equal(parseSettingsRoute("/settings/restore").backupTab, "restore");
  assert.deepEqual(parseSettingsRoute("/settings/account").subPanels, ["general-login"]);
  assert.equal(settingsPathForLegacy("/settings/sync-match-report"), "/sync-activity");
  assert.equal(settingsPathForLegacy("/settings/sync-issues"), "/sync-activity");
  assert.equal(parseSettingsRoute("/settings/force-sync").panel, "sync");
  assert.deepEqual(parseSettingsRoute("/settings/force-sync").subPanels, ["sync-tools"]);
  const oneTimeImportsRoute = parseSettingsRoute("/settings/connections#one-time-imports");
  assert.equal(oneTimeImportsRoute.title, "One Time Imports");
  assert.ok(oneTimeImportsRoute.subPanels.includes("tools-one-time-imports"));
  assert.equal(parseSettingsRoute("/settings/connections#tautulli").section, "one-time-imports");
  assert.equal(settingsPathForLegacy("tautulli"), "/settings/connections#one-time-imports");
  assert.equal(parseSettingsRoute("/settings/tautulli").path, "/settings/connections");
});

test("settings help matches the main panel minimum and grows only after Read more", () => {
  assert.deepEqual(settingsHelpLayout(140, 320), {
    minHeight: 320,
    height: 320,
    collapsed: false,
    showReadMore: false,
    expanded: false,
  });
  assert.deepEqual(settingsHelpLayout(520, 320), {
    minHeight: 320,
    height: 320,
    collapsed: true,
    showReadMore: true,
    expanded: false,
  });
  assert.equal(settingsHelpLayout(340, 320).showReadMore, false, "one-line-or-smaller overflow does not add an unnecessary control");
  assert.equal(settingsHelpLayout(340, 320).height, 320, "small overflow still matches the main card height");
  assert.equal(settingsHelpLayout(146.25, 146.5).height, 146.5, "fractional CSS heights are preserved for exact alignment at page zoom");
  assert.equal(settingsHelpLayout(350, 320).showReadMore, true, "meaningful extra help gets a Read more control");
  assert.deepEqual(settingsHelpLayout(520, 320, true), {
    minHeight: 320,
    height: 0,
    collapsed: false,
    showReadMore: true,
    expanded: true,
  });
});

test("Settings Read more is based on clipped help copy, not the whole card's height", () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-shell.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  assert.match(source, /settingsHelpLayout\(article\.scrollHeight, targetHeight, wasExpanded\)/);
  assert.match(source, /button\.style\.setProperty\("display", "none", "important"\)[\s\S]*?settingsHelpLayout\(article\.scrollHeight/);
  assert.match(source, /document\.addEventListener\("toggle",[\s\S]*?prepareHelpReadMore\(\);/);
  assert.doesNotMatch(source, /const fullHelpHeight = Math\.round\(article\.getBoundingClientRect\(\)\.height\)/);
  assert.match(styles, /\.settings-pane \.settings-row-help \.help-read-more\.hidden\s*\{\s*display:\s*none\s*!important;/);
});

test("every section produces a routable canonical path with visible content", () => {
  // Panels that render their content inside data-sub-panel rows: a route that
  // resolves to one of these panels but lists no subPanels shows a blank page.
  const subPanelPanels = new Set(["general", "sync", "tools"]);
  for (const id of Object.keys(SETTINGS_SECTIONS)) {
    if (id === "advanced") continue; // legacy redirect section
    const route = parseSettingsRoute(`/settings/${id}`);
    assert.equal(route.kind, "task");
    assert.equal(route.section, id);
    assert.equal(route.path, `/settings/${id}`);
    assert.ok(route.panel, `section ${id} maps to a panel`);
    if (subPanelPanels.has(route.panel)) {
      assert.ok(route.subPanels?.length, `section ${id} on panel "${route.panel}" needs at least one visible sub-panel`);
    }
    if (route.panel === "backups") {
      assert.ok(route.backupTab, `section ${id} on the backups panel needs a backupTab`);
    }
  }
});

test("parent group routes aggregate every child's panel into one view list", () => {
  // Media Servers fans its children out across a single underlying panel - the
  // parent route must reveal all of them, not just the first.
  const mediaServers = parseSettingsRoute("/settings/media-servers");
  assert.deepEqual(
    mediaServers.views.map((v) => v.panel),
    ["apps"],
  );

  // Backup and Restore are separate top-level groups that each reveal only
  // their own tab on the shared "backups" panel.
  const backup = parseSettingsRoute("/settings/backup");
  assert.deepEqual(backup.views.map((v) => v.backupTab), ["settings"]);
  const restore = parseSettingsRoute("/settings/restore");
  assert.deepEqual(restore.views.map((v) => v.backupTab), ["restore"]);

  const advanced = parseSettingsRoute("/settings/advanced");
  assert.equal(advanced.path, "/settings/general");

  const tools = parseSettingsRoute("/settings/tools");
  assert.deepEqual(
    tools.views.map((v) => v.panel),
    ["tools"],
  );
  const sync = parseSettingsRoute("/settings/sync");
  assert.deepEqual(sync.subPanels, ["sync-tuning", "sync-tools", "sync-history"]);
});

test("Users page refreshes its account list each time the route opens", () => {
  const app = fs.readFileSync(path.resolve(import.meta.dirname, "../public/app.js"), "utf8");
  const events = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-events.js"), "utf8");
  const routing = app.match(/function handleRouting\(path\)[\s\S]*?function applyActiveView\(\)/)?.[0] || "";
  const init = events.match(/export function initSettingsEvents\([\s\S]*?\n\}/)?.[0] || "";

  assert.match(routing, /activeSettingsRoute\?\.panel === "users"/);
  assert.match(routing, /loadSettingsUsersForRoute\(\)/);
  assert.match(events, /export \{ loadSettingsUsers \};/);
  assert.doesNotMatch(init, /loadSettingsUsers\(/);
});

test("Users options expose administrator promotion and demotion controls", () => {
  const users = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-users.js"), "utf8");
  assert.match(users, /data-user-action="\$\{user\.isAdmin \? "remove-admin" : "make-admin"\}"/);
  assert.match(users, /isInstallAdmin \? renderAdminRow/);
  assert.match(users, /"make-admin": \[`Granting admin access/);
  assert.match(users, /"remove-admin": \[`Removing admin access/);
});

test("user management options render paired action cards and keep instance controls in the heading", () => {
  const users = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/settings-users.js"), "utf8");
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  assert.match(users, /<summary class="accordion-header">[\s\S]*?class="sync-tool-summary-title"[\s\S]*?<b>Options<\/b>[\s\S]*?class="user-option-actions user-options-heading-actions"/);
  assert.match(users, /class="user-options-grid"[\s\S]*?data-user-rename-form[\s\S]*?data-user-password-form[\s\S]*?Administrator access/);
  assert.match(users, /class="user-options-footer"[\s\S]*?data-user-remove-open/);
  assert.match(styles, /\.user-options-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(styles, /\.user-option\s*\{[\s\S]*?background:\s*var\(--brand-menu\)/);
  assert.match(styles, /\.user-options-grid[\s\S]*?\.field:not\(#syncTuningFields\)[\s\S]*?background:\s*var\(--brand-main\)/);
  assert.match(styles, /\.user-options-heading-actions\s*\{[\s\S]*?position:\s*static/);
});

test("legacy and invalid settings routes normalize safely", () => {
  assert.equal(parseSettingsRoute("/settings/general").path, "/settings/general");
  assert.equal(parseSettingsRoute("/settings/account/login").path, "/settings/account");
  assert.equal(parseSettingsRoute("/settings/apps").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/plex").path, "/settings/media-servers");
  assert.equal(parseSettingsRoute("/settings/connections/webhooks").path, "/settings/webhooks");
  assert.equal(parseSettingsRoute("/settings/metadata/tmdb").path, "/settings/metadata");
  assert.equal(parseSettingsRoute("/settings/data/backups").path, "/settings/backup");
  assert.equal(parseSettingsRoute("/settings/backup-restore").path, "/settings/backup");
  assert.equal(parseSettingsRoute("/settings/backup-settings").path, "/settings/backup");
  assert.equal(parseSettingsRoute("/settings/data/restore").path, "/settings/restore");
  assert.equal(parseSettingsRoute("/settings/data/import").path, "/settings/trakt");
  assert.equal(parseSettingsRoute("/settings/system/advanced").path, "/settings/database-repairs");
  assert.equal(parseSettingsRoute("/settings/tools").path, "/settings/tools");
  assert.equal(parseSettingsRoute("/sync").path, "/settings/sync");
  assert.equal(parseSettingsRoute("/logs").path, "/settings/logs");
  assert.equal(settingsPathForLegacy("api-keys"), "/settings/metadata");
  assert.equal(settingsPathForLegacy("about"), "/about");
  assert.equal(settingsPathForLegacy("changelog"), "/settings/changelog");
  assert.equal(settingsPathForLegacy("/settings/about"), "/about");
  assert.equal(parseSettingsRoute("/settings/changelog").title, "Changelog");
  assert.equal(parseSettingsRoute("/settings/changelog").panel, "changelog");
  assert.equal(parseSettingsRoute("/settings/not-a-section").path, "/settings");
});

test("forced password changes always resolve to account", () => {
  const route = parseSettingsRoute("/settings/logs", { mustChangePassword: true });
  assert.equal(route.path, "/settings/account");
  assert.equal(route.panel, "general");
  assert.deepEqual(route.subPanels, ["general-login"]);
});

test("non-admin settings routes expose profile sections but omit shared settings", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { classList: { contains: (name) => name === "non-admin-user" } } };
  try {
    const general = parseSettingsRoute("/settings/general");
    assert.equal(general.kind, "task");
    assert.deepEqual(general.subPanels, ["general-login"]);
    assert.equal(parseSettingsRoute("/settings/metadata").kind, "overview");
    assert.equal(parseSettingsRoute("/settings/backup").kind, "overview");
    assert.equal(parseSettingsRoute("/settings/tools").kind, "overview");
    assert.equal(parseSettingsRoute("/settings/users").kind, "overview");
    assert.deepEqual(parseSettingsRoute("/settings/media-servers").subPanels, [
      "media-servers-plex", "media-servers-emby", "media-servers-jellyfin",
    ]);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("administrator viewing a user's workspace gets the same restricted settings routes", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { classList: { contains: (name) => name === "supervised-child" } } };
  try {
    assert.deepEqual(parseSettingsRoute("/settings/general").subPanels, ["general-login"]);
    assert.equal(parseSettingsRoute("/settings/users").kind, "overview");
    assert.equal(parseSettingsRoute("/settings/metadata").kind, "overview");
    assert.equal(parseSettingsRoute("/settings/media-servers").kind, "task");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("One Time Imports groups Tautulli and Netflix with contextual help", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  const row = html.match(/<div class="settings-row one-time-imports-row hidden" data-sub-panel="tools-one-time-imports">([\s\S]*?)<\/div>\s*<div class="settings-row hidden" id="seerr"/);
  assert.ok(row, "shared One Time Imports Settings row exists before Seerr");
  assert.match(row[1], /<p style="margin: 0;">One Time Imports<\/p>[\s\S]*<div id="oneTimeImportsContent">[\s\S]*<details id="tautulliImportDetails"[\s\S]*<details id="netflixImportDetails" class="sync-tool-details">[\s\S]*<b>Netflix<\/b>[\s\S]*id="netflixImportFileStatus"[\s\S]*class="settings-row-help"[\s\S]*One Time Imports - Help[\s\S]*Tautulli[\s\S]*Netflix/);
  assert.equal((row[1].match(/One Time Imports - Help/g) || []).length, 1, "importers share one contextual help card");
  assert.equal((row[1].match(/id="netflixCsvFile"/g) || []).length, 1, "Netflix form appears once inside the shared section");
  assert.equal((html.match(/data-sub-panel="tools-one-time-imports"/g) || []).length, 1, "both importers share one parent section");
  assert.match(html, /id="netflixImportSummary"[^>]*hidden><\/div>/);
  assert.match(html, /id="netflixReviewList"[^>]*><\/div>[\s\S]*class="netflix-import-actions"[\s\S]*id="netflixImportButton"/);
  assert.doesNotMatch(html, /Choose a CSV to begin/);
  assert.doesNotMatch(row[1], /Before committing, Plekt creates a local watch-history backup/);
  assert.match(styles, /\.settings-row\.one-time-imports-row\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*3fr\)\s+minmax\(280px,\s*2fr\);/);
  assert.match(styles, /#netflixImportStatus\[hidden\][\s\S]*display:\s*none !important/);
});
