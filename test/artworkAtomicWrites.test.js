import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDataDir } from "./helpers.js";

const directory = makeTempDataDir("plekt-artwork-atomic-");
const { writeArtworkFile } = await import("../server/src/utils/posterCache.js");
const { db } = await import("../server/src/db.js");
test.after(() => db.close());

test("a refused artwork rename preserves the previous complete file", async (t) => {
  const destination = path.join(directory, "image.webp");
  await fs.writeFile(destination, "previous complete image");
  t.mock.method(fs, "rename", async () => { throw new Error("destination locked"); });
  await assert.rejects(writeArtworkFile(destination, Buffer.from("replacement")), /destination locked/);
  assert.equal(await fs.readFile(destination, "utf8"), "previous complete image");
  assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
});
