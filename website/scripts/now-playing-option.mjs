// Read or set the Dashboard Now Playing option "Allow part watched items here" through the
// app's own config API, so release captures never need a browser to flip it.
//
//   node scripts/now-playing-option.mjs                       print the saved value
//   node scripts/now-playing-option.mjs --part-watched=off    save OFF, then read it back
//   node scripts/now-playing-option.mjs --part-watched=on     save ON, then read it back
//   options: --base-url=<url>   another running app than the catalogue's
//
// The sign-in comes from PLEKT_USER and PLEKT_PASSWORD, or else from the gitignored
// .claude/local-environment.md, exactly as recapture.mjs does; it is never printed.
// Exit codes: 0 saved value matches (or was printed), 1 read-back mismatch, 2 setup or sign-in error.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSignIn } from "./lib/capture-signin.mjs";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};

const wanted = option("part-watched");
if (wanted !== null && !["on", "off"].includes(wanted)) fail("--part-watched must be on or off.");
const catalogue = JSON.parse(await fs.readFile(path.join(websiteRoot, "capture-catalogue.json"), "utf8"));
const baseUrl = (option("base-url") || catalogue.baseUrl).replace(/\/+$/, "");

let signIn;
try {
  signIn = await loadSignIn({ localEnvironmentFile: path.join(websiteRoot, "..", ".claude", "local-environment.md") });
} catch (error) {
  fail(error.message);
}

// One attempt only: the login is rate limited (10 per 15 minutes).
const login = await fetch(`${baseUrl}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: baseUrl },
  body: JSON.stringify({ username: signIn.user, password: signIn.password }),
}).catch((error) => fail(`Cannot reach ${baseUrl}: ${error.message}`));
const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
if (!login.ok || !cookie) fail(`Sign-in failed at ${baseUrl} (HTTP ${login.status}). Username from ${signIn.source} (${signIn.user.length} characters). Nothing changed.`);
const headers = { "Content-Type": "application/json", Origin: baseUrl, Cookie: cookie };

async function savedNowPlaying() {
  const response = await fetch(`${baseUrl}/api/config`, { headers });
  if (!response.ok) fail(`Reading settings failed (HTTP ${response.status}).`);
  return (await response.json()).config?.nowPlaying || {};
}

const current = await savedNowPlaying();
if (wanted === null) {
  console.log(`allowPartWatched: ${current.allowPartWatched !== false ? "on" : "off"}`);
  process.exit(0);
}

const save = await fetch(`${baseUrl}/api/config`, {
  method: "POST",
  headers,
  body: JSON.stringify({ nowPlaying: { ...current, allowPartWatched: wanted === "on" } }),
});
if (!save.ok) fail(`Saving failed (HTTP ${save.status}): ${(await save.text()).slice(0, 200)}`);

// Read back with a fresh request, the API equivalent of reloading the page.
const after = (await savedNowPlaying()).allowPartWatched !== false ? "on" : "off";
console.log(`allowPartWatched: ${after}${after === wanted ? " (saved and confirmed)" : ` (MISMATCH: wanted ${wanted})`}`);
process.exit(after === wanted ? 0 : 1);
