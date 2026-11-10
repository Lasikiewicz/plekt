import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  assertSafeOutboundUrl,
  boundedFetchTimeoutMs,
  createUpstreamTimeoutError,
  fetchWithTimeout,
  uploadFileWithTimeout,
} from "../server/src/utils/outbound.js";
import { applyTuningConfig, resetTuningForTests } from "../server/src/utils/tuning.js";

test("upstream timeouts map to HTTP 504 errors", () => {
  const error = createUpstreamTimeoutError(2500);
  assert.equal(error.status, 504);
  assert.equal(error.code, "UPSTREAM_TIMEOUT");
  assert.match(error.message, /2500ms/);
});

test("explicit outbound timeout overrides are finite and bounded", () => {
  assert.equal(boundedFetchTimeoutMs(200), 200);
  assert.equal(boundedFetchTimeoutMs(999_999), 120_000);
  assert.equal(boundedFetchTimeoutMs(-10), 1);
  assert.equal(boundedFetchTimeoutMs("not-a-number"), 10_000);
});

test("outbound URLs reject unsafe schemes, credentials, and metadata endpoints", () => {
  assert.throws(() => assertSafeOutboundUrl("file:///etc/passwd"), /must use http or https/);
  assert.throws(() => assertSafeOutboundUrl("https://user:pass@example.com"), /embedded credentials/);
  assert.throws(() => assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data"), /blocked metadata endpoint/);
  assert.equal(assertSafeOutboundUrl("http://192.168.1.20:32400").hostname, "192.168.1.20");
});

test("fetchWithTimeout rejects an unsafe initial URL before fetching", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(fetchWithTimeout("http://169.254.169.254/latest/meta-data"), /blocked metadata endpoint/);
  assert.equal(fetchCalls, 0);
});

test("fetchWithTimeout refuses cross-origin redirects that preserve a request body", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null, { status: 307, headers: { location: "https://other.example/token" } });
  });
  await assert.rejects(fetchWithTimeout("https://source.example/token", { method: "POST", body: JSON.stringify({ client_secret: "test-secret" }) }), /request bodies/);
  assert.equal(calls, 1);
});

test("fetchWithTimeout validates redirects and does not forward credentials across origins", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), headers: new Headers(options.headers) });
    if (requests.length === 1) {
      return new Response(null, { status: 302, headers: { Location: "https://cdn.example.test/image.jpg?api_key=secret&X-Plex-Token=plex&width=340" } });
    }
    return new Response("ok", { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await fetchWithTimeout("https://media.example.test/image.jpg", {
    headers: { Accept: "image/*", "X-Api-Key": "secret" },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get("accept"), "image/*");
  assert.equal(requests[1].headers.has("x-api-key"), false);
  const redirected = new URL(requests[1].url);
  assert.equal(redirected.searchParams.has("api_key"), false);
  assert.equal(redirected.searchParams.has("X-Plex-Token"), false);
  assert.equal(redirected.searchParams.get("width"), "340");
});

test("fetchWithTimeout replaces upstream exception objects with a safe error", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new Error("sensitive upstream stack marker");
    error.stack = "Error: sensitive upstream stack marker\\n    at provider.internal/request.js:1:1";
    throw error;
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg"),
    (error) => {
      assert.equal(error.message, "Upstream request failed");
      assert.doesNotMatch(error.stack, /sensitive upstream stack marker/);
      return true;
    },
  );
});

test("fetchWithTimeout preserves a safe network cause when the upstream exposes one", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ECONNREFUSED", message: "private provider host" };
    throw error;
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg"),
    (error) => {
      assert.equal(error.code, "UPSTREAM_REQUEST_FAILED");
      assert.equal(error.failureCode, "ECONNREFUSED");
      assert.equal(error.failureReason, "connection refused");
      assert.equal(error.message, "Upstream request failed (connection refused)");
      assert.doesNotMatch(error.message, /private provider host/);
      return true;
    },
  );
});

test("fetchWithTimeout falls back to the tunable default when no explicit timeout is given", async (t) => {
  t.after(() => resetTuningForTests());
  applyTuningConfig({ outboundTimeoutSec: 2 }); // clamp minimum, 2000ms

  const originalFetch = globalThis.fetch;
  // Never resolves on its own, but rejects when the internal AbortController
  // fires - matching real fetch()'s abort-signal contract.
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal.reason));
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg"),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /2000ms/);
      return true;
    },
  );
});

