import { getTrackerAdapter, isTrackerProvider, trackerProviderIds } from "./trackers/registry.js";

const MAX_REASON_LENGTH = 900;
const MAX_EXAMPLES = 8;
const MAX_RESTORE_ISSUES = 5_000;

const AUTHORITATIVE_RESTORE_KINDS = new Set([
  "backup_restore",
  "full_sync_watchstates",
  "restore",
]);

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return (normalized || fallback).slice(0, MAX_REASON_LENGTH);
}

function providerLabel(provider) {
  const key = String(provider || "").trim().toLowerCase();
  if (isTrackerProvider(key)) return getTrackerAdapter(key).label;
  if (key === "plex") return "Plex";
  if (key === "emby") return "Emby";
  if (key === "jellyfin") return "Jellyfin";
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "provider";
}

function restoreIssueProvider(issue = {}) {
  return String(issue.provider || issue.target || "").trim().toLowerCase();
}

function isExpectedRestoreAvailabilitySkip(issue = {}) {
  const provider = restoreIssueProvider(issue);
  if (isTrackerProvider(provider)) return false;
  if (issue.expectedSkip === true) return true;
  const detail = [issue.reason, issue.lastError, issue.detail]
    .map((value) => String(value || ""))
    .join(" ");
  return /no matching item/i.test(detail);
}

function failureReason(result = {}) {
  return text(result.error || result.reason || result.message, "The sync operation reported a failure.");
}

function isIntentionalStop(result = {}) {
  return result.cancelled === true || result.aborted === true || result.reset === true;
}

function isActionableFailure(result = {}) {
  const value = objectValue(result);
  if (isIntentionalStop(value)) return false;
  return value.success === false || (value.success === undefined && Boolean(value.error));
}

function runKey(...values) {
  return values
    .map((value) => String(value ?? "").trim())
    .find(Boolean) || "latest";
}

function idPart(...values) {
  return runKey(...values).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100) || "latest";
}

// The tracker named by a "<Label> rejected N restored plays" restore failure.
export function trackerForRejection(reason) {
  const label = String(reason || "").match(/(\S+) rejected \d+ restored play/i)?.[1]?.toLowerCase() || "";
  return trackerProviderIds().find((provider) => provider === label || getTrackerAdapter(provider).label.toLowerCase() === label) || "";
}

function parseTrackerRejection(reason) {
  // Restore issue updates use normal singular/plural grammar, while older
  // failures used the literal "play(s)" wording. Accept all three forms so
  // the attention item keeps its tracker-specific actions as issues are
  // resolved one at a time.
  const provider = trackerForRejection(reason);
  const match = String(reason || "").match(/rejected (\d+) restored play(?:\(s\)|s?) after (\d+) retries/i);
  if (!provider || !match) return null;
  const examplesMatch = String(reason || "").match(/\(for example:\s*(.*?)\)\s*$/i);
  const examples = examplesMatch
    ? examplesMatch[1]
      .split(/,\s+(?=[^,]+ - S\d{2}E\d{2}\b)/i)
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, MAX_EXAMPLES)
    : [];
  return {
    provider,
    rejectedCount: Number(match[1]) || 0,
    retryCount: Number(match[2]) || 0,
    examples,
  };
}

function safeIssueNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function localSlug(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

function episodeCoordinatesFromTitle(title = "") {
  const match = String(title || "").match(/\bS(\d{1,3})E(\d{1,3})\b/i);
  return {
    season: safeIssueNumber(match?.[1]),
    episode: safeIssueNumber(match?.[2]),
  };
}

function showTitleFromIssue(title = "") {
  return String(title || "")
    .replace(/\s+-\s+S\d{1,3}E\d{1,3}\b.*$/i, "")
    .trim();
}

function numericProviderId(value) {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) ? normalized : "";
}

