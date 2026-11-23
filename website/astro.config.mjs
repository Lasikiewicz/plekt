import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";

const buildDate = new Date();

export default defineConfig({
  site: "https://plekt.net",
  output: "static",
  build: {
    format: "directory",
  },
  legacy: {
    collectionsBackwardsCompat: true,
  },
  integrations: [mdx(), sitemap({ serialize: (item) => ({ ...item, lastmod: buildDate }) })],
});
