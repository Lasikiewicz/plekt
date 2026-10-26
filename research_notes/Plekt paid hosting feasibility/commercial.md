# Plekt paid hosting feasibility / commercial

**Research date: 21 October 2026.** Assumption: the operator and initial customer base are in the UK; this is a feasibility assessment, not legal or tax advice. External sources checked on 21 October 2026 unless a source's displayed update is noted.

## Commercial proposition and feasibility

### Takeaway

A paid hosted service is technically imaginable as a per-customer managed *watch-state synchronisation* service, but current third-party metadata/API terms create material launch blockers. Do not sell a public multi-tenant or centrally hosted Plekt service until licensing is confirmed in writing, especially for TMDB and TheTVDB, and artwork rights are independently resolved. A lower-risk first experiment is paid setup/maintenance assistance for customer-owned self-hosted instances, or a small private pilot where customers provide their own API credentials and connect their own media servers, subject to provider approvals.

### Cited Findings

- Plekt is a self-hosted Node.js app: one long-running process serves UI, API and per-minute scheduler; state is local SQLite plus local media folder. Its core proposition is receiving Plex, Emby and Jellyfin playback events and synchronising watched/unwatched status and resume progress among the user's services. There is no external DB or cloud-function architecture. — [Repository architecture](../../docs/architecture.md) (accessed 21 Oct 2026).
- The repository's `LICENSE.md` is GNU AGPL version 3. AGPL permits charging for copies/services, while §13 requires a network user interacting remotely with a modified version to be offered that version's Corresponding Source. Assess whether planned changes constitute modification and build a source-offer process into service operations. This license does not grant rights to third-party metadata, artwork, logos or API data. — [Repository LICENSE.md](../../LICENSE.md); [GNU AGPLv3, §13](https://www.gnu.org/licenses/agpl-3.0.html) (accessed 21 Oct 2026).
- TMDB's current API terms say API use is non-commercial unless there is a separate written commercial agreement; charging for an application integrating TMDB is explicitly an example. The terms also prohibit selling/sublicensing API access or content and require TMDB attribution/logo. TMDB content may not be cached more than six months; license termination requires cessation and purging cached content. — [TMDB API Terms](https://www.themoviedb.org/api-terms-of-use) and [TMDB developer FAQ](https://developer.themoviedb.org/docs/faq) (accessed 21 Oct 2026). **This is a gating dependency**: Plekt uses TMDB broadly for detail, search, discover, recommendations, artwork and other pages, so a nominally “hosting-only” fee may still be commercial use in an application that uses TMDB.
- TheTVDB explicitly offers commercial licenses. Its published table says annual project/company revenue under $50k: free with attribution; $50k–$250k: $1,000/year; $250k–$1m: $10,000/year; above $1m/custom contact. It requires end-user linked attribution unless approved otherwise. Its general API license says no sublicensing/resale/distribution of API or data, and says API terms do not license use/display of images, trailers or programming. The hosting operator should obtain written confirmation that its exact SaaS/managed-hosting arrangement qualifies for the relevant tier, including whether aggregated company revenue or each project applies. — [TheTVDB API licensing](https://thetvdb.com/api-information), [TheTVDB Terms](https://thetvdb.com/tos) (accessed 21 Oct 2026).
- Plekt's built-in shared TheTVDB project key and project Fanart key are stated in local metadata docs; production customers could therefore create provider usage under one shared project identity. The repo says users can optionally supply personal Fanart keys, and TMDB is user-supplied. — [Repository metadata docs](../../docs/metadata.md) (accessed 21 Oct 2026). Hosting provider-key proxying or pooling should not be assumed permitted merely because the local app already supports shared project keys.
- Fanart's current API documentation describes project keys and optional user personal keys, a 7-day vs 2-day delay for new images, and image copyright fields; available public docs do not establish a paid-hosting or image redistribution grant. Fanart's terms page focuses on responsibility for user-contributed uploads, not a clear hosting license. Obtain written clarification and rights for displaying/caching art. — [Fanart API documentation](https://api.fanart.tv/), [Fanart terms](https://fanart.tv/terms-and-conditions/) (accessed 21 Oct 2026).
- OMDb's official terms page limits a license for contributions to “Personal, Non-Commercial Purposes”; the API's paid patron plan is not, from the public legal text located, evidence of commercial-use permission. OMDb is optional and only supplies IMDb rating/vote pills in Plekt, so a launch could disable it pending written clarification. — [OMDb terms](https://www.omdbapi.com/legal.htm), [Plekt metadata docs](../../docs/metadata.md) (accessed 21 Oct 2026).
- Trakt's current API policy explicitly permits apps that sync a user's media-server activity with their own Trakt account, including hosted/backend apps, but prohibits bulk harvesting, resale/redistribution, or sharing credentials across services; use user authorization, least necessary data, fair rate limits, and deletion/disconnect controls. Current developer docs distinguish Standard and paid Premium tiers; limits are dynamic and should be read from response headers. — [Trakt API Use Policy](https://developer.trakt.tv/docs/api-use-policy), [Trakt Premium](https://developer.trakt.tv/docs/premium) (updated 13 Oct 2026; accessed 21 Oct 2026).
- Plex's developer portal publishes PMS API documentation for tools/services that integrate with a media server, but says community developer-built tools are not officially reviewed, approved or endorsed. The Plex Terms located also place responsibility for interfacing software and its data practices on the software provider and call for a privacy notice. Confirm that hosting users' Plex-connected instances and handling Plex tokens fits current Plex terms and branding rules before launch. — [Plex Media Server API portal](https://developer.plex.tv/), [Plex Terms](https://www.plex.tv/about/plex-terms-of-service-apple/) (accessed 21 Oct 2026).

### Inferences

- **Potential customer promise:** “We run and maintain Plekt's sync service for your own media-server accounts; we do not store or stream your media files.” Be explicit this is an independent service and that customer media servers, accounts, internet access and provider APIs remain dependencies.
- A small fee is plausibly easier to justify as time saved on installation, HTTPS/domain, updates, backups, monitoring and support than as raw compute. That is a hypothesis, not validated willingness to pay. Price should be tested only after costed unit economics (hosting, backups, payment fees, support minutes, API license costs and VAT) are known.
- Multi-tenant shared metadata caches can improve request efficiency but increase both licensing/redistribution exposure and cross-customer data-isolation risk. Separate per-customer instances/databases and keys may be safer to pilot, but do not solve commercial API restrictions by themselves.

### Gaps

- No reliable public data found for Plekt's addressable market, paid conversion, acceptable monthly price, provider support, hosting cost/customer, or demand relative to free self-hosting.
- No written provider determination found for a paid hosted Plekt service from TMDB, TVDB, Fanart, OMDb or Plex. Published public terms are not a substitute for provider confirmation of this deployment model.
- The repo license was read; a full dependency, artwork provenance, trademark and bundled-asset license audit was not in scope.

## Customer operation: onboarding, support and network shape

### Takeaway

The most important product constraint is connectivity to each customer's *own* media servers. Plekt's hosted process must be able to call those servers, and webhook-driven events must be delivered to Plekt; customers behind NAT, firewalls, CGNAT or dynamic IPs may require an outbound tunnel/agent or networking changes. This is an operations-heavy integration, so onboarding and support boundaries are central to whether “small fee” economics work.

### Cited Findings

- Plekt's Plex setup documentation says the media-server base URL must be reachable **from the Plekt server machine**, not merely from the customer's browser. Plex setup supports account discovery or manually supplied server URL/token. — [Plekt Plex docs](../../docs/plex.md) (accessed 21 Oct 2026).
- Plekt is designed around inbound webhooks plus polling/WebSocket channels (for Plex, Emby and Jellyfin) and outbound requests to configured servers; sync and scheduler live in the one application process. — [Plekt architecture](../../docs/architecture.md), [Plekt Plex docs](../../docs/plex.md) (accessed 21 Oct 2026).
- TMDB states it does not currently provide an API SLA; its API availability may be restricted or discontinued. This is representative of upstream API dependency risk, not a guarantee of a specific outage rate. — [TMDB developer FAQ](https://developer.themoviedb.org/docs/faq) and [TMDB API Terms](https://www.themoviedb.org/api-terms-of-use) (accessed 21 Oct 2026).

### Inferences

- A conventional hosted web app cannot reach private RFC1918 addresses at a customer's home by default. Asking users to port-forward a media server may create unacceptable security/support burden; a managed outbound connector/tunnel or customer-operated VPN could avoid some inbound exposure, but would require product work and security review. Test this with actual target households before committing to a hosting architecture.
- Webhooks require a reachable public Plekt endpoint; setup must handle secure URL, webhook secret, TLS and provider-specific configuration. If hosting is inaccessible or provider events are delayed, polling/fallbacks must be communicated honestly.
- Scope the offer as hosting/sync software only. Never accept, proxy, store or stream movie/TV media files. Clarify customers need lawful content and their own licensed media-server services; hosting software does not grant content rights. This distinction is commercially and reputationally important but does not itself cure metadata/API licensing.
- Onboarding should be a guided compatibility check: supported Plex/Emby/Jellyfin version; outbound reachability from server to customer; inbound webhook reachability; account/OAuth permissions; per-provider API credentials; test event; backup/restore; disconnect/delete path. Support should ask customers to redact tokens/logs, and provide self-service token rotation and account disconnection.
- Offer an initial manually provisioned cohort with bounded support hours and one media-server type at a time. Record setup completion, first successful sync, sync reliability, tickets/customer/month, churn and willingness to pay; don't infer demand from likes or expressions of interest alone.

### Gaps

- Need a network architecture decision and proof with users across common home-router/ISP configurations, including CGNAT and servers not permanently online.
- No current operational SLA, disaster recovery target, region/data residency design, uptime budget, or incident process exists in the repository docs reviewed.

## UK legal, privacy and billing readiness; launch sequence

### Takeaway

Taking subscriptions turns a hobby deployment into a consumer-facing service. The operator will likely process identifiable watch history and account/API tokens, creating privacy/security and consumer-contract duties. On the research date, UK subscription contract guidance was newly published (19 October 2026); have a UK solicitor/accountant confirm applicability and commencement details before taking money.

### Cited Findings

- ICO guidance says a privacy notice should explain identity/contact details, purpose, lawful basis, data categories, recipients and retention, and be clear, accessible and given at collection or within the applicable period. A personal data breach reportable under UK GDPR must be reported to ICO without undue delay and no later than 72 hours after awareness. — [ICO right to be informed](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/right-to-be-informed/), [ICO breach guidance](https://ico.org.uk/for-organisations/report-a-breach/personal-data-breach/personal-data-breaches-a-guide/) (accessed 21 Oct 2026).
- ICO says controllers generally need to pay a data protection fee unless exempt; current tiers are £52 (micro), £78 (small/medium) and £3,763 (large), determined by staff/turnover and relevant category. A small operator should use the ICO self-assessment, not assume exemption. — [ICO fee guide](https://ico.org.uk/for-organisations/data-protection-fee/data-protection-fee/) (accessed 21 Oct 2026).
- GOV.UK lists the UK VAT registration threshold as taxable turnover over £90,000 in a rolling 12-month period or expectation of exceeding it in the next 30 days; voluntary registration is possible below. — [GOV.UK VAT thresholds](https://www.gov.uk/how-vat-works/vat-thresholds) (accessed 21 Oct 2026).
- GOV.UK guidance published 19 October 2026 says the DMCCA 2024 and Consumer Subscription Contracts (Cancellation and Information) Regulations 2026 regulate business-to-consumer subscriptions. Exact commencement/applicability and transition need checking against the new 77-page guidance and regulations. Existing online/distance selling guidance requires clear pre-contract information, total price, duration/termination information and confirmation. — [GOV.UK subscription-contract guidance](https://www.gov.uk/government/publications/subscription-contracts), [GOV.UK online selling guidance](https://www.gov.uk/online-and-distance-selling-for-businesses/online-selling) (accessed 21 Oct 2026).
- UK consumer subscriptions will need transparent recurring-price/renewal terms, a usable cancellation route and appropriate confirmation/refund processes; use a payment provider that supports tax records, receipts, failed-payment handling and cancellation. This is an operational recommendation; exact statutory obligations must be validated against the 2026 rules. — [DMCCA 2024](https://www.legislation.gov.uk/ukpga/2024/13/contents), [GOV.UK subscription-contract guidance](https://www.gov.uk/government/publications/subscription-contracts) (accessed 21 Oct 2026).

### Inferences

- Before selling: decide controller/processor roles for customer and household-member watch data; map data flows including logs, OAuth tokens, payment provider, backups and metadata APIs; minimize and encrypt secrets; tenant isolation; retention and deletion; incident response; privacy notice; terms, acceptable-use and support policy; refund/cancellation and complaints process; ICO fee self-assessment; VAT and business-registration advice.
- Customer proposition should be opt-in and narrow: watch-state sync, setup/updates, backups and support. Make clear that media itself remains at customer premises and no guarantee can be made that upstream platforms, networks or APIs remain available.
- Recommended stages: (0) interview 10–20 technically representative users and run a no-payment concierge setup test; (1) seek written API/platform clearances and make licensing cost model; (2) run a small invite-only paid-intent pilot only after legal, data protection and connectivity gates, with each customer isolated and their own optional provider keys; (3) expand only if install success, ticket load and gross margin support the price; (4) build automation and formal uptime/support promises only after evidence.
- Demand-validation questions: What do users currently spend time/money maintaining? Which topology/provider mix do they have? Would they pay for hosting, or only setup/maintenance? What price and support hours? Can they permit a connector/tunnel? Would they provide their own API keys? Use a transparent waitlist/price test without implying availability or collecting unnecessary account secrets.

### Gaps

- The newly published 2026 subscription guidance is time-sensitive; no complete review of its full text or commencement instruments was made here. Confirm exact deadlines, cooling-off/cancellation and reminder duties with counsel before launch.
- Tax treatment may differ for bundles, overseas consumers and digital services; current note assumes UK-only early sales and does not determine VAT classification or cross-border obligations.
- No detailed security threat model, DPIA threshold assessment, payment processor review or UK consumer terms have been completed.
