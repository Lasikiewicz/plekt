# Metadata Sources (TMDB, TheTVDB, Fanart.tv, OMDb, YouTube)

Where movie/TV metadata comes from, how the sources are split, and how everything is
cached. The frontend never talks to a metadata API directly - the server proxies and
caches every source (the CSP is `connect-src 'self'`).

## Files

AniDB is an optional, anime-only source of titles and descriptions (Settings > Metadata
providers > AniDB, off by default). It never changes seasons, episode numbering, artwork,
watch history or outbound identities. A movie or show uses AniDB only through a match the
user previewed and confirmed (`anidb_matches`), automatically for movies through a unique
Wikidata TMDB movie ID/AniDB ID link whose AniDB entry has type Movie, or when its cached TVDB
series record carries exactly one AniDB link and the cached AniDB entry covers the same
number of regular episodes. Anything else keeps the existing TMDB/TVDB metadata; there is
no title-based matching. Matched detail pages show the AniDB title as text (not the logo),
the AniDB description, and an attribution line linking the entry and CC BY-NC-SA 4.0.

Files: `anidbGateway.js` (registered HTTP client `plekt` v1, request deduplication and
last-good fallback), `anidbProtocol.js` (bounded XML normalization), `anidbRepository.js`
(SQLite cache, daily request guards and cross-process pacing), `anidbMatches.js` (saved
and automatic match resolution), `anidbMovieMatches.js` (movie-only Wikidata lookup),
`anidbBackup.js` (backup collections) and
`routes/anidb.js` (`/api/anidb/status|settings|preview|matches|enrich|cache`, admin only,
disabled in demo mode). The browser side is `public/modules/anidb-settings.js` (Settings
card) and `anidb-metadata.js` (one bounded `/api/anidb/enrich` call per TMDB detail batch).
The gateway refreshes at most once per 24 hours per entry and at most one request every
two seconds; failures retain the last successful metadata without extending its success
timestamp. Request guards and provider cooldowns are separate from cached payloads, so
clearing the AniDB cache or a factory reset cannot bypass AniDB limits; saved matches
survive a cache clear. Backups carry the cache, guards and matches, and a restore only
moves guards forward. AniDB data terms are separate from Plekt's code license.
AniDB's [data-use policy](https://anidb.net/policy) permits donations only to cover operating
costs, and prohibits profit and paid features/services. Plekt's sponsorship is used only
for operating costs (confirmed 22 October 2026); reassess these terms if that model changes.
Unlicensed third-party mapping datasets and AniDB artwork are not included. Wikidata structured IDs
are [CC0](https://www.wikidata.org/wiki/Help:Data_access). Movie lookup uses P4947 and
P5646 on the same entity; multiple results remain unresolved. Saved confirmations take
priority. The bounded process-local lookup cache retains positive/negative results for
24 hours and resets on restart; cache-only reads never query Wikidata. Failed lookups
pause queries for at least 15 minutes (longer Retry-After is respected) and keep existing
metadata. Automatic lookup results are derived data, not saved confirmations or backup data.

| File | Role |
| --- | --- |
| `server/src/utils/tmdbGateway.js` | TMDB gateway + merged TV details assembly, discovery feeds, collection search/details; caches in `tmdb_metadata_cache`, `tmdb_search_cache`, `tmdb_person_cache` |
| `server/src/utils/tvdbGateway.js` | TheTVDB v4 gateway; caches in `tvdb_metadata_cache`, `tvdb_season_cache` |
| `server/src/utils/fanartGateway.js` | Fanart.tv artwork (posters, season posters, backdrops, HD logos); caches in `fanart_cache` |
| `server/src/utils/omdbGateway.js` | OMDb - IMDb rating/votes by IMDb id (`omdb_cache`, 7-day TTL) |
| `server/src/utils/nextAiringCache.js` | File-backed next-airing cache used to narrow Upcoming page episode lookups |
| `server/src/utils/tmdbClient.js` | Thin poster-URL helper for the poster pipeline's TMDB fallback |
| `public/modules/tmdb.js` | Frontend fetch + in-memory cache over the `/api/tmdb-*` endpoints |

## What the cached TMDB document holds

The cached document is trimmed before it is stored, so the detail pages are not
paying to carry data nothing renders:

- Streaming availability is kept only for the regions the detail page reads
  (`GB` and `US`). TMDB returns every country it knows about, which was the single
  largest field in a movie document.
- The release-dates block is dropped; nothing in the server or the SPA reads it.
- `status`, `poster_path`, `backdrop_path` and the cached artwork URLs are mirrored
  into their own columns on every write, so grid and card paths read those instead
  of parsing the whole document.

Existing rows were rewritten in place on upgrade rather than being re-fetched, so
no title is requested from TMDB again to gain the smaller shape.

**Resolving a show's TVDB id.** TV details are cached against the TVDB series id,
so that id has to be known before the cache can answer. When a caller supplies only
a TMDB id, the id is read from the already-cached document first; the upstream
lookup runs only when it genuinely is not known yet. That lookup asks TMDB for the
full appended payload, so leaving it on the hot path cost roughly 300ms on every
show and episode page load, cached or not.


## Who provides what

| Data | Movies | TV shows |
| --- | --- | --- |
| Title, overview, status, network, genres, artwork | TMDB | **TheTVDB** (prefer its English series overview when available) |
| Season/episode numbering, titles, overviews, air dates | - | **TheTVDB** |
| Cast/credits, trailers, reviews, recommendations, watch providers, content ratings | TMDB | TMDB |
| Extra artwork (posters/backdrops/logos gallery) | TMDB + Fanart.tv | TMDB + TVDB + Fanart.tv |
| IMDb rating badge | OMDb | OMDb |
| Trailer titles/metadata | YouTube Data API | YouTube Data API |

The split is invisible to callers: `getTmdbDetails()` / `getTmdbSeason()`
(`tmdbGateway.js`) return one merged shape for TV, keyed by TMDB id, so every caller
(routes, frontend, `deriveNextAiring`) is unaware of the split. TheTVDB's numbering is
deliberately preferred because it is more accurate than TMDB's own for many shows.

The Netflix CSV importer is a separate matching path: it keeps TMDB episode coordinates.
`netflixImport.js` orchestrates previews, review and commit; `netflixCsv.js` owns CSV and
label parsing, and `netflixEpisodes.js` owns episode matching and season evidence. Existing
importer exports remain available from `netflixImport.js`.
For combined `A / B` rows only, an unmatched segment may drop its known show prefix and
grammatical filler (`the`, `a`, `an`, `and`, `of`); remaining words must agree in order.
Every segment must uniquely identify a different episode in the allowed season, or the
whole bundle stays in review without a whole-row number or neighbour fallback.
Reversed segment order can match one provider episode only when it contains the same complete
set of distinct segment keys in the allowed season; missing, extra or competing bundles stay in review.
`netflixEpisodeAliases.js` adds linked TVDB episode names as alternate titles only when a
unique episode remote ID or unique exact air date maps them to a TMDB episode. It does not
copy TVDB numbering into a TMDB watch identity. Missing or conflicting mappings retain the
original TMDB data and leave the row reviewable.
`server/resources/netflix-episode-title-aliases.json` also records sourced episode-title
variants, including broadcaster-confirmed Ghost Wars titles, officially paired Winx Club
dub names and The Hive's Mamma/Mama spelling. Each entry requires its TMDB show and unique episode
ID, the expected current canonical title, and its recorded air date when supplied. These
aliases survive TVDB outages, preserve provider coordinates, and are ignored on identity or
title conflicts. They do not enable general prefix or fuzzy matching.
Its `rows` registry pins complete Netflix source titles to verified episode identities for
standalone specials, Big Al's separate mini-series, LEGO Friends and SpongeBob release-order
differences. All targets require a unique episode ID, exact canonical title and air date, and
must have aired by the watch date. Any failed target leaves the complete row on the normal
review path. Current metadata supplies the coordinates; Netflix's labels are never copied.
The registry also disambiguates verified named rows for Sirens, Starstruck, Medal of Honor
and Go, Diego, Go. Don't Tell the Bride entries have a pre-2021 watch window because the
couples' names were reused in later retrospective episodes; later watches remain reviewable.
When no search result has the exact Netflix
show or film name, `getTmdbAlternativeTitles` (`tmdbGateway.js`, `{movie|tv}/{id}/alternative_titles`,
cached 30 days in the metadata cache under a key with no TMDB id) is read for the top five
results, and a result listing the exact name counts as an exact match.
When an exact show is missing coordinates explicitly named by the CSV, its recorded Netflix
aliases are searched too. Empty metadata is not evidence against a show; the original candidate
is retained and the existing structure/episode checks must still establish a single survivor.
Longer search titles containing every query word in order may enter the same evidence
comparison, without becoming exact title matches. Distinct named segments of one complete
bundle count independently; generic Episode N segments, incomplete bundles and tied shows
remain unresolved. This recovers Pocoyo's named bundle and the individually named DreamWorks
Spooky Stories shorts, while leaving its unspecified Play All program for review.
Episode-evidence selection also rejects a suggested series with a known release year
later than the CSV watch, so a future namesake cannot bypass the watch-date guard.

`netflixCatalogue.js` reads `server/resources/netflix-catalogue.json` lazily for Netflix CSV
imports. The snapshot records five official engagement-report sources, workbook SHA-256 hashes,
paired bilingual titles, their original report labels and `releaseYears` (the years in the
reports' Release Date column, Netflix's own premiere of a film or season; licensed titles usually
have none). It excludes Other aggregate rows and the unclassified combined 2023 H1 sheet. Only
positive title/alias evidence is used; there are no Netflix IDs in these workbooks. Existing
same-name TMDB candidates remain reviewable unless episode evidence, a hard fact, or the
"Netflix title + clear winner" rule (`reportedCandidates`, see docs/settings.md and
docs/decisions.md entry 54) resolves them. Missing/unreadable snapshot data retains the previous matching behavior.

Refresh the bundled snapshot with `python scripts/update-netflix-catalogue.py` (Python 3,
standard library only). The updater caches official workbooks outside the repository and
records skipped sources. `--generated-at <ISO-UTC-time>` makes regeneration reproducible.
Imports read the snapshot offline rather than downloading workbooks for each preview.
`server/resources/netflix-title-aliases.json` separately keeps title pairs supported by
Netflix pages, with UFA producer corroboration for Charité at War / Charité, alongside
Trolls Holiday Special / Trolls Holiday. Sources require Netflix and accept only Netflix
or UFA URLs. Charité at War's six episode titles establish the existing season map to
Charité season 2; the alias does not copy Netflix season numbers. These pairs recover exact-title searches but never count as engagement-report
presence or premiere-year evidence for the clear-winner rule. Remakes remain ambiguous.

- `id` on a TV show's details is always the resolved TMDB ID (via TheTVDB's `remoteIds`,
  or the caller-supplied ID), since Seerr requests and `/tvshow/tmdb/:id` routing are
  TMDB-keyed. TheTVDB's `remoteIds` mapping is community-submitted and occasionally
  points at a stale/incorrect TMDB id; `getTvShowDetails` verifies it by fetching that
  id and, if it 404s, falls back to a TMDB title search and uses the corrected id -
  otherwise cast/trailers/images would silently stay empty for that show.
