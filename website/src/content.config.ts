import { defineCollection } from "astro:content";
import { z } from "astro/zod";

const docs = defineCollection({
  type: "content",
  schema: z.object({
    title: z.string(),
    seoTitle: z.string().optional(),
    heading: z.string().optional(),
    description: z.string(),
    category: z.string(),
    order: z.number(),
    sourceVersion: z.string(),
    sourcePaths: z.array(z.string()),
    screenshots: z.array(z.string()).default([]),
  }),
});

export const collections = { docs };
