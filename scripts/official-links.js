// The official Plekt places, shown as one row wherever a release entry used to say
// "Visit the Plekt website": CHANGELOG.md, the GitHub release notes and the Discord
// release post. The in-app changelog keeps its own copy in
// public/modules/changelog-channels.js (the browser cannot import from scripts/);
// test/officialLinks.test.js fails if the two lists drift apart.

export const OFFICIAL_LINKS = [
  { label: "Plekt.net", url: "https://plekt.net" },
  { label: "Discord", url: "https://discord.gg/7ZmEGKcRC5" },
  { label: "Reddit", url: "https://www.reddit.com/r/plekt/" },
  { label: "GitHub", url: "https://github.com/Lasikiewicz/plekt" },
];

export function officialLinksMarkdown() {
  return OFFICIAL_LINKS.map(({ label, url }) => `[${label}](${url})`).join(" · ");
}