- A "Specials" (season 0) entry is only included in a show's `seasons` list when
  TheTVDB actually has episodes attached to it - an empty placeholder season is
  dropped rather than shown as a dead, always-empty accordion row.
- `DETAILS_SCHEMA_VERSION` bumping is described under [Caching](#caching); no manual
  cache clearing is needed after an upgrade that changes the cached shape.

## API keys

- **TMDB** - user-supplied key (Settings → Metadata or `TMDB_API_KEY`). Required for
  metadata-rich pages.
- **TheTVDB** - works out of the box via a built-in shared project key
  (`TVDB_PROJECT_KEY` overrides it); a personal key (Settings or `TVDB_API_KEY`) takes
  precedence and raises the personal rate limit. Bearer tokens are cached ~25 days,
  keyed by a fingerprint of the key in use.
- **Fanart.tv** - built-in shared project key (`FANART_PROJECT_KEY` overrides); an
  optional personal key is passed as `client_key` for a higher limit.
- **OMDb** - optional user key (Settings → Metadata or `OMDB_API_KEY`); enables the
  IMDb rating pill.
- **YouTube** - optional user key; enables trailer metadata via `GET /api/youtube-meta`
  (key sent as an `X-goog-api-key` header, never in the URL).

## Caching

Every gateway throttles requests, de-duplicates in-flight calls (`inflight` maps), and
caches in SQLite:

| Cache table | Contents | TTL |
| --- | --- | --- |
| `tmdb_metadata_cache` | Merged details per item, keyed by `movie_<id>` / `tv_<id>` with TVDB aliases (or `tv_tvdb_<id>` when no TMDB match), stamped with `DETAILS_SCHEMA_VERSION` | 1 day for airing/in-production shows; longer for ended/released |
| `tmdb_search_cache` | Search responses, including negative results, Discover snapshots keyed by feed type/genre, and per-title recommendation responses | Searches: 15 min (1 day for misses); Discover: 15 min with stale-while-revalidate; recommendations: 6 hours (1 day for misses) |
| `tmdb_person_cache` | Person details + credits, `PERSON_SCHEMA_VERSION` | 7 days |
| `tvdb_metadata_cache` | Raw TVDB series/extended responses, English series-overview translation state, and title-search results | Series: 14 days active / 180 days archived; English synopsis: 30 days for available/missing translations, 15 minutes after provider errors; searches 180 days (1 hour for misses; the movie page's Recommended TV Shows lookup, sent with `relatedTvLookup`, reads a miss for 7 days) |
| `tvdb_season_cache` | TVDB season episode lists, built from the cached series payload's episodes (one TVDB call covers every season, stamped with the series fetch time; a series row older than the season TTL is refetched once first); seasons absent from that payload use `/v4/seasons/{id}/extended` | 2 days upcoming / 7 days active / 180 days archived |
| `fanart_cache` | Raw fanart.tv responses per item, key `movies/<tmdbId>` / `tv/<tvdbId>`, including "no artwork" 404 misses | 7 days (1 day for misses) |
| `omdb_cache` | IMDb rating/votes, including HTTP-error negatives (bad key / exhausted quota) | 7 days (6 hours for HTTP errors) |
| `youtube_meta_cache` | Trailer metadata per video ID (oEmbed + optional Data API fields) | 30 days |

Schema-version bumps (`DETAILS_SCHEMA_VERSION`, `PERSON_SCHEMA_VERSION`,
`PROGRESS_CACHE_SCHEMA_VERSION` in `showProgressCache.js`) force refetches after a
shape change - never hand-edit cache rows to migrate them.

TV show pages prefer the English series synopsis from TheTVDB's
`/series/{id}/translations/eng` endpoint when that translation has an overview.
If it is missing, Plekt uses the overview from the regular extended-series
response. A provider error also falls back to that overview and retries the
translation lookup after 15 minutes; a previously cached English synopsis stays
usable during the error. Translation cache state lives in the series row and
does not extend the structural series cache TTL. The `Language` fact continues
to show TMDB's original-language code, so an English synopsis can appear beside
`JA` for a Japanese-language show.

Discover snapshots use versioned keys (`discover:v2|<type>|<genre>`) in
`tmdb_search_cache`. A normal `/api/discover` request returns the last successful
snapshot immediately, starts a background refresh when that snapshot is older than
15 minutes, and only increments the shared `cache_versions.discover` generation when
the feed payload changes. The same response adds a bounded personalized rail by combining
TMDB recommendations for distinct movies and shows watched in the rolling last 12 months.
Those per-title responses are cached separately so a watch-state refresh does not rebuild the
public rails. Every rail removes titles already present in the user's watched history before it
reaches the browser.
`/api/live-updates` carries the Discover generation so open pages can re-read changed TMDB
snapshots without waiting for the TMDB calls in the foreground.

A show whose episode total cannot be resolved stamps `total_checked_at` in the progress
cache and waits seven days before trying again, so an unresolvable title does not repeat
the same failing lookups on every start. See [tv-shows.md](tv-shows.md).

Library-added webhooks and newly observed provider Up Next items enqueue the show/movie in a
single background metadata warm-up queue. The scheduler also scans active `playback_progress`
(the Part Watched source) and known watch history as a restart/import backstop. Queue work is
deduplicated and serialized through the gateway throttle, with visible media-page requests
given priority over queued warm-up work. It refreshes missing-artwork, light, or stale rows,
so a temporary provider failure is retried automatically rather than waiting
for a dashboard or show-page visit. Settings → Advanced → Storage & cache (`/settings/advanced#storage`, `GET /api/cache-stats`,
`POST /api/clear-cache`, handlers in `index.js`) reports and clears the caches;
`POST /api/refresh-tmdb-metadata` (and the TVDB-scoped `POST /api/refresh-tvdb-metadata`)
queue a whole-library refresh as a cancellable background job and return immediately
(`202`); `GET` on either endpoint polls the same job's live log and result. Running the
whole pass server-side means it survives closing the settings panel, navigating away, or
reloading the page - the poll just re-attaches to whatever job is already running.

TV Fix Match uses the same queue with the selected TVDB series identity as an explicit
warm-up item. It first clears stale show metadata and artwork associations, then queues
the corrected series so cache-only dashboard cards can resolve the new poster without a
prior show-page visit. The interactive dialog also requests the full merged details
record and refreshes the compact dashboard snapshot before closing when that provider
request succeeds; a provider outage leaves the rematch saved and the queued warm-up
available for a later retry. `POST /api/rematch-show` reports this server-side work as
`metadata_refresh: "queued"`.

## API endpoints (all admin-authenticated, all in `server/src/index.js`)

Trakt replacement reads a complete show history snapshot and keeps Trakt-only plays at their
current canonical episode numbers, including numbers that overlap Plekt's old structure.
Missing target plays are added and verified before only uniquely identified old history IDs
are removed. Already-correct plays are not re-added. If a new date would share an occupied
target, replacement refuses before writing: Trakt can disable multiple plays and replace the
existing date even for an append request. Ambiguous imported rows stay for review; an imported
row proven by its Trakt date and coordinates can be repaired into the stored numbering while
retaining its canonical Trakt override. Only inbound polling advances the history import cursor.

Single and batch marks, Force Sync, restore replay and retry all apply the same outbound
numbering rules. An unmatched translated episode fails closed instead of sending stored
coordinates to Trakt. Cached inbound maps also cover the first Trakt import before Fix Match.
Background metadata warming fills the recent stored TVDB seasons needed by translated Up Next
cards (two active seasons and their successors, at most four serial reads); dashboard reads
remain cache-only.

| Endpoint | Backing |
| --- | --- |
| `GET /api/tmdb-details` (alias `media-details`) | `getTmdbDetails` - merged movie/TV details |
| `POST /api/tmdb-details-batch` | Batched details for explorer prefetch (bounded worker pool; items may set `light: true` to skip next-airing/artwork enrichment on cold fetches - light-cached rows are refetched in full by detail pages) |
| `GET /api/tmdb-season` | Season episode list (TVDB-backed for TV). Takes `tmdbId` or, for series that only exist on TVDB, `tvdbId` |
| `GET /api/tmdb-person` | Person details + filmography |
| `GET /api/tmdb-search`, `GET /api/tvdb-search`, `GET /api/media-search` | Remote + local search. `tmdb-search` accepts `movie`, `tv`, `multi`, or `person`; `media-search` returns `local`, `discovery` (TMDB movies/shows), `people` (a separately paged TMDB people search), `collections`, and `tvdb` results, all queried in parallel. `tvdb-search` result lists are cached so the shared TVDB key survives per-keystroke searching |
| `GET /api/tmdb-collection?id=` | Cached TMDB collection/franchise details and movie members |
| `GET /api/discover?mediaType=&genre=` | Cached TMDB feeds for trending, movies currently in theatres, popular/upcoming or on-air titles, optional genre browsing, and a watch-history recommendation rail. The theatrical rail follows TMDB release data and is not a local cinema or streaming-availability check. Watched titles are filtered from every rail, and titles dismissed with Discover's **Don't recommend** action are filtered from the personalized rail. Normal requests serve the cached snapshot and revalidate stale data in the background; `refresh=1` rebuilds before responding. Requires a reachable TMDB API key |
| `POST /api/discover/dismiss` | Persist a movie or TV TMDB id as excluded from the personalized Discover recommendation rail. |
| `GET /api/tmdb-images`, `GET /api/tvdb-images`, `GET /api/fanart-images` | Artwork galleries for the edit-image dialog |
| `GET /api/season-posters`, `GET /api/season-poster-options` | Saved/current season posters for the Season Posters tab, and TMDB/TVDB/fanart.tv options for one season (`routes/seasonArtwork.js`; provider options are demo-disabled) |
| `GET /api/show-season-source/preview?tvdbId=&tmdbId=&source=`, `POST /api/show-season-source` | Fix Match per-show TVDB/TMDB choice (`routes/showSeasonSource.js`). The preview returns the rows' detected numbering, episode and watch-row counts and the episodes with no partner, without writing. The save needs `confirm: true`, recomputes that preview, stores the choice, and refreshes show progress. Watch rows keep their stored numbers; the show page places them by translation. Demo-disabled |
| `GET /api/show-season-source/trakt-preview?tvdbId=&tmdbId=`, `POST /api/show-season-source/trakt-replace` | Second Fix Match confirmation (`routes/showSeasonSource.js`, `utils/showTraktReplace.js`). The preview returns episode and play counts and the review list without calling Trakt; replacement needs `confirm: true`, verifies target numbers and history, preserves Trakt-only plays, and writes per-row Trakt overrides. Conflicting occupied targets refuse before writing. A show with a translated choice is skipped by scheduled override reconciliation. |
| `GET /api/tmdb-poster`, `GET /api/tmdb-profile` | Image proxies (rate-limited 300/min) |
| `GET /api/remote-artwork` | Downloads and caches fanart.tv / TVDB / TMDB artwork by URL, then redirects to `/media/...` (see [posters-artwork.md](posters-artwork.md)) |
| `GET /api/omdb-rating` | IMDb rating pill |
| `GET /api/youtube-meta` | Trailer metadata |
| `GET /api/upcoming?month=YYYY-MM` | Future TV episodes for the Upcoming calendar. `&revalidate=1` answers from the persistent cache and rebuilds the month behind the response; `&refresh=1` rebuilds before responding (see [upcoming.md](upcoming.md)) |
| `POST /api/refresh-tmdb-metadata`, `POST /api/rematch-show`, `POST /api/rematch-tv-shows` | Cache refresh / identity fixes |

## Frontend

`public/modules/tmdb.js` wraps the endpoints with in-memory caches
(`state.tmdbDetailsCache`, `state.tmdbSeasonCache`) and helpers like
`resolveEpisodeTitleFromTmdb` that upgrade "Episode 5" labels to real titles as data
arrives. Explorer prefetch (`observeExplorerTmdbPrefetch`) warms details for visible
cards.

The Discover page keeps provider failures actionable: a missing TMDB key links to
Settings → Metadata, transient TMDB/network failures offer a retry, and a stale local
server build asks the operator to restart Plekt. The selected rails, including the
personalized recommendation rail, are restored from a bounded browser cache before the
first request, then refreshed from the server cache when its SSE Discover version changes
or watch state changes. Watched titles are hidden rather than shown with a watched badge.
Choosing **Don't recommend** on a Discover card removes that movie or show from the personalized
rail immediately and saves the exclusion on the server, so it remains excluded after a refresh
or on another browser.
Discover never depends on a media server or Trakt connection.

Background frontend lookups are debounced into bounded batches of up to eight items, and a
batch answers only once its slowest item resolves. Detail pages therefore pass `{ immediate: true }` to
`fetchTmdbDetails`, which sends that single item on its own request so a visible page
never waits behind explorer prefetch work. Dashboard history and Up Next rendering are
cache-only: they use local rows, cached artwork, and cached metadata, and never initiate
TMDB/TVDB requests. If an episode has no trusted series id, its title is used without
promoting an episode-level provider id into a TV-series lookup.
