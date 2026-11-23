import { getCollection, type CollectionEntry } from "astro:content";
import type { APIRoute } from "astro";
import { docsNav } from "../../data/site.js";

const getEntrySlug = (entry: CollectionEntry<"docs">) => entry.id.replace(/\.(?:md|mdx)$/i, "");

export const GET: APIRoute = async () => {
const entries = await getCollection("docs");
const docsBySlug = new Map(entries.map((entry) => [getEntrySlug(entry), entry]));
type HeadingInfo = { level: number; text: string };
type NavChild = { id: string; label: string; children?: NavChild[] };
type NavItem = { slug: string; label: string; description: string; children?: NavChild[] };
type NavSection = { label: string; items: NavItem[] };
type SearchPage = { slug: string; label: string; body: string };
type SectionSearchEntry = NavChild & {
  section: string;
  body: string;
  excerpt: string;
  headingPath: string[];
  href: string;
  kind: "section";
  pageLabel: string;
  pageSlug: string;
};

const stripSearchMarkup = (value: unknown) => String(value || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/[\\*_`>#-]/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const headingFromLine = (line: string): HeadingInfo | null => {
  const normalizedLine = line.trim();
  const markdownHeading = normalizedLine.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
  if (markdownHeading) return { level: markdownHeading[1].length, text: markdownHeading[2] };
  const htmlHeading = normalizedLine.match(/^<h([2-6])(?:\s+[^>]*)?>(.*?)<\/h\1>$/i);
  if (htmlHeading) return { level: Number(htmlHeading[1]), text: htmlHeading[2] };
  return null;
};
const headingSlug = (value: unknown) => stripSearchMarkup(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const truncateSearchText = (value: unknown, limit = 420) => {
  const text = stripSearchMarkup(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "")}…`;
};
const extractSectionBody = (body: unknown, id: string) => {
  const lines = String(body || "").split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const heading = headingFromLine(line);
    return heading && (headingSlug(heading.text) === id || line.includes(`id="${id}"`));
  });
  if (start < 0) return null;

  const startHeading = headingFromLine(lines[start]);
  const end = lines.findIndex((line, index) => {
    if (index <= start) return false;
    const heading = headingFromLine(line);
    return heading && startHeading && heading.level <= startHeading.level;
  });
  return lines.slice(start + 1, end < 0 ? lines.length : end).join(" ");
};
const collectSectionEntries = (children: NavChild[], page: SearchPage, section: string, parentHeadings: string[] = []): SectionSearchEntry[] => children.flatMap((child) => {
  const sectionBody = extractSectionBody(page.body, child.id);
  const headingPath = [...parentHeadings, child.label];
  return [
    ...(sectionBody === null ? [] : [{
      ...child,
      section,
      body: stripSearchMarkup(sectionBody),
      excerpt: truncateSearchText(sectionBody),
      headingPath,
      href: `/docs/${page.slug}/#${child.id}`,
      kind: "section" as const,
      pageLabel: page.label,
      pageSlug: page.slug,
    }]),
    ...collectSectionEntries(child.children || [], page, section, headingPath),
  ];
});
const docsSearchEntries = (docsNav as NavSection[]).flatMap((section) => section.items.flatMap((item) => {
  const entry = docsBySlug.get(item.slug);
  if (!entry) return [];

  const page = {
    ...item,
    section: section.label,
    body: entry.body ?? "",
    excerpt: item.description,
    headingPath: [item.label],
    href: `/docs/${item.slug}/`,
    kind: "guide",
    pageLabel: item.label,
    pageSlug: item.slug,
  };

  return [{ ...page, body: stripSearchMarkup(page.body) }, ...collectSectionEntries(item.children || [], page, section.label)];
}));
const navSlugs = new Set((docsNav as NavSection[]).flatMap((section) => section.items.map((item) => item.slug)));
const extraEntries = entries.filter((entry) => !navSlugs.has(getEntrySlug(entry)));
const extraGroup = (slug: string) => slug.startsWith("settings/") ? "Settings" :
  slug.startsWith("movies/") || slug.startsWith("tv-shows/") ? "Features" : "Guides";
const extraSearchEntries = extraEntries.map((entry) => {
  const slug = getEntrySlug(entry);
  return { kind: "guide", label: entry.data.title, headingPath: [entry.data.title], pageSlug: slug,
    pageLabel: entry.data.title, section: extraGroup(slug), body: stripSearchMarkup(entry.body ?? ""),
    excerpt: entry.data.description, href: `/docs/${slug}/` };
});
return new Response(JSON.stringify([...docsSearchEntries, ...extraSearchEntries]), {
  headers: { "Content-Type": "application/json; charset=utf-8" },
});
};
