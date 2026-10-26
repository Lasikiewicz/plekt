import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { sidebarNavigationPath, sidebarUserPresentation } from "../public/modules/sidebar-navigation.js";

function target({ id = "", view = "", explorerNav = "", settingsPath = "" } = {}) {
  return { id, dataset: { view, explorerNav, settingsPath } };
}

test("sidebar primary destinations resolve to browser-friendly paths", () => {
  assert.equal(sidebarNavigationPath(target({ view: "dashboard" })), "/");
  assert.equal(sidebarNavigationPath(target({ view: "explorer", explorerNav: "movies" })), "/movies");
  assert.equal(sidebarNavigationPath(target({ view: "explorer", explorerNav: "shows" })), "/tvshows");
  assert.equal(sidebarNavigationPath(target({ view: "upcoming" })), "/upcoming");
  assert.equal(sidebarNavigationPath(target({ view: "history" })), "/history");
  assert.equal(sidebarNavigationPath(target({ view: "stats" })), "/stats");
  assert.equal(sidebarNavigationPath(target({ view: "settings" })), "/settings");
  assert.equal(sidebarNavigationPath(target({ view: "about" })), "/about");
  assert.equal(sidebarNavigationPath(target({ view: "manualWatchReview" })), "/manual-watch-review");
});

test("sidebar special and nested destinations resolve correctly", () => {
  assert.equal(sidebarNavigationPath(target({ id: "brandLink" })), "/");
  assert.equal(sidebarNavigationPath(target({ id: "syncProgressIndicator" })), "/sync-activity");
  assert.equal(sidebarNavigationPath(target({ settingsPath: "/settings/sync#activity" })), "/settings/sync#activity");
  assert.equal(sidebarNavigationPath(target()), "");
});

test("sidebar shows the active account and only gives administrators the switcher", () => {
  const accounts = [
    { name: "admin", active: false },
    { name: "testuser2", active: true },
  ];
  assert.deepEqual(sidebarUserPresentation(accounts, "admin", false), {
    name: "testuser2",
    canSwitch: true,
  });
  assert.deepEqual(sidebarUserPresentation(accounts, "testuser2", true), {
    name: "testuser2",
    canSwitch: false,
  });
  assert.deepEqual(sidebarUserPresentation([], "testuser1", true), {
    name: "testuser1",
    canSwitch: false,
  });
});

test("signed-in account control sits above Version and replaces the nav switcher", () => {
  const html = fs.readFileSync(path.resolve(import.meta.dirname, "../public/index.html"), "utf8");
  const styles = fs.readFileSync(path.resolve(import.meta.dirname, "../public/styles.css"), "utf8");
  const appEvents = fs.readFileSync(path.resolve(import.meta.dirname, "../public/modules/app-events.js"), "utf8");
  const nav = html.match(/<nav class="topnav[\s\S]*?<\/nav>/)?.[0] || "";
  const footer = html.match(/<div class="sidebar-build-row">([\s\S]*?)<div class="sidebar-project-links">/)?.[1] || "";

  assert.ok(footer.indexOf("sidebarCurrentUserWrap") < footer.indexOf("id=\"appVersion\""));
  assert.match(footer, /id="sidebarCurrentUserButtonName"/);
  assert.match(footer, /id="sidebarCurrentUserButton"[^>]*>\s*<span id="sidebarCurrentUserButtonName"><\/span>\s*<\/button>/);
  assert.match(footer, /id="sidebarCurrentUserStatic"/);
  assert.doesNotMatch(nav, /id="sidebarSwitchUserButton"|class="nav-tab[^\"]*"[^>]*>\s*<span>Switch user/);
  assert.match(styles, /\.sidebar-current-user-button,\s*\.sidebar-current-user-static\s*\{[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/);
  assert.match(styles, /\.sidebar-current-user-list\s*\{[^}]*background:\s*var\(--brand-menu\);/);
  assert.match(footer, /id="appVersion"/);
  assert.doesNotMatch(appEvents, /sidebarAppearancePanel\)\?\.prepend\(elements\.appVersion\)/);
  assert.match(styles, /\.account-user-only\s*\{\s*display:\s*none\s*!important;/);
  assert.match(styles, /html\.non-admin-user \.account-user-only\s*\{\s*display:\s*revert\s*!important;/);
});
