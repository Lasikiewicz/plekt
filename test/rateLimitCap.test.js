import test from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, rateLimitBucketCount } from "../server/src/utils/rateLimit.js";

test("a flood of distinct keys inside one window stays under the bucket cap", () => {
  for (let index = 0; index < 6000; index += 1) {
    checkRateLimit(`flood-${index}`, { max: 10, windowMs: 60 * 60_000 });
  }

  assert.ok(rateLimitBucketCount() <= 5000, `bucket count ${rateLimitBucketCount()} exceeds cap`);
});

test("a key that stays within its budget is still limited after the flood", () => {
  const key = "steady-caller";
  let allowed = 0;
  for (let index = 0; index < 12; index += 1) {
    if (checkRateLimit(key, { max: 10, windowMs: 60 * 60_000 })) allowed += 1;
  }

  assert.equal(allowed, 10);
});
