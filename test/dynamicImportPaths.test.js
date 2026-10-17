import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dynamic import() paths are only checked at runtime, so a wrong relative path
// (for example ./utils/x.js from inside utils/) sits unnoticed until that branch
// runs. This resolves every relative dynamic import under server/src.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server", "src");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

test("every relative dynamic import under server/src resolves to a file", () => {
  const missing = [];
  let checked = 0;
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      checked += 1;
      const target = path.resolve(path.dirname(file), match[1]);
      if (!fs.existsSync(target)) {
        missing.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
  }
  assert.ok(checked > 0, "expected to find dynamic imports under server/src");
  assert.deepEqual(missing, []);
});
