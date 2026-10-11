import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.join(here, "..", "server", "src", "utils", "processErrorHandlers.js")).href;

function runChild(body) {
  const script = `
    const { installProcessErrorHandlers } = await import(${JSON.stringify(moduleUrl)});
    installProcessErrorHandlers({ flush: () => {} });
    ${body}
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
}

test("an unhandled rejection is logged and the process keeps running", () => {
  const result = runChild(`
    Promise.reject(new Error("stray rejection"));
    setTimeout(() => console.log("still alive"), 100);
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still alive/);
  assert.match(result.stderr, /Unhandled promise rejection/);
  assert.match(result.stderr, /stray rejection/);
});

test("an uncaught exception is logged and the process exits non-zero", () => {
  const result = runChild(`
    setTimeout(() => { throw new Error("boom"); }, 0);
    setTimeout(() => console.log("should not run"), 200);
  `);

  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /should not run/);
  assert.match(result.stderr, /Uncaught exception - exiting/);
  assert.match(result.stderr, /boom/);
});