function localHrefForRestoreIssue(issue = {}) {
  const type = String(issue.type || "").toLowerCase();
  const title = String(issue.sourceTitle || issue.title || "").trim();
  const showTitle = String(issue.sourceShowTitle || issue.showTitle || showTitleFrom(title)).trim();
  const sourceRowId = String(issue.sourceRowId || "").trim();
  const sourceSeason = safeIssueNumber(issue.sourceSeason, safeIssueNumber(issue.season));
  const sourceEpisode = safeIssueNumber(issue.sourceEpisode, safeIssueNumber(issue.episode));
  const ids = objectValue(issue.sourceIds);
  const fallbackIds = objectValue(issue.ids);

  // A history id on the local show route is the most useful repair link: it
  // opens the exact imported row even when its provider identity is currently
  // wrong or missing. The season/episode path keeps the location obvious.
  if (type === "episode" && showTitle && sourceSeason != null && sourceEpisode != null) {
    const path = `/tvshow/${localSlug(showTitle)}/season/${sourceSeason}/episode/${sourceEpisode}`;
    return sourceRowId ? `${path}?historyId=${encodeURIComponent(sourceRowId)}` : path;
  }
  if (type === "movie") {
    const tmdbId = numericProviderId(ids.tmdb || fallbackIds.tmdb);
    if (tmdbId) return `/movie/tmdb/${tmdbId}`;
    if (title) return `/search?q=${encodeURIComponent(title)}`;
  }
  if (showTitle) return `/search?q=${encodeURIComponent(showTitle)}`;
  return title ? `/search?q=${encodeURIComponent(title)}` : "";
}

// Older restore results kept rejected plays under the tracker's own key.
export function trackerRejectedItems(result = {}) {
  const provider = trackerProviderIds().find((id) => Array.isArray(objectValue(result[id]).rejectedItems));
  return provider ? result[provider].rejectedItems : [];
}

