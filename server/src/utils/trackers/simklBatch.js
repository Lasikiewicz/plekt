import { db } from '../../db.js';
import { claimTrackerWriteIntent, finishTrackerWriteIntent, trackerIntentConnectionCurrent } from '../trackerWriteIntents.js';
import { freshSimklConnection } from './simklConnection.js';
import { simklRequest, simklReviewRequired, simklMediaMatches } from './simklClient.js';
import { sendSimklWatchedBatch } from './simklBatchClient.js';
import { createSimklBatchQueue } from './simklBatchQueue.js';
import { createSimklBatchBudget } from './simklBatchBudget.js';
import { isAuthoritativeRestoreActive } from '../configStore.js';
import { watchedPlayedSyncEnabled } from '../syncFlags.js';
import { simklFullSyncContext } from './simklFullSyncContext.js';

// Preserve the existing verification allowance, plus POST and two readbacks.
export const SIMKL_BATCH_QUOTA_RESERVE = 55;
const budget = createSimklBatchBudget(db);
const quotaError = count => Object.assign(simklReviewRequired(`Simkl quota reserve reached; ${count} watched intents remain unsent`), { code: 'SIMKL_QUOTA_RESERVE', status: 429 });
function current(connection) {
  if(simklFullSyncContext()?.isCurrent&&!simklFullSyncContext().isCurrent())throw simklReviewRequired('Simkl full sync was cancelled or lost its worker lease');
  if(isAuthoritativeRestoreActive()||!watchedPlayedSyncEnabled())throw simklReviewRequired('Simkl watched dispatch is paused');
  if (!db.prepare("SELECT 1 FROM tracker_connections WHERE provider='simkl' AND id=? AND remote_user_id=? AND status='connected'").get(connection.id, connection.remoteUserId)) {
    throw simklReviewRequired('Simkl connection changed before batch completion');
  }
}
const enqueue = createSimklBatchQueue({
  partition:()=>simklFullSyncContext()?.runId||'',
  current,
  matches: simklMediaMatches,
  async prepare(connection, chunk) {
    const ticket = budget.acquire(connection);
    const fresh = await freshSimklConnection();
    current(connection);
    if (fresh?.id !== connection.id) throw simklReviewRequired('Simkl connection changed before batch preflight');
    let response;
    try {response=await simklRequest(fresh, '/sync/activities', { withMetadata: true,
      minimumRemaining: SIMKL_BATCH_QUOTA_RESERVE + 4, allowUnknownQuota: true, reserveCheckpoint: true });}
    catch(error) {
      // A verified bulk-only reserve stop is not an account-wide safety hold:
      // ordinary watches must still be able to use their reserved allowance.
      if(simklFullSyncContext()&&error.code==='SIMKL_QUOTA_RESERVE')budget.complete(ticket,error.quotaRemaining);
      throw error;
    }
    const {data,metadata}=response;
    if (!Number.isFinite(Date.parse(data.all)) || Date.parse(data.all) <= 1000) throw simklReviewRequired('Simkl batch needs a valid pre-send cursor');
    if (!Number.isSafeInteger(metadata.quotaRemaining) || metadata.quotaRemaining < SIMKL_BATCH_QUOTA_RESERVE + 3) {
      throw quotaError(chunk.length);
    }
    return { preSendCursor: data.all, fresh, ticket };
  },
  claim(chunk) {
    db.transaction(() => {
      for (const item of chunk) {
        const record=db.prepare('SELECT w.watched_at,w.sync_action,p.state FROM watch_history w LEFT JOIN playstate p ON p.media_key=w.media_key WHERE w.id=?').get(item.intent.watch_record_id||'');
        if(record&&(record.state==='unwatched'||['unwatched','unplayed'].includes(record.sync_action)||Date.parse(record.watched_at)!==Date.parse(item.intent.watched_at)))throw simklReviewRequired('Local watch changed before Simkl batch claim');
        const live = db.prepare('SELECT expires_at,due_at,media_json,watched_at FROM tracker_write_intents WHERE id=?').get(item.intent.id);
        if (!live || live.expires_at <= Date.now() || live.due_at > Date.now() || live.media_json !== item.intent.media_json || live.watched_at !== item.intent.watched_at) throw simklReviewRequired('Simkl intent changed or is no longer due before batch claim');
        if (!trackerIntentConnectionCurrent(item.intent) || !claimTrackerWriteIntent(item.intent.id)) throw simklReviewRequired('Simkl batch could not claim every intent');
      }
    }).immediate();
  },
  async send(connection, media, { fresh, ticket, ...options }) {
    current(connection);
    const result = await sendSimklWatchedBatch(fresh, media, { ...options, request: (scope, path, init) => {
      current(connection);
      return simklRequest(scope, path, init);
    } });
    budget.complete(ticket,result.quota.quotaRemaining);
    return result.outcomes.map(outcome => ({ status: outcome.status === 'confirmed' ? 'settled' : outcome.status === 'not_found' ? 'rejected' : 'review', detail: outcome.status === 'not_found' ? 'Simkl did not match this batch item' : outcome.status === 'confirmed' ? '' : 'Simkl batch item was not confirmed by readback' }));
  },
  finish(item, status, detail) { finishTrackerWriteIntent(item.intent.id, status, detail); },
});

export const enqueueSimklWatched = (connection, intent, media, trigger) => enqueue(connection, intent, media, trigger);
