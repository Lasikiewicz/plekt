import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function rollForwardTodo(input, released) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(released);
  if (!match) throw new Error("Expected a released version in major.minor.patch format.");
  const [, major, minor, patch] = match.map(Number);
  const nextRelease = `${major}.${minor + 1}.0`;
  const nextHotfix = `${major}.${minor}.${patch + 1}`;
  const sections = input.split(/(?=^## )/m);
  const releaseIndex = sections.findIndex((s) => /^## Release: v[^\n]+ \(Expected\)/.test(s));
  const postIndex = sections.findIndex((s) => /^## Post Release \(v[^\n]+\)/.test(s));
  if (releaseIndex < 0 || postIndex < 0) throw new Error("TODO needs one Release and one Post Release section.");
  const compare = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  };
  const target = nextRelease;
  sections[releaseIndex] = sections[releaseIndex].replace(/^## Release: v[^\n]+ \(Expected\)/, `## Release: v${target} (Expected)`);
  const hotfixIndex = sections.findIndex((s) => /^## Hotfix: v[^\n]+ \(Expected\)/.test(s));
  if (hotfixIndex >= 0) sections[hotfixIndex] = sections[hotfixIndex].replace(/^## Hotfix: v[^\n]+ \(Expected\)/, `## Hotfix: v${nextHotfix} (Expected)`);
  const postVersion = sections[postIndex].match(/^## Post Release \(v(\d+\.\d+\.\d+)\)/)?.[1];
  if (!postVersion) throw new Error("Post Release heading needs a major.minor.patch version.");
  const postHasEntries = /^- \[[ x-]\] /m.test(sections[postIndex]);
  const postFirst = postHasEntries && compare(postVersion, target) < 0;
  if ((postIndex < releaseIndex) !== postFirst) {
    const [post] = sections.splice(postIndex, 1);
    const releasePosition = sections.findIndex((s) => /^## Release: /.test(s));
    sections.splice(releasePosition + (postFirst ? 0 : 1), 0, post);
  }
  return sections.join("");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const todo = path.join(root, "todo.md");
  if (!fs.existsSync(todo)) console.log("No local todo.md; nothing to roll forward.");
  else {
    try {
      const released = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
      const input = fs.readFileSync(todo, "utf8");
      const output = rollForwardTodo(input, released);
      if (output !== input) fs.writeFileSync(todo, output);
      console.log(`TODO rolled forward after v${released}.`);
    } catch (error) { console.error(`Cannot roll forward TODO: ${error.message}`); process.exitCode = 1; }
  }
}
