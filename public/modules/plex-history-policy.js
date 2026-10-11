// Shared copy and state reader for the "Sync historical watched items to Plex"
// setting, so the first-run setup wizard and Settings - Sync - Sync Tuning show
// the same label, help, and consequences instead of drifting apart.
//
// The setting exists because the providers are not equivalent. Emby, Jellyfin,
// and Trakt can all be told when a watch actually happened; Plex's server API
// has no supported historical-date setter, so an imported watch is recorded
// using the Plex server's own clock. The copy here has to say that plainly
// rather than implying the original date was preserved.

export const PLEX_HISTORICAL_SYNC_LABEL = "Sync historical watched items to Plex";

export const PLEX_HISTORICAL_SYNC_CHOICES = Object.freeze([
  {
    value: "on",
    label: "On -",
    inlineDescription: "Recommended",
    descriptionLines: [
      "Send older watched items to Plex so its library matches Plekt.",
      "Plex may date their activity as today.",
    ],
    description: "Send older watched items to Plex so its library matches Plekt. Plex may date their activity as today.",
  },
  {
    value: "off",
    label: "Off",
    descriptionLines: [
      "Older items may stay unwatched in Plex, so counts can differ.",
      "Imported or restored watches will not appear in Plex activity.",
      "New watches still sync; existing Plex history is unchanged.",
    ],
    description: "Older items may stay unwatched in Plex, so counts can differ. Imported or restored watches will not appear in Plex activity. New watches still sync; existing Plex history is unchanged.",
  },
]);

export const PLEX_HISTORICAL_SYNC_HELP_HTML = [
  "Sends older watched items to Plex so its library matches Plekt.",
  "Plex may date them today because Plex controls the activity date.",
  "Turn this off to skip older watched history; new watches still sync normally.",
].join("<br>");

// What actually changes when the setting is off. Kept as data so the setup
// wizard can show it collapsed and Settings can show it inline without either
// place rewriting it.
export const PLEX_HISTORICAL_SYNC_OFF_CONSEQUENCES = Object.freeze([
  "Older items may stay unwatched in Plex, so counts can differ.",
  "Imported or restored watches will not appear in Plex activity.",
  "Existing Plex history is unchanged; new watches still sync normally.",
]);

// The distinction the setup preview and every import confirmation has to make:
// this is a Plex date limitation, not a general one.
export const PROVIDER_DATE_NOTE_HTML = [
  "<b>Trakt</b>, <b>Emby</b>, and <b>Jellyfin</b> keep the original date.",
  "<b>Plex</b> receives the watched state only, so its activity date may show as today.",
].join("<br>");

export function plexHistoricalSyncOffWarningHtml() {
  return `Turning this off means:<ul class="policy-consequence-list">${
    PLEX_HISTORICAL_SYNC_OFF_CONSEQUENCES.map((line) => `<li>${line}</li>`).join("")
  }</ul>Day-to-day watching is not affected. New watches still sync to Plex normally.`;
}

// ── Provider outcome reporting ─────────────────────────────────────────────
// The server returns per-provider counts (see summarizeProviderOutcomes in
// server/src/utils/watchSyncPolicy.js) for each <=100-record batch, so a
// multi-batch action has to add them up before it can say anything true.

const DECISION_KEYS = ["sent", "already_matching", "skipped_by_policy", "unsupported", "failed"];

export function mergeProviderOutcomes(batches = []) {
  const byTarget = new Map();
  for (const bucket of batches.flat()) {
    const target = String(bucket?.target || "").trim().toLowerCase();
    if (!target) continue;
    if (!byTarget.has(target)) {
      byTarget.set(target, Object.fromEntries([["target", target], ...DECISION_KEYS.map((key) => [key, 0])]));
    }
    const merged = byTarget.get(target);
    for (const key of DECISION_KEYS) merged[key] += Number(bucket?.[key] || 0);
  }
  return [...byTarget.values()];
}

function providerLabel(target) {
  return String(target).charAt(0).toUpperCase() + String(target).slice(1);
}

/**
 * A short sentence for the outcomes a plain "pushed N of M" count cannot
 * express: a provider Plekt deliberately did not write to, and a provider
 * that already agreed. Returns "" when there is nothing of that kind to say,
 * so the caller can append it unconditionally.
 */
export function providerOutcomeNotice(outcomes = []) {
  const merged = mergeProviderOutcomes([outcomes]);
  const notes = [];
  for (const bucket of merged) {
    if (bucket.skipped_by_policy > 0) {
      notes.push(`${providerLabel(bucket.target)} skipped ${bucket.skipped_by_policy} by the historical sync policy`);
    }
    if (bucket.already_matching > 0) {
      notes.push(`${providerLabel(bucket.target)} already matched ${bucket.already_matching}`);
    }
  }
  return notes.length ? ` ${notes.join("; ")}.` : "";
}

// The stored setting is published as { value, default, overridden } like the
// rest of the tuning section, but a plain boolean is accepted too so a caller
// reading a raw config object does not need to know which shape it has.
export function plexHistoricalSyncEnabled(config = {}) {
  const field = config?.tuning?.plexHistoricalWatchedSync;
  if (field === undefined || field === null) return true;
  if (typeof field === "object") return field.value !== false;
  return field !== false;
}
