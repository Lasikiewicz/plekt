import test from "node:test";
import assert from "node:assert/strict";

// The page modules read browser storage on import; a throwaway stand-in is enough here.
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage ??= globalThis.localStorage;
globalThis.history ??= { state: null, pushState() {}, replaceState() {} };
globalThis.window ??= { addEventListener() {}, location: { origin: "http://localhost:5055", pathname: "/" } };
const { webhookTestFailureAdvice, webhookTestFailureLabel } = await import("../public/modules/webhook-test.js");

test("the failure headline names the same cause as the advice", () => {
  const rejected = { rejectedCount: 2, seen: [] };
  assert.equal(webhookTestFailureLabel(rejected), "Token rejected");
  assert.match(webhookTestFailureAdvice(rejected, "emby"), /token was rejected/);

  const ignored = { seen: [{ event: "item.markplayed", count: 1, markPlayed: true }] };
  assert.equal(webhookTestFailureLabel(ignored), "Mark received but ignored");
  assert.match(webhookTestFailureAdvice(ignored, "emby"), /ignored it/);

  const noMark = { seen: [{ event: "playback.stop", count: 1 }] };
  assert.equal(webhookTestFailureLabel(noMark), "No mark-played event");
  assert.match(webhookTestFailureAdvice(noMark, "emby"), /no mark-played event/);

  assert.equal(webhookTestFailureLabel({ seen: [] }), "No mark received");
  assert.equal(webhookTestFailureLabel({}), "No mark received");
});
