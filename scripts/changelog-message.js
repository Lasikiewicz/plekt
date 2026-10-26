import { changelogSectionGroups } from "./changelog-sections.js";

const RELEASE_TYPES = new Set(["feat", "fix", "security", "enhance", "perf", "docs"]);

// Release-pipeline bookkeeping commits (rebuilding/promoting the changelog
// itself, and the merge commits the pre-push hook creates when syncing
// against a branch another push already advanced) carry no user-visible
// content of their own - their subject line is noise in a changelog and their
// absence of bullets shouldn't blank out an otherwise-detailed release.
// Shared so every generator drops them the same way. The bump/update patterns
// below match commit messages from before the changelog pipeline moved to
// local computation (see CLAUDE.md's branching model section) - they no
// longer get created, but rebuild-develop-changelog.js's git-history walk can
// still cross them for any reset anchor that predates the move, so they stay
// recognized.
const NOISE_MESSAGE_PATTERNS = [
  /^chore: rebuild develop changelog\b/,
  /^chore: promote develop changelog to alpha\b/,
  /^chore: promote alpha to main\b/,
  /^chore: bump alpha build for /,
  /^chore: bump develop build for /,
  /^chore: update changelog for /,
  /^chore: reset (?:develop|alpha) build counter after promotion to /i,
  /^Merge (branch|commit|pull request|remote-tracking branch)\b/i,
];

export function isNoiseCommitMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  return NOISE_MESSAGE_PATTERNS.some((pattern) => pattern.test(subject));
}

// Changelog entries are assembled from commit bodies at several branch
// boundaries. A commit can have a valid release type while its bullets still
// describe the bookkeeping around the changelog itself (for example,
// consolidating entries or resetting a build counter). Those notes are useful
// to the maintainer while working, but they are not release content and must
// not reach alpha or main.
const CHANGELOG_ARTIFACT_PATTERN = /\b(?:changelog(?:[-.]|\s|$)|release notes?|release entry|release history)\b/i;
const CHANGELOG_PROCESS_ACTION_PATTERN = /\b(?:consolidat(?:e|ed|ing|ion)|trim(?:med|ming)?|shorten(?:ed|ing)?|drop(?:ped|ping)|fold(?:ed|ing)?|regenerat(?:e|ed|ing)|rewrit(?:e|ten|ing)|correct(?:ed|ion|ing)|clean(?:ed|up|ing)?|deduplicat(?:e|ed|ing)|tighten(?:ed|ing)?|summariz(?:e|ed|ing))\b/i;
const BUILD_COUNTER_PATTERN = /\b(?:reset|bump(?:ed|ing)?)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i;

export function isChangelogProcessText(value) {
  const text = String(value || "").trim();
  if (!text) return false;

  return BUILD_COUNTER_PATTERN.test(text)
    || /\bchangelog[- ]process\b/i.test(text)
    || (CHANGELOG_ARTIFACT_PATTERN.test(text) && CHANGELOG_PROCESS_ACTION_PATTERN.test(text));
}

// A bullet can describe the release pipeline's own machinery - git hooks, CI
// workflows, the promotion scripts themselves - rather than something
// Plembfin the app actually does. That's real, useful information, but it
// belongs in CLAUDE.md/docs for whoever maintains the project, not in a
// changelog an end user reads to find out what changed in the app. This is
// independent of commit type: a legitimate fix/feat commit's bullet list can
// still slip in a line like this if a push session bundled dev-tooling work
// alongside real product changes, so it has to be caught by content, not by
// trusting the commit was typed "chore:".
const RELEASE_TOOLING_PATTERN = /\b(?:pre-push hook|commit-msg hook|git hooks?|githooks|ci pipeline|github actions workflow|release pipeline|build gate|force to (?:alpha|main)|push to git|changelog\.(?:develop|alpha)\.json|rebuild-develop-changelog\.js|promote-develop-to-alpha\.js|promote-alpha-to-main\.js|validate-commit-message\.js|changelog-message\.js)\b/i;

export function isReleaseToolingText(value) {
  return RELEASE_TOOLING_PATTERN.test(String(value || "").trim());
}

