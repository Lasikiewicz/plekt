# Plex Watchlist Sync

Plekt stores the personal watchlist locally as the canonical present-set. A local
watchlist add or removal commits to SQLite first and creates durable provider work; the
browser does not wait for Plex.

## Why Plex is the only provider

Plex has a real account-level watchlist covering its whole catalogue, so it can hold what
a watchlist is for: titles you do not own yet. Plekt uses the account-level Universal
Watchlist; the Plex watchlist RSS feed is read-only, so it serves only as a read fallback
(`plexWatchlistClient.js`). Emby and Jellyfin have no watchlist concept.
Their nearest equivalents, a playlist or Favorites, address items by library id and so can
only hold media already on the server. Both were verified against their live APIs before
being retired: adding an id the library does not hold is accepted and then silently ignored
(`ItemAddedCount: 0`), and a playlist cannot hold a series as a series - Emby expands it
into the episodes it happens to have. That last behaviour also made every later snapshot
read the entry as removed, which deleted it from the canonical list and fanned the deletion
out to Plex.

`WATCHLIST_SYNC_PROVIDERS` in `configStore.js` and `WATCHLIST_PROVIDERS` in
`personalWatchlistRepository.js` are both `["plex"]`. Rows left behind by the retired
projections are deleted once on load by `purgeRetiredWatchlistProviders()`, so the
unfiltered queue summaries behind the settings panel cannot keep reporting issues for a
projection that no longer exists. The canonical watchlist itself is never touched by that
cleanup.

## Controls

Watchlist sync is disabled by default and is turned on in any of three places, all writing
the same `watchlistSync.enabled` flag:

- **Guided setup** - a *Sync Watchlist with Plekt* checkbox on the Plex row of the media
  servers step, checked by default and applied when that step is completed.
- **Settings → Media Servers → Plex** - the same checkbox, which saves on change rather than
  waiting for the card's Save button (that button only submits connection fields).
- **Settings → Sync → Sync Tools → Plex Watchlist Sync** - the on/off control, plus
  **Sync now** for an immediate reconcile.

The first sync takes a safe union of the Plekt and Plex lists. Plex-only entries are
imported into Plekt. Later complete snapshots reconcile additions and removals;
incomplete snapshots cannot delete canonical entries.

## Completion and removal

Completed movies and explicitly completed TV shows create a durable local removal tombstone
with origin `watched`, then fan out removal work to every enabled provider. Watching one
episode of an incomplete show does not remove the show. A confirmed removal from a managed
provider representation becomes a canonical local removal with origin `provider_removed`.
An explicit local re-add creates a newer revision, so an older completion or provider event
cannot immediately undo it.

## Recovery and status

The queue, provider ownership ledger, snapshot generations, mutation history, and activity
events live in separate SQLite tables. A Plex outage, incomplete snapshot, or ambiguous
match never deletes the canonical local row. Status exposes
pending, unavailable, reauthentication, and failure states, with retry actions in Settings.

`GET /api/watchlist-sync/status` returns an `issues` array, both per provider and for the
whole queue. Each entry groups the stuck queue rows by provider and state and carries the
count, up to three affected titles, the redacted provider error, the highest attempt count,
and the next scheduled retry time. The Plex Watchlist Sync panel in Settings renders one
card per group, so a refused change explains what Plex reported and what to do:

- `reauth_required` means the stored Plex sign-in was refused, and offers a button that opens
  Settings → Media Servers to reconnect it.
- `failed` shows the error Plex returned, the failed attempt count, and when the next
  automatic attempt is due.
- `not_available` means Plekt could not match the title in the Plex catalogue, usually
  because the entry carries none of the provider ids Plex matches on. It stays on the
  Plekt list and keeps retrying.

A provider whose last snapshot run failed gets its own card, built from `providers[].lastRun`
rather than the queue. Nothing can be queued against a list Plekt could not read, so that
failure is otherwise invisible: the provider row still reports its configured capability. That
read is also the only path by which an addition made in the provider becomes a canonical
Plekt watchlist entry (`recordProviderSnapshot` applies unmatched remote items with reason
`provider_added`), so a failed run stops imports in both directions.

A **Retry queued changes** button on that panel posts `{"action":"retry"}` to
`/api/watchlist-sync/run`, which resets failed, unavailable, and reauthentication rows back
to pending and immediately runs a reconcile pass. Because `retry` mode deliberately skips the
provider snapshot, the button follows it with a plain `run` whenever a run failure is on
screen, so a failed read is actually re-attempted. The panel header reads `Needs attention`
only for failed or reauthentication rows.

Full Plekt backup/export includes the canonical watchlist and its non-secret sync state.
Restoring it invalidates remote observations and forces another safe-union snapshot before
delivery resumes. Watch-history-only backups do not include personal watchlist data.

The authenticated API surface is:

- `GET /api/watchlist-sync/status`
- `POST /api/watchlist-sync/preview`
- `POST /api/watchlist-sync/run`
- `GET /api/watchlist-sync/activity`

All provider credentials remain server-side. The scheduler runs the watchlist worker under
the shared SQLite leadership lease with its own queue and time budget, independently of
watched-state and personal-rating synchronization.
