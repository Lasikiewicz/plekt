import { activeSyncOperation, loadMediaConfig, loadRuntimeState, SYNC_OPERATION_SCHEDULED } from "./configStore.js";
import { createLoopStore } from "./loopStore.js";
import { getMediaConnection } from "./mediaConnectionRepo.js";
import { ensurePlexServerOwnership } from "./plexTokenManager.js";
import { resolvePlexAccountId } from "./plexClient.js";
import { fetchPlexSessions } from "./liveSessions.js";
import { refreshLiveSessions } from "./liveSessionCompletion.js";
import { listActiveTenants, resolveAdminUserName } from "./tenancy.js";
import { runWithUserContext } from "./userContext.js";
import { DATA_DIR } from "../paths.js";

function inTenant(tenant, work) {
  return runWithUserContext(tenant, work);
}

// A missing ID never matches. Deterministic first claimant (admin first) also
// keeps pre-existing duplicate connections from showing the same play twice.
export function routePlexSessions(entries, snapshots) {
  const routed = new Map();
  const claims = new Set();
  for (const entry of entries) {
    const { serverId, userIds = [], owned } = entry;
    const snapshot = snapshots.get(serverId);
    if (!snapshot && owned !== false) continue; // Legacy/unknown: retain its own poll.
    const ids = userIds.map((id) => String(id ?? "").trim()).filter(Boolean);
    const available = ids.filter((id) => !claims.has(`${serverId}:${id}`));
    for (const id of ids) claims.add(`${serverId}:${id}`);
    routed.set(entry.tenant.name, {
      ok: snapshot?.ok ?? false,
      sessions: snapshot?.ok ? snapshot.sessions.filter((session) => {
        const id = String(session.client?.userId ?? "").trim();
        // Anonymous/bypassed playback can report player ID 1 with an empty
        // User element, even when the person intended a shared account.
        if (id === "1" && session.client?.userIdSource === "player") return false;
        return Boolean(serverId && id && available.includes(id));
      }) : [],
    });
  }
  return routed;
}

async function readEntry(tenant) {
  const runtime = await loadRuntimeState();
  const operation = activeSyncOperation(runtime);
  if (operation && operation.kind !== SYNC_OPERATION_SCHEDULED) return null;
  const config = await loadMediaConfig();
  const connection = config.plex?.connectionId ? getMediaConnection("plex") : null;
  const owned = connection && config.plex.baseUrl && config.plex.token
    ? await ensurePlexServerOwnership() : null;
  const userIds = connection?.remoteUserId ? [connection.remoteUserId] : [];
  // Server-local owner IDs (often 1) can differ from plex.tv's account ID.
  if (owned === true) {
    const localId = await resolvePlexAccountId(config.plex, { lane: "interactive" }).catch(() => null);
    if (localId != null) userIds.push(String(localId));
  }
  return { tenant, config, serverId: connection?.serverId || "", owned, userIds };
}

// Only normalized session data is handed over. Owner tokens remain inside the
// owner's context; all tracking/completion/writes use the receiving user's config.
export async function refreshTenantLiveSessions({ logger = () => {}, trace = () => {} } = {}, {
  tenants = [{ name: resolveAdminUserName(), role: "admin", dataDir: DATA_DIR }, ...listActiveTenants()],
  read = readEntry,
  fetchOwner = (entry) => fetchPlexSessions(entry.config, { allUsers: true }),
  refresh = refreshLiveSessions,
} = {}) {
  const entries = [];
  let hasActiveSession = false;
  let failed = false;
  for (const tenant of tenants) {
    try {
      const entry = await inTenant(tenant, () => read(tenant));
      if (entry) entries.push(entry);
    } catch (error) {
      failed = true;
      logger(`Live session configuration failed for ${tenant.name}: ${error?.message || error}`);
    }
  }
  const snapshots = new Map();
  for (const entry of entries) {
    if (entry.owned !== true || !entry.serverId || snapshots.has(entry.serverId)) continue;
    try {
      snapshots.set(entry.serverId, await inTenant(entry.tenant, () => fetchOwner(entry)));
    } catch {
      snapshots.set(entry.serverId, { ok: false, sessions: [] });
    }
  }
  const routed = routePlexSessions(entries, snapshots);
  for (const entry of entries) {
    try {
      const result = await inTenant(entry.tenant, () => refresh(entry.config, createLoopStore(), {
        logger, trace, plexSessions: routed.get(entry.tenant.name),
      }));
      hasActiveSession ||= result.currentRows.length > 0 || result.pendingConfirmations > 0;
    } catch (error) {
      failed = true;
      logger(`Live session refresh failed for ${entry.tenant.name}: ${error?.message || error}`);
    }
  }
  return { hasActiveSession, failed };
}
