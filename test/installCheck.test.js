import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-install-check-");

const {
  installCheckBody,
  installChannel,
  installArch,
  readInstallCheckState,
  answerInstallCheck,
  installCheckStatus,
  installCheckUrl,
  sendInstallCheckIfDue,
  resetInstallCheckRuntime,
} = await import("../server/src/utils/installCheck.js");
const { adminDb } = await import("../server/src/db.js");

const URL_BASE = "https://collector.test/";
const ok = () => Promise.resolve({ ok: true, status: 204 });

function reset() {
  adminDb.prepare("DELETE FROM settings WHERE id = 'install_check'").run();
  resetInstallCheckRuntime();
}

function recorder(response = ok) {
  const calls = [];
  const fetcher = async (url, options, timeout) => {
    calls.push({ url, options, timeout, body: JSON.parse(options.body) });
    return response();
  };
  return { calls, fetcher };
}

test("body flags: never checked is first, week and month", () => {
  const body = installCheckBody({ last: null, today: "2026-11-04", version: "2.2.3", channel: "main", arch: "amd64" });
  assert.deepEqual(body, { first: true, week: true, month: true, v: "2.2.3", channel: "main", arch: "amd64" });
});

test("body flags: same day-range gives week and month false", () => {
  const body = installCheckBody({ last: "2026-11-03", today: "2026-11-04", version: "2.2.3", channel: "main", arch: "amd64" });
  assert.equal(body.first, false);
  assert.equal(body.week, false);
  assert.equal(body.month, false);
});

test("body flags: a new ISO week and a new month are detected", () => {
  // Sunday 1 November 2026 is ISO week 44; Monday 2 November starts week 45.
  const week = installCheckBody({ last: "2026-11-01", today: "2026-11-02", version: "1", channel: "main", arch: "amd64" });
  assert.equal(week.week, true);
  assert.equal(week.month, false);
  const month = installCheckBody({ last: "2026-10-31", today: "2026-11-01", version: "1", channel: "main", arch: "amd64" });
  assert.equal(month.month, true);
  assert.equal(month.week, false);
});

test("body flags: the ISO week rolls across a year end", () => {
  // 31 December 2026 (Thursday) and 1 January 2027 (Friday) are both ISO week 53 of 2026.
  const body = installCheckBody({ last: "2026-12-31", today: "2027-01-01", version: "1", channel: "main", arch: "amd64" });
  assert.equal(body.week, false);
  assert.equal(body.month, true);
});

test("body carries only the agreed fields", () => {
  const body = installCheckBody({ last: null, today: "2026-11-04", version: "2.2.3", channel: "alpha", arch: "arm64" });
  assert.deepEqual(Object.keys(body).sort(), ["arch", "channel", "first", "month", "v", "week"]);
});

test("channel and arch are normalised", () => {
  assert.equal(installChannel({ BUILD_CHANNEL: "stable" }), "main");
  assert.equal(installChannel({ BUILD_CHANNEL: "Alpha" }), "alpha");
  assert.equal(installChannel({ BUILD_CHANNEL: "develop" }), "develop");
  assert.equal(installArch("x64"), "amd64");
  assert.equal(installArch("arm64"), "arm64");
  assert.equal(installArch("riscv64"), "other");
});

test("a fresh install is unanswered and off", () => {
  reset();
  const status = installCheckStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.needsAnswer, true);
});

test("a stored choice of on reads on for main, alpha and develop builds", () => {
  reset();
  answerInstallCheck(true);
  const previous = process.env.BUILD_CHANNEL;
  try {
    for (const channel of ["main", "alpha", "develop"]) {
      process.env.BUILD_CHANNEL = channel;
      const status = installCheckStatus();
      assert.equal(status.enabled, true, channel);
      assert.equal(status.payload.channel, channel);
    }
  } finally {
    if (previous === undefined) delete process.env.BUILD_CHANNEL;
    else process.env.BUILD_CHANNEL = previous;
  }
});

test("nothing is sent before the user answers or after they decline", async () => {
  reset();
  const { calls, fetcher } = recorder();
  assert.equal((await sendInstallCheckIfDue({ fetcher, url: URL_BASE })).reason, "off");
  answerInstallCheck(false);
  assert.equal((await sendInstallCheckIfDue({ fetcher, url: URL_BASE })).reason, "off");
  assert.equal(readInstallCheckState().asked, true);
  assert.equal(installCheckStatus().needsAnswer, false);
  assert.equal(calls.length, 0);
});

