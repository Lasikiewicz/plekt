# Tracker API review

Research checked 26 October 2026. This note covers current API feasibility and release gates for Trakt, Simkl, MyAnimeList, and MDBList. It does not authorize an integration.

## What can the tracker APIs do, and what blocks a small v2.2.0 item?

### Takeaway

Trakt and Simkl both expose watchlist read/write operations, but a real two-way watchlist sync is not just a few API calls: it needs direction, deletion, status, and canonical-list decisions. Simkl is the closest incremental extension because Plekt already has its connection; still, its delta/removal semantics and the repository's new provider representation make it medium-sized. MAL is a separate, anime-only integration with OAuth and progress ambiguity, and is a poor quick-release fit.

### Cited Findings

- Trakt supports OAuth user access and recommends PKCE for authorization-code flow; access tokens last seven days and refresh tokens are single-use/rotating. API app registration requires a verified GitHub account, and user-controlled list management is a permitted use. [Trakt OAuth guide](https://developer.trakt.tv/docs/authentication-oauth); [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy) (accessed 26 October 2026).
- Trakt's Sync API documents watchlist GET, add, and remove operations. The current Standard API limits are 500 authenticated GETs per user per five minutes and one authenticated POST/PUT/DELETE per user per second; clients should use response headers and honor `Retry-After`. [Trakt Sync API](https://trakt.docs.apiary.io/#reference/sync/get-watchlist/get-watchlist); [Trakt Rate Limits](https://developer.trakt.tv/docs/rate-limiting) (accessed 26 October 2026).
- Trakt says user-directed management and migration of a person's own lists are permitted without a separate approval or commercial agreement, but the app must use OAuth, provide privacy information, and include the prescribed non-endorsement credit. Bulk harvesting, redistribution, and bypassing restrictions are prohibited. [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy) (accessed 26 October 2026).
- Simkl's current Sync guide supports status-based watchlists for shows, movies, and anime, delta reads gated by `/sync/activities`, and batched writes through `POST /sync/add-to-list`. Movie status excludes `watching` and `hold`. Removing an item is done through `/sync/history/remove`; remote deletion deltas only say that some list item was removed, so clients must fetch the current ID set and diff it. [Simkl Sync guide](https://api.simkl.org/guides/sync); [Simkl Add to Watchlist reference](https://api.simkl.org/api-reference/simkl/add-to-list) (accessed 26 October 2026).
- Simkl requires serialized, incremental traffic: API v2 allows 10 GETs/second and one POST/second; daily per-user quotas are 500 free, 1,000 PRO, and 10,000 VIP. Writes accept arrays, and documentation says to batch rather than send one request per item. [Simkl Rate Limits](https://api.simkl.org/resources/rate-limits) (accessed 26 October 2026).
- MyAnimeList's official API reference is published at `/apiconfig/references/api/v2`; it documents authenticated user anime lists and list status fields. The reference and auth page were not retrievable in this web session, so exact OAuth limitations, rate ceilings, and export/import terms are not independently confirmed here. [MAL API v2 reference](https://myanimelist.net/apiconfig/references/api/v2); [MAL API auth reference](https://myanimelist.net/apiconfig/references/auth) (linked, but not fetchable during review; accessed 26 October 2026).
- The deferred plan itself says the MAL candidate needs OAuth2/PKCE, anime-only capability declarations, conservative status/score/date import, and explicit safeguards for inferred watched-episode progress, specials, split seasons, and unknown episode totals. This is consistent with a larger adapter rather than a small v2.2.0 closure. [Plekt deferred tracker plan](../../plan/active/deferred-tracker-work/step1-deferred-tracker-capabilities.md) (reviewed 26 October 2026).

### Inferences

- Simkl watchlist support is technically feasible but would require careful modeling of remote list statuses and an explicit rule for removals/deletions; it is not a quick settings-only addition.
- Trakt API access is technically and policy-wise available for user-authorized list sync, but the candidate would still need a separate Plekt behavior/design scope and would overlap the broader watchlist representation work.
- MAL should remain future work until the product decides what `watching` means when only a provider episode count is available. Never infer a sequence of episode watches by default.

### Gaps

- I did not verify the exact source-level license/branding terms for Simkl or MAL, or whether MAL imposes an unlisted operational request ceiling. Do not claim these are cleared until checked from their terms or developer portal.
- Plekt's current Trakt watchlist support status was not confirmed by source inspection in this research slice; the deferred plan says watchlist sync is absent.

## Does MDBList now meet the old Phase 0 gate?

### Takeaway

MDBList's current API documentation exposes authenticated watchlist, watched-history, and ratings operations, so the old assumption that it might be list-only is outdated. It is still a poor v2.2.0 candidate: third-party OAuth/app registration and rights/terms need a deliberate review, the free tier is limited, and the available rendered documentation does not settle episode-level history coverage.

### Cited Findings

- The current MDBList API index documents `/watchlist/items`, `/sync/watched`, `/sync/ratings`, and watchlist add/remove endpoints. It also documents API key and OAuth-based access. [MDBList API documentation](https://api.mdblist.com/docs/) (accessed 26 October 2026).
- MDBList currently documents API key, Device Code, Public PKCE, and OAuth 2.0 methods. App-based methods must be registered in its developer portal; OAuth bearer tokens expire after 30 days. The API calls the current authorization scope `write` and says that it grants access to profile, lists, watchlist, ratings, collection, and playback state. [MDBList Authentication](https://api.mdblist.com/docs/authentication/) (accessed 26 October 2026).
- MDBList documents 1,000 daily requests for the free tier and 1,000 read / 300 write requests per five-minute window; overages return 429 and `Retry-After`. Limits are shared across a user's API keys and OAuth apps. [MDBList API documentation](https://api.mdblist.com/docs/) (accessed 26 October 2026).
- MDBList's 2025 terms say users must comply with applicable laws and third-party provider terms and that service availability is not guaranteed. They do not, in the text surfaced during this review, state a clear third-party-app license or an integration approval process. [MDBList Terms and Privacy](https://mdblist.com/static/legal.html) (last updated 8 March 2025; accessed 26 October 2026).
- MDBList's own October 2026 product updates say it can no longer sync with Trakt after Trakt blocked its API access; it offers manual Trakt export import instead. That makes MDBList unsuitable as a hidden Trakt bridge and is a relevant dependency risk for any integration. [MDBList product updates](https://mdblist.com/new-features/) (accessed 26 October 2026).

### Inferences

- The existing MDBList Phase 0 check is partly answered: documented user watchlist, history, and rating endpoints exist, and OAuth is now documented rather than only in beta. The scope should not be rewritten to call it a watch-history tracker until episode-level coverage is verified against the schema.
- MDBList can be investigated as a direct provider integration, but do not rely on it to pass Trakt data through. The published Trakt API restriction means Plekt would need its own user authorization to each service and a supported data path.
- Before any MDBList implementation, confirm developer app registration, exact terms for third-party apps, and whether its `sync/watched` model carries episode-level play records. This is a gate, not a coding task.

### Gaps

- The interactive OpenAPI schema for MDBList did not expose detailed request/response fields through the browser fetch, so coverage of episode-level history and ratings cannot be stated with confidence.
- MDBList's legal page did not resolve whether a third-party Plekt integration needs written approval or a separate license. The developer portal or MDBList support must confirm this before implementation.