function restoreIssueItems(result = {}, tracker = null, runId = "", reason = "") {
  const value = objectValue(result);
  const persisted = Array.isArray(value.restoreIssues)
    ? value.restoreIssues
    : Array.isArray(value.restoreItems)
      ? value.restoreItems
      : Array.isArray(value.rejectedItems)
        ? value.rejectedItems
        : trackerRejectedItems(value);
  const parsedCount = Number(value.restoreIssueCount || tracker?.rejectedCount || 0);
  const rawItems = persisted.length
    ? persisted
    : (tracker?.examples || []).map((title, index) => ({
      key: `restore-example:${idPart(`${runId}-${index}-${title}`)}`,
      title,
      sourceTitle: title,
      candidate: true,
      reason: "This title was retained as an example by the failed restore; the exact rejected row was not persisted.",
    }));
  const normalizedItems = rawItems.slice(0, MAX_RESTORE_ISSUES).map((raw, index) => {
    const input = typeof raw === "string" ? { title: raw } : objectValue(raw);
    const provider = text(input.provider || input.target || tracker?.provider).toLowerCase();
    const title = text(input.sourceTitle || input.title, "Unknown media").slice(0, 400);
    const titleCoordinates = episodeCoordinatesFromTitle(title);
    const type = String(input.type || input.mediaType || "").toLowerCase() === "movie"
      ? "movie"
      : String(input.type || input.mediaType || "").toLowerCase() === "episode" || titleCoordinates.season != null
        ? "episode"
        : "unknown";
    const item = {
      key: text(input.key, `restore-issue:${idPart(`${runId}-${index}-${title}`)}`).slice(0, 280),
      provider,
      target: text(input.target || input.provider).toLowerCase(),
      category: text(input.category),
      sourceRowId: text(input.sourceRowId).slice(0, 240),
      sourcePlaystateKey: text(input.sourcePlaystateKey || input.mediaKey).slice(0, 240),
      sourceMediaKey: text(input.sourceMediaKey).slice(0, 240),
      title,
      sourceTitle: title,
      showTitle: text(input.showTitle || showTitleFromIssue(title)).slice(0, 300),
      sourceShowTitle: text(input.sourceShowTitle || input.showTitle || showTitleFromIssue(title)).slice(0, 300),
      type,
      season: safeIssueNumber(input.season, titleCoordinates.season),
      episode: safeIssueNumber(input.episode, titleCoordinates.episode),
      sourceSeason: safeIssueNumber(input.sourceSeason, safeIssueNumber(input.season, titleCoordinates.season)),
      sourceEpisode: safeIssueNumber(input.sourceEpisode, safeIssueNumber(input.episode, titleCoordinates.episode)),
      watchedAt: text(input.watchedAt || input.watched_at),
      ids: objectValue(input.ids),
      sourceIds: objectValue(input.sourceIds),
      reason: text(
        input.lastError || input.reason,
        provider && !isTrackerProvider(provider)
          ? `${providerLabel(provider)} did not confirm the restored state.`
          : reason || `${provider ? providerLabel(provider) : "The tracker"} could not match this restored play.`,
      ),
      candidate: input.candidate === true,
    };
    item.localHref = localHrefForRestoreIssue(item);
    item.localLinkLabel = item.localHref?.startsWith("/search?") ? "Search in Plekt" : "Open in Plekt";
    // Media-server restore issues may only retain the playstate media key
    // when the matching watch-history row was not available during the
    // restore pass. That key is still enough for the repair route to reload
    // the canonical playstate and retry the affected target. Tracker repairs
    // still require the source watch-history row because their retry logic
    // re-resolves that row's provider identity.
    const isTracker = isTrackerProvider(item.provider);
    const hasRepairSource = isTracker
      ? Boolean(item.sourceRowId)
      : Boolean(item.sourceRowId || item.sourcePlaystateKey || item.sourceMediaKey);
    item.canRepair = hasRepairSource
      && !item.candidate
      && item.type !== "unknown"
      && (isTracker || ["plex", "emby", "jellyfin"].includes(item.provider));
    item.repairLabel = item.provider && !isTracker
      ? `Retry on ${providerLabel(item.provider)}`
      : "Retry this play";
    return item;
  });
  const expectedSkipCount = Math.max(
    normalizedItems.filter((item) => isExpectedRestoreAvailabilitySkip(item)).length,
    Number(value.expectedSkipCount) || Number(value.pushed?.expectedSkipCount) || 0,
  );
  const items = normalizedItems.filter((item) => !isExpectedRestoreAvailabilitySkip(item));
  const issueCount = Math.max(
    items.length,
    parsedCount > 0 ? Math.max(0, parsedCount - expectedSkipCount) : 0,
  );
  return {
    items,
    issueCount,
    expectedSkipCount,
    complete: issueCount > 0 && items.length >= issueCount && value.restoreIssuesComplete !== false,
  };
}

function restoreIssueRequiresMatch(issue = {}) {
  return /not enough row data|fix match/i.test([
    issue.reason,
    issue.lastError,
    issue.detail,
  ].map((value) => String(value || "")).join(" "));
}

