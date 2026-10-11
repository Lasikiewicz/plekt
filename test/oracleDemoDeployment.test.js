import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "update-changelog.yml"), "utf8");
const manualWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "deploy-oracle-demo.yml"), "utf8");
const deployScript = fs.readFileSync(path.join(root, "scripts", "deploy-oracle-demo.sh"), "utf8");

test("main release builds an OCI-compatible image and gates the public demo deployment", () => {
  assert.match(workflow, /docker\/setup-qemu-action@v4/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /deploy-oracle-demo:/);
  assert.match(workflow, /needs: update/);
  assert.match(workflow, /secrets\.OCI_DEMO_SSH_KEY/);
  assert.match(workflow, /scripts\/deploy-oracle-demo\.sh/);
  assert.match(workflow, /scripts\/verify-oracle-demo\.js/);
});

test("public demo can be refreshed manually from an existing release image", () => {
  assert.match(manualWorkflow, /workflow_dispatch:/);
  assert.match(manualWorkflow, /release_version:/);
  assert.match(manualWorkflow, /DEPLOY_CONFIRMATION/);
  assert.match(manualWorkflow, /ghcr\.io\/lasikiewicz\/plekt:\$release_version/);
  assert.match(manualWorkflow, /scripts\/deploy-oracle-demo\.sh/);
  assert.match(manualWorkflow, /scripts\/verify-oracle-demo\.js/);
  assert.doesNotMatch(manualWorkflow, /docker\/build-push-action/);
});

test("OCI deploy helper is limited to exact GHCR releases and demo mode", () => {
  assert.match(deployScript, /Refusing an image outside the expected GHCR repository/);
  assert.match(deployScript, /--env PLEKT_DEMO_MODE=1/);
  assert.match(deployScript, /--env PLEKT_DEMO_SEED=1/);
  assert.match(deployScript, /--env BUILD_CHANNEL=main/);
  assert.match(deployScript, /--volume \"\$DATA_DIR:\/data:Z\"/);
  assert.match(deployScript, /Migrating the existing container \/data/);
  assert.match(deployScript, /--restart unless-stopped/);
  assert.match(deployScript, /Port \$HOST_PORT is already in use/);
});
