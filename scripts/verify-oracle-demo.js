import process from "node:process";

const expectedVersion = String(process.argv[2] || "").trim();
const baseUrl = String(process.argv[3] || "https://demo.plembfin.com/").trim();

if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`Expected a released semver as the first argument, got "${expectedVersion}"`);
}

const origin = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);

async function read(pathname) {
  const url = new URL(pathname, origin);
  url.searchParams.set("release", expectedVersion);
  url.searchParams.set("check", String(Date.now()));
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return body;
}

const changelog = JSON.parse(await read("/changelog.json"));
if (String(changelog.version || "") !== expectedVersion) {
  throw new Error(`Demo reports v${changelog.version || "unknown"}; expected v${expectedVersion}`);
}

const ping = JSON.parse(await read("/api/ping"));
if (ping.ok !== true) {
  throw new Error("Demo health endpoint did not report ok=true");
}

const page = await read("/");
if (!/Public demo/i.test(page)) {
  throw new Error("Demo homepage does not contain the public-demo guardrail");
}

console.log(`Verified ${origin.origin} is healthy and serving Plekt v${expectedVersion}.`);
