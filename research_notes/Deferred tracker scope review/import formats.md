# User controlled import options

Research checked 26 October 2026. This note covers user-owned export and import paths for IMDb, Trakt, Simkl, JustWatch and Reelgood. It does not treat any private or unofficial website endpoint as a supported API.

## Which sources provide a practical user-controlled export?

### Takeaway
Trakt is the clearest portable migration source: its official API policy recommends the user’s own data export for one-time imports, and Simkl’s official importer documents a ZIP export workflow that carries watch history, watchlist and ratings. IMDb offers CSV exports for ratings and generic lists, but its current Watchlist FAQ does not document an export or identify a watchlist CSV schema; inspect a real user export before promising watchlist import. Simkl’s CSV list export is paid; its JSON API/backup is available as an alternate.

### Cited Findings
- Trakt explicitly permits one-time user-requested import/export/migration of the account owner’s history, ratings and lists, and recommends the user’s Trakt data export; OAuth is required to access protected account data via the API. [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy)
- Simkl’s official Trakt importer says the user can download one `trakt-export-<username>.zip` from Trakt settings, upload it without extracting, and the browser parses it locally, sending Simkl only watch history, watchlist and ratings. [Simkl Trakt importer](https://simkl.com/apps/import/trakt/)
- IMDb’s Lists FAQ (updated 9 July 2026) confirms a per-list Export icon; its ratings FAQ confirms a CSV export from Your Ratings. The Watchlist FAQ (updated 9 July 2026) documents watchlist behavior but has no export instructions. IMDb’s help confirms that Watchlists, Lists and Check-ins can hold up to 12,000 items. [IMDb Lists FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-the-list-feature/GNQMN47VZSE7KW38), [IMDb Ratings FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-imdb-ratings/G67Y87TFYYP6TWAV), [IMDb Watchlist FAQ](https://help.imdb.com/article/imdb/track-movies-tv/faq-for-the-watchlist-feature/G9PA556494DM8YBA)
- IMDb check-ins can be exported as RSS or CSV, but those are check-in records, not the same as its newer private “Your watch history” page. [IMDb Check-ins FAQ](https://help.imdb.com/article/imdb/track-movies-tv/check-ins-faq/GG59ELYW45FMC7J3), [IMDb Watched FAQ](https://help.imdb.com/article/imdb/new-features-updates/mark-as-watched-faq/GR2SD7Y4LZVNHUVH)
- Simkl says users can access and export their own data through its free API; its API reference provides authenticated JSON endpoints for pulling user state and adding/removing watchlist statuses. CSV list export is advertised as a VIP feature. [Simkl Privacy Policy](https://simkl.com/about/policies/privacy/), [Simkl API `GET All items`](https://api.simkl.org/api-reference/simkl/get-all-items), [Simkl API `POST Add to Watchlist`](https://api.simkl.org/api-reference/simkl/add-to-list), [Simkl feature plans](https://simkl.com/vip/)

### Inferences
- A user-selected Trakt ZIP upload is a more bounded first Trakt migration than a connected background integration: it avoids OAuth, ongoing polling and API-state reconciliation while still using an officially supported user export. File structure and mapping must be verified against a real sample before implementation.
- The currently assigned Plekt watch-history CSV plan explicitly excludes watchlists and third-party formats. An IMDb/Trakt watchlist importer is therefore additive work, not included in that plan; avoid expanding that v2.2.0 assignment without the user selecting the extra scope.

### Gaps
- The official IMDb help does not specify export column names or guarantee that the regular Watchlist produces CSV, nor confirm `tconst` coverage. A sample export must be inspected before a reliable parser scope can be estimated.
- Trakt’s own export settings page could not be fetched by the research browser, so the ZIP’s exact JSON files, ID fields and field-level retention were not confirmed from Trakt’s own help. Simkl’s importer confirms the ZIP and categories, but is a third-party description.
- Simkl paid CSV export is confirmed in its pricing page, but the exact free-account API allowances for complete profile extraction were not quantified here.

## What do direct tracker APIs make feasible?

### Takeaway
Trakt and Simkl both expose watchlist/status operations, but integration adds user authorization, endpoint/rate-limit handling, and state semantics. Simkl’s refreshed documentation is explicit about granular list statuses, accepted cross-provider IDs, and the “don’t pull all items until activity changes” sync pattern. IMDb’s personal-data import/export should remain file-based; its public datasets are not the user’s personal Watchlist/history API.

### Cited Findings
- Trakt’s current API policy permits an app to manage a user’s own lists/history with authorization; it bars scraping and bulk harvesting. Standard API access is free for commercial and noncommercial apps, while higher limits and restricted endpoints are Premium. [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy)
- Trakt Standard limits currently document 1 authenticated POST/PUT/DELETE per second and 500 authenticated GET requests per 5 minutes; the policy says limits and endpoint access can change. [Trakt Rate Limits](https://developer.trakt.tv/docs/rate-limiting)
- Simkl’s current reference exposes `/sync/add-to-list` for `watching`, `plantowatch`, `hold`, `completed` and `dropped`; it accepts identifiers including IMDb, TMDB, TVDB, MAL and AniDB, and calls out `not_found` results and silent status rewrites that clients must inspect. [Simkl Add to Watchlist](https://api.simkl.org/api-reference/simkl/add-to-list)
- Simkl requires OAuth bearer tokens for user-data endpoints, `client_id`, `app-name`, `app-version`, and a descriptive User-Agent. Its API rules cap each app at 10 GET/sec and 1 POST/sec per client ID and user token, require activity-gated delta sync, and require a commercial license at revenue of $150/month or more. [Simkl API introduction](https://api.simkl.org/api-reference/introduction), [Simkl API rules](https://api.simkl.org/api-rules)
- Simkl instructs tracker apps already syncing another tracker to offer Simkl login and sync as well if using its API. The existing Plekt Simkl connection meets this condition. [Simkl API rules](https://api.simkl.org/api-rules)

### Inferences
- Simkl watchlist sync is technically viable but not a tiny integration: the plan identifies new shared list representation/scope plumbing plus read/add/remove operations. It also needs explicit product decisions about status handling, conflicts, and whether to preserve any original dates.
- MyAnimeList is a distinct anime-only capability and the plan’s safety requirements (no invented episode watches, explicit handling of specials/split cours/unknown totals) imply more domain-specific mapping and testing than a short release fit. Simkl’s catalog can accept MAL IDs, but that does not solve importing and representing the user’s MAL list safely.
- A direct Trakt connection can be permitted, but the current release already has separate Trakt-related connection work completed/assigned elsewhere. Watchlist synchronization should remain explicitly separate from the permitted one-time import path.

### Gaps
- Trakt endpoint-level access tiers, exact current endpoint schemas and OAuth details were not revalidated on its interactive API reference; the legacy Apiary reference labels itself deprecated. Scope/API review should use the current endpoint reference before implementation.
- No current user export sample was available for Trakt, IMDb or Simkl, so duplicate/order/date fields cannot be promised.

## Which migration and availability work is bounded for v2.2.0?

### Takeaway
Do not add ongoing third-party watchlist synchronization or regional streaming-service management to v2.2.0: both require unresolved contracts and behavior choices. A single source-file watchlist importer could be a bounded follow-up only after selecting the source and inspecting an actual export, but generic watch-history CSV and Netflix history are already separate v2.2.0 work and should not be silently broadened. JustWatch and Reelgood availability APIs are partner/business integrations, not a quick consumer-export route.

### Cited Findings
- JustWatch’s Content Partner API requires a concluded contract and partner token for each request and requires branded title links beside each availability widget. [JustWatch Content Partner API](https://apis.justwatch.com/docs/api/)
- Reelgood separates real-time consumer-app API lookups from S3 data exports intended for analysis/history; its business documentation describes the latter as covering 300+ services and 25+ countries and updated up to twice daily. It directs product teams to discuss use with Reelgood. [Reelgood API documentation](https://data.reelgood.com/api-docs/api-documentation/)
- Simkl’s importer documentation demonstrates a user-controlled Trakt archive route; Trakt policy endorses one-time imports from user exports and does not require two-way sync for that use. [Simkl Trakt importer](https://simkl.com/apps/import/trakt/), [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy)
- In the repository, Plekt’s v2.2.0 watch-history CSV design is restricted to Plekt’s own watch-history format, not watchlists, ratings or third-party files. The deferred watchlist plan calls for backup-safe preview/commit, canonical ID matching, deduplication, and explicit replace choice. [Watch-history CSV plan](../../plan/csv-export-import.md), [Deferred watchlist design](../../plan/active/deferred-tracker-work/step2-watchlist-migration-and-availability.md)

### Inferences
- **Best v2.2.0 fit from this candidate set:** do not start a new watchlist or tracker feature in this release. It already has large assigned work, and the simplest importer still needs an actual source file, scope selection, and import behavior decisions.
- Keep Phase 2b Simkl custom watchlist/status support, Phase 4 MAL integration, Phase 5 multi-source importer/export formats, and preferred-service/availability filtering out of the v2.2.0 implementation scope. If the user wants one small addition later, a preview-only decision brief for a single selected user export format is the narrowest next step; it is not yet approved work.
- JustWatch availability would be a product/data partnership with attribution constraints; Reelgood availability would require business API engagement or a paid data offering. Neither should be treated as an uncontracted fallback to the existing TMDB data.

### Gaps
- Public docs did not establish a user-facing JustWatch or Reelgood watchlist export/import format. Their documented APIs/data offerings cover title availability/metadata, not migration of a person’s private watchlist.
- JustWatch contract pricing, Reelgood business API pricing/terms, API rate limits and Plekt eligibility were not publicly established in the sources reviewed; contact/contract details would be required before estimating.
- No geographic priority for preferred services was specified in this scope-review assignment; the plan mentions GB and US as the existing TMDB availability regions, but region-specific service UI would require a user decision.
