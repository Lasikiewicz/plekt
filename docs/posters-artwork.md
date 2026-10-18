# Posters & Artwork Pipeline

How every poster, backdrop, logo, and profile photo in the app gets fetched, resized,
cached, and rendered. This pipeline exists so the browser never loads images directly
from media servers (mixed content, LAN-only addresses, tokens in URLs) and so remote
artwork is fetched once, not per page view.

## Batch poster lookup (`POST /api/poster-batch`)

A library page renders many cards at once, and each missing poster used to be
its own `GET /api/poster` request: one `requireAdmin`, one media-config load and
one full lookup chain per card. `hydratePosterFallbacks` now coalesces a
viewport's worth of unresolved posters into a single `POST /api/poster-batch`
call before it hydrates any card.

The endpoint mirrors the existing `tmdb-details-batch` convention: `POST` only,
`requireAdmin`, at most 240 items, a bounded worker pool, and one result per
input position (`{ id, payload }`). Both routes share one resolver, so the
lookup order, the in-flight dedupe and the negative caching cannot drift apart
between them.

Only resolved URLs are written into the client's lookup cache. A miss is left
untouched so the per-card path can still run its own fallback lookup, and a
failed batch is not an error state: every card simply falls back to the
behaviour that existed before. The `format=image` redirect stays a single
request, since it is used directly as an `<img>` source and cannot be batched.

When such an `<img>` fails to load (the Movies and TV grids render cards this
way), the shared image error handler asks for a fallback URL through
`batchedFallbackPosterUrl`: failures arriving within 100 ms are sent as one
batch with `fallback: true` per item (up to 240, any overflow in a following
batch). A batch result, hit or miss, is remembered like a single fallback
lookup. A lone failure, a failed batch request, or an id missing from the
response uses the single `GET /api/poster?fallback=1` lookup as before, and
cache-only surfaces (`allowNetwork: false`) never queue a lookup.


## Files

| File | Role |
| --- | --- |
| `server/src/utils/posterCache.js` | Fetch → sharp resize → store in `data/media/` → record in `poster_cache` |
| `server/src/utils/mediaArtwork.js` | Resolve and persist canonical show posters (`media_artwork`) and per-season overrides (`season_artwork`) separately from episode artwork |
| `server/src/routes/seasonArtwork.js` | List saved season posters and gather season-specific options from TMDB, TVDB, and fanart.tv |
| `server/src/index.js` | `handlePoster` (`GET /api/poster`) - candidate resolution; `handleTmdbPoster` / `handleTmdbProfile` / `handleRemoteArtwork` proxies |
| `server/src/utils/tmdbClient.js` | TMDB poster-URL fallback lookup |
| `public/modules/images.js` | Frontend: `posterMarkup`, fallback hydration, lookup caching, TMDB URL builders |
| `server/server.js` | Static mount `/media` → `data/media/` (365-day immutable cache headers) |

## Backend: `GET /api/poster?id=<id>&variant=<poster|backdrop>`

`handlePoster` resolves `id` in this order: **watch record id → `media_key` →
`playback_progress` row → live session** (`findLiveSessionPosterRow` matches
`live_tracking_cache` / `active_sessions` - this is what lets a currently-playing item
that has never been watched still get a poster; see
[now-playing.md](now-playing.md)).

For the resolved row it tries candidates in order:

1. the stored `poster_url` on the row (which may already be a cached `/media/...` URL)
2. the configured media server's image endpoint (Plex thumb path / Emby / Jellyfin
   `Items/<id>/Images/Primary`)
3. TMDB fallback (`fetchPosterFromTmdb`)

The first candidate that downloads successfully goes through `cacheArtworkFromUrl`
(`posterCache.js`):

- Plex tokens are stripped from the URL and sent as an `X-Plex-Token` header
- body limits (10 MB), content-type checks, 12s timeout
- resized with **sharp** to webp - poster 340w/q80, backdrop 1600w/q82, profile
  780w/q82, logo 800w/q90 (falls back to the original bytes if sharp fails)
- newly fetched artwork is written to
  `data/media/posters|backdrops|profiles|logos/<sha256>.<ext>` and served at
  `/media/...`
- metadata recorded in the `poster_cache` table keyed by
  SHA-256(`mediaKey[:variant]`)

When an existing cache row is first read or written after this identifier change,
its database ID is re-keyed to SHA-256. Its stored image path remains unchanged, so
the cached file continues to work until artwork is fetched again.

**Missing files:** a `cached` row whose file is gone from `data/media/` is not served. The
`/media/*` route downloads it again from the row's `original_url` (for http(s) sources
only) and redirects to the new file. A missing file with no downloadable source returns
**404**, never the app page. `original_url` stores query values whose names contain `key`
or `token` as `redacted`, so a provider URL that carried an API key in its query cannot be
downloaded again; it returns 404 and the row is marked `failed`.

Canonical show and movie poster resolution also checks saved `/media/...` references
against the local file before returning them. If an old artwork override or metadata-cache
row points at a file that is absent from local storage, resolution falls through to the
provider poster path instead of repeatedly selecting the broken file.

**Negative caching:** failures are recorded as `failed` (retry after 24h) or `missing`
(retry after 7 days) so a dead lookup doesn't hammer upstream on every page view.
HTTP 429/503 are treated as transient and not persisted. `usableCachedPoster` only
trusts a `cached` row whose file still exists on disk.

The cache key is the **mediaKey** (canonical title + type + IDs), so a live session, a
history row, and a playstate row for the same item share one cached image.

