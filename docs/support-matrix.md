# Provider support matrix

What Plekt syncs with each provider: what moves, for which item types, in which direction, how
changes reach Plekt and how you sign in. Each provider has its own section, so a link such as
`support-matrix.md#simkl` goes straight to one of them.

## How Plekt differs

- **One record.** Plekt keeps your watch history once, locally. Every connected service is
  brought in line with that record.
- **No pairs.** You do not set up "Plex to Trakt" or "Emby to Jellyfin" links. Connect each
  service once and a change on any of them reaches all the others.
- **Every connected service in sync.** A watch, unwatch, rating or resume position made on one
  service is applied to every other service that supports it.

"Not yet" means Plekt does not do this today. It is not a promise of a date.

| Provider | Role | Section |
| --- | --- | --- |
| Plex | Media server | [Plex](#plex) |
| Emby | Media server | [Emby](#emby) |
| Jellyfin | Media server | [Jellyfin](#jellyfin) |
| Trakt | Watch tracker | [Trakt](#trakt) |
| Simkl | Watch tracker | [Simkl](#simkl) |
| Tautulli | One-time history import | [Tautulli](#tautulli) |
| Seerr | Requests | [Seerr](#seerr) |
| TMDB, TheTVDB, Fanart.tv, OMDb, YouTube, AniDB | Metadata | [Metadata sources](#metadata-sources) |

The media server, Tautulli and Seerr sections are written by hand from the provider pages
([Plex](plex.md), [Emby](emby.md), [Jellyfin](jellyfin.md)) and the code. The Trakt and Simkl
tables are generated from the trackers' capability tables by `npm run support-matrix`, and a
test fails when they drift from the code.

## Plex

| | |
| --- | --- |
| Direction | Both ways |
| Sign-in | Plex authorization with a PIN tied to a device key Plekt generates, or a manual server URL, token and account name |
| Changes arrive by | Plex webhooks (needs Plex Pass), the Plex notification WebSocket, and scheduled catch-up sync |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watched and unwatched state | Yes, both ways | movies, episodes |
| Resume position and Up Next | Yes, both ways | movies, episodes |
| Ratings | Yes, both ways | movies, shows, episodes |
| Watchlist | Yes, both ways, with the Plex account watchlist | movies, shows |
| Playlists | Yes, both ways | movies, episodes |
| Collections | Not yet | - |

Details: [plex.md](plex.md), [personal-ratings.md](personal-ratings.md),
[personal-watchlist.md](personal-watchlist.md).

## Emby

| | |
| --- | --- |
| Direction | Both ways |
| Sign-in | Emby username and password (Plekt keeps only the token), or a manual server URL, API key and user ID |
| Changes arrive by | The Plekt Emby plugin or Emby's built-in webhook, and scheduled catch-up sync |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watched and unwatched state | Yes, both ways | movies, episodes |
| Resume position and Up Next | Yes, both ways | movies, episodes |
| Ratings | Yes, both ways (see the note below) | movies, shows, episodes |
| Watchlist | No: Emby has no account watchlist, so the watchlist stays on Plex | - |
| Playlists | Yes, both ways | movies, episodes |
| Collections | Not yet | - |

Emby 4.9.5.0 and 4.10.1.0 accept a rating write without storing it, so ratings do not stick on
those versions. Plekt reads the item back after writing and flags the failure instead of reporting
success. This is a known Emby defect, described in [emby.md](emby.md).

Details: [emby.md](emby.md), [personal-ratings.md](personal-ratings.md),
[personal-watchlist.md](personal-watchlist.md).

## Jellyfin

| | |
| --- | --- |
| Direction | Both ways |
| Sign-in | Quick Connect, or Jellyfin username and password (Plekt keeps only the token), or a manual server URL, API key and user ID |
| Changes arrive by | The Plekt Jellyfin plugin or the Jellyfin Webhook plugin, and scheduled catch-up sync |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watched and unwatched state | Yes, both ways | movies, episodes |
| Resume position and Next Up | Yes, both ways | movies, episodes |
| Ratings | Yes, both ways | movies, shows, episodes |
| Watchlist | No: Jellyfin has no account watchlist, so the watchlist stays on Plex | - |
| Playlists | Yes, both ways | movies, episodes |
| Collections | Not yet | - |

Details: [jellyfin.md](jellyfin.md), [personal-ratings.md](personal-ratings.md),
[personal-watchlist.md](personal-watchlist.md).

## Trakt

Written from the Trakt adapter's capability table. Do not edit the block between the markers.

<!-- generated:tracker:trakt:start - run `npm run support-matrix`, do not edit by hand -->

| | |
| --- | --- |
| Direction | Both ways: Plekt reads your Trakt history and sends new watches, ratings and unwatches back |
| Sign-in | Device code: Plekt shows a code and you approve it on trakt.tv |
| Changes arrive by | scheduled sync, media-server events, your own actions (Check now, Sync now) |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watched state into Plekt | Yes | movies, episodes |
| Play history into Plekt, each play with its date | Yes | movies, episodes |
| Mark watched from Plekt | Yes | movies, episodes |
| Mark unwatched from Plekt | Yes | movies, episodes |
| Send a play with its original date | Yes | movies, episodes |
| Send repeat plays | Yes | movies, episodes |
| Ratings into Plekt | Yes | movies, shows, episodes |
| Set a rating from Plekt | Yes | movies, shows, episodes |
| Clear a rating from Plekt | Yes | movies, shows, episodes |
| Resume position | Not yet | - |
| Watchlist | Not yet | - |

<!-- generated:tracker:trakt:end -->

Dropped shows also sync both ways via Trakt's hidden dropped list (dropped movies stay local in
Plekt). Details: [settings.md](settings.md), [auth.md](auth.md), [personal-ratings.md](personal-ratings.md).

## Simkl

Written from the Simkl adapter's capability table. Do not edit the block between the markers.

<!-- generated:tracker:simkl:start - run `npm run support-matrix`, do not edit by hand -->

| | |
| --- | --- |
| Direction | Both ways: Plekt reads your Simkl library and sends new watches and ratings back |
| Sign-in | Device code: Plekt shows a code and you approve it on simkl.com |
| Changes arrive by | media-server events, your own actions (Check now, Sync now) |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watched state into Plekt | Yes | movies, episodes |
| Play history into Plekt, each play with its date | Not yet | - |
| Mark watched from Plekt | Yes | movies, shows, episodes |
| Mark unwatched from Plekt | Not yet | - |
| Send a play with its original date | Not yet | - |
| Send repeat plays | Not yet | - |
| Ratings into Plekt | Yes | movies, shows |
| Set a rating from Plekt | Yes | movies, shows |
| Clear a rating from Plekt | Yes | movies, shows |
| Resume position | Not yet | - |
| Watchlist | Not yet | - |

<!-- generated:tracker:simkl:end -->

Simkl only checks for changes when you ask or when a media server reports one; it is never
polled on a schedule. Ratings are sent only for a movie already completed with a known watch
date or a show already on a Simkl list, so a rating cannot create watched history by accident.
Dropped shows and movies also sync both ways with Simkl's Dropped list, restoring the title's
previous non-Completed list on un-drop. See [personal-ratings.md](personal-ratings.md) and
[settings.md](settings.md).

## Tautulli

| | |
| --- | --- |
| Direction | Into Plekt only |
| Sign-in | Tautulli server URL and API key, stored separately from the Plex connection |
| Changes arrive by | A one-time import you start yourself, with a preview before anything is written |

| What syncs | Status | Item types |
| --- | --- | --- |
| Watch history import | Yes, one time | movies, episodes |
| Anything sent back to Tautulli | No | - |

A local watch-history backup is made before a confirmed import. See [settings.md](settings.md).

## Seerr

Overseerr and Jellyseerr.

| | |
| --- | --- |
| Direction | Availability into Plekt, requests out of Plekt. No watch state moves. |
| Sign-in | Seerr server URL and API key |
| Changes arrive by | Your own actions: Plekt asks Seerr when you open a detail page or press Request |

| What syncs | Status | Item types |
| --- | --- | --- |
| Availability labels on detail pages | Yes | movies, shows |
| Requesting a title from Plekt | Yes | movies, shows |
| Watch state, ratings, watchlist, playlists | No | - |

See [media-detail.md](media-detail.md) and [settings.md](settings.md).

## Metadata sources

TMDB, TheTVDB, Fanart.tv, OMDb, YouTube and optional AniDB supply posters, summaries, episode
lists, trailer details and external ratings. They are read-only sources, not sync targets, so
they have no direction or watch state. What each one provides, how keys are entered and how
results are cached is in [metadata.md](metadata.md).
