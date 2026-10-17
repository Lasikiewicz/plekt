import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const changelogPath = resolve(process.cwd(), "..", "changelog.json");
const outputPath = resolve(process.cwd(), "src/generated/release.json");
const changelog = JSON.parse(await readFile(changelogPath, "utf8"));
const entry = Array.isArray(changelog.entries) ? changelog.entries[0] : undefined;
if (!entry || entry.version !== changelog.version || !/^\d+\.\d+\.\d+$/.test(entry.version) ||
    typeof entry.date !== "string" || typeof entry.message !== "string" ||
    !Array.isArray(entry.details) || !entry.details.every((bullet) => typeof bullet === "string")) {
  throw new Error("changelog.json has no valid current release entry");
}

const bundled = { version: entry.version, date: entry.date, summary: entry.message, bullets: entry.details };
await mkdir(resolve(process.cwd(), "src/generated"), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(bundled, null, 2)}\n`);
console.log(`Bundled Plekt v${bundled.version} (${bundled.date.slice(0, 10)})`);
