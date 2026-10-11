import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const assetsRoot = path.join(websiteRoot, "public", "assets");

const copies = [
  ["public/plekt_header_logo_dark.png", "plembfin_header_logo_dark.png"],
  ["public/plekt_header_logo_light.png", "plembfin_header_logo_light.png"],
  ["public/favicon.svg", "favicon.svg"],
  ["docs/plembfin-hub.svg", "plembfin-hub.svg"],
];

for (const [source, destination] of copies) {
  const sourcePath = path.join(repositoryRoot, source);
  const destinationPath = path.join(assetsRoot, destination);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

const legacyScreenshotsPath = path.join(assetsRoot, "screenshots");
if (fs.existsSync(legacyScreenshotsPath)) fs.rmSync(legacyScreenshotsPath, { recursive: true, force: true });

const directories = [["public/icons", "icons"]];

for (const [source, destination] of directories) {
  fs.cpSync(path.join(repositoryRoot, source), path.join(assetsRoot, destination), { recursive: true });
}

console.log("Synchronized Plembfin logo, diagram, screenshots, and provider icons.");
