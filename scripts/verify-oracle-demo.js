import process from "node:process";

const expectedVersion = String(process.argv[2] || "").trim();
const baseUrl = String(process.argv[3] || "https://demo.plembfin.com/").trim();

if (!/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  throw new Error(`Expected a released semver as the first argument, got "${expectedVersion}"`);
}

const origin = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
const fallbackHost = process.env.OCI_DEMO_HOST
  ? new URL(`http://${process.env.OCI_DEMO_HOST}${process.env.OCI_DEMO_PORT && process.env.OCI_DEMO_PORT !== "80" ? `:${process.env.OCI_DEMO_PORT}` : ""}/`)
  : null;

async function fetchOne(targetOrigin, pathname) {
  const url = new URL(pathname, targetOrigin);
  url.searchParams.set("release", expectedVersion);
  url.searchParams.set("check", String(Date.now()));
  const response = await fetch(url, {
    headers: {
      "cache-control": "no-cache",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return response.text();
}

async function read(pathname) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await fetchOne(origin, pathname);
    } catch (err) {
      lastError = err;
      if (fallbackHost && fallbackHost.origin !== origin.origin) {
        try {
          return await fetchOne(fallbackHost, pathname);
        } catch (fallbackErr) {
          lastError = fallbackErr;
        }
      }
      if (attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
  throw lastError;
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
