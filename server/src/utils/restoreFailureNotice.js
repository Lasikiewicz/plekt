// Called inside the runtime-state transaction after owner/heartbeat revalidation.
// Recovery releases the fence without acknowledging its failure for the user.
export function retainedRestoreFailure(runtime, operation, staleBefore, now) {
  if (staleBefore === undefined || !["backup_restore", "full_sync_watchstates", "restore"].includes(operation?.kind)) return {};
  const previous = runtime.restoreSyncSummary?.error ? runtime.restoreSyncSummary
    : runtime.restoreSyncResult?.error ? runtime.restoreSyncResult : null;
  return { restoreSyncFailureNotice: runtime.restoreSyncFailureNotice || {
    ...(previous || {}), success: false, kind: operation.kind, recoveredAt: now,
    error: previous?.error || "Restore interrupted: no heartbeat for three minutes. Automated sync has resumed.",
  } };
}
