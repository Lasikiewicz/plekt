import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validatePlanLayout, checkPlanLayouts } from "../scripts/plan-layout.js";

const valid = `# Example plan

## Steps
- [ ] [Step 1](active/example/step1.md)

## Where we are
Implementation is underway; the focused checks remain to be run.

---

## Background and history
[History](history.md)

Last updated: 23 October 2026
`;

test("accepts a concise summary with a history link", () => {
  const result = validatePlanLayout(valid, { file: path.join("plan", "example.md"), exists: () => true });
  assert.deepEqual(result, []);
});

test("reports section order, length, journal style, and inline history violations", () => {
  const bad = `## Where we are\n\n${"word ".repeat(121)}\n\n- old note\n\n## Steps\n\n## Background and history\nA long inline dated history entry.`;
  const errors = validatePlanLayout(bad, { file: path.join("plan", "x.md") });
  assert(errors.some((error) => error.includes('"Steps" must come before')));
  assert(errors.some((error) => error.includes("maximum is 120")));
  assert(errors.some((error) => error.includes("one concise paragraph")));
  assert(errors.some((error) => error.includes("only one Markdown link line")));
});

test("reports a missing history target", () => {
  const errors = validatePlanLayout(valid, { file: path.join("plan", "x.md"), exists: () => false });
  assert(errors.some((error) => error.includes("history.md link target does not exist")));
});

test("requires status and history sections and rejects clipped status", () => {
  assert.equal(validatePlanLayout("# Empty summary").length, 2);
  const clipped = valid.replace("Implementation is underway; the focused checks remain to be run.", "Previous status was copied and clipped…");
  assert(validatePlanLayout(clipped, { exists: () => true }).some((error) => error.includes("clipped source text")));
  assert(validatePlanLayout(valid + "\n## Where we are\nOld journal\n", { exists: () => true }).some((error) => error.includes("duplicate summary section")));
});

test("ignores heading-like text inside fenced code", () => {
  const markdown = `${valid}\n\n\`\`\`md\n## Where we are\n${"x".repeat(1200)}\n## Background and history\ninline notes\n\`\`\`\n`;
  assert.deepEqual(validatePlanLayout(markdown, { file: path.join("plan", "example.md"), exists: () => true }), []);
});

test("scans root summaries and archived summary files, and skips when plan is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan-layout-"));
  try {
    const plan = path.join(root, "plan");
    fs.mkdirSync(path.join(plan, "archive", "old"), { recursive: true });
    fs.writeFileSync(path.join(plan, "example.md"), valid);
    fs.writeFileSync(path.join(plan, "README.md"), "invalid");
    fs.writeFileSync(path.join(plan, "archive", "old", "summary.md"), valid);
    const errors = checkPlanLayouts(root);
    assert.equal(errors.filter((error) => error.includes("link target does not exist")).length, 2);
    assert.deepEqual(checkPlanLayouts(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
