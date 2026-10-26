import { writeAuditLog } from "../db.js";
import { sendJson, methodNotAllowed } from "../utils/http.js";
import { readJson } from "../utils/requestBody.js";
import {
  createTrackerAuthFlow, getTrackerAuthFlow, getTrackerConnection,
  markTrackerAuthFlow, claimTrackerAuthFlowPoll, saveTrackerConnection,
} from "../utils/trackerConnectionRepo.js";
import { currentTrackerGeneration } from "../utils/trackers/generation.js";
import { BUNDLED_SIMKL_CLIENT_ID } from "../utils/simklAppConfig.js";
import { startSimklDeviceAuth, pollSimklDeviceAuth, getSimklUser, simklDevicePollOutcome } from "../utils/trackers/simklAuth.js";

const polling = new Set();
const pending = (res, flow) => sendJson(res, { status: "pending", retryAfter: flow.intervalSeconds }, 202);
const expired = (res, flow, changed = false) => {
  markTrackerAuthFlow(flow.id, "expired");
  return sendJson(res, { status: "expired", ...(changed ? { error: "The Simkl connection changed while this sign-in was waiting. Start the sign-in again." } : {}) }, changed ? 409 : 410);
};

// The caller enforces administrator browser sessions and same-origin requests.
export async function handleSimklAuth(req, res, path) {
  if (path === "tracker-auth/simkl/start") {
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    const clientId = BUNDLED_SIMKL_CLIENT_ID;
    const expectedConnectionId = currentTrackerGeneration("simkl");
    const device = await startSimklDeviceAuth(clientId);
    const flow = createTrackerAuthFlow({
      provider: "simkl", clientId, deviceCode: device.device_code, userCode: device.user_code,
      verificationUrl: device.verification_url, intervalSeconds: device.interval,
      expiresAt: Date.now() + device.expires_in * 1000, initialSyncMode: body.initialSyncMode,
      preferEarlierWatchedDate: body.preferEarlierWatchedDate, expectedConnectionId,
    });
    writeAuditLog("tracker-auth.simkl.started", { detail: { flowId: flow.id } });
    return sendJson(res, { flowId: flow.id, userCode: flow.userCode, verificationUrl: flow.verificationUrl, intervalSeconds: flow.intervalSeconds, expiresAt: flow.expiresAt });
  }
  const match = path.match(/^tracker-auth\/simkl\/([a-f\d-]+)\/status$/i);
  if (!match) return sendJson(res, { error: "Not found" }, 404);
  if (req.method !== "GET") return methodNotAllowed(res);
  const flow = getTrackerAuthFlow(match[1], { includeCredentials: true });
  if (!flow || flow.provider !== "simkl") return sendJson(res, { error: "Authentication flow not found" }, 404);
  if (flow.status === "expired" || flow.expiresAt <= Date.now() || flow.expectedConnectionId == null) return expired(res, flow);
  if (flow.status === "completed") return sendJson(res, { status: "completed", connection: getTrackerConnection("simkl") });
  if (flow.status !== "pending") return sendJson(res, { status: "failed", error: "Simkl sign-in failed. Start the sign-in again." }, 409);
  if (currentTrackerGeneration("simkl") !== flow.expectedConnectionId) return expired(res, flow, true);
  if (polling.has(flow.id) || !claimTrackerAuthFlowPoll(flow.id)) return pending(res, flow);
  polling.add(flow.id);
  try {
    let tokens;
    try { tokens = await pollSimklDeviceAuth(flow); }
    catch (error) {
      if (flow.expiresAt <= Date.now()) return expired(res, flow);
      const outcome = simklDevicePollOutcome(error, flow.intervalSeconds);
      if (outcome?.status === "expired") return expired(res, flow);
      if (outcome?.status === "pending") {
        markTrackerAuthFlow(flow.id, "pending", outcome.intervalSeconds);
        return pending(res, { intervalSeconds: outcome.intervalSeconds });
      }
      throw error;
    }
    const tokenReceivedAt = Date.now();
    if (flow.expiresAt <= tokenReceivedAt) return expired(res, flow);
    const user = await getSimklUser({ clientId: flow.clientId, accessToken: tokens.access_token });
    if (flow.expiresAt <= Date.now()) return expired(res, flow);
    const connection = saveTrackerConnection({
      provider: "simkl", expectedConnectionId: flow.expectedConnectionId, clientId: flow.clientId,
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: tokenReceivedAt + tokens.expires_in * 1000,
      ...user, initialSyncMode: 'baseline', preferEarlierWatchedDate: flow.preferEarlierWatchedDate,
      baselineComplete: false, lastValidatedAt: Date.now(),
    });
    markTrackerAuthFlow(flow.id, "completed");
    writeAuditLog("tracker-auth.simkl.connected", { detail: { connectionId: connection.id, remoteUserId: connection.remoteUserId } });
    return sendJson(res, { status: "completed", connection });
  } catch (error) {
    if (error.stale) return expired(res, flow, true);
    // The existing table has no failed/denied-by-Simkl state. Retire the
    // flow without inventing a provider denial or retrying a consumed grant.
    markTrackerAuthFlow(flow.id, "expired");
    return sendJson(res, { status: "failed", error: "Simkl sign-in failed. Start the sign-in again." }, 502);
  } finally { polling.delete(flow.id); }
}
