# Privacy Policy — Plekt Release Bot

This Devvit app posts release announcements to r/plekt. It is operated by the
moderators of r/plekt for that subreddit.

## What the bot does

The app includes the current Plekt release notes in its uploaded build. On its
scheduled check, it compares that release version with its Reddit-hosted app storage.
If the version has not been announced, it submits and pins a text post to r/plekt,
unpins its previous release post and records the version. A moderator can also submit
an edited release announcement from the
subreddit menu.

## Data the bot accesses

- Bundled release notes: version, date, summary and change bullets from the Plekt
  changelog at build time.
- The app's stored last-announced version, used to suppress duplicate scheduled posts.
- Subreddit context needed to display the moderator-only menu action and submit posts.

## Data the bot stores

The app stores the version number it last announced or recorded as its initial
baseline. On first run with no stored version, it records the bundled version without
posting. It does not access, log or retain Reddit users' personal information,
messages or account details.

## Data the bot does not use

- It makes no external HTTP requests.
- It does not read or collect Reddit users' personal data.
- It does not share data with third parties.

## Contact

Questions can be sent via modmail to r/plekt.
