# Sync capacity guidance

Plekt publishes measured ranges rather than a universal library limit. Run
`BENCHMARK_ITEMS=1000 node scripts/benchmark-sync.js` with the deployment's normal
Node.js and storage configuration, and keep the workload and environment beside the
result. Larger or provider-heavy installations should use a Force Sync preview and a
smaller scope before expanding coverage.

The in-app health endpoint reports current history scale, matching failures, and outbound
pressure. Being outside the tested range is guidance to reduce scope or enrich less; it
does not disable synchronization.

## Measuring a library larger than yours

`scripts/generate-synthetic-library.js` builds a disposable library at a stated scale,
and `scripts/benchmark-surfaces.js` records the server-side surfaces against it:

```bash
node scripts/generate-synthetic-library.js --data-dir /tmp/plekt-scale --movies 6000 --shows 1200 --episodes-per-show 24 --history-rows 90000
node scripts/benchmark-surfaces.js --data-dir /tmp/plekt-scale --runs 5 --output docs/benchmarks/surfaces-scale.json
```

The generator writes only to the directory it is given and refuses one holding a database
it did not create. Results land in `docs/benchmarks/`, each carrying the library scale and
the hardware it was taken on, so a number always travels with its workload.

The Movies and TV Shows libraries, dashboard preview, and Stats all read the whole watch
history and are not capped. `MAX_HISTORY_LIMIT` (25,000, in
[`dataRepo.js`](../server/src/utils/dataRepo.js)) is an API pagination safety bound only.
Stats deliberately reuses the uncapped history cache so its existing JS echo-suppression
and identity semantics remain identical. A 25,005-row regression test crosses the old
ceiling; the 90,000-row fixture reports all 90,000 watches, 6,000 unique movies, and 72,000
episode watches.

Full-history derived caches cost memory and rebuild time, and both grow with the library.
On that 90,000-row fixture, uncapping Stats raised its rebuild from 1,320.8ms to 2,203.0ms
and a full cache rebuild from 4,444.1ms to 5,314.9ms. The compact all-time HTTP payload was
15,631 bytes. See `docs/benchmarks/stats-uncapped-after.json` for the recorded workload and
hardware.
