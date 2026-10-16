import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const captureRoot = path.join(websiteRoot, "public", "assets", "app-captures");
const requiredCaptures = [
  "dashboard-dark.png",
  "dashboard-light.png",
  "dashboard-home-dark.png",
  "dashboard-home-light.png",
  "now-playing-dark.png",
  "now-playing-light.png",
  "discover-dark.png",
  "discover-light.png",
  "watchlist-dark.png",
  "watchlist-light.png",
  "ratings-dark.png",
  "ratings-light.png",
  "playlists-dark.png",
  "playlists-light.png",
  "tvshows-dark.png",
  "tvshows-light.png",
  "sync-activity-focused-dark.png",
  "sync-activity-focused-light.png",
];
// Full dashboard frames are taken at the approved 1396x950 viewport (v2.1.0 Force to main).
const maxHeights = { "dashboard-dark.png": 950, "dashboard-light.png": 950 };
const failures = [];

function readPngDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

for (const fileName of requiredCaptures) {
  const filePath = path.join(captureRoot, fileName);
  if (!fs.existsSync(filePath)) {
    failures.push(`missing capture ${fileName}`);
    continue;
  }

  const dimensions = readPngDimensions(filePath);
  if (!dimensions) {
    failures.push(`${fileName} is not a PNG capture`);
  } else if (dimensions.width > 1440 || dimensions.height > (maxHeights[fileName] ?? 780)) {
    failures.push(`${fileName} is ${dimensions.width}x${dimensions.height}; rebuild it without the app footer/build label`);
  }
}

if (failures.length) {
  console.error(`Capture asset check failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Capture asset check passed (${requiredCaptures.length} theme-safe captures).`);
}
