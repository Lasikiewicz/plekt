import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { quickstartCompose, quickstartHostPort } from "../../src/generated/quickstart.js";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const composeSource = fs.readFileSync(path.join(repositoryRoot, "docker-compose.quickstart.yml"), "utf8").trimEnd();
const readme = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
const methodA = readme.split("### Method A: Docker Compose (recommended)")[1]?.split("\n### ")[0] || "";
const readmeCompose = methodA.match(/```yaml\r?\n([\s\S]*?)\r?\n```/)?.[1];

test("homepage and README quickstart stay in sync with docker-compose.quickstart.yml", () => {
  assert.ok(readmeCompose, "README.md must include the Method A Compose example");
  assert.equal(quickstartCompose, composeSource, "the homepage snippet must read the shared Compose file");
  assert.equal(readmeCompose.trimEnd(), composeSource, "the README Compose example has drifted from docker-compose.quickstart.yml");
});

test("homepage quickstart derives its local URL port from the published Compose port", () => {
  const expectedHostPort = composeSource.match(/^\s+-\s+["']?(\d+):\d+["']?\s*$/m)?.[1];
  assert.ok(expectedHostPort, "docker-compose.quickstart.yml must publish a host port");
  assert.equal(quickstartHostPort, expectedHostPort);
});
