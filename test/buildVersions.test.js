// Five-segment build versions and the release-history guard.
//
// These cover the two things in the release flow that fail silently and ship to
// every user if they are wrong: version ordering (which drives the app's update
// indicator and the release-version decision) and release-history preservation
// (a truncated changelog cannot be recovered once users have pulled the image).
// See docs/decisions.md entry 18.

import test from "node:test";
import assert from "node:assert/strict";

const {
  parseBuildVersion,
  compareBuildVersions,
  formatBuildVersion,
  releaseVersionOf,
  buildVersion,
  bumpPatch,
} = await import("../scripts/version.js");

const { verifyReleaseHistory } = await import("../scripts/promote-alpha-to-main.js");

test("the full command ladder is strictly increasing", () => {
  const ladder = [
    "1.1.0.0.0", // release
    "1.1.0.0.1", // push to git
    "1.1.0.0.2",
    "1.1.0.0.3",
    "1.1.0.1.0", // force to alpha
    "1.1.0.1.1", // push to git
    "1.1.0.1.2",
    "1.1.0.2.0", // force to alpha
    "1.1.0.2.1", // push to git
    "1.1.1.0.0", // force to main
    "1.1.1.0.1", // push to git
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.equal(
      compareBuildVersions(ladder[i], ladder[i - 1]),
      1,
      `${ladder[i]} should sort after ${ladder[i - 1]}`,
    );
  }
});

test("a release outranks every pre-release build that preceded it", () => {
  assert.equal(compareBuildVersions("1.1.1.0.0", "1.1.0.9.9"), 1);
  assert.equal(compareBuildVersions("1.2.0.0.0", "1.1.9.9.9"), 1);
});

test("four-segment versions from before the change are not reinterpreted", () => {
  // The migration case. An alpha image already in the wild reports "1.0.2.1";
  // it must mean exactly what the new scheme would write for the same build.
  assert.equal(compareBuildVersions("1.0.2.1", "1.0.2.1.0"), 0);
  assert.deepEqual(parseBuildVersion("1.0.2.1"), [1, 0, 2, 1, 0]);
  assert.deepEqual(parseBuildVersion("1.1.0"), [1, 1, 0, 0, 0]);
  // And it still orders correctly against the release that follows it.
  assert.equal(compareBuildVersions("1.0.3.0.0", "1.0.2.1"), 1);
});

test("display trims trailing zeros only, and never below three segments", () => {
  assert.equal(formatBuildVersion("1.1.0.0.0"), "1.1.0");
  assert.equal(formatBuildVersion("1.1.0.1.0"), "1.1.0.1");
  assert.equal(formatBuildVersion("1.1.0.1.3"), "1.1.0.1.3");
  // Not a trailing zero: a develop build keeps the alpha segment's zero.
  assert.equal(formatBuildVersion("1.1.0.0.2"), "1.1.0.0.2");
  assert.equal(formatBuildVersion("1.1.0"), "1.1.0");
  assert.equal(formatBuildVersion("v1.1.0.2.0"), "1.1.0.2");
  // A release must never trim to two segments even when the patch is zero.
  assert.equal(formatBuildVersion("2.0.0.0.0"), "2.0.0");
});

test("unparseable and over-long versions never win a comparison", () => {
  assert.equal(parseBuildVersion("1.1.0.1.1.1"), null, "six segments is not a build version");
  assert.equal(parseBuildVersion("1.2.0-alpha.1"), null, "prerelease tags were rejected, see entry 18");
  assert.equal(parseBuildVersion(""), null);
  assert.equal(parseBuildVersion(null), null);
  // compareBuildVersions returns 0 rather than guessing, so an unreadable
  // version cannot present itself as newer than the installed one.
  assert.equal(compareBuildVersions("1.2.0-alpha.1", "1.1.0"), 0);
  assert.equal(compareBuildVersions("garbage", "1.1.0"), 0);
});

test("package.json only ever receives the three-segment release version", () => {
  // Five segments is not valid semver and npm rejects or mishandles it.
  assert.equal(releaseVersionOf("1.1.0.2.1"), "1.1.0");
  assert.equal(releaseVersionOf("1.1.0"), "1.1.0");
  assert.equal(buildVersion("1.1.0", 2, 1), "1.1.0.2.1");
  assert.equal(buildVersion("1.1.0"), "1.1.0.0.0");
  assert.equal(bumpPatch("1.1.0"), "1.1.1");
  assert.equal(bumpPatch("1.1.0.4.2"), "1.1.1", "a build version bumps on its release part");
});

test("the release-history gate accepts a correctly extended history", () => {
  assert.deepEqual(
    verifyReleaseHistory({
      priorVersions: ["1.1.0", "1.0.2", "1.0.1"],
      newVersions: ["1.1.1", "1.1.0", "1.0.2", "1.0.1"],
      newMainVersion: "1.1.1",
    }),
    [],
  );
});

