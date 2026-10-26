import { getTrackerConnection, updateTrackerTokens, updateTrackerConnectionStatus } from "../trackerConnectionRepo.js";
import { runInTrackerGeneration, assertTrackerGeneration } from "./generation.js";
import { refreshSimklToken } from "./simklAuth.js";

const flights = new Map();

// Auth lifecycle only: calling this does not activate a sync adapter.
export async function freshSimklConnection(force = false) {
  const connection = getTrackerConnection("simkl", { includeCredentials: true });
  if (!connection) return null;
  assertTrackerGeneration("simkl");
  if (!force && connection.accessTokenExpiresAt > Date.now() + 5 * 60_000) return connection;
  if (!flights.has(connection.id)) {
    const work = runInTrackerGeneration("simkl", connection.id, async () => {
      let tokens;
      try { tokens = await refreshSimklToken(connection); }
      catch (error) {
        if (error.status === 400 || error.status === 401) updateTrackerConnectionStatus("simkl", {
          connectionId: connection.id, status: "reauth_required", lastError: "Simkl authorization expired. Sign in again.",
        });
        throw error;
      }
      assertTrackerGeneration("simkl");
      updateTrackerTokens("simkl", {
        connectionId: connection.id, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
      });
      return getTrackerConnection("simkl", { includeCredentials: true });
    });
    flights.set(connection.id, work);
    work.finally(() => flights.delete(connection.id)).catch(() => {});
  }
  const result = await flights.get(connection.id);
  return runInTrackerGeneration("simkl", connection.id, () => {
    assertTrackerGeneration("simkl");
    return result;
  });
}
