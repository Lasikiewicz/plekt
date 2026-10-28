import { adminDb } from "../db.js";
import { DATA_DIR } from "../paths.js";
import { listNonAdminUsers, resolveAdminUserName } from "./tenancy.js";
import { getTenantDatabaseForUser } from "./tenantDatabase.js";
import { getActiveUserName } from "./userContext.js";

const ACTIVE_PLEX_ACCOUNT_SQL = "SELECT 1 FROM media_connections WHERE provider='plex' AND remote_user_id=? AND status IN ('connected','reauth_required','legacy') LIMIT 1";

// Plex sees one person per Plex account, so two Plekt users signed into the
// same account would import each other's plays with nothing to tell them
// apart. Returns the name of another Plekt user already connected to this
// Plex account, or "" when none is.
export function otherPlektUserOnPlexAccount(remoteUserId, { rootDataDir = DATA_DIR } = {}) {
  const accountId = String(remoteUserId || "").trim();
  if (!accountId) return "";
  const current = getActiveUserName();
  const adminName = resolveAdminUserName(rootDataDir);
  const users = [{ name: adminName, database: () => adminDb }]
    .concat(listNonAdminUsers(rootDataDir).map((user) => ({ name: user.name, database: () => getTenantDatabaseForUser(user.name, rootDataDir) })));
  for (const user of users) {
    if (user.name === current) continue;
    try {
      if (user.database().prepare(ACTIVE_PLEX_ACCOUNT_SQL).get(accountId)) return user.name;
    } catch {
      // A user whose database cannot be read holds no claim we can check.
    }
  }
  return "";
}