function recommendationsFor(reason, { source = "sync", provider = "", requiresMatch = false } = {}) {
  const lower = String(reason || "").toLowerCase();
  if (source === "restore" && requiresMatch) {
    const target = providerLabel(provider || "the affected app");
    return [
      `Use Fix match on each affected Plekt item to confirm its title, season, episode, and provider IDs match the ${target} library.`,
      "Retry each affected item after saving the match; the retry will use the corrected local identity.",
      "If the item is intentionally unavailable on that app, skip the issue to let the remaining restore targets complete.",
    ];
  }
  if (isTrackerProvider(provider) && /rejected .*restored play|could not match|not_found/.test(lower)) {
    const tracker = providerLabel(provider);
    return [
      `Check the listed titles on ${tracker} and confirm their series, season, and episode numbering.`,
      `For split or combined episodes, confirm the canonical mapping used by ${tracker} and rerun the restore.`,
      `If the items do not exist on ${tracker}, skip this issue to accept the partial ${tracker} replay.`,
    ];
  }
  if (source === "restore" && /no matching item|not found|did not confirm|projection/.test(lower)) {
    const target = providerLabel(provider || "the target app");
    return [
      `Open the listed item in Plekt and confirm its title, season, episode, and provider IDs match the ${target} library.`,
      `Refresh or reconnect ${target}, then retry the individual item once it is available.`,
      "If this item is intentionally unavailable on that app, skip the issue; the other restored targets can remain complete.",
    ];
  }
  if (/unauthorized|forbidden|401|403|token|credential|api key/.test(lower)) {
    return [
      `Check the ${provider || "target"} connection credentials in Settings and test the connection.`,
      "Save the corrected connection, then retry the initial import or restore.",
      "If this source is not available, skip the issue to continue with the remaining projections.",
    ];
  }
  if (/timeout|network|refused|connect|fetch|econn|socket/.test(lower)) {
    return [
      `Confirm ${provider || "the target"} is running and reachable from the Plekt server.`,
      "Check firewall, proxy, and DNS settings, then retry once the connection is stable.",
      "If the source is intentionally unavailable, skip the issue to continue.",
    ];
  }
  if (source === "initial_import") {
    return [
      `Check the ${provider || "source"} connection and retry the initial import.`,
      "Review Settings → Logs for the detailed failure if the retry fails again.",
      "If you do not want to import this source, skip it to finish the remaining setup sync.",
    ];
  }
  return [
    "Review Settings → Logs for the detailed failure and confirm the connected app is available.",
    "Retry the operation after correcting the reported problem.",
    "If the affected items are intentionally unavailable, skip this issue to accept the incomplete projection.",
  ];
}

