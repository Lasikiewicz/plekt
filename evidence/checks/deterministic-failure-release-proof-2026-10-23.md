# Simkl deterministic failure release proof — 2026-10-23

Scope: offline failure injection through the production Simkl transport, adapter, and sync path. Tests use `makeTempDataDir()` and synthetic credentials only. No local app server, disposable authenticated DATA_DIR, provider account, or live credential was used. No production code was changed.

## Coverage matrix

| Release concern | Evidence | Result |
| --- | --- | --- |
| HTTP 500 / 503 failed reads do not advance the durable cursor or mutate the inbox | `test/simklFailureReleaseGate.test.js`: calls `syncSimklObservations({ trigger: "user" })`; injects HTTP responses at the mocked network boundary; asserts original cursor and exact inbox row survive, with no local watch or write intent | Pass; one request per failure |
| Read timeout does not advance the cursor or mutate the inbox | Same file; stalls the network fetch until the production outbound timeout aborts it. The test shortens only the 30-second timer to 5 ms for deterministic execution | Pass; `UPSTREAM_TIMEOUT` / 504, one request |
| Failed or malformed supplementary rating reads reject the whole snapshot | `test/simklAdapter.test.js`, “failed or malformed supplemental ratings fails the snapshot instead of advancing its cursor”; `test/simklRatingConditionalIntegration.test.js`, conditional integration failure keeps rating snapshot and cursor unchanged | Pass |
| Inbound snapshots carry no absence authority; omissions do not remove observations | `test/simklFailureReleaseGate.test.js` asserts absence of reconciliation writes; `test/simklPersistence.test.js`, “Simkl baseline is persisted without importing old history; deltas merge and never remove omissions”; `test/simklAdapter.test.js`, activity-gated reads assert `absenceReconciliation === false` | Pass |
| Rate limit backoff and request pacing are bounded | `test/simklTransport.test.js`: burst cooldown, daily reset, serial pacing, quota guard; `test/simklBatchPersistence.test.js`: quota failure leaves attempts at zero and does not repeat preflight | Pass. Simkl governor cooldown applies to provider rate/quota signals; generic 5xx/timeout automatic retries are not implemented or required by this behavior |
| Uncertain watched write cannot be blindly resent | `test/simklAdapter.test.js`: lost response and successful POST/readback failure persist review; a second adapter call does not POST again. `test/simklBatchPersistence.test.js`: lost batch response holds all claimed intents and the next call sends nothing | Pass |
| Timeout behavior does not retry a request and releases the transport queue | `test/simklTransport.test.js`, “Simkl stalled response bodies time out once and release the account queue”; “Simkl never retries an uncertain POST and failures do not poison the queue” | Pass |
| Durable holds survive recovery / restart-like persistence paths | `test/simklBatchPersistence.test.js`: expired sending leases recover to review; `test/simklPersistence.test.js`: full backup preserves cursor/review decisions and quarantines unfinished work, and expired send leases become visible review with no retry activation | Pass |
| Rating writes do not resend after an unsuccessful readback | `test/simklRatings.test.js`, “write not_found and changed or failed readback are surfaced without retrying the send” | Pass |

## Verification run

Focused command:

```text
node --test test/simklFailureReleaseGate.test.js test/simklAdapter.test.js test/simklPersistence.test.js test/simklBatchPersistence.test.js test/simklTransport.test.js
```

Result: **55 passed, 0 failed**. A second focused run after adding the production-timeout case:

```text
node --test test/simklFailureReleaseGate.test.js
```

Result: **4 passed, 0 failed**. No full test suite or build was run.

Rating hold checks:

```text
node --test test/simklRatings.test.js test/simklRatingConditionalIntegration.test.js
```

Result: **11 passed, 0 failed**.

## Limits

These are deterministic code-path tests, not a live provider outage or account test. The failed reads are demonstrated through production sync and adapter functions with an offline network boundary. Generic 500/503/timeouts are surfaced after one bounded attempt; recovery depends on a later user/event trigger. The Simkl quota governor provides pacing/cooldown for rate-limit signals. No release claim about live Simkl availability is made.
