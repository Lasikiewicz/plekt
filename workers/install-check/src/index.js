// Plekt install-check collector: a Cloudflare Worker that counts the opt-in
// anonymous daily check sent by Plekt installs. It keeps daily counters only.
// It never reads, stores or logs an IP address, header or request body, and it
// has no per-request or per-install record of any kind.
// Design: plan/active/self-hosted-usage-report/plan.md (Data contract).

const MAX_BODY_BYTES = 512;
const RETENTION_DAYS = 90;
const MAX_VERSIONS_PER_DAY = 40;
const BODY_KEYS = ["arch", "channel", "first", "month", "v", "week"];
const CHANNELS = new Set(["main", "alpha", "develop"]);
const ARCHS = new Set(["amd64", "arm64", "other"]);
const VERSION_PATTERN = /^(?:unknown|\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.]{1,16})?)$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function reply(status, body = null, extraHeaders = {}) {
  if (body === null) return new Response(null, { status, headers: { "cache-control": "no-store", ...extraHeaders } });
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export function utcDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

function validDay(value) {
  if (!DAY_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Returns the cleaned body, or null for anything that is not exactly the
// documented shape: six keys, three booleans, and bounded strings.
export function parseCheckBody(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((key, index) => key !== BODY_KEYS[index])) return null;
  if (typeof value.first !== "boolean" || typeof value.week !== "boolean" || typeof value.month !== "boolean") return null;
  if (typeof value.v !== "string" || value.v.length > 32 || !VERSION_PATTERN.test(value.v)) return null;
  if (typeof value.channel !== "string" || !CHANNELS.has(value.channel)) return null;
  if (typeof value.arch !== "string" || !ARCHS.has(value.arch)) return null;
  return { first: value.first, week: value.week, month: value.month, v: value.v, channel: value.channel, arch: value.arch };
}

// Reads at most MAX_BODY_BYTES; returns null when the body is larger.
async function readCappedBody(request) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Constant-time comparison of two secrets by comparing their SHA-256 digests.
async function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

const INCREMENT_SQL =
  "INSERT INTO counter (day, name, n) VALUES (?, ?, 1) ON CONFLICT(day, name) DO UPDATE SET n = n + 1";

async function recordCheck(db, day, body) {
  const known = await db.prepare("SELECT name FROM counter WHERE day = ? AND name LIKE 'v:%'").bind(day).all();
  const versions = new Set((known.results || []).map((row) => row.name));
  let versionName = `v:${body.v}`;
  if (!versions.has(versionName) && versions.size >= MAX_VERSIONS_PER_DAY) versionName = "v:other";
  const names = ["checks", versionName, `channel:${body.channel}`, `arch:${body.arch}`];
  if (body.first) names.push("new");
  if (body.week) names.push("week");
  if (body.month) names.push("month");
  await db.batch(names.map((name) => db.prepare(INCREMENT_SQL).bind(day, name)));
}

export async function readDay(db, day) {
  const rows = await db.prepare("SELECT name, n FROM counter WHERE day = ?").bind(day).all();
  const stats = { date: day, checks: 0, new: 0, week: 0, month: 0, versions: {}, channels: {}, archs: {} };
  for (const row of rows.results || []) {
    if (row.name === "checks" || row.name === "new" || row.name === "week" || row.name === "month") stats[row.name] = row.n;
    else if (row.name.startsWith("v:")) stats.versions[row.name.slice(2)] = row.n;
    else if (row.name.startsWith("channel:")) stats.channels[row.name.slice(8)] = row.n;
    else if (row.name.startsWith("arch:")) stats.archs[row.name.slice(5)] = row.n;
  }
  return stats;
}

export async function pruneOldDays(db, now = new Date()) {
  const cutoff = utcDay(new Date(new Date(now).getTime() - RETENTION_DAYS * 86_400_000));
  await db.prepare("DELETE FROM counter WHERE day < ?").bind(cutoff).run();
  return cutoff;
}

async function handleActive(request, env, now) {
  if (request.method !== "POST") return reply(405, { error: "method not allowed" }, { allow: "POST" });
  if (!String(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
    return reply(415, { error: "expected application/json" });
  }
  const text = await readCappedBody(request);
  if (text === null) return reply(413, { error: "body too large" });
  const body = parseCheckBody(text);
  if (!body) return reply(400, { error: "invalid body" });
  await recordCheck(env.DB, utcDay(now), body);
  return reply(204);
}

async function handleStats(request, env, url, now) {
  if (request.method !== "GET") return reply(405, { error: "method not allowed" }, { allow: "GET" });
  const header = request.headers.get("authorization") || "";
  const given = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!(await tokenMatches(given, env.READ_TOKEN))) {
    return reply(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  const day = url.searchParams.get("date") || utcDay(now);
  if (!validDay(day)) return reply(400, { error: "date must be YYYY-MM-DD" });
  return reply(200, await readDay(env.DB, day));
}

export async function handleRequest(request, env, now = new Date()) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/active") return handleActive(request, env, now);
  if (url.pathname === "/v1/stats") return handleStats(request, env, url, now);
  return reply(404, { error: "not found" });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return reply(500, { error: "internal error" });
    }
  },
  async scheduled(_event, env) {
    await pruneOldDays(env.DB);
  },
};
