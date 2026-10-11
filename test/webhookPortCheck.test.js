import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plembfin-webhook-port-check-");
const { portFromUri, publishedPortFromEnv, buildWebhookPortFindings } = await import("../server/src/utils/webhookPortCheck.js");

test("portFromUri reads the explicit port with and without a token query", () => {
  assert.equal(portFromUri("http://plekt.local:5055/webhook/abc"), 5055);
  assert.equal(portFromUri("http://plekt.local:5056/api/webhook?token=secret"), 5056);
});

test("portFromUri falls back to the scheme default and rejects bad input", () => {
  assert.equal(portFromUri("http://plekt.local/webhook"), 80);
  assert.equal(portFromUri("https://plekt.example.com/webhook"), 443);
  assert.equal(portFromUri("not a url"), null);
});

test("publishedPortFromEnv reads PLEKT_PUBLISHED_PORT and the legacy name", () => {
  assert.equal(publishedPortFromEnv({ PLEKT_PUBLISHED_PORT: "5056" }), 5056);
  assert.equal(publishedPortFromEnv({ PLEMBFIN_PUBLISHED_PORT: "5056" }), 5056);
  assert.equal(publishedPortFromEnv({}), null);
  assert.equal(publishedPortFromEnv({ PLEKT_PUBLISHED_PORT: "abc" }), null);
  assert.equal(publishedPortFromEnv({ PLEKT_PUBLISHED_PORT: "70000" }), null);
});

test("unset PUBLISHED_PORT reports that the port cannot be checked", () => {
  const findings = buildWebhookPortFindings({
    publishedPort: null,
    jellyfinDestinations: [{ name: "Plekt", uri: "http://plekt.local:5055/webhook" }],
  });
  assert.deepEqual(findings.map((finding) => finding.kind), ["port_unknown"]);
});

test("a Jellyfin webhook on the published port produces no finding", () => {
  const findings = buildWebhookPortFindings({
    publishedPort: 5056,
    jellyfinDestinations: [{ name: "Plekt", uri: "http://plekt.local:5056/webhook?token=x" }],
  });
  assert.deepEqual(findings, []);
});

test("a Jellyfin webhook on another port produces a wrong_port finding without the token", () => {
  const findings = buildWebhookPortFindings({
    publishedPort: 5056,
    jellyfinDestinations: [{ name: "Plekt", uri: "http://plekt.local:5055/webhook?token=secret" }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "wrong_port");
  assert.equal(findings[0].webhookPort, 5055);
  assert.equal(findings[0].expectedPort, 5056);
  assert.ok(!findings[0].message.includes("secret"));
  assert.ok(!findings[0].message.includes("token"));
});

test("an unreadable Jellyfin read (null) adds no Jellyfin finding", () => {
  const findings = buildWebhookPortFindings({ publishedPort: 5056, jellyfinDestinations: null });
  assert.deepEqual(findings, []);
});

test("the status route refuses callers without an admin session and returns no findings", async () => {
  const { handleWebhookPort } = await import("../server/src/routes/webhookPort.js");
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; },
    send(body) { this.body = body; return this; },
  };
  await handleWebhookPort({ method: "GET", headers: {}, get() { return undefined; } }, res, "webhook-port/status");
  assert.equal(res.statusCode, 401);
  assert.ok(!res.body.includes("findings"));
});

test("the status route returns the port check to an admin API key, with no webhook tokens", async () => {
  const { AUTH } = await import("../server/src/appConfig.js");
  const { handleWebhookPort } = await import("../server/src/routes/webhookPort.js");
  const { runWebhookPortCheck } = await import("../server/src/utils/webhookPortCheck.js");
  const previousKey = AUTH.apiKey;
  const previousPort = process.env.PLEKT_PUBLISHED_PORT;
  AUTH.apiKey = "route-test-api-key";
  process.env.PLEKT_PUBLISHED_PORT = "5056";
  try {
    await runWebhookPortCheck({ log: { warn() {} } });
    const res = {
      statusCode: 200,
      headers: {},
      body: "",
      status(code) { this.statusCode = code; return this; },
      set(headers) { Object.assign(this.headers, headers); return this; },
      send(body) { this.body = body; return this; },
    };
    const req = { method: "GET", headers: {}, get(name) { return name === "x-api-key" ? "route-test-api-key" : undefined; } };
    await handleWebhookPort(req, res, "webhook-port/status");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.publishedPort, 5056);
    assert.deepEqual(body.findings, []);
    assert.ok(!res.body.includes("token"));
  } finally {
    AUTH.apiKey = previousKey;
    if (previousPort === undefined) delete process.env.PLEKT_PUBLISHED_PORT;
    else process.env.PLEKT_PUBLISHED_PORT = previousPort;
  }
});

test("the startup check stores its result and the status read reuses it within the TTL", async () => {
  const { runWebhookPortCheck, getWebhookPortStatus } = await import("../server/src/utils/webhookPortCheck.js");
  const previous = process.env.PLEKT_PUBLISHED_PORT;
  process.env.PLEKT_PUBLISHED_PORT = "5056";
  try {
    const checked = await runWebhookPortCheck({ log: { warn() {} } });
    assert.equal(checked.publishedPort, 5056);
    assert.deepEqual(checked.findings, []);
    const cached = await getWebhookPortStatus({ now: checked.checkedAt + 1000 });
    assert.equal(cached, checked);
  } finally {
    if (previous === undefined) delete process.env.PLEKT_PUBLISHED_PORT;
    else process.env.PLEKT_PUBLISHED_PORT = previous;
  }
});

test("Emby and Plex get advice only when connected", () => {
  const findings = buildWebhookPortFindings({
    publishedPort: 5056,
    connected: { emby: true, plex: false },
  });
  assert.deepEqual(findings.map((finding) => [finding.provider, finding.kind]), [["emby", "advice"]]);
  assert.match(findings[0].message, /port 5056/);
  assert.match(findings[0].message, /Webhooks plugin settings/);
});
