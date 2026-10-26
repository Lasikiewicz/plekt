# Streaming availability and watchlist scope

## Is TMDB availability data a viable basis for saved services and an availability filter?

### Takeaway
TMDB already exposes per-title streaming offers by country and discovery filters by region, provider, and offer type, so this is technically possible without adding a new data vendor. It is still a product-and-data feature with attribution, freshness, coverage, and unknown-state behavior to settle; it is not a small release-close task.

### Cited Findings
- TMDB's TV watch-provider endpoint returns streaming, rental, and purchase availabilities per country, but not full deep links; it points to a TMDB URL for the actual links and requires JustWatch attribution, with access revocation for noncompliance. [TMDB TV Watch Providers](https://developer.themoviedb.org/reference/tv-series-watch-providers)
- TMDB's Discover TV API accepts `watch_region`, provider filters, and monetization types `flatrate`, `free`, `ads`, `rent`, and `buy`; provider and type filters are paired with a region. [TMDB Discover TV](https://developer.themoviedb.org/reference/discover-tv)
- TMDB says it enforces upper limits around 40 requests per second to prevent bulk scraping, that the limit can change, and clients should honor HTTP 429. [TMDB Rate Limiting](https://developer.themoviedb.org/docs/rate-limiting)
- TMDB's FAQ says non-commercial API use is free with attribution; commercial use requires contacting sales. It also requires a logo and an About/Credits notice. [TMDB FAQ](https://developer.themoviedb.org/docs/faq)
- TMDB's API terms prohibit caching content longer than six months and require attribution. [TMDB API Terms](https://www.themoviedb.org/api-terms-of-use?language=en-CA)

### Inferences
- The existing plan says detail pages already show TMDB availability for GB or US. Saved services and a “Available on my services” filter could reuse that source, but need settings, per-region provider identifiers, availability caching/refresh, explicit treatment of rent/buy versus subscription, and a state for missing data. This is a moderate multi-surface feature, not a low-effort closure.
- Since the data is JustWatch-powered, UI copy needs JustWatch attribution alongside the API's TMDB attribution. The exact legal/branding placement should be confirmed against both partners' current terms before implementation.
- A user’s subscription list is preference data and cannot be inferred from the provider list or a title's presence in their media library; the plan already correctly calls for explicit user-selected services.

### Gaps
- The public docs establish country-scoped offers and a regions mechanism, but do not establish the completeness or error rate for any particular provider-country pair. That requires measuring real catalog records and deciding how to represent absent data.
- No commercial-license determination was made for Plekt. The project’s use case should be reviewed against TMDB's commercial-use definition before treating the free developer terms as settled.

## Do JustWatch or Reelgood provide a supported consumer export or lightweight API for watchlist migration?

### Takeaway
The official evidence found supports JustWatch consumer watchlists and custom lists, but not a user self-service export; its partner API/export is contract-gated and its terms prohibit scraping. Reelgood's documented API and S3 exports are business data products, not a documented user watchlist export, so direct integrations are not suitable for a quick v2.2.0 addition.

### Cited Findings
- JustWatch says a free account can save a synced personal watchlist, and custom lists can be created/shared; its public consumer help pages do not describe exporting these lists. [JustWatch Terms of Use](https://support.justwatch.com/article/just-watchs-terms-of-use), [JustWatch Custom Lists](https://support.justwatch.com/article/what-are-custom-lists)
- JustWatch's service terms prohibit data mining, robots, scraping, and similar data gathering unless specifically authorized. [JustWatch Terms of Use, section 7.1](https://support.justwatch.com/article/just-watchs-terms-of-use)
- JustWatch's documented content partner API requires a concluded contract and partner token, and each integration must show branded JustWatch links next to the where-to-watch integration. [JustWatch Content Partner API](https://apis.justwatch.com/docs/api/)
- JustWatch's bulk availability data export is delivered from a credentialed S3 bucket; access keys and bucket directory are handed to partners after contract conclusion. [JustWatch Data Export](https://apis.justwatch.com/docs/data_export/)
- Reelgood presents its API as real-time single-title lookups for consumer-facing apps and its S3 export as a business/analyst data product; it directs potential users to “Let's talk” rather than publishing an open consumer-list API. [Reelgood API Documentation](https://data.reelgood.com/api-docs/api-documentation/)
- Reelgood's official product page says data access is via API or bulk S3 export; the published partner material describes API keys issued per integration. [Reelgood About](https://data.reelgood.com/about-us/), [Reelgood Technology](https://data.reelgood.com/technology/)

### Inferences
- Do not scrape JustWatch or rely on undocumented endpoints. If JustWatch import/export is wanted, first obtain explicit permission and a documented user-data transfer path; no such self-service path was found in official help.
- Reelgood may be a licensed availability data vendor for a future product, but that does not supply an individual user's watchlist. It also adds a vendor/contract and pricing dependency without solving migration from a consumer account.
- For watchlist migration, prioritize documented user-supplied JSON/CSV exports from sources that actually provide them, plus a generic preview-first importer; treat JustWatch/Reelgood source-specific support as contingent on an official export or written permission.

### Gaps
- No official consumer help page found in this research documents export of a JustWatch or Reelgood personal watchlist. This is a limit of the public documentation reviewed, not proof that no private account-support process exists.
- Reelgood's business API/export price and minimum agreement are not public in the cited materials; sales contact is required to assess commercial feasibility.

Research checked 26 October 2026. Provider service availability, terms, and partner access may change; re-check before a future implementation.
