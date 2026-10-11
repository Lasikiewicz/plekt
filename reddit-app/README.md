# Plekt release bot (Devvit app)

A small [Devvit](https://developers.reddit.com) app installed only in r/plembfin. On a
schedule, it checks the public `changelog.json` in this repository; when a new release
has been published, it posts a release announcement to r/plembfin and pins it,
un-pinning whichever earlier release post it had pinned before.

This is a separate deployable from the main Plekt app - it runs on Reddit's own
infrastructure (not this repo's server or CI), and is built/deployed with the `devvit`
CLI rather than `npm start`/Docker.

## Why this exists instead of a GitHub Actions → Reddit API call

The equivalent of `scripts/notify-discord-release.js` (a script called directly from
`update-changelog.yml`) doesn't work for Reddit: Reddit's Data API now requires a
manual review to grant script-app access, and that review was declined for this use
case with a recommendation to use Devvit instead. Devvit apps get built-in, pre-approved
Reddit API access once installed by a moderator - no separate API credentials needed -
but only apps built on Devvit's own platform get that; there's no way for an external
system (like this repo's CI) to push a trigger into a Devvit app; it has to poll on a
schedule instead, hence the cron job here rather than an instant post-release trigger.

## How posting works

- `runAs: "APP"` in `submitPost` means the post is authored by the app's own built-in
  Reddit identity, not any particular moderator's account. The `u/plembfin-releases`
  account created earlier isn't needed for this - it can be left alone or removed as a
  moderator invite.
- The last-announced version is stored in the app's own Redis-backed storage
  (`redis.get`/`redis.set` in `src/core/release.ts`), scoped to this one subreddit
  installation. There's no shared state file in this repo to keep in sync.
- On first install, if a release has already been published, the bot will immediately
  post an announcement for whatever is currently the newest entry in `changelog.json`
  the first time its scheduled job runs (up to 15 minutes after install) - that's
  expected, not a bug.

## One-time setup

You'll need Node.js 24+ and to be logged in as a moderator of r/plembfin (your main
account is fine - the bot posts as itself, not as whoever runs these commands).

```bash
cd reddit-app
npm install
npm run login          # opens a browser to log in via devvit login
```

### Test it first (recommended)

```bash
npm run dev             # devvit playtest - creates/uses a test subreddit
```

This gives you a link to a test subreddit where you can trigger the scheduled job
manually and confirm it posts and pins correctly before touching r/plembfin.

### Deploy for real

```bash
npm run deploy           # type-checks, then `devvit upload`
```

The first upload will prompt for:

- An app icon (optional, can skip).
- **Terms & Conditions** and **Privacy Policy** URLs - once this folder is pushed to
  `main`, use:
  - `https://github.com/Lasikiewicz/plekt/blob/main/reddit-app/TERMS.md`
  - `https://github.com/Lasikiewicz/plekt/blob/main/reddit-app/PRIVACY.md`
- Approval for the `raw.githubusercontent.com` HTTP domain this app requests in
  `devvit.json`. Reddit reviews new domain requests within 1-2 business days
  (see [`http-fetch` docs](https://developers.reddit.com/docs/capabilities/server/http-fetch)).
  The app can be installed before approval lands, but its scheduled job will fail to
  fetch the changelog (and simply do nothing) until the domain is approved.

Once uploaded, install it to r/plembfin from
`https://developers.reddit.com/apps/plembfin-release-bot` (or via
`npm run launch` to publish it, if you want it listed), and grant it moderator
permissions when prompted so it can pin/un-pin posts.

## Files

- `devvit.json` - app manifest: scheduler cron task, permissions (`reddit`, `redis`,
  `http` domain allowlist)
- `src/index.ts` - Hono server entrypoint, mounts the scheduler route
- `src/routes/scheduler.ts` - the `/internal/scheduler/check-new-release` endpoint
  `devvit.json`'s cron task calls
- `src/core/release.ts` - the actual logic: fetch changelog, dedupe against Redis,
  un-sticky the previous post, submit and sticky the new one

The product is now Plekt. The existing Devvit app id, subreddit names and bot identity remain unchanged; this rebrand changes announcement copy and repository links.