export function isChangelogProcessMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  if (!subject) return false;

  return isChangelogProcessText(subject)
    || isReleaseToolingText(subject)
    || /^(?:chore|docs?)(?:\([^)]*\))?:\s*(?:reset|bump)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i.test(subject)
    || /^(?:chore|docs?)\s+-\s+(?:reset|bump)\s+(?:the\s+)?(?:develop|alpha)\s+build(?:\s+counter|\s+metadata)?\b/i.test(subject);
}

export function filterChangelogDetails(details) {
  const values = Array.isArray(details) ? details : (details == null ? [] : [details]);
  return values
    .map((detail) => String(detail || "").trim())
    .filter((detail) => detail && !isChangelogProcessText(detail) && !isReleaseToolingText(detail));
}

// Keep one user-facing change when two commits describe it with harmless
// differences such as a conventional prefix, punctuation, or line wrapping.
// The first spelling wins so a reviewed/manual wording remains stable while
// later duplicate commits cannot make a release entry grow.
export function dedupeChangelogDetails(details) {
  const seen = new Set();
  return (Array.isArray(details) ? details : [details])
    .map((detail) => String(detail || "").trim())
    .filter((detail) => {
      const key = comparable(detail);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function filterChangelogEntries(entries = []) {
  if (!Array.isArray(entries)) return [];

  return entries
    // Tooling-only alpha builds are useful to current alpha testers but do not
    // describe product changes and must never enter a stable release entry.
    .filter((entry) => entry && entry.toolingOnly !== true && !isChangelogProcessMessage(entry.message))
    .map((entry) => ({
      ...entry,
      details: filterChangelogDetails(entry.details),
    }))
    .filter((entry) => String(entry.message || "").trim() || entry.details.length > 0);
}

export function changelogEntryProcessViolations(entry = {}) {
  const violations = [];
  // Belt-and-suspenders alongside the generators' own noise guard: a bare
  // merge/bump commit message (no real bullets) is never informative to a
  // user reading Settings -> Changelog, so the target-branch gate refuses it
  // too, in case a future code path in either generator ever reaches this
  // check without having applied that guard itself.
  if (isNoiseCommitMessage(entry.message) || isChangelogProcessMessage(entry.message)) {
    violations.push(`message: ${String(entry.message).split(/\r?\n/, 1)[0].trim()}`);
  }

  for (const [field, values] of [
    ["details", entry.details],
    ["sections.newFeatures", entry.sections?.newFeatures],
    ["sections.majorBugFixes", entry.sections?.majorBugFixes],
    ["sections.tweaks", entry.sections?.tweaks],
  ]) {
    for (const value of Array.isArray(values) ? values : []) {
      if (isChangelogProcessText(value) || isReleaseToolingText(value)) violations.push(`${field}: ${String(value).trim()}`);
    }
  }

  for (const [section, groups] of Object.entries(entry.sectionGroups || {})) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const value of Array.isArray(group?.details) ? group.details : []) {
        if (isChangelogProcessText(value) || isReleaseToolingText(value)) {
          violations.push(`sectionGroups.${section}: ${String(value).trim()}`);
        }
      }
    }
  }

  return Array.from(new Set(violations));
}

// A multi-commit push (routine on alpha, and especially a "Merge alpha with
// main" promotion that bundles a whole branch at once) backfills bullets from
// every commit in range, not just the one that triggered the build. Without
// this check that included commits whose type isn't user-facing - chore:,
// test:, refactor:, ci:, style: - dumping their bullets into the same
// changelog entry as real feat/fix/security work: an internal debug-only
// endpoint, or a note about fixing a test's expectations, read like product
// changes to anyone browsing Settings -> Changelog even though neither one
// is. Only commits typed as one of the RELEASE_TYPES belong in the backfill.
export function isReleaseTypeCommitMessage(message) {
  const subject = String(message || "").split(/\r?\n/, 1)[0].trim();
  const match = subject.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*/);
  return Boolean(match && RELEASE_TYPES.has(match[1].toLowerCase()));
}