test("the release-history gate refuses a truncated history", () => {
  // This is the compounding-loss case: the release is built from alpha's
  // checkout, which never saw main's history, so writing from the working tree
  // would publish a changelog containing only this release.
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0", "1.0.2", "1.0.1"],
    newVersions: ["1.1.1"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0, "a history with everything dropped must fail");
  assert.match(failures.join("\n"), /missing/);
  assert.match(failures.join("\n"), /1\.1\.0/);
});

test("the release-history gate refuses a single dropped release", () => {
  // The subtle version: only the most recent release is missing, which is
  // exactly what one un-synced cycle produces.
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0", "1.0.2"],
    newVersions: ["1.1.1", "1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0);
  assert.match(failures.join("\n"), /1\.1\.0/);
});

test("the release-history gate refuses more or fewer than one new release", () => {
  const two = verifyReleaseHistory({
    priorVersions: ["1.0.2"],
    newVersions: ["1.1.1", "1.1.0", "1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(two.length > 0, "two new releases in one promotion must fail");

  const none = verifyReleaseHistory({
    priorVersions: ["1.0.2"],
    newVersions: ["1.0.2"],
    newMainVersion: "1.1.1",
  });
  assert.ok(none.length > 0, "no new release must fail");
});

test("the release-history gate refuses a new release under the wrong version", () => {
  const failures = verifyReleaseHistory({
    priorVersions: ["1.1.0"],
    newVersions: ["1.2.0", "1.1.0"],
    newMainVersion: "1.1.1",
  });
  assert.ok(failures.length > 0);
  assert.match(failures.join("\n"), /expected 1\.1\.1/);
});

// The four guards added after a session produced each of these failures for real:
// a 24-bullet entry from unconsolidated commits, bullets naming internals, a
// run-on headline, and two agents corrupting the repository at once.

const { changelogEntryQualityViolations, CHANGELOG_ALPHA_MAX_BULLETS } = await import("../scripts/changelog-message.js");
const { productCommitSubjects } = await import("../scripts/check-pending-commits.js");
const { lockDecision } = await import("../scripts/release-lock.js");

test("a publishable entry passes the quality gate", () => {
  assert.deepEqual(changelogEntryQualityViolations({
    details: [
      "Show the right next episode even when it has never been watched",
      "Return an episode to Up Next when you mark it unwatched",
      "Mirror Up Next onto Plex Continue Watching and Emby Resume",
    ],
  }), []);
});

test("alpha permits unlimited tweaks while limiting runaway feature and fix entries", () => {
  const entry = (n) => ({ details: Array.from({ length: n }, (_, i) => `Real user-visible bullet number ${i}`) });
  const alpha = { maxBullets: CHANGELOG_ALPHA_MAX_BULLETS, boundary: "alpha" };

  assert.deepEqual(changelogEntryQualityViolations(entry(12), alpha), [], "three normal pushes must promote to alpha");
  assert.deepEqual(changelogEntryQualityViolations(entry(12)), [], "a release keeps all reviewed user-visible changes");
  assert.ok(changelogEntryQualityViolations(entry(CHANGELOG_ALPHA_MAX_BULLETS + 1), alpha).length > 0, "a runaway entry is still refused at alpha");
  const tweaks = { sections: { newFeatures: ["First feature", "Second feature", "Third feature"], majorBugFixes: [], tweaks: Array.from({ length: 40 }, (_, i) => `Distinct tweak ${i}`) } };
  assert.deepEqual(changelogEntryQualityViolations(tweaks, alpha), []);

  // Jargon is wrong at either boundary and must be caught at both.
  const jargon = { details: ["One real bullet", "Two real bullet", "Record every seed in up_next_rail_seeds"] };
  assert.ok(changelogEntryQualityViolations(jargon, alpha).length > 0);
  assert.ok(changelogEntryQualityViolations(jargon).length > 0);
});

test("the quality gate refuses an entry with too few bullets", () => {
  assert.ok(changelogEntryQualityViolations({ details: ["One", "Two"] }).length > 0);
  const many = changelogEntryQualityViolations({
    details: Array.from({ length: 12 }, (_, i) => `Real user-visible bullet number ${i}`),
  });
  assert.deepEqual(many, [], "main release notes must not truncate reviewed changes");
});

test("the quality gate refuses bullets that name internals", () => {
  const cases = [
    "Record every seed in up_next_rail_seeds and reject it by identity",
    "Consult Emby's legacy query when /Items/Resume answers with an empty list",
    "Stop reading a bare provider_item_id for a provider that did not issue it",
  ];
  for (const bullet of cases) {
    const violations = changelogEntryQualityViolations({ details: ["First bullet", "Second bullet", bullet] });
    assert.ok(violations.length > 0, `should have flagged: ${bullet}`);
  }
});

test("the quality gate leaves ordinary product wording alone", () => {
  // It must not fire on product nouns or version numbers, or it would be
  // disabled the first time it cried wolf.
  assert.deepEqual(changelogEntryQualityViolations({
    details: [
      "Mirror Up Next onto Plex Continue Watching so the same queue appears there",
      "Ship v1.1.0 with the Main and Alpha changelog tabs",
      "Restore Jellyfin as a full Up Next source for reading and dismissing",
    ],
  }), []);
});

test("pending product commits are counted without tooling commits", () => {
  // The exact pre-consolidation state that produced the 290-character headline.
  assert.equal(productCommitSubjects([
    "feat: make Up Next authoritative across Plex, Emby, and Jellyfin",
    "fix: correct the changelog build labels",
    "chore: five-segment build versions",
    "feat: show alpha builds and per-channel update notices",
    "chore: rebuild develop changelog",
  ]).length, 3);

  assert.equal(productCommitSubjects([
    "feat: make Up Next reliable across Plex, Emby, and Jellyfin",
    "chore: five-segment build versions",
    "chore: rebuild develop changelog",
  ]).length, 1);
});

test("the release lock refuses a concurrent session but not an abandoned one", () => {
  const now = Date.now();
  assert.equal(lockDecision({ existing: null, now }).action, "acquire");
  assert.equal(lockDecision({ existing: { pid: 4242, startedAt: new Date(now).toISOString() }, now, pid: 4242 }).action, "acquire");
  assert.equal(lockDecision({ existing: { pid: 999, startedAt: new Date(now - 60_000).toISOString() }, now }).action, "refuse");
  // A crashed session must not block the repository forever.
  assert.equal(lockDecision({ existing: { pid: 999, startedAt: new Date(now - 45 * 60_000).toISOString() }, now }).action, "acquire");
  // startedAt is an ISO string; coercing it with Number() yielded NaN and made
  // every staleness comparison false.
  assert.equal(lockDecision({ existing: { pid: 999, startedAt: "nonsense" }, now }).action, "acquire");
});

// An alpha branch that is BEHIND the running build must never present as an
// update. The comparison used to test base versions for inequality rather than
// order, so a build on base 1.1.0 against a branch still on the 1.0.2 cycle
// listed the previous cycle as "new since your alpha build - not pulled yet",
// and the banner read "Newer alpha build available - build 2. You're running
// build 2." because both cycles happened to have two builds.
//
// This is not only a half-finished-promotion symptom: "Force to main" resets
// changelog.alpha.json but never touches the alpha branch, so right after every
// release a running alpha build legitimately sits on a newer base than the
// branch does.
const { describePendingAlphaBuild, mergeAlphaEntries } = await import("../server/src/routes/maintenance.js");

test("a new cycle's build 1 is not swallowed by the previous cycle's build 1", () => {
  const merged = mergeAlphaEntries(
    [{ build: 1, version: "1.3.0.1.0", details: ["a"] }],
    [{ build: 1, version: "1.2.2.1.0", details: ["a", "b", "c"] }],
  );
  assert.deepEqual(merged.map((e) => e.version).sort(), ["1.2.2.1.0", "1.3.0.1.0"]);

  const sameEntry = mergeAlphaEntries(
    [{ build: 1, version: "1.3.0.1.0", details: ["a"] }],
    [{ build: 1, version: "1.3.0.1.0", details: ["a", "b"] }],
  );
  assert.equal(sameEntry.length, 1);
  assert.equal(sameEntry[0].details.length, 2, "the richer copy of the same build survives");
});

test("an alpha branch behind the running build is never an update", () => {
  const result = describePendingAlphaBuild(
    { baseVersion: "1.1.0", build: 2, entries: [] },
    { baseVersion: "1.0.2", build: 2, entries: [{ build: 1 }, { build: 2 }] },
  );
  assert.equal(result.newerBuildAvailable, false);
  assert.deepEqual(result.pendingEntries, []);
});

test("a newer alpha cycle makes every remote entry pending", () => {
  const result = describePendingAlphaBuild(
    { baseVersion: "1.1.0", build: 2, entries: [] },
    { baseVersion: "1.2.0", build: 1, entries: [{ build: 1 }] },
  );
  assert.equal(result.newerBuildAvailable, true);
  assert.equal(result.pendingEntries.length, 1);
});

test("within one cycle only builds past the installed one are pending", () => {
  const sameBuild = describePendingAlphaBuild(
    { baseVersion: "1.1.0", build: 2, entries: [] },
    { baseVersion: "1.1.0", build: 2, entries: [{ build: 1 }, { build: 2 }] },
  );
  assert.equal(sameBuild.newerBuildAvailable, false, "an identical branch is not an update");

  const ahead = describePendingAlphaBuild(
    { baseVersion: "1.1.0", build: 1, entries: [] },
    { baseVersion: "1.1.0", build: 3, entries: [{ build: 2 }, { build: 3 }] },
  );
  assert.equal(ahead.newerBuildAvailable, true);
  assert.deepEqual(ahead.pendingEntries.map((e) => e.build), [2, 3]);

  const behind = describePendingAlphaBuild(
    { baseVersion: "1.1.0", build: 3, entries: [] },
    { baseVersion: "1.1.0", build: 1, entries: [{ build: 1 }] },
  );
  assert.equal(behind.newerBuildAvailable, false, "a branch behind within the cycle is not an update");
});
