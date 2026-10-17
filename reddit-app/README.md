# Plekt release bot (Devvit app)

The `plekt-app` Devvit app posts release announcements to r/plekt. It makes no external
HTTP requests. Each build copies the current release entry from the repository root's
`changelog.json` into the app bundle: version, date, summary and bullets. The scheduled
announcement checks this bundled release against the Redis `lastAnnouncedVersion` value,
posts and pins a new version once, unpins the previous release post from the app, then
stores that version. On a fresh install with no stored version, the first check stores
the bundled version without posting.

Moderators can also choose **Post release announcement** from the r/plekt subreddit menu.
The form opens with version, title and body filled from the bundled release; moderators
can edit those fields before submitting. Manual posts do not change the scheduled
announcement version.

## Releasing an app version

Use Node.js 24 or newer. Bump the app version in `package.json` and the root package entry
in `package-lock.json`, then build, upload and install the uploaded version:

```powershell
Set-Location C:\Github\plembfin\reddit-app
npm run build:release
npm run test:types
npm test
npm run build
npx --no-install devvit upload
npx --no-install devvit install plekt "plekt-app@<uploaded-version>"
```

`npm run build:release` reads the current top entry in `../changelog.json` and writes
`src/generated/release.json`. `npm run build` runs this bundling step before Vite. The
uploaded app contains that release snapshot, so build and upload again to announce a
later Plekt release. The install command uses the exact version reported by `devvit
upload`; for this revision, that app version is **0.0.3**. Uploading and installing are
separate actions. This project request authorizes neither; do them only when specifically
requested.

The app's subreddit and scheduler configuration is in `devvit.json`. The scheduled task
runs every 15 minutes. Automatic announcements and manual form submissions are authored
by the app. Keep the app installed as a moderator in r/plekt with permission to submit
posts.

## Local checks

```powershell
npm run build:release
npm run test:types
npm test
npm run build
```

Tests use mocked Reddit and Redis APIs. They cover first-run baselining, duplicate
suppression, one-time posting for a new bundled version, manual form posting, and the
absence of outbound fetches.

## Files

- `src/core/release.ts` - bundled-release formatting and scheduled/manual post logic
- `src/index.ts` - moderator subreddit menu action and app server entry point
- `src/routes/scheduler.ts` - scheduled release check endpoint
- `scripts/bundle-release.mjs` - copies the current changelog entry into the app bundle
- `test/release.test.mjs` - mocked release flow tests