TV Fix Match invalidates poster rows keyed by the old episode identity and queues the
selected TVDB series through the metadata warm-up path. The resolver passes the corrected
TVDB identity through to the TV poster fallback, so a dashboard card can recover the
canonical show poster by identity instead of waiting for an ambiguous title search. The
interactive match dialog refreshes the dashboard snapshot after the warm-up request
completes when the metadata provider is reachable.

## Backend: `GET /api/remote-artwork?url=<url>&variant=<poster|logo|backdrop>`

fanart.tv and TVDB return absolute CDN URLs rather than image paths. `handleRemoteArtwork`
downloads those through the same `cacheArtworkFromUrl` pipeline and redirects to the
resulting `/media/...` URL, so the browser only ever loads artwork from this app. The
host allowlist is `assets.fanart.tv`, `artworks.thetvdb.com`, and `image.tmdb.org`; any
other host is rejected with 400. Requests for the same URL are deduped while in flight,
and a URL that cannot be downloaded returns **404** rather than a placeholder image, so
the caller's own fallback (the title heading, or hiding a gallery tile) still applies.
The negative cache keeps a repeat request for an unreachable image fast, and the 404
carries a 10-minute `Cache-Control` so a page reload does not re-request it while a
recovered upstream host is still picked up promptly.

## Frontend (`public/modules/images.js`)

- `posterMarkup(item)` renders an `<img>` when a usable URL is known, otherwise a
  `poster-fallback` span carrying a `data-poster-id`.
- Every rendered poster carries the `poster-img` class, which draws an animated loading
  skeleton until the bitmap decodes. A `load` listener in `app-events.js` adds
  `is-loaded` to end it; the error path clears it too, so a failed image does not keep
  animating. The skeleton honours `prefers-reduced-motion`.
- Media detail artwork uses the same loading treatment for hero posters, season and episode
  thumbnails, cast images, trailer thumbnails, and gallery images. Each image keeps its
  reserved box while loading so a slow artwork response is visibly pending rather than blank;
  reduced-motion users receive a static skeleton.
- `proxiedArtworkUrl(url, variant)` rewrites fanart.tv and TVDB CDN URLs to
  `/api/remote-artwork`. Local `/media` and TMDB URLs pass through unchanged. Show and
  movie logos and the Edit Images gallery tiles all render through it, while the saved
  value stays the original upstream URL. Artwork the proxy could not fetch is remembered
  for the session (`markArtworkUnavailable`, recorded by the image error handler), and
  `proxiedArtworkUrl` then returns an empty string for it - a detail page that renders
  several times as its parts arrive requests a dead image once, not once per render.
- `bestTmdbLogo(tmdbData)` accepts English and language-neutral logos only. A title
  whose only TMDB logo art is in another language renders its text heading instead.
- `hydratePosterFallbacks(container)` finds fallback spans and calls
  `lookupPosterUrl(posterId)` → `GET /api/poster` - deduped in-flight
  (`state.posterLookupInflight`), cached in memory (`state.posterLookupCache`) and in
  localStorage so revisits skip the API entirely
  (`clearPersistentPosterLookupCache` resets it).
- Explorer/dashboard views gate hydration behind IntersectionObservers so only visible
  cards trigger lookups.
- `bindPosterImageErrorHandler` swaps a broken `<img>` back to the fallback path.
- `configuredImageUrl` builds direct media-server image URLs for contexts where the
  server URL is known and same-origin rules allow it (the CSP `img-src` is extended at
  runtime with configured server origins - see [architecture.md](architecture.md)).
- **`isCachedStorageImageUrl()` returns `true` only for `/media/posters/` and
  `/media/backdrops/` URLs. TMDB `image.tmdb.org` URLs are NOT treated as cached.**
  Code that decides whether artwork still needs caching must use this helper.

## Custom artwork

Media detail pages let the user pick artwork from TMDB/TVDB/Fanart galleries
(`edit-dialogs.js` → `openEditImageDialog`, endpoints `GET /api/tmdb-images`,
`/api/tvdb-images`, `/api/fanart-images`). A show's selected poster is stored in
`media_artwork` through `POST /api/update-watch` with `artwork_scope: "show"`.
Provider aliases and the normalized show title point to the same canonical value,
so TV-show cards, the library, dashboard fallbacks, and personal show entries use
the edit everywhere. Episode rows keep their own `watch_history.poster_url`, so
episode stills are not overwritten by a show-poster edit. History, dashboard, and upcoming
episode cards carry a separate `season_poster_url` resolved by `getCanonicalSeasonPosterUrls()`.
Saved season overrides in `season_artwork` take precedence over cached provider art and are
keyed by show identity alias and season number. The Edit Images **Season Posters** tab stores
these selected overrides.
Show-level library cards and detail headers explicitly keep the shared series poster. Movie artwork remains
stored on its watch rows and is propagated across repeated plays as before.
Data-URL uploads are also accepted and persisted through `cacheArtworkFromUrl`.

## Profile photos

Cast profile images go through `GET /api/tmdb-profile` (rate-limited, cached under the
`profiles/` variant) - same pipeline, `profile` variant.

## Troubleshooting

Missing/wrong posters: see the poster section of
[troubleshooting.md](troubleshooting.md). Useful checks: the `poster_cache` row for the
mediaKey (`status`, `detail`, `original_url`), whether the file exists under
`data/media/`, and whether the negative-cache TTL is suppressing retries.
