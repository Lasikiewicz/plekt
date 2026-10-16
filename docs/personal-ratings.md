# Personal Rating Sync

Personal ratings are a separate synchronization domain from watched state, play
history, resume positions, and custom lists. Plekt's local `personal_ratings`
table remains the canonical store. Remote work is optional and is delivered through
its own durable queue and scheduler cadence.

## Settings

Open **Settings → Sync → Sync Tools → Personal Rating Sync**. It is disabled by
default and has one control: on or off. When enabled, every connected Plex, Emby,
Jellyfin, and Trakt account participates in two-way sync on a five-minute cadence.
The first complete snapshot imports provider ratings; later snapshots reconcile
additions, changes, and removals. A partial or failed snapshot cannot clear local
ratings through missing rows.

Later complete scans hold removals for review when **at least two** previously rated
items and **more than 20%** of that provider's rated baseline disappear. Exactly 20%
or one missing rating follows normal reconciliation. Malformed or truncated scans
fail; per-item processing errors prevent the missing-rating clear pass.

A persistent **Rating scan held for review** warning in this panel lists the provider,
counts and missing titles. No observations or ratings from that held snapshot are
applied, and scheduled scans cannot bypass it. **Approve these removals** fetches a
fresh snapshot and applies the reviewed removal set only if it still matches; changed
removals require another review. Local edits retain the normal conflict protection.
**Dismiss and keep ratings** removes the warning without clearing ratings or advancing
the baseline. A later scan may hold the same removals again. Holds survive restarts.

Plekt remains the source of truth. A newer canonical Plekt value wins a
conflict and is queued back to the provider. A provider value with no newer local
change is imported and fanned out to the other connected providers. Outbound intent
markers suppress an echo of a change Plekt just sent.

## Local writes and queue behavior

Rating and remove-rating actions commit Plekt's canonical value first. If rating
sync is enabled, the same SQLite transaction upserts one queue item per enabled send
provider. A later edit or removal replaces the pending item for that provider, so a
stale rating cannot be delivered after a newer intent.

The request that saves a local rating does not call Plex, Emby, Jellyfin, or Trakt.
The queue worker leases items, retries transient failures with backoff, records
`not_found` and `reauth_required` states, and preserves failed work for a manual
retry. The Settings status view reports failed, unmatched, and reauthentication-
required queue work, including partial completion when some items remain unresolved.
A provider outage therefore does not roll back the local rating or affect the
watched-state synchronizer.

## Identity and episodes

Movies and shows use their own provider identity. An episode uses its parent show
identity plus season and episode coordinates in `media_key`; episode-level TMDB,
TVDB, IMDb, and provider item IDs are stored separately for remote writes. This
prevents an episode's leaf ID from fragmenting the show's episode rating record.

Authenticated Trakt snapshots read the account's ratings feed. For episode writes,
Plekt can resolve a Trakt leaf ID from show identity and season/episode
coordinates, then retry with the canonical episode ID when an external episode ID
is rejected.

## API

Enabling the Settings toggle starts a complete rating sync immediately, and a **Sync now**
button in the panel runs one on demand. The title
Force Sync modal retains its targeted **Push Personal Rating** troubleshooting
action; it does not enter the watched-state Force Sync activity or operation lock.

The authenticated endpoints are:

- `GET /api/rating-sync/status`
- `POST /api/rating-sync/run`
- `POST /api/rating-sync/push`
- `POST /api/rating-sync/retry`

To review a hold, POST to `/api/rating-sync/run` with `action` equal to `approve-held`
or `dismiss-held`, one `provider`, and the current `runId` from the status response.
Stale review tokens return HTTP 409. Status exposes held runs as `held`; their SQLite
status remains `partial`, with review data in `cursor_json.ratingHold`.

Trakt is a selectable target for both watched-state Push and personal-rating Push.
Watched-state Pull remains media-server-only because the existing pull operation
imports watched state from Plex, Emby, or Jellyfin; it is not a personal-rating
operation.

## Storage

Migration 20 adds episode identity and origin metadata to `personal_ratings` and
creates:

- `personal_rating_sources` - the last provider observation, snapshot generation,
  conflict status, and outbound echo markers.
- `personal_rating_sync_queue` - one durable latest-intent row per provider/media key,
  with lease, retry, and result state.
- `personal_rating_sync_runs` - per-provider baseline/import generation and counts.

See [sqlite-schema.md](sqlite-schema.md) for the table reference and
[scheduled-sync.md](scheduled-sync.md) for scheduler ownership and cadence.