export function formatChangelogMessage(message) {
  let text = String(message || "").trim();
  text = text.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, "").trim();

  const m = text.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/);
  if (!m) return text;
  const labels = {
    feat: "Feature",
    feature: "Feature",
    fix: "Fix",
    security: "Security",
    chore: "Chore",
    docs: "Docs",
    ci: "CI",
    enhance: "Enhancement",
    perf: "Performance",
  };
  const label = labels[m[1].toLowerCase()];
  if (!label) return text;
  let rest = m[2].trim();
  rest = rest.replace(/^(feature|feat|fix|security|chore|docs|ci|enhancement|enhance|perf)\s*[:-]\s*/i, "").trim();
  if (!rest) return label;
  return `${label} - ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

// A release entry can bundle more than one unrelated push into its one
// headline - several "Push to git" runs land in the same develop entry
// before a "Force to alpha", and likewise several "Force to alpha" runs can
// land in the same alpha entry before a "Force to main". Picking only the
// most recent one (the old behavior) silently drops every earlier push from
// the one line most people actually read in Settings -> Changelog, even
// though their bullets are still listed below it. This instead folds every
// formatted "Label - description" headline passed in into one sentence
// naming all of them, unwrapping a headline that's already one of these
// composite sentences (from an earlier "Force to alpha" this same cycle)
// rather than nesting "This update includes This update includes ...".
export function synthesizeHeadline(messages = []) {
  const cleaned = messages.map((message) => String(message || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];

  const fragments = cleaned.map((message) => {
    let rest = message.replace(/^[A-Za-z]+\s+-\s+/, "").trim();
    rest = rest.replace(/^this update includes\s+/i, "").replace(/\.$/, "").trim();
    if (!rest) return message;
    return rest.charAt(0).toLowerCase() + rest.slice(1);
  });

  const last = fragments[fragments.length - 1];
  const joined = fragments.length === 2
    ? `${fragments[0]} and ${last}`
    : `${fragments.slice(0, -1).join(", ")}, and ${last}`;
  return `This update includes ${joined}.`;
}

// Reads the bullet list out of a commit body.
//
// A bullet may wrap across several lines. The commit format this project asks
// for produces exactly that, because bodies are wrapped near 72 characters, so
// most real bullets are multi-line. An earlier version kept only lines that
// began with a bullet marker and dropped everything else, which silently
// truncated every wrapped bullet at its first line - "Clear seeds for items
// that leave the queue. Without this a seeded episode" - and published the
// fragment to the changelog. It failed quietly, so it survived until a commit
// with long bullets went through.
//
// A line continues the current bullet when it is non-blank and is not itself a
// bullet. A blank line ends the bullet. That blank-line rule is what keeps the
// intro paragraph and any section headings out: they are separated from the
// bullets by blank lines, so they never attach to one and never start a bullet
// of their own.
export function bulletPointsFrom(message) {
  const lines = String(message || "")
    // Commit bodies entered through some shell paths contain a literal
    // "\\n" instead of an actual line break. Treat both forms identically.
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    // Drop the subject line; it becomes the entry's headline, not a bullet.
    .slice(1);

  const bullets = [];
  let open = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      // A blank line closes the bullet, so a following prose block cannot be
      // absorbed into it.
      open = false;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, "").trim();
      if (text) {
        bullets.push(text);
        open = true;
      } else {
        open = false;
      }
      continue;
    }

    if (open) {
      // Continuation of the bullet above. Both sides are already trimmed, so a
      // single space is the whole join - no global whitespace normalizing,
      // which would otherwise collapse runs of spaces inside a wrapped bullet
      // while leaving them intact in a single-line one.
      bullets[bullets.length - 1] = `${bullets[bullets.length - 1]} ${line}`;
    }
    // Otherwise it is prose outside any bullet - the intro paragraph or a
    // section heading. Ignored, same as before.
  }

  return bullets.filter(Boolean);
}

function comparable(value) {
  return String(value || "")
    .replace(/^[a-zA-Z]+(?:\([^)]*\))?:\s*/, "")
    .replace(/^[a-zA-Z]+\s+-\s+/, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

export function validateReleaseMessage(message) {
  const raw = String(message || "").trim();
  const subject = raw.split(/\r?\n/, 1)[0].trim();
  const match = subject.match(/^([a-zA-Z]+)(?:\([^)]*\))?:\s*(.*)$/);
  if (!match || !RELEASE_TYPES.has(match[1].toLowerCase())) return [];

  const bullets = bulletPointsFrom(raw);
  const subjectKey = comparable(subject);
  const meaningfulBullets = bullets.filter((bullet) => comparable(bullet) !== subjectKey);
  if (meaningfulBullets.length > 0) return [];

  return [
    `${match[1].toLowerCase()} commits must include at least one user-visible bullet that adds detail beyond the subject.`,
    `Use: git commit -m "${subject}" -m "- What changed for users"`,
  ];
}

// Quality gate for an entry that is about to be published to testers or users.
//
// Applied at the two promotion boundaries, not to develop's rolling entry.
// Develop legitimately accumulates bullets across several pushes in a cycle, so
// counting them there would block normal work; by the time an entry is promoted
// it has to read as release notes.
//
// Both rules exist because a session produced exactly these failures: four
// unconsolidated commits gave a 24-bullet entry with a 290-character headline,
// and bullets naming internals ("up_next_rail_seeds", "/Items/Resume",
// "provider_item_id") reached the changelog from an otherwise well-written
// commit. Neither was caught by anything.
export const CHANGELOG_MIN_BULLETS = 3;
// A reviewed main release keeps every distinct user-visible change.
export const CHANGELOG_MAX_BULLETS = Number.POSITIVE_INFINITY;
// Alpha's ceiling applies to features and fixes, not tweaks.
export const CHANGELOG_ALPHA_MAX_BULLETS = 30;

// Identifiers that read as code rather than as a description of behaviour.
// Deliberately narrow: it must not fire on ordinary product nouns like
// "Up Next", "Continue Watching", or a version such as "1.1.0".
const CODE_IDENTIFIER_PATTERNS = [
  { pattern: /\b[a-z0-9]+(?:_[a-z0-9]+){1,}\b/, why: "snake_case identifier" },
  { pattern: /(?:^|\s)\/[A-Za-z][A-Za-z0-9]*(?:\/[A-Za-z0-9{}]+)*\b/, why: "API path" },
  { pattern: /\b[a-z]+[A-Z][A-Za-z]*\(\)/, why: "function name" },
  { pattern: /\b\w+\.(?:js|mjs|json|yml|ts)\b/, why: "source file name" },
  { pattern: /`[^`]+`/, why: "code span" },
];

