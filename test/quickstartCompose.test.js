import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quickstart = fs.readFileSync(path.join(root, "docker-compose.quickstart.yml"), "utf8");

test("default compose matches quick-start and local builds use the dev overlay", () => {
  const base = fs.readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const dev = fs.readFileSync(path.join(root, "docker-compose.dev.yml"), "utf8");
  assert.equal(base.replace(/\r\n/g, "\n"), quickstart.replace(/\r\n/g, "\n"));
  assert.match(dev, /^\s+build: \.$/m);
  assert.match(dev, /^\s+image: plekt:dev$/m);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(readme.includes("docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build"));
});

test("quick-start compose pulls the published image and never builds locally", () => {
  assert.match(quickstart, /^\s+image: ghcr\.io\/lasikiewicz\/plekt:latest$/m);
  assert.doesNotMatch(quickstart, /^\s+build:/m);
});

test("quick-start compose requires ADMIN_PASSWORD from .env and never ships a default", () => {
  assert.match(quickstart, /ADMIN_PASSWORD: "\$\{ADMIN_PASSWORD:\?[^"}]+\}"/);
});

test("README quick-start snippet matches docker-compose.quickstart.yml exactly", () => {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(
    readme.includes("```yaml\n" + quickstart + "```"),
    "README Method A must embed docker-compose.quickstart.yml verbatim",
  );
});
