import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseLocalEnvironment, loadSignIn } from "./capture-signin.mjs";

const sample = "# Local\n\n- Plekt local server: http://localhost:5056/\n- Username = admin (lowercase)\n- Password = s3cret!x\n";

test("takes only the first token, so a trailing note is not part of the username", () => {
  assert.deepEqual(parseLocalEnvironment(sample), { user: "admin", password: "s3cret!x" });
});

test("missing lines give nulls", () => {
  assert.deepEqual(parseLocalEnvironment("- Username: admin\n"), { user: null, password: null });
});

test("environment variables take precedence over the file", async () => {
  const signIn = await loadSignIn({ env: { PLEKT_USER: "u", PLEKT_PASSWORD: "p" }, localEnvironmentFile: "/nonexistent" });
  assert.deepEqual([signIn.user, signIn.password], ["u", "p"]);
});

test("falls back to the local environment file when the variables are incomplete", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-signin-"));
  const file = path.join(dir, "local-environment.md");
  await fs.writeFile(file, sample);
  const signIn = await loadSignIn({ env: { PLEKT_USER: "only-user" }, localEnvironmentFile: file });
  assert.deepEqual([signIn.user, signIn.password, signIn.source], ["admin", "s3cret!x", file]);
});

test("missing file and missing lines fail with a clear message", async () => {
  await assert.rejects(loadSignIn({ env: {}, localEnvironmentFile: "/nonexistent/x.md" }), /cannot be read/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capture-signin-"));
  const file = path.join(dir, "local-environment.md");
  await fs.writeFile(file, "- Username = admin\n");
  await assert.rejects(loadSignIn({ env: {}, localEnvironmentFile: file }), /has no/);
});
