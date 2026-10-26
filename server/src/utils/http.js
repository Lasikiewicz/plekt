// The API is same-origin only: no Access-Control-Allow-Origin is ever sent, so
// cross-origin reads are blocked by the browser. Same-origin requests (the SPA)
// and server-to-server callers (webhooks, cron) never preflight, so no other
// CORS headers are needed either.
function sanitizeResponseBody(body, status) {
  if (status >= 500) {
    return { ...(body && typeof body === "object" && body.ok !== undefined ? { ok: false } : {}), error: "Internal server error" };
  }
  if (!body || typeof body !== "object") return body;
  return body;
}

export function sendJson(res, body, status = 200, extraHeaders = {}) {
  const safeBody = sanitizeResponseBody(body, status);
  res.status(status).set({ "Content-Type": "application/json", ...extraHeaders }).send(JSON.stringify(safeBody));
}

export function sendOptions(res) {
  res.status(204).send("");
}

export function sendApiError(res, error, body = { error: "Request failed" }, status = 500) {
  if (error?.code === "RESTORE_ACTIVE") {
    return sendJson(res, {
      error: "An authoritative watch-history restore is active. Try again when it completes.",
      code: "RESTORE_ACTIVE",
    }, 409);
  }
  return sendJson(res, body, status);
}

export function methodNotAllowed(res) {
  sendJson(res, { error: "Method not allowed" }, 405);
}

export function notFound(res) {
  sendJson(res, { error: "Not found" }, 404);
}
