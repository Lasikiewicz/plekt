import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";
import { MEDIA_DIR } from "../paths.js";
import { listNonAdminUsers, multiUserEnabled } from "./tenancy.js";
import { getTenantDatabaseForUser } from "./tenantDatabase.js";
import { runAsAdmin } from "./userContext.js";

// Read every user's references before deleting shared files. If any database
// cannot be inspected, fail closed: it may own a file another user never saw.
export function sweepOrphanArtwork({ mediaDir = MEDIA_DIR, databases = null } = {}) {
  const references = new Set();
  runAsAdmin(() => {
    const sources = databases || [db, ...(multiUserEnabled() ? listNonAdminUsers().map((user) => getTenantDatabaseForUser(user.name)) : [])];
    for (const database of sources) {
      for (const row of database.prepare("SELECT storage_path FROM poster_cache WHERE storage_path IS NOT NULL").all()) {
        references.add(String(row.storage_path).replaceAll("\\", "/"));
      }
    }
  });
  let removed = 0;
  for (const folder of ["posters", "backdrops", "profiles", "logos"]) {
    const directory = path.join(mediaDir, folder);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      // Never touch uploads, subdirectories, temporary writes or unknown files.
      if (!entry.isFile() || !/^[a-f0-9]{32,64}\.(?:jpg|jpeg|png|webp|gif)$/i.test(entry.name)) continue;
      if (references.has(`${folder}/${entry.name}`)) continue;
      // Another process may have renamed a completed download but not yet
      // committed its row. Let fresh files settle before deciding they are orphaned.
      if (Date.now() - fs.statSync(path.join(directory, entry.name)).mtimeMs < 10 * 60 * 1000) continue;
      try { fs.unlinkSync(path.join(directory, entry.name)); removed += 1; }
      catch (error) { console.warn(`Artwork maintenance could not remove ${folder}/${entry.name}: ${error.message}`); }
    }
  }
  return { removed };
}
