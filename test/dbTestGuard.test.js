import assert from "node:assert/strict";
import test from "node:test";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-db-test-guard-");
const { assertNotRealDataDirUnderTest } = await import("../server/src/db.js");
const { DEFAULT_DATA_DIR } = await import("../server/src/paths.js");

test("the test runner may not open the real data folder", () => {
  assert.throws(
    () => assertNotRealDataDirUnderTest({ env: { NODE_TEST_CONTEXT: "child-v8" }, execArgv: [], dataDir: DEFAULT_DATA_DIR }),
    /Refusing to open the real data folder/,
  );
  assert.throws(
    () => assertNotRealDataDirUnderTest({ env: {}, execArgv: ["--test"], dataDir: DEFAULT_DATA_DIR }),
    /Refusing to open the real data folder/,
  );
});

test("a temp data folder under the test runner, or the real folder outside it, is allowed", () => {
  assert.doesNotThrow(() => assertNotRealDataDirUnderTest({ env: { NODE_TEST_CONTEXT: "child-v8" }, execArgv: [], dataDir: process.env.DATA_DIR }));
  assert.doesNotThrow(() => assertNotRealDataDirUnderTest({ env: {}, execArgv: [], dataDir: DEFAULT_DATA_DIR }));
});
