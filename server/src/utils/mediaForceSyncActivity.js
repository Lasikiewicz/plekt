import { randomUUID } from "node:crypto";
import { createPerUserState } from "./perUserState.js";

const MAX_ACTIVITIES = 40;
const MAX_LINES = 500;
const ACTIVITY_TTL_MS = 30 * 60 * 1000;
const activitiesByUser = createPerUserState(() => new Map());

function pruneActivities(now = Date.now()) {
  const activities = activitiesByUser();
  for (const [id, activity] of activities) {
    if (now - activity.updatedAt > ACTIVITY_TTL_MS) activities.delete(id);
  }
  while (activities.size > MAX_ACTIVITIES) {
    const oldest = [...activities.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    activities.delete(oldest.id);
  }
}

function activitySnapshot(activity) {
  if (!activity) return null;
  return {
    ...activity,
    lines: activity.lines.map((line) => ({ ...line })),
    meta: { ...activity.meta },
    result: activity.result || null,
    cancellationRequested: Boolean(activity.cancellationRequested),
  };
}

export function createMediaForceSyncActivity(meta = {}) {
  pruneActivities();
  const activities = activitiesByUser();
  const now = Date.now();
  const activity = {
    id: randomUUID(),
    status: "running",
    createdAt: now,
    updatedAt: now,
    meta: { ...meta },
    lines: [],
    result: null,
    error: "",
    cancellationRequested: false,
  };
  activities.set(activity.id, activity);
  appendMediaForceSyncActivity(activity.id, "Operation started.", "info");
  return activity.id;
}

export function appendMediaForceSyncActivity(id, text, level = "info") {
  const activity = activitiesByUser().get(String(id));
  if (!activity) return false;
  activity.lines.push({ at: Date.now(), level: String(level || "info"), text: String(text || "") });
  if (activity.lines.length > MAX_LINES) activity.lines.splice(0, activity.lines.length - MAX_LINES);
  activity.updatedAt = Date.now();
  return true;
}

export function requestMediaForceSyncCancellation(id) {
  const activity = activitiesByUser().get(String(id || ""));
  if (!activity) return { found: false, status: "not_found" };
  if (activity.status !== "running") return { found: true, requested: false, status: activity.status };
  if (!activity.cancellationRequested) {
    activity.cancellationRequested = true;
    appendMediaForceSyncActivity(id, "Cancellation requested by the user.", "warning");
  }
  return { found: true, requested: true, status: "cancellation_requested" };
}

export function isMediaForceSyncCancellationRequested(id) {
  return Boolean(activitiesByUser().get(String(id || ""))?.cancellationRequested);
}

export function finishMediaForceSyncActivity(id, result, error = "") {
  const activity = activitiesByUser().get(String(id));
  if (!activity) return false;
  const cancelled = Boolean(result?.cancelled);
  activity.status = error ? "error" : cancelled ? "cancelled" : "completed";
  activity.error = String(error || "");
  activity.result = result || null;
  activity.updatedAt = Date.now();
  appendMediaForceSyncActivity(id, error || (cancelled ? "Operation cancelled." : "Operation completed."), error ? "error" : cancelled ? "warning" : "success");
  return true;
}

export function getMediaForceSyncActivity(id) {
  pruneActivities();
  return activitySnapshot(activitiesByUser().get(String(id || "")));
}