test("nothing is sent when no collector is configured", async () => {
  reset();
  answerInstallCheck(true);
  const { calls, fetcher } = recorder();
  assert.equal((await sendInstallCheckIfDue({ fetcher, url: "" })).reason, "no-collector");
  assert.equal(calls.length, 0);
});

test("the collector defaults to active.plekt.net and the env var overrides or turns it off", () => {
  assert.equal(installCheckUrl({}), "https://active.plekt.net");
  assert.equal(installCheckUrl({ PLEKT_INSTALL_CHECK_URL: "  " }), "https://active.plekt.net");
  assert.equal(installCheckUrl({ PLEKT_INSTALL_CHECK_URL: "https://example.test/c" }), "https://example.test/c");
  assert.equal(installCheckUrl({ PLEMBFIN_INSTALL_CHECK_URL: "off" }), "");
  assert.equal(installCheckUrl({ PLEKT_INSTALL_CHECK_URL: "OFF" }), "");
});

test("opt-in sends one check per UTC day to /v1/active", async () => {
  reset();
  answerInstallCheck(true);
  const { calls, fetcher } = recorder();
  const day1 = new Date("2026-11-04T09:00:00Z");

  const first = await sendInstallCheckIfDue({ now: day1, fetcher, url: URL_BASE });
  assert.equal(first.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://collector.test/v1/active");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].body.first, true);
  assert.equal(readInstallCheckState().lastCheckDay, "2026-11-04");

  const again = await sendInstallCheckIfDue({ now: new Date("2026-11-04T20:00:00Z"), fetcher, url: URL_BASE });
  assert.equal(again.reason, "already-sent");
  assert.equal(calls.length, 1);

  const next = await sendInstallCheckIfDue({ now: new Date("2026-11-05T00:01:00Z"), fetcher, url: URL_BASE });
  assert.equal(next.sent, true);
  assert.equal(calls[1].body.first, false);
  assert.equal(calls[1].body.week, false);
});

test("a failed send waits an hour and keeps the flags as they were", async () => {
  reset();
  answerInstallCheck(true);
  const failing = recorder(() => Promise.resolve({ ok: false, status: 500 }));
  const start = new Date("2026-11-04T09:00:00Z");

  assert.equal((await sendInstallCheckIfDue({ now: start, fetcher: failing.fetcher, url: URL_BASE })).reason, "failed");
  assert.equal(readInstallCheckState().lastCheckDay, null);

  const waiting = await sendInstallCheckIfDue({ now: new Date(start.getTime() + 30 * 60_000), fetcher: failing.fetcher, url: URL_BASE });
  assert.equal(waiting.reason, "retry-wait");
  assert.equal(failing.calls.length, 1);

  const good = recorder();
  const retry = await sendInstallCheckIfDue({ now: new Date(start.getTime() + 61 * 60_000), fetcher: good.fetcher, url: URL_BASE });
  assert.equal(retry.sent, true);
  assert.equal(good.calls[0].body.first, true);
});

test("a thrown request is swallowed", async () => {
  reset();
  answerInstallCheck(true);
  const fetcher = async () => { throw new Error("network down"); };
  const result = await sendInstallCheckIfDue({ now: new Date("2026-11-04T09:00:00Z"), fetcher, url: URL_BASE });
  assert.deepEqual({ sent: result.sent, reason: result.reason }, { sent: false, reason: "failed" });
});

test("turning it off stops further checks and keeps the last day", async () => {
  reset();
  answerInstallCheck(true);
  const { calls, fetcher } = recorder();
  await sendInstallCheckIfDue({ now: new Date("2026-11-04T09:00:00Z"), fetcher, url: URL_BASE });
  answerInstallCheck(false);
  assert.equal((await sendInstallCheckIfDue({ now: new Date("2026-11-06T09:00:00Z"), fetcher, url: URL_BASE })).reason, "off");
  assert.equal(calls.length, 1);
  assert.equal(readInstallCheckState().lastCheckDay, "2026-11-04");
});

test("a develop build sends once a day like any other channel", async () => {
  reset();
  answerInstallCheck(true);
  const previous = process.env.BUILD_CHANNEL;
  process.env.BUILD_CHANNEL = "develop";
  try {
    const { calls, fetcher } = recorder();
    const result = await sendInstallCheckIfDue({ fetcher, url: URL_BASE });
    assert.equal(result.reason, "sent");
    assert.equal(result.body.channel, "develop");
    assert.equal(calls.length, 1);
  } finally {
    if (previous === undefined) delete process.env.BUILD_CHANNEL;
    else process.env.BUILD_CHANNEL = previous;
  }
});
