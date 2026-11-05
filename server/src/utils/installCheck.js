import fs from "node:fs";
import path from "node:path";
import { adminDb } from "../db.js";
import { PUBLIC_DIR } from "../paths.js";
import { fetchWithTimeout } from "./outbound.js";
import { isDemoMode } from "./demoMode.js";
import { brandEnv } from "./brandEnv.js";

// The opt-in anonymous daily check that lets the maintainer count active
// installs. At most one POST per UTC day, with no identifier, token, account or
// library data. The first/week/month flags come from the date of the last check
// the collector accepted, so the collector can count new, weekly-active and
// monthly-active installs without being able to tell installs apart.
// Design and decisions: plan/active/self-hosted-usage-report/plan.md.

const SETTINGS_ID = "install_check";
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
const SEND_TIMEOUT_MS = 10_000;

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  asked: false,
  answeredAt: null,
  lastCheckDay: null,
  lastSentAt: null,
});

const selectStmt = adminDb.prepare("SELECT data FROM settings WHERE id = ?");
const upsertStmt = adminDb.prepare(
  `INSERT INTO settings (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
);

let retryAt = 0;
let sending = false;

export function readInstallCheckState() {
  const row = selectStmt.get(SETTINGS_ID);
  let stored = null;
  try {
    stored = row?.data ? JSON.parse(row.data) : null;
  } catch {
    stored = null;
  }
  return {
    enabled: stored?.enabled === true,
    asked: stored?.asked === true,
    answeredAt: Number(stored?.answeredAt) || null,
    lastCheckDay: /^\d{4}-\d{2}-\d{2}$/.test(stored?.lastCheckDay || "") ? stored.lastCheckDay : null,
    lastSentAt: Number(stored?.lastSentAt) || null,
  };
}

function writeInstallCheckState(state) {
  upsertStmt.run(SETTINGS_ID, JSON.stringify({ ...DEFAULT_STATE, ...state }), Date.now());
  return state;
}

// Only a choice the user made turns it on: ticked and answered.
export function installCheckAllowed(state = readInstallCheckState()) {
  return state.enabled === true && state.asked === true;
}

// The one-time question is for an install that has not answered yet. Closing it
// without choosing is an answer of "off".
export function installCheckNeedsAnswer(state = readInstallCheckState()) {
  return state.asked !== true;
}

export function answerInstallCheck(enabled, now = Date.now()) {
  const state = readInstallCheckState();
  retryAt = 0;
  return writeInstallCheckState({ ...state, enabled: enabled === true, asked: true, answeredAt: now });
}

// The maintainer's collector (a Cloudflare Worker, workers/install-check). Only an
// install that opted in ever contacts it. PLEKT_INSTALL_CHECK_URL points the check
// at another collector, or at "off" to send nothing from this server.
export const DEFAULT_INSTALL_CHECK_URL = "https://active.plekt.net";

export function installCheckUrl(env = process.env) {
  const value = String(brandEnv("INSTALL_CHECK_URL", env) || "").trim();
  if (!value) return DEFAULT_INSTALL_CHECK_URL;
  return /^(off|none|disabled|false|0)$/i.test(value) ? "" : value;
}

function readVersionFile(file) {
  try {
    const version = String(JSON.parse(fs.readFileSync(path.resolve(PUBLIC_DIR, "..", file), "utf8"))?.version || "").trim();
    return version || null;
  } catch {
    return null;
  }
}

export function installVersion() {
  return readVersionFile("changelog.json") || readVersionFile("changelog.alpha.json") || readVersionFile("package.json") || "unknown";
}

// "main" is the release image, "alpha" the pre-release, "develop" a development
// build. Mirrors the channel rules of /version.json and the changelog route.
export function installChannel(env = process.env, root = path.resolve(PUBLIC_DIR, "..")) {
  const envChannel = String(env.BUILD_CHANNEL || "").toLowerCase().trim();
  if (envChannel === "alpha" || envChannel === "develop") return envChannel;
  if (["release", "latest", "stable", "main"].includes(envChannel)) return "main";
  const hasRelease = fs.existsSync(path.join(root, "changelog.json"));
  if (!hasRelease && fs.existsSync(path.join(root, "changelog.alpha.json"))) return "alpha";
  if (!hasRelease && fs.existsSync(path.join(root, "changelog.develop.json"))) return "develop";
  return "main";
}

export function installArch(arch = process.arch) {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  return "other";
}

function isoWeekKey(day) {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

export function utcDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

// The whole request body. `last` is the UTC day of the last accepted check, or null.
export function installCheckBody({ last = null, today, version, channel, arch }) {
  return {
    first: last === null,
    week: last === null || isoWeekKey(last) !== isoWeekKey(today),
    month: last === null || last.slice(0, 7) !== today.slice(0, 7),
    v: version,
    channel,
    arch,
  };
}

// What would be sent now: shown in Settings so the user can inspect it.
export function previewInstallCheckBody(now = new Date(), state = readInstallCheckState()) {
  return installCheckBody({
    last: state.lastCheckDay,
    today: utcDay(now),
    version: installVersion(),
    channel: installChannel(),
    arch: installArch(),
  });
}

export function installCheckStatus(now = new Date()) {
  const state = readInstallCheckState();
  const url = installCheckUrl();
  return {
    enabled: state.enabled,
    asked: state.asked,
    needsAnswer: installCheckNeedsAnswer(state),
    lastSentAt: state.lastSentAt,
    collectorConfigured: Boolean(url),
    demo: isDemoMode(),
    developBuild: installChannel() === "develop",
    payload: previewInstallCheckBody(now, state),
  };
}

// Sends the daily check when it is due. Quiet: a failure waits an hour and
// changes nothing, and nothing here can affect sync or any other work.
export async function sendInstallCheckIfDue({ now = new Date(), fetcher = fetchWithTimeout, url = installCheckUrl() } = {}) {
  if (isDemoMode()) return { sent: false, reason: "demo" };
  const initial = readInstallCheckState();
  if (!installCheckAllowed(initial)) return { sent: false, reason: "off" };
  if (!url) return { sent: false, reason: "no-collector" };
  if (installChannel() === "develop") return { sent: false, reason: "develop-build" };
  const nowMs = new Date(now).getTime();
  if (nowMs < retryAt) return { sent: false, reason: "retry-wait" };
  if (sending) return { sent: false, reason: "in-flight" };
  sending = true;
  try {
    // Read again: the user may have turned it off while another send held the flag.
    const state = readInstallCheckState();
    const today = utcDay(now);
    if (!installCheckAllowed(state)) return { sent: false, reason: "off" };
    if (state.lastCheckDay && state.lastCheckDay >= today) return { sent: false, reason: "already-sent" };
    retryAt = nowMs + RETRY_AFTER_FAILURE_MS;
    const body = installCheckBody({
      last: state.lastCheckDay,
      today,
      version: installVersion(),
      channel: installChannel(),
      arch: installArch(),
    });
    const response = await fetcher(new URL("v1/active", url.endsWith("/") ? url : `${url}/`).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      lane: "enrichment",
    }, SEND_TIMEOUT_MS);
    if (!response?.ok) return { sent: false, reason: "failed" };
    retryAt = 0;
    writeInstallCheckState({ ...readInstallCheckState(), lastCheckDay: today, lastSentAt: nowMs });
    return { sent: true, reason: "sent", body };
  } catch {
    return { sent: false, reason: "failed" };
  } finally {
    sending = false;
  }
}

// Test hook: forget the in-memory retry wait.
export function resetInstallCheckRuntime() {
  retryAt = 0;
  sending = false;
}
