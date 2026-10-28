import test from "node:test";
import assert from "node:assert/strict";
import { replaceLogContent } from "../public/modules/logs.js";

function terminal(top, oldHeight, newHeight) {
  return {
    scrollTop: top, scrollHeight: oldHeight, clientHeight: 400,
    set innerHTML(value) {
      this.html = value;
      this.scrollHeight = newHeight;
      this.scrollTop = Math.min(this.scrollTop, Math.max(0, newHeight - 400));
    },
  };
}

test("shrinking log content must not turn an older-log reader into a bottom follower", () => {
  const el = terminal(800, 2000, 1300);
  replaceLogContent(el, "new logs");
  assert.equal(el.scrollTop, 800);
});

test("refresh follows new entries when previously at bottom", () => {
  const el = terminal(1600, 2000, 2500);
  replaceLogContent(el, "new logs");
  assert.equal(el.scrollTop, 2500);
});

test("initial load and category changes can force bottom scrolling", () => {
  const el = terminal(100, 2000, 2500);
  replaceLogContent(el, "new logs", true);
  assert.equal(el.scrollTop, 2500);
});