function restoreAttention(runtime = {}) {
  const result = objectValue(runtime.restoreSyncResult);
  if (!isActionableFailure(result)) return null;

  const kind = runKey(runtime.restoreSyncKind, result.restoreKind, "restore");
  const runId = runKey(runtime.restoreSyncRunId, result.runId, result.finishedAt);
  const reason = failureReason(result);
  const rejection = parseTrackerRejection(reason);
  const restoreIssues = restoreIssueItems(result, rejection, runId, reason);
  const targetIssues = restoreIssues.items.filter((issue) => issue.provider && !isTrackerProvider(issue.provider));
  const requiresMatch = restoreIssues.items.some(restoreIssueRequiresMatch);
  const storedTrackerIssues = restoreIssues.items.filter((issue) => isTrackerProvider(issue.provider));
  const trackers = [...new Set([rejection?.provider, ...storedTrackerIssues.map((issue) => issue.provider)].filter(Boolean))];
  const expectedSkipCount = restoreIssues.expectedSkipCount;
  const providers = [...new Set(restoreIssues.items.map((issue) => issue.provider).filter(Boolean))];
  // One tracker rejecting part of its replay gets that tracker's actions;
  // anything mixed is reported as a projection failure.
  const trackerOnly = trackers.length === 1 && targetIssues.length === 0;
  const tracker = trackerOnly ? trackers[0] : "";
  const trackerName = providerLabel(tracker);
  const trackerSummary = rejection || (storedTrackerIssues.length ? {
    rejectedCount: storedTrackerIssues.length,
    retryCount: Number(objectValue(result[tracker]).retryCount) || 0,
    examples: storedTrackerIssues.slice(0, MAX_EXAMPLES).map((issue) => issue.title),
  } : null);
  const id = trackerOnly
    ? `restore:${idPart(runId)}:${tracker}-rejected`
    : `restore:${idPart(runId)}:projection-failed`;
  const operationLabel = kind === "backup_restore" ? "Authoritative watch-history restore" : "Authoritative watch-state restore";
  const providerSummary = providers.map((provider) => {
    const count = restoreIssues.items.filter((issue) => issue.provider === provider).length;
    return `${count} ${providerLabel(provider)}`;
  }).join(", ");
  const explanation = trackerOnly
    ? `${operationLabel} is still paused because ${trackerName} rejected ${trackerSummary.rejectedCount} restored play${trackerSummary.rejectedCount === 1 ? "" : "s"}. This can happen when a source represents a split, combined, or special episode differently from ${trackerName} (for example, two parts versus one longer episode), so Plekt cannot confirm those records are the same plays. Normal sync is fenced so it cannot overwrite the partially restored state while this issue is unresolved.`
    : targetIssues.length
      ? `${operationLabel} is still paused because ${providerSummary || "one or more connected apps"} did not confirm every restored item. ${expectedSkipCount ? `${expectedSkipCount} item${expectedSkipCount === 1 ? " was" : "s were"} absent from a connected library and was recorded as an expected skip. ` : ""}${requiresMatch ? "At least one failed item no longer has enough saved row data for a direct retry; fix its local match and run the restore again to capture a fresh item-level repair. " : ""}Other targets and trackers may already have completed; normal sync remains fenced until each outstanding item is repaired or skipped.`
    : `${operationLabel} is still paused because this failure means the connected projections are not known to be complete. Normal sync is fenced so it cannot overwrite the partially restored state while this issue is unresolved.`;

  return {
    id,
    source: "restore",
    kind: trackerOnly ? "restore_tracker_rejections" : "restore_projection_failures",
    severity: "blocking",
    title: trackerOnly ? `${trackerName} rejected part of the restored watch history` : `${operationLabel} needs attention`,
    summary: trackerOnly
      ? `${trackerSummary.rejectedCount} restored ${trackerName} play${trackerSummary.rejectedCount === 1 ? "" : "s"} could not be accepted after ${trackerSummary.retryCount} retries.`
      : targetIssues.length
        ? `${restoreIssues.issueCount} restored item${restoreIssues.issueCount === 1 ? "" : "s"} still need attention${providerSummary ? ` (${providerSummary})` : ""}.${expectedSkipCount ? ` ${expectedSkipCount} expected availability skip${expectedSkipCount === 1 ? "" : "s"} omitted.` : ""}`
        : reason,
    explanation,
    recommendations: recommendationsFor(reason, {
      source: "restore",
      provider: trackerOnly ? tracker : targetIssues.length === 1 ? targetIssues[0].provider : "the affected app",
      requiresMatch,
    }),
    canSkip: true,
    skipLabel: trackerOnly ? "Skip all remaining and resume sync" : "Skip and resume sync",
    createdAt: Number(result.finishedAt || runtime.restoreSyncStartedAt || 0) || null,
    context: {
      restoreKind: kind,
      runId,
      ...(providers.length ? { providers } : {}),
      ...(trackerOnly ? {
        provider: tracker,
        rejectedCount: trackerSummary.rejectedCount,
        retryCount: trackerSummary.retryCount,
        examples: trackerSummary.examples,
        issueCount: restoreIssues.issueCount || trackerSummary.rejectedCount,
        issueItems: restoreIssues.items,
        issueItemsComplete: restoreIssues.complete,
        ...(expectedSkipCount ? { expectedSkipCount } : {}),
      } : (restoreIssues.items.length ? {
        issueCount: restoreIssues.issueCount,
        issueItems: restoreIssues.items,
        issueItemsComplete: restoreIssues.complete,
        ...(expectedSkipCount ? { expectedSkipCount } : {}),
      } : {})),
    },
  };
}

function initialImportAttention(provider, entry = {}) {
  const status = String(entry.status || "").trim().toLowerCase();
  const reason = failureReason(entry);
  if (!["failed", "error"].includes(status) && !entry.error) return null;
  if (status === "cancelled" || status === "skipped") return null;
  const sourceLabel = providerLabel(provider);
  const runId = idPart(entry.startedAt, entry.completedAt, entry.error);
  return {
    id: `initial-import:${idPart(provider)}:${runId}`,
    source: "initial_import",
    kind: "initial_import_failure",
    severity: "blocking",
    title: `${sourceLabel} initial import needs attention`,
    summary: reason,
    explanation: `The initial ${sourceLabel} import is marked as failed, so Plekt cannot treat the initial sync as complete for this source.`,
    recommendations: recommendationsFor(reason, { source: "initial_import", provider: sourceLabel }),
    canSkip: true,
    skipLabel: `Skip ${sourceLabel} import`,
    createdAt: Number(entry.completedAt || entry.startedAt || 0) || null,
    context: { scope: "initial_import", provider: String(provider || "") },
  };
}

