# Step 9: deferred phases (not part of this effort)

Deferred when the scope narrowed on 24 September 2026. Phase 2b is deferred because Trakt has no watchlist sync to match.

## Work

### Phase 2b - Tracker watchlist support

Net-new plumbing, not an extension. Deferrable without blocking Phase 2.

- Decide the `representation` and `remote_scope_key` model for container-less providers.
- Widen the two watchlist provider constraints.
- Implement watchlist read/add/remove for Simkl.

### Phase 4 - MyAnimeList anime adapter

- Implement OAuth2/PKCE and token refresh.
- Add anime-only capability declarations.
- Implement conservative list/status/score/date import.
- Add explicit numbering and inferred-progress warnings.

Exit when ordinary anime, specials, split seasons, and unknown episode totals have deterministic tests and safe user-facing outcomes.

### Phase 5 - Import tools

- Add shared CSV parsing/validation and preview UI.
- Add IMDb list/watchlist parser.
- Add unresolved-match review and import audit records.
- Add export formats that retain provider IDs and watch dates.

Exit when imports are repeatable, idempotent, reversible through local backup/restore, and cannot trigger provider writes without an explicit user action.

## Design

### MyAnimeList implementation plan

Treat MyAnimeList as a separate anime adapter, not as a general movie/TV tracker.

Map MAL list statuses as follows:

- `completed` maps to watched episodes according to `num_watched_episodes`;
- `watching` maps to partial progress only if Plekt's product explicitly accepts provider progress import;
- `plan_to_watch` maps to an optional external watchlist import, not automatically Plekt's movie/TV watchlist;
- `on_hold` and `dropped` map to provider metadata/status, not watched state.

Because MAL commonly represents an anime entry with an episode count rather than a full per-episode history, the first MAL release must not invent per-episode watches from that count by default. Import show-level progress as provider progress, or import individual episodes only when the API supplies verifiable episode-level state. A user opt-in may enable inferred contiguous progress later, but it must be labelled as inferred and must handle specials, split cours, unknown episode totals, and non-contiguous watches explicitly.

Use MAL IDs as aliases and resolve the title through the existing metadata pipeline. Add explicit tests for specials, split cour/seasons, unknown episode counts, and numbering mismatches.

MAL's anime-only coverage makes it the best test of the capability contract: with MAL and Simkl both connected, a movie must dispatch only to Simkl, and the merged date anchor must ignore MAL for non-anime entirely.

### Import-oriented integrations

#### Shared rules for every import source

Carried over from the retired root `TODO.md` (items 1 and 2), and binding on every importer
added under this plan as well as on
[archive/tautulli-watch-history-import](../../archive/tautulli-watch-history-import/summary.md):

- **Take an automatic backup immediately before any merge or import runs**, using the
  existing backup system (see [docs/backups.md](../../../docs/backups.md),
  `public/modules/tools-backups.js`), so a bad merge can be rolled back. The Tautulli
  importer already does this with a `pre_tautulli_import` reason; every new source uses the
  same path with its own reason string rather than inventing one.
- **The merge/import decision must be verified before a new source is added**, not after. It
  has to handle clashes cleanly - duplicate records, and conflicting watch dates or provider
  IDs for the same play - rather than inserting a second row. The identity-aware helper built
  for Tautulli (`prepareTautulliImport`) is the reference shape: one decision function shared
  by preview and commit, so the preview cannot disagree with the result.
- Historical rows imported this way are historical projections, so they carry an explicit
  `syncIntent` and travel through the provider matrix in
  [archive/historical-watch-sync-policy](../../archive/historical-watch-sync-policy/summary.md). An importer must never
  create outbound work that bypasses it.

#### MDBList

MDBList was requested as a tracker alongside Simkl (Reddit, r/jellyfin,
27 August 2026) and has not been investigated at all. Before it is placed anywhere in the
delivery order above, run the same Phase 0 gate applied to Simkl: licensing
and rate limits with the exact wording and source URL, auth model, whether it exposes
personal watched state and ratings rather than only lists, and whether episodes are covered.

Until that gate is answered, do not assume MDBList is a live-sync candidate. Its list API may
make it an import/export integration, or a metadata source only - see
[mdblist-metadata-source.md](../../mdblist-metadata-source.md), which covers the separate
ratings-aggregation use for MDBList and is independent of any tracker work here.

#### IMDb

Provide a generic list CSV importer with an IMDb-specific parser. Support `tconst`, title, year, watched/list state, and rating when present. This is a one-time or user-triggered import, not a background connection. Do not request IMDb metadata API access merely to implement personal watch synchronization.

The same telemetry obligation applies to every import source.

#### Serializd and TV Time

Do not add credentials, scraping, private endpoint calls, or background polling for either service. If users provide exports in the future, add them through the same import pipeline with an explicit source label and no provider connection record.

## Carried Simkl file-import validation

When file-import work starts, inspect an actual JSON archive before defining its
importer. The Phase 0 request was blocked and consumed the monthly allowance; no
archive was validated. CSV is title-level, not complete episode/play history.
Investigate the recorded CSV-only movie/API omission without inferring an unwatch.
See step 1d for counts and evidence. These checks remain unrun and imports deferred.

### 21 October 2026: Phase 0 carry-forward

Assigned export-file evidence gaps to deferred import work; no importer implemented
and no export validation marked passed.
