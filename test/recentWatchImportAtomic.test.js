import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { makeTempDataDir } from "./helpers.js";

const dataDir = makeTempDataDir("plekt-recent-watch-atomic-");
const { db } = await import("../server/src/db.js");

test("Plex, Emby and Jellyfin imports serialize their final identity check across processes", async () => {
  const providers = ["plex", "emby", "jellyfin"];
  const media = {
    title: "Atomic Cross Provider Film",
    type: "movie",
    ids: { imdb: "tt-atomic-cross-provider", tmdb: "990001" },
    watched_at: "2026-11-01T12:00:00.000Z",
  };
  const source = `
    import { createInterface } from "node:readline";
    import { db } from "./server/src/db.js";
    import { findWatchedByAnyMediaKeySync } from "./server/src/utils/dataRepo.js";
    import { insertRecentWatchIfMissing } from "./server/src/utils/recentWatchImportInsert.js";
    const provider = process.env.TEST_PROVIDER;
    const media = JSON.parse(process.env.TEST_MEDIA);
    const alreadyThere = findWatchedByAnyMediaKeySync(media);
    console.log("READY " + JSON.stringify({ provider, found: Boolean(alreadyThere) }));
    const input = createInterface({ input: process.stdin });
    for await (const line of input) { if (line === "GO") break; }
    input.close();
    const record = {
      title: media.title,
      media_type: "movie",
      watched_at: media.watched_at,
      source: provider,
      imdb_id: media.ids.imdb,
      tmdb_id: media.ids.tmdb,
      sync_action: "watched",
    };
    const result = insertRecentWatchIfMissing(media, record, { prefetch: false });
    console.log("RESULT " + JSON.stringify({ provider, inserted: result.inserted, reason: result.reason }));
    db.close();
  `;
  const children = providers.map((provider) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      env: { ...process.env, DATA_DIR: dataDir, TEST_PROVIDER: provider, TEST_MEDIA: JSON.stringify(media) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    return { child, get output() { return output; } };
  });

  const ready = await Promise.all(children.map((entry) => new Promise((resolve, reject) => {
    const check = () => {
      const line = entry.output.split(/\r?\n/).find((row) => row.startsWith("READY "));
      if (line) {
        entry.child.stdout.off("data", check);
        entry.child.off("exit", onExit);
        resolve(JSON.parse(line.slice("READY ".length)));
      }
    };
    const onExit = (code) => reject(new Error(entry.output || `child exited before ready (${code})`));
    entry.child.stdout.on("data", check);
    entry.child.once("error", reject);
    entry.child.once("exit", onExit);
    check();
  })));
  assert.deepEqual(ready.map((row) => row.found), [false, false, false]);
  for (const { child } of children) child.stdin.end("GO\n");

  const results = await Promise.all(children.map((entry) => new Promise((resolve, reject) => {
    const finish = (code) => {
      if (code !== 0) return reject(new Error(entry.output || `child exited ${code}`));
      const line = entry.output.split(/\r?\n/).find((row) => row.startsWith("RESULT "));
      if (!line) return reject(new Error(entry.output || "child omitted its result"));
      resolve(JSON.parse(line.slice("RESULT ".length)));
    };
    if (entry.child.exitCode !== null) return finish(entry.child.exitCode);
    entry.child.once("error", reject);
    entry.child.once("exit", finish);
  })));

  assert.equal(results.filter((row) => row.inserted).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM watch_history WHERE tmdb_id = ?").get(media.ids.tmdb).count, 1);
  assert.equal(db.prepare("SELECT COUNT(DISTINCT source) AS count FROM watch_history WHERE tmdb_id = ?").get(media.ids.tmdb).count, 1);
});
