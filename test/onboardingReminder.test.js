import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const index = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public/modules/onboarding.js"), "utf8");
const dashboard = fs.readFileSync(path.join(root, "public/modules/dashboard.js"), "utf8");

test("setup tasks use a compact Finish Setup reminder above Sync - Idle", () => {
  const sidebarFooter = index.indexOf('<div class="sidebar-footer">');
  const reminder = index.indexOf('id="sidebarOnboardingCta"');
  const syncIdle = index.indexOf('id="syncProgressIndicator"');
  assert.ok(sidebarFooter >= 0);
  assert.ok(reminder > sidebarFooter && reminder < syncIdle);
  assert.match(index, /id="sidebarOnboardingButton"[^>]*>Finish Setup<\/button>/);
  assert.match(index, /id="sidebarOnboardingDismiss"[^>]*aria-label="Dismiss Finish Setup reminder"/);
  assert.doesNotMatch(index, /id="dashboardChecklist"/);
  assert.doesNotMatch(dashboard, /renderDashboardChecklist|dashboardChecklist/);
});

test("Finish Setup only appears while tasks remain and dismisses without confirmation", () => {
  assert.match(app, /const hasSetupTasks = Array\.isArray\(cachedStatus\.checklist\) && cachedStatus\.checklist\.length > 0;/);
  assert.match(app, /container\.classList\.toggle\("hidden", !hasSetupTasks \|\| dismissed\);/);
  assert.match(app, /const onboardingCtaButton = event\.target\.closest\("#sidebarOnboardingButton"\);[\s\S]*?navigateTo\("\/setup"\);/);
  assert.match(app, /const onboardingCtaDismiss = event\.target\.closest\("#sidebarOnboardingDismiss"\);[\s\S]*?api\("\/api\/setup\/checklist\/dismiss", \{ method: "POST" \}\)/);
  assert.doesNotMatch(app, /Dismiss onboarding reminder\?/);
});
