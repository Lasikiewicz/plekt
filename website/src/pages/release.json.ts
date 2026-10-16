import type { APIRoute } from "astro";
import release from "../generated/release.json";

export const GET: APIRoute = () => {
  if (release.version !== release.entries[0]?.version) {
    throw new Error("Release feed version must match the latest stable entry.");
  }
  // Alpha release data is deliberately excluded from the public stable feed.
  const { version, date, summary, entries } = release;
  return new Response(JSON.stringify({ version, date, summary, entries }) + "\n", {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
