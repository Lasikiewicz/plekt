import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchProvenance,
  normalizeWatchProvenance,
  provenanceTelemetryLines,
} from "../server/src/utils/watchProvenance.js";

test("watch provenance records the exact ingest path without raw payload data", () => {
  const provenance = buildWatchProvenance(
    {
      source: "plex",
      event: "library_history",
      phase: "completed",
      itemId: "12345",
      user: "alice",
    },
    {
      ingestPath: "plex_scheduled_library_history",
      sourceTimestamp: "2026-07-16T09:25:00.000Z",
    },
  );

  assert.equal(provenance.ingest_path, "plex_scheduled_library_history");
  assert.equal(provenance.event, "library_history");
  assert.equal(provenance.item_id, "12345");
  assert.equal(provenance.source_timestamp, "2026-07-16T09:25:00.000Z");
  assert.equal(provenance.confidence, "exact");
  assert.equal("rawPayload" in provenance, false);
});

test("legacy provenance is explicit about what cannot be recovered", () => {
  const provenance = normalizeWatchProvenance(null, { source: "plex" });
  const telemetry = provenanceTelemetryLines(null);

  assert.equal(provenance.ingest_path, "unknown");
  assert.equal(provenance.confidence, "source_only");
  assert.match(provenance.note, /predates detailed provenance/i);
  assert.match(telemetry.join("\n"), /Ingest path: unavailable/);
  assert.match(telemetry.join("\n"), /only the originating platform was retained/i);
});

test("provenance normalization accepts stored JSON but drops unknown fields", () => {
  const normalized = normalizeWatchProvenance(JSON.stringify({
    source: "emby",
    ingestPath: "emby_webhook",
    event: "item.markplayed",
    itemId: "item-1",
    rawPayload: "secret payload",
  }));

  assert.equal(normalized.source, "emby");
  assert.equal(normalized.ingest_path, "emby_webhook");
  assert.equal(normalized.item_id, "item-1");
  assert.equal("rawPayload" in normalized, false);
});

test("provenance preserves a provider-only Trakt series override", () => {
  const normalized = normalizeWatchProvenance({
    source: "plex",
    provider_overrides: { trakt: { tmdb_id: "329471", season: 1, episode: 1 } },
  });

  assert.deepEqual(normalized.provider_overrides, {
    trakt: { tmdb_id: "329471", season: 1, episode: 1 },
  });
});

test("provenance keeps import source_title for later CSV dedupe", () => {
  const normalized = normalizeWatchProvenance({
    source: "netflix_import",
    phase: "netflix",
    source_title: "Last Christmas",
    source_timestamp: "2024-12-12T12:00:00.000Z",
  });
  assert.equal(normalized.source_title, "Last Christmas");
});
