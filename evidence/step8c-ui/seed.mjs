import fs from 'node:fs';
import { db, bumpDataVersion } from '../../server/src/db.js';
import { getTrackerConnection } from '../../server/src/utils/trackerConnectionRepo.js';
import { createSimklFullSyncRun } from '../../server/src/utils/trackers/simklFullSyncStore.js';
import { SIMKL_FULL_SYNC_NORMAL_POLICY, estimateSimklFullSync } from '../../server/src/utils/trackers/simklFullSyncPolicy.js';
import { publishSimklFullSyncRun } from '../../server/src/utils/trackers/simklFullSyncRunner.js';
import { saveInitialSync } from '../../server/src/utils/initialSyncStore.js';
const mode = process.argv[2] || 'known';
const f = 'evidence/step8c-ui/original.json';
const orig = JSON.parse(fs.readFileSync(f, 'utf8'));
if (!orig.onboarding) { orig.onboarding = db.prepare("SELECT * FROM settings WHERE id='onboarding'").get() || null; fs.writeFileSync(f, JSON.stringify(orig, null, 1)); }
const conn = getTrackerConnection('simkl');
const policy = SIMKL_FULL_SYNC_NORMAL_POLICY;
const pacing = mode === 'known'
  ? estimateSimklFullSync(1200, { quotaLimit: 1000, quotaRemaining: 300, policy })
  : estimateSimklFullSync(1200, { quotaLimit: undefined, quotaRemaining: undefined, policy });
const jobId = 'ui-check-job';
const rows = [1, 2, 3].map(n => ({ id: `ui-check-${n}`, side: 'tracker', targets: [], media: { type: 'movie', title: `UI check ${n}`, ids: {} }, watchedAt: Date.now() }));
saveInitialSync({ id: jobId, status: 'waiting_quota', startedAt: Date.now(), completedAt: null, error: '',
  destinations: [{ provider: 'simkl', label: 'Simkl', status: 'waiting_quota', items: rows.map(r => ({ id: r.id, type: 'movie', title: r.media.title, status: 'pending' })) }] });
const run = createSimklFullSyncRun({ connection: { id: conn.id, accountId: conn.remoteUserId }, rows, initialJobId: jobId, policy, pacing });
const next = Date.now() + 3 * 86400000;
db.prepare("UPDATE simkl_full_sync_runs SET status='waiting_quota', next_run_at=? WHERE id=?").run(next, run.id);
const chk = db.prepare("SELECT status,next_run_at FROM simkl_full_sync_runs WHERE id=?").get(run.id);
if (!(chk.next_run_at > Date.now() + 86400000) || chk.status !== 'waiting_quota') throw new Error('not future');
publishSimklFullSyncRun(run.id);
bumpDataVersion();
fs.writeFileSync('evidence/step8c-ui/runid.txt', run.id);
console.log(mode, run.id, chk, JSON.stringify(pacing));
process.exit(0);
