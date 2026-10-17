import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createServer, getServerPort } from "@devvit/web/server";
import { Devvit } from "@devvit/public-api";
import { buildPost, currentRelease, submitReleasePost } from "./core/release";
import { scheduler } from "./routes/scheduler";

Devvit.configure({ redditAPI: true, redis: true });

const releaseForm = Devvit.createForm((data: Record<string, string>) => ({
  title: "Post release announcement",
  acceptLabel: "Post announcement",
  fields: [
    { type: "string", name: "version", label: "Version", defaultValue: data.version, required: true },
    { type: "string", name: "title", label: "Title", defaultValue: data.title, required: true },
    { type: "paragraph", name: "body", label: "Body", defaultValue: data.body, required: true },
  ],
}), async ({ values }, context) => {
  if (context.subredditName?.toLowerCase() !== "plekt") {
    context.ui.showToast("This action is only available in r/plekt.");
    return;
  }
  const version = values.version.trim();
  const title = values.title.trim();
  const body = values.body.trim();
  if (!version || !title || !body) {
    context.ui.showToast("Version, title and body are required.");
    return;
  }
  await submitReleasePost({ ...currentRelease, version }, title, body);
  context.ui.showToast(`Release announcement for v${version} posted.`);
});

Devvit.addMenuItem({
  label: "Post release announcement",
  location: "subreddit",
  forUserType: "moderator",
  onPress: (_event, context) => {
    if (context.subredditName?.toLowerCase() !== "plekt") {
      context.ui.showToast("This action is only available in r/plekt.");
      return;
    }
    const entry = currentRelease;
    const { title, text: body } = buildPost(entry);
    context.ui.showForm(releaseForm, {
      version: entry.version,
      title,
      body,
    });
  },
});

const app = new Hono();
const internal = new Hono();

internal.route("/scheduler", scheduler);

app.route("/internal", internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
