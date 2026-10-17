import { reddit, redis } from "@devvit/web/server";
import release from "../generated/release.json";

const SUBREDDIT = "plekt";
const LAST_ANNOUNCED_KEY = "lastAnnouncedVersion";

type ReleaseEntry = {
  version: string;
  date: string;
  summary: string;
  bullets: string[];
};

const currentRelease = release as ReleaseEntry;

function bulletList(items: string[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const item of items) {
    const line = `- ${item}`;
    if (used + line.length + 1 > 3000) {
      lines.push(`- …and ${items.length - lines.length} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export function buildPost(entry: ReleaseEntry, title = `Plekt v${entry.version} released`, body?: string) {
  const text = body ?? [entry.summary, bulletList(entry.bullets),
    "[View the full changelog](https://github.com/Lasikiewicz/plekt/blob/main/CHANGELOG.md)"]
    .filter(Boolean).join("\n\n");
  return { title: title.trim().slice(0, 300), text: text.trim() };
}

export async function checkAndAnnounceNewRelease(): Promise<void> {
  const entry = currentRelease;
  const lastAnnounced = await redis.get(LAST_ANNOUNCED_KEY);
  if (lastAnnounced === undefined) {
    // First run with no recorded version sets a baseline without publishing old news.
    await redis.set(LAST_ANNOUNCED_KEY, entry.version);
    console.log(`Baseline set to v${entry.version}; no post made.`);
    return;
  }
  if (lastAnnounced === entry.version) return;

  const appUser = await reddit.getAppUser();
  await unstickPreviousPosts(appUser?.username);
  const post = await submitReleasePost(entry);
  await post.sticky(1);
  await redis.set(LAST_ANNOUNCED_KEY, entry.version);
  console.log(`Posted and stickied release v${entry.version} to r/${SUBREDDIT}.`);
}

async function unstickPreviousPosts(appUsername: string | undefined): Promise<void> {
  if (!appUsername) return;
  const hot = await reddit.getHotPosts({ subredditName: SUBREDDIT, limit: 5 }).all();
  for (const post of hot) {
    if (post.stickied && post.authorName === appUsername) await post.unsticky();
  }
}

export async function submitReleasePost(entry: ReleaseEntry, title?: string, body?: string) {
  const { title: postTitle, text } = buildPost(entry, title, body);
  return reddit.submitPost({ subredditName: SUBREDDIT, title: postTitle, text, runAs: "APP" });
}

export { currentRelease };
