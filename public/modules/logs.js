export const DEBUG_LOGS_KEY = "plembfin_debug_logs";
export const MAX_DEBUG_LOGS = 500;

export function replaceLogContent(el, html, forceScroll = false) {
  const scrollTop = el.scrollTop;
  const follow = forceScroll || el.scrollHeight - scrollTop - el.clientHeight < 120;
  el.innerHTML = html;
  el.scrollTop = follow ? el.scrollHeight : scrollTop;
}

export function readStoredDebugLogs(storage = localStorage) {
  try {
    const parsed = JSON.parse(storage.getItem(DEBUG_LOGS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_DEBUG_LOGS) : [];
  } catch (error) {
    return [];
  }
}

export function appendDebugLog(logs, message, details, storage = localStorage) {
  const timestamp = new Date().toISOString();
  const suffix = details === undefined ? "" : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
  const nextLogs = [...logs, `[${timestamp}] ${message}${suffix}`].slice(-MAX_DEBUG_LOGS);
  try {
    storage.setItem(DEBUG_LOGS_KEY, JSON.stringify(nextLogs));
  } catch (error) {
    // Ignore storage quota errors
  }
  return nextLogs;
}

export function clearDebugLogs(storage = localStorage) {
  storage.removeItem(DEBUG_LOGS_KEY);
  return [];
}

export function logsToText(logs) {
  return logs.join("\n");
}

export async function fetchDiagnosticLogs(headers = {}, category = "all") {
  try {
    const url = new URL("/api/diagnostic-logs", window.location.origin);
    url.searchParams.set("limit", "500");
    if (category && category !== "all") {
      url.searchParams.set("category", category);
    }
    const res = await fetch(url, {
      credentials: "same-origin",
      headers: { ...headers, "Cache-Control": "no-store" },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return [`Diagnostic logs request failed (${res.status}): ${data.error || res.statusText || "unknown error"}`];
    }
    return data.logs || [];
  } catch (error) {
    console.error("Failed to fetch diagnostic logs", error);
    return [`Diagnostic logs request failed: ${error.message || String(error)}`];
  }
}

export async function clearDiagnosticLogs(headers = {}) {
  const url = new URL("/api/diagnostic-logs", window.location.origin);
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { ...headers, "Cache-Control": "no-store" },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Clear logs failed with ${res.status}`);
  }
  return true;
}

export function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatBrowserLocalTime(rawTs = "") {
  if (!rawTs) return "";
  try {
    let d;
    if (rawTs.endsWith("Z") || rawTs.includes("T")) {
      d = new Date(rawTs);
    } else {
      const normalized = rawTs.replace(" ", "T");
      d = new Date(normalized.endsWith("Z") ? normalized : normalized + "Z");
    }
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
  } catch (e) {
    /* fallback */
  }
  return rawTs;
}

export function formatLogLineToHtml(rawLine = "") {
  const line = String(rawLine || "").trim();
  if (!line) return "";
  if (line.startsWith("===")) {
    return `<div class="log-section-header">${escapeHtml(line)}</div>`;
  }

  // Extract leading timestamp [2026-07-22T07:35:05.372Z] or [2026-07-22 07:35:05]
  const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\]\s*(.*)$/);
  if (!tsMatch) {
    return `<div class="log-row"><span class="log-msg">${escapeHtml(line)}</span></div>`;
  }

  const rawTs = tsMatch[1];
  let remainder = tsMatch[2];
  const localTime = formatBrowserLocalTime(rawTs);

  let category = "LOG";
  let instance = "";

  // Check if remainder has [CATEGORY]
  const catMatch = remainder.match(/^\[(.*?)\]\s*(.*)$/);
  if (catMatch) {
    category = catMatch[1];
    remainder = catMatch[2];

    // Check if remainder has [INSTANCE]
    const instMatch = remainder.match(/^\[(.*?)\]\s*(.*)$/);
    if (instMatch) {
      instance = instMatch[1];
      remainder = instMatch[2];
    }
  }

  const catKey = category.toLowerCase();
  let badgeClass = "badge-system";
  if (catKey.includes("plex")) badgeClass = "badge-plex";
  else if (catKey.includes("sync")) badgeClass = "badge-sync";
  else if (catKey.includes("poll") || catKey.includes("cron")) badgeClass = "badge-poll";

  const isError = catKey.includes("error") || remainder.toLowerCase().includes("error") || remainder.toLowerCase().includes("failed");
  if (isError) badgeClass = "badge-error";

  return `
    <div class="log-row ${isError ? "log-row-error" : ""}">
      <span class="log-time">${escapeHtml(localTime)}</span>
      <span class="log-badge ${badgeClass}">${escapeHtml(category)}</span>
      ${instance ? `<span class="log-instance">[${escapeHtml(instance)}]</span>` : ""}
      <span class="log-msg">${escapeHtml(remainder)}</span>
    </div>
  `.trim();
}
