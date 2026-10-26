import fs from 'node:fs';
import { db, bumpDataVersion } from '../../server/src/db.js';
const o = JSON.parse(fs.readFileSync('evidence/step8c-ui/original.json', 'utf8'));
const ids = db.prepare("SELECT id FROM simkl_full_sync_runs").all().map(r => r.id).filter(id => !o.runs.some(x => x.id === id));
const r = {};
for (const id of ids) {
  r.intents = (r.intents || 0) + db.prepare("DELETE FROM tracker_write_intents WHERE provider='simkl' AND logical_key LIKE ?").run(`simkl-full-sync:${id}%`).changes;
  r.items = (r.items || 0) + db.prepare("DELETE FROM simkl_full_sync_items WHERE run_id=?").run(id).changes;
  r.runs = (r.runs || 0) + db.prepare("DELETE FROM simkl_full_sync_runs WHERE id=?").run(id).changes;
}
db.prepare("DELETE FROM initial_sync_items WHERE job_id='ui-check-job'").run();
if (o.hdr) db.prepare("UPDATE settings SET data=? WHERE id='initial-outward-sync'").run(o.hdr.data); else db.prepare("DELETE FROM settings WHERE id='initial-outward-sync'").run();
if (o.onboarding) db.prepare("UPDATE settings SET data=?, updated_at=? WHERE id='onboarding'").run(o.onboarding.data, o.onboarding.updated_at);
db.prepare("UPDATE tracker_connections SET full_sync_json=?, initial_sync_json=? WHERE provider='simkl'").run(o.conn.full_sync_json, o.conn.initial_sync_json);
bumpDataVersion();
console.log(r, db.prepare("SELECT full_sync_json FROM tracker_connections WHERE provider='simkl'").get(), db.prepare("SELECT count(*) c FROM settings WHERE id='initial-outward-sync'").get());
process.exit(0);
