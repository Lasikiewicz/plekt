// Runs the application test suite. Without file arguments only test/**/*.test.js
// runs: node's default discovery would also pick up reddit-app/test, whose
// dependencies (typescript) are installed only in reddit-app, never by root npm ci.
// Named files (npm test -- test/foo.test.js) run on their own, as before.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const files = args.some((arg) => !arg.startsWith("-")) ? [] : ["test/**/*.test.js"];
const result = spawnSync(
  process.execPath,
  ["--import", "./scripts/test-data-setup.js", "--test", ...args, ...files],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