function bulletsOf(entry = {}) {
  const details = Array.isArray(entry.details) ? entry.details.filter(Boolean) : [];
  if (details.length) return details;
  return changelogSectionGroups(entry).flatMap((section) => section.details).filter(Boolean);
}

// Alpha does not cap tweaks; review them for duplicates and fixes to features
// introduced in the same release. Main keeps the full reviewed cycle.
export function changelogEntryQualityViolations(entry = {}, { maxBullets = CHANGELOG_MAX_BULLETS, minBullets = CHANGELOG_MIN_BULLETS, boundary = "release" } = {}) {
  const violations = [];
  const bullets = bulletsOf(entry);

  if (bullets.length < minBullets) {
    violations.push(`only ${bullets.length} bullet(s); a published entry needs at least ${minBullets}`);
  }
  const cappedBullets = boundary === "alpha" && entry.sections
    ? [...(entry.sections.newFeatures || []), ...(entry.sections.majorBugFixes || [])]
    : boundary === "alpha" ? bullets.filter((bullet) => !/^tweak\s*:/i.test(bullet)) : bullets;
  if (Number.isFinite(maxBullets) && cappedBullets.length > maxBullets) {
    violations.push(boundary === "alpha"
      ? `${cappedBullets.length} feature and fix bullets, past the ${maxBullets} runaway ceiling. Merge related bullets in changelog.develop.json's entry so testers can read it, then promote again.`
      : `${bullets.length} bullets; at most ${maxBullets} should be published. Combine the cycle's alpha bullets into the most significant user-visible changes.`);
  }

  for (const bullet of bullets) {
    for (const { pattern, why } of CODE_IDENTIFIER_PATTERNS) {
      const match = String(bullet).match(pattern);
      if (match) {
        violations.push(`bullet names a ${why} (${match[0].trim()}): ${String(bullet).slice(0, 80)}`);
        break;
      }
    }
  }

  return violations;
}
