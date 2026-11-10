import test from "node:test";
import assert from "node:assert/strict";

const { acquireKeyedLock } = await import("../server/src/utils/keyedLock.js");

test("waiters on one key run one at a time, in arrival order", async () => {
  const order = [];
  const run = async (name, holdMs) => {
    const release = await acquireKeyedLock("keyed-lock-test:order");
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    order.push(`${name}:end`);
    release();
  };
  await Promise.all([run("a", 20), run("b", 0), run("c", 0)]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("different keys do not block each other", async () => {
  const first = await acquireKeyedLock("keyed-lock-test:x");
  const other = await acquireKeyedLock("keyed-lock-test:y");
  other();
  first();
});

test("releasing twice is harmless and a released key can be taken again", async () => {
  const release = await acquireKeyedLock("keyed-lock-test:repeat");
  release();
  release();
  const again = await acquireKeyedLock("keyed-lock-test:repeat");
  again();
});
