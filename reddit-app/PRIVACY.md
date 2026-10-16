# Privacy Policy — Plekt Release Bot

This Devvit app ("the bot") posts release announcements to r/plekt. It is operated
by the moderators of r/plekt for that single subreddit.

## What the bot does

On a fixed schedule, the bot fetches a public JSON file
(`release.json`) from [plekt.net](https://plekt.net/release.json). If it contains a
release the bot hasn't announced yet, the bot submits a text post to r/plekt
describing that release, and pins it (un-pinning whichever earlier release post the
bot itself previously pinned).

## Data the bot accesses

- The public `release.json` file on plekt.net. This file
  contains only release notes - version numbers, dates, and a description of
  code changes. It contains no personal or user data of any kind.
- Public Reddit content in r/plekt (post listings), to determine which post, if
  any, it previously pinned.

## Data the bot stores

The bot stores one value in its own Reddit-hosted app storage: the version number of
the release it last announced or recorded as its initial baseline, so it doesn't post
the same release twice. The first successful check records a baseline without posting. It stores no
other data, and does not access, log, or retain any Reddit user's personal information,
messages, or account details.

## Data the bot does not do

- It does not read, collect, or store any Reddit user's personal data.
- It does not make requests to any domain other than the one required to read the
  public changelog file.
- It does not share data with any third party.

## Contact

Questions can be sent via modmail to r/plekt.
