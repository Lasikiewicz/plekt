import test from "node:test";
import assert from "node:assert/strict";
import { rollForwardTodo } from "../scripts/roll-forward-todo.mjs";

const todo = `# Plekt TODO\n\n## Hotfix: v2.3.1 (Expected)\n\n### Work in Progress\n\n- [ ] fix\n\n## Release: v2.3.0 (Expected)\n\n### Work in Progress\n\n- [ ] feature\n\n### Not Started\n\n## Post Release (v2.3.0)\n\n- [ ] announce\n\n## Future Release\n`;

test("a published minor release advances the backlog without losing entries", () => {
  const result = rollForwardTodo(todo, "2.3.0");
  assert.match(result, /Hotfix: v2\.3\.1 \(Expected\)/);
  assert.match(result, /Release: v2\.4\.0 \(Expected\)/);
  assert.ok(result.indexOf("## Post Release") < result.indexOf("## Release:"));
  for (const item of ["fix", "feature", "announce"]) assert.ok(result.includes(`- [ ] ${item}`));
  assert.equal(rollForwardTodo(result, "2.3.0"), result);
});

test("a hotfix advances its patch without moving the next feature release", () => {
  const result = rollForwardTodo(rollForwardTodo(todo, "2.3.0"), "2.3.1");
  assert.match(result, /Hotfix: v2\.3\.2 \(Expected\)/);
  assert.match(result, /Release: v2\.4\.0 \(Expected\)/);
});

test("later releases advance the minor version and invalid input fails", () => {
  assert.match(rollForwardTodo(todo, "2.4.0"), /Release: v2\.5\.0 \(Expected\)/);
  assert.throws(() => rollForwardTodo(todo, "not-a-version"));
  assert.throws(() => rollForwardTodo("# no sections\n", "2.3.0"));
});
