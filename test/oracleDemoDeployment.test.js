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
  assert.match(manualWorkflow, /ghcr\.io\/lasikiewicz\/plekt:\$release_version-demo/);
  assert.match(manualWorkflow, /scripts\/deploy-oracle-demo\.sh/);
  assert.match(manualWorkflow, /scripts\/verify-oracle-demo\.js/);
  assert.doesNotMatch(manualWorkflow, /docker\/build-push-action/);
});

test("public demo gets its artwork from a demo layer built on the released tag", () => {
  const dockerfile = fs.readFileSync(path.join(root, "packaging", "demo-image", "Dockerfile"), "utf8");
  const ignore = fs.readFileSync(path.join(root, "packaging", "demo-image", "Dockerfile.dockerignore"), "utf8");
  const rootIgnore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
  const publish = fs.readFileSync(path.join(root, ".github", "workflows", "docker-publish.yml"), "utf8");
  assert.match(dockerfile, /^FROM \$\{BASE_IMAGE\}$/m);
  assert.match(dockerfile, /COPY .*public\/demo-assets/);
  assert.match(ignore, /^!public\/demo-assets$/m);
  assert.match(rootIgnore, /^public\/demo-assets$/m);
  for (const text of [workflow, publish]) {
    assert.match(text, /file: packaging\/demo-image\/Dockerfile/);
    assert.match(text, /IMAGE_NAME \}\}:\$\{\{ steps\.(release|version)\.outputs\.version \}\}-demo/);
  }
  assert.match(workflow, /RELEASE_IMAGE: ghcr\.io\/lasikiewicz\/plekt:\$\{\{ needs\.update\.outputs\.version \}\}-demo/);
  assert.match(workflow, /verify-oracle-demo\.js "\$RELEASE_VERSION"/);
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
