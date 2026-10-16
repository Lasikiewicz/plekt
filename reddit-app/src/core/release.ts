import { reddit, redis } from "@devvit/web/server";

const SUBREDDIT = "plekt";
const RELEASE_URL = "https://plekt.net/release.json";
const LAST_ANNOUNCED_KEY = "lastAnnouncedVersion";

type ChangelogSections = {
  newFeatures?: string[];
  majorBugFixes?: string[];
  tweaks?: string[];
};

type ChangelogSectionGroups = Partial<Record<keyof ChangelogSections, {
  title?: string;
  details?: string[];
}[]>>;

type ChangelogEntry = {
  version: string;
  message: string;
  websiteUrl?: string;
  sections?: ChangelogSections;
  sectionGroups?: ChangelogSectionGroups;
  details?: string[];
};

const SECTION_LABELS: [keyof ChangelogSections, string][] = [
  ["newFeatures", "New Features"],
  ["majorBugFixes", "Bug Fixes"],
  ["tweaks", "Tweaks"],
];

function bulletList(items: string[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const item of items) {
    const line = `- ${item}`;
    if (used + line.length + 1 > 3000) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < items.length) lines.push(`- …and ${items.length - shown} more`);
  return lines.join("\n");
}

function sectionBulletList(entry: ChangelogEntry, key: keyof ChangelogSections): string | null {
  const groups = entry.sectionGroups?.[key];
  if (!Array.isArray(groups) || groups.length === 0) return bulletList(entry.sections?.[key]);
  const items: string[] = [];
  for (const group of groups) {
    if (group.title) items.push(`**${group.title}**`);
    if (Array.isArray(group.details)) items.push(...group.details);
  }
  return bulletList(items);
}

function buildPost(entry: ChangelogEntry): { title: string; text: string } {
  const sections: string[] = [];
  for (const [key, label] of SECTION_LABELS) {
    const list = sectionBulletList(entry, key);
    if (list) sections.push(`**${label}**\n\n${list}`);
  }
  if (sections.length === 0) {
    const list = bulletList(entry.details);
    if (list) sections.push(list);
  }

  const bodyParts = [entry.message];
  const websiteUrl = String(entry.websiteUrl ?? "").trim();
  if (websiteUrl) bodyParts.push(`Website: ${websiteUrl}`);
  if (sections.length) bodyParts.push(sections.join("\n\n"));
  bodyParts.push(
    "[View the full changelog](https://github.com/Lasikiewicz/plekt/blob/main/CHANGELOG.md)",
  );

  return {
    title: `Plekt v${entry.version} released`.slice(0, 300),
    text: bodyParts.join("\n\n"),
  };
}

async function fetchLatestEntry(): Promise<ChangelogEntry | undefined> {
  const response = await fetch(RELEASE_URL, { redirect: "error" });
  if (!response.ok) {
    console.error(`Failed to fetch release feed: ${response.status}`);
    return undefined;
  }
  // The website feed uses summary/bullets, rather than changelog.json's message/details.
  const feed = (await response.json()) as {
    version?: unknown;
    entries?: { version?: unknown; summary?: unknown; bullets?: unknown }[];
  };
  const latest = Array.isArray(feed.entries) ? feed.entries[0] : undefined;
  if (
    !latest || typeof latest.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(latest.version) || feed.version !== latest.version ||
    typeof latest.summary !== "string" || !latest.summary.trim() ||
    !Array.isArray(latest.bullets) || !latest.bullets.every((item) => typeof item === "string")
  ) {
    console.error("Invalid release feed; announcement state unchanged.");
    return undefined;
  }
  return {
    version: latest.version,
    message: latest.summary,
    websiteUrl: "https://plekt.net",
    details: latest.bullets,
  };
}

async function unstickPreviousPosts(appUsername: string | undefined): Promise<void> {
  if (!appUsername) return;
  const hot = await reddit.getHotPosts({ subredditName: SUBREDDIT, limit: 5 }).all();
  for (const post of hot) {
    if (post.stickied && post.authorName === appUsername) {
      await post.unsticky();
    }
  }
}

export async function checkAndAnnounceNewRelease(): Promise<void> {
  const entry = await fetchLatestEntry();
  if (!entry) return;

  const lastAnnounced = await redis.get(LAST_ANNOUNCED_KEY);
  if (lastAnnounced === undefined) {
    // First run of this app: record the current release as already known, so nothing old is posted.
    await redis.set(LAST_ANNOUNCED_KEY, entry.version);
    console.log(`Baseline set to v${entry.version}; no post made.`);
    return;
  }
  if (lastAnnounced === entry.version) return;

  const appUser = await reddit.getAppUser();
  await unstickPreviousPosts(appUser?.username);

  const { title, text } = buildPost(entry);
  const post = await reddit.submitPost({
    subredditName: SUBREDDIT,
    title,
    text,
    runAs: "APP",
  });
  await post.sticky(1);

  await redis.set(LAST_ANNOUNCED_KEY, entry.version);
  console.log(`Posted and stickied release v${entry.version} to r/${SUBREDDIT}.`);
}
