# Step 10: Watchlist migration and streaming availability

Merged into this plan on 16 October 2026 (it was its own proposed plan and builds on step 9's
deferred watchlist and import scope). Not started. The original design follows unchanged.

Outline (from the former summary):

1. Check the streaming data, regions, and what Trakt, JustWatch and Reelgood can export.
2. Decide the region and service settings, how availability shows, and which pages get the filter.
3. Design the watchlist file format and the preview-then-import flow.
4. Build, document, and test with real exports.

---

# Watchlist migration and streaming availability: design

Moved here from the summary on 16 October 2026 by the plan consolidation; no content changed.

## Current baseline

- Dated watch history, Trakt history sync, and watch-history reports already exist.
- The authenticated `/api/personal-media` endpoint returns the local watchlist and accepts
  per-title additions and removals. Full Plekt backup/export also contains the list.
- Plex is the only provider with live personal-watchlist sync. Trakt's current connection
  syncs watched state and ratings, not its watchlist.
- Detail pages show TMDB streaming availability for GB or US, but users cannot save their
  own preferred services or filter the list to titles on those services.

## Proposed scope

### 1. Preferred streaming services

- Let the user choose a region and the subscription services they have.
- Use provider availability data already returned by TMDB where possible; confirm region
  coverage, freshness, and terms during the investigation before committing to a design.
- Show whether a title is included with a selected subscription, available only to rent or
  buy, unavailable from the selected services, or has unknown availability.
- Add an **Available on my services** filter to the Watchlist and relevant discovery/search
  views. Keep the TMDB "where to watch" link available for the full regional listing.
- Do not infer subscription access from a title merely appearing in a Plex, Emby, or
  Jellyfin library.

### 2. Watchlist migration and portable files

- Add a watchlist-only JSON export and a documented CSV format, alongside the existing API
  and full Plekt backup.
- Add a preview-first importer for supported JSON/CSV data. Start with Trakt exports and a
  column-mapped generic CSV/JSON path; investigate JustWatch and Reelgood export/API
  options before promising direct support for either service.
- Match titles using provider IDs where available, then report unmatched and ambiguous
  titles for review instead of silently guessing.
- Merge into the canonical Plekt watchlist by default, deduplicate matches, and require
  an explicit choice before replacing existing items.
- Preserve a source "date added" and identifiers when supplied. Record the import time
  when a source does not include a date.
- Keep the first version as a migration/import workflow. Decide separately whether any
  ongoing third-party watchlist sync belongs in the tracker-connection work.

## Investigation and delivery outline

1. Verify the current provider-availability data, supported regions, and source export/API
   options for Trakt, JustWatch, and Reelgood. Set the supported import formats and the
   metadata identity rules.
2. Define where region and preferred-service settings live, how availability states are
   presented, and which pages get the filter.
3. Design the watchlist-only file schema and preview/commit flow, including duplicate,
   missing-ID, ambiguous-match, and replace behavior.
4. Implement in separate reviewable changes, document the migration and settings flows,
   and verify imports against representative movie and TV exports plus titles with missing
   and conflicting identifiers.

Each step gets its own step file when it starts.

## Acceptance criteria

- A user can choose their region and subscription services and filter eligible titles by
  those services.
- Results distinguish subscription inclusion from rent/buy offers and unknown availability.
- A user can export just the Plekt watchlist to portable JSON and CSV.
- A supported source file can be previewed, corrected where matching is uncertain, and
  merged without deleting the current list by default.
- Re-importing the same file does not create duplicate watchlist entries.
- Existing dated watch-history sync and reports keep their current behavior.

## Related plans

- Coordinate with the deferred watchlist/import scope in
  [external-tracker-connections step 9](step9-deferred.md) if
  that plan proceeds.
