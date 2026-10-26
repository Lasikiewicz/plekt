import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const composePath = path.join(repositoryRoot, "docker-compose.quickstart.yml");
const outputPath = path.join(websiteRoot, "src", "generated", "quickstart.js");
const compose = fs.readFileSync(composePath, "utf8").trimEnd();
const hostPort = compose.match(/^\s+-\s+["']?(\d+):\d+["']?\s*$/m)?.[1];

if (!hostPort) throw new Error("Could not read the published host port from docker-compose.quickstart.yml");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `// Generated from docker-compose.quickstart.yml. Do not edit by hand.\nexport const quickstartCompose = ${JSON.stringify(compose)};\nexport const quickstartHostPort = ${JSON.stringify(hostPort)};\n`,
);

console.log("Generated the website quickstart from docker-compose.quickstart.yml.");
