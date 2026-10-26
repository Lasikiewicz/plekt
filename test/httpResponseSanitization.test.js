import test from "node:test";
import assert from "node:assert/strict";
import { sendJson } from "../server/src/utils/http.js";

function responseCapture() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    set() { return this; },
    send(body) { this.body = JSON.parse(body); return this; },
  };
}

test("500 responses redact stack traces even when the error body is a string", () => {
  const res = responseCapture();
  sendJson(res, "Internal failure\n    at privateModule (C:/app/server/private.js:42:3)", 500);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Internal server error" });
});