test("fetchWithTimeout honors an explicit timeoutMs override regardless of tuning", async (t) => {
  t.after(() => resetTuningForTests());
  applyTuningConfig({ outboundTimeoutSec: 60 });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal.reason));
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    fetchWithTimeout("https://media.example.test/image.jpg", {}, 200),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /200ms/);
      return true;
    },
  );
});

test("fetchWithTimeout aborts a response body that stalls after headers", async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetchWithTimeout(`http://127.0.0.1:${server.address().port}/`, {}, 80);
  let watchdog;
  try {
    await assert.rejects(Promise.race([
      response.text(),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("body did not time out")), 800); }),
    ]), (error) => error.code === "UPSTREAM_TIMEOUT");
  } finally { clearTimeout(watchdog); }
});

test("fetchWithTimeout keeps streaming, cloning, and caller cancellation working after headers", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/complete") { res.end("streamed value"); return; }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const complete = await fetchWithTimeout(`${base}/complete`, {}, 2000);
  const clone = complete.clone();
  assert.equal(complete.url, `${base}/complete`);
  assert.deepEqual(await Promise.all([complete.text(), clone.text()]), ["streamed value", "streamed value"]);

  const controller = new AbortController();
  const stalled = await fetchWithTimeout(`${base}/stalled`, { signal: controller.signal }, 2000);
  const read = stalled.text();
  controller.abort();
  await assert.rejects(read, { name: "AbortError" });

  const cancelled = await fetchWithTimeout(`${base}/stalled`, {}, 2000);
  await cancelled.body.cancel();
  const afterCancel = await fetchWithTimeout(`${base}/complete`, {}, 2000);
  assert.equal(await afterCancel.text(), "streamed value");
});

// A local upload target: `respond(req, res, body)` runs once the body is in.
async function uploadServer(t, respond) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => respond(req, res, Buffer.concat(chunks)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/upload`;
}

function tempFile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plembfin-upload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "file.bin");
  fs.writeFileSync(filePath, content);
  return filePath;
}

test("uploadFileWithTimeout sends the file with its headers and returns the response", async (t) => {
  let seen = null;
  const url = await uploadServer(t, (req, res, body) => {
    seen = { method: req.method, headers: req.headers, body: body.toString() };
    res.writeHead(201).end("stored");
  });
  const filePath = tempFile(t, "backup body");

  const result = await uploadFileWithTimeout(url, { method: "PUT", headers: { "Content-Length": "11", "x-test": "1" }, filePath }, 1000);
  assert.deepEqual(result, { ok: true, status: 201, text: "stored" });
  assert.equal(seen.method, "PUT");
  assert.equal(seen.body, "backup body");
  assert.equal(seen.headers["x-test"], "1");
  assert.equal(seen.headers["transfer-encoding"], undefined);
});

test("uploadFileWithTimeout keeps going past the timeout while data keeps flowing", async (t) => {
  // The answer trickles in over about 500ms, well past the 200ms timeout.
  const url = await uploadServer(t, (req, res) => {
    res.writeHead(200);
    let sent = 0;
    const tick = setInterval(() => {
      res.write("x");
      sent += 1;
      if (sent === 5) { clearInterval(tick); res.end(); }
    }, 100);
  });
  const filePath = tempFile(t, "body");
  const result = await uploadFileWithTimeout(url, { headers: { "Content-Length": "4" }, filePath }, 200);
  assert.equal(result.text, "xxxxx");
});

test("uploadFileWithTimeout fails a transfer that stalls longer than the timeout", async (t) => {
  const url = await uploadServer(t, (req, res) => { setTimeout(() => res.writeHead(200).end(), 600); });
  const filePath = tempFile(t, "body");
  await assert.rejects(
    uploadFileWithTimeout(url, { headers: { "Content-Length": "4" }, filePath }, 200),
    (error) => {
      assert.equal(error.status, 504);
      return true;
    },
  );
});

test("uploadFileWithTimeout refuses unsafe URLs before connecting", async (t) => {
  const filePath = tempFile(t, "body");
  await assert.rejects(uploadFileWithTimeout("http://169.254.169.254/latest", { filePath }), /blocked metadata endpoint/);
});

test("fetchWithTimeout blocks redirects to metadata endpoints", async (t) => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(fetchWithTimeout("https://media.example.test/image.jpg"), /blocked metadata endpoint/);
  assert.equal(fetchCalls, 1);
});
