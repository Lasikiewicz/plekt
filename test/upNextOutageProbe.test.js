import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-up-next-outage-probe-test-"));
process.env.DATA_DIR = dataDir;

const { upNextProvidersToProbeForOutage } = await import("../server/src/utils/liveSessionCompletion.js");

const config = {
  plex: { baseUrl: "http://plex", token: "t" },
  emby: { baseUrl: "http://emby", apiKey: "k", userId: "u" },
  jellyfin: { baseUrl: "http://jellyfin", apiKey: "k", userId: "u" },
};
const succeeded = (provider) => [
  { provider, feed_kind: "next_up", status: "succeeded" },
  { provider, feed_kind: "resume", status: "succeeded" },
];

test("defect AA: a failed sessions call re-reads a provider whose Up Next feeds still look healthy", () => {
  const feeds = [...succeeded("plex"), ...succeeded("emby"), ...succeeded("jellyfin")];
  assert.deepEqual(upNextProvidersToProbeForOutage(new Set(["jellyfin"]), config, { feeds }), ["jellyfin"]);
});

test("defect AA: no probe when the feeds are already failed, the provider is unconfigured, or nothing failed", () => {
  const feeds = [
    { provider: "jellyfin", feed_kind: "next_up", status: "failed" },
    { provider: "jellyfin", feed_kind: "resume", status: "failed" },
  ];
  assert.deepEqual(upNextProvidersToProbeForOutage(new Set(["jellyfin"]), config, { feeds }), []);
  assert.deepEqual(upNextProvidersToProbeForOutage(new Set(["emby"]), { ...config, emby: { disabled: true } }, { feeds: [] }), []);
  assert.deepEqual(upNextProvidersToProbeForOutage(new Set(), config, { feeds: [] }), []);
});

test("defect AA: one feed still succeeded is enough to probe", () => {
  const feeds = [
    { provider: "emby", feed_kind: "next_up", status: "failed" },
    { provider: "emby", feed_kind: "resume", status: "succeeded" },
  ];
  assert.deepEqual(upNextProvidersToProbeForOutage(new Set(["emby"]), config, { feeds }), ["emby"]);
});