function pushSyncAttention(onboarding = {}) {
  const push = objectValue(onboarding.pushSync);
  const status = String(push.status || "").trim().toLowerCase();
  if (!["failed", "error"].includes(status) && !push.error) return null;
  const reason = failureReason(push);
  const runId = idPart(push.startedAt, push.completedAt, push.error);
  return {
    id: `initial-push:${runId}`,
    source: "initial_import",
    kind: "initial_push_failure",
    severity: "blocking",
    title: "Initial push sync needs attention",
    summary: reason,
    explanation: "The initial push did not complete, so connected apps may not match Plekt's canonical watch history yet.",
    recommendations: recommendationsFor(reason, { source: "initial_import", provider: "connected apps" }),
    canSkip: true,
    skipLabel: "Skip initial push",
    createdAt: Number(push.completedAt || push.startedAt || 0) || null,
    context: { scope: "initial_push" },
  };
}

function forceSyncAttention(runtime = {}) {
  const result = objectValue(runtime.forceSyncResult);
  if (!isActionableFailure(result)) return null;
  const reason = failureReason(result);
  const runId = idPart(result.jobId, result.runId, result.finishedAt, runtime.forceSyncHeartbeat);
  return {
    id: `force-sync:${runId}:failed`,
    source: "force_sync",
    kind: "force_sync_failure",
    severity: "blocking",
    title: "Force Sync needs attention",
    summary: reason,
    explanation: "The operation stopped before all requested destinations were confirmed, so its result remains incomplete until you retry or explicitly skip it.",
    recommendations: recommendationsFor(reason, { source: "force_sync" }),
    canSkip: true,
    skipLabel: "Skip this Force Sync",
    createdAt: Number(result.finishedAt || runtime.forceSyncHeartbeat || 0) || null,
    context: { runId },
  };
}

function isSkipped(item, runtime = {}) {
  const skips = objectValue(runtime.syncAttentionSkips);
  return Boolean(skips[item.id]?.skippedAt);
}

export function buildSyncAttentionItems(runtime = {}, onboarding = {}) {
  const items = [...(runtime.trackerWriteAttention || [])];
  const restore = restoreAttention(runtime);
  if (restore) items.push(restore);

  const backgroundImports = objectValue(onboarding.backgroundImports);
  const servers = objectValue(backgroundImports.servers);
  for (const [provider, entry] of Object.entries(servers)) {
    const item = initialImportAttention(provider, objectValue(entry));
    if (item) items.push(item);
  }
  const trackers = objectValue(backgroundImports.trackers);
  for (const provider of trackerProviderIds()) {
    const tracker = initialImportAttention(provider, objectValue(trackers[provider]));
    if (tracker) items.push(tracker);
  }
  const push = pushSyncAttention(onboarding);
  if (push) items.push(push);

  const force = forceSyncAttention(runtime);
  if (force) items.push(force);

  return items
    .filter((item) => !isSkipped(item, runtime))
    .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
}

export function syncAttentionState(runtime = {}, onboarding = {}) {
  const attention = buildSyncAttentionItems(runtime, onboarding);
  return {
    attention,
    count: attention.length,
    status: attention.length ? "attention" : "clear",
  };
}

export function syncAttentionItemIsAuthoritativeRestore(item = {}) {
  return item.source === "restore" && AUTHORITATIVE_RESTORE_KINDS.has(String(item.context?.restoreKind || ""));
}

export function syncAttentionFailureReason(result = {}) {
  return failureReason(result);
}
