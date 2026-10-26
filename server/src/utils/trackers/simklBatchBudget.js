import { createHash, randomUUID } from 'node:crypto';
import { nextSimklDailyReset } from './simklTransport.js';

// No credentials or raw account identifiers. A held reservation survives a
// restart/crash and also prevents another process from preflighting this account.
export function createSimklBatchBudget(db, now = Date.now) {
  const key = connection => `simkl-batch-budget:${createHash('sha256').update(`${connection.clientId}:${connection.remoteUserId}`).digest('hex')}`;
  const blocked = () => Object.assign(new Error('Simkl batch quota is held until the next quota reset'), {code:'SIMKL_QUOTA_RESERVE',status:429});
  return {
    acquire(connection) {
      const id=key(connection),owner=randomUUID(),time=now(),until=nextSimklDailyReset(time);
      db.transaction(()=>{
        const row=db.prepare('SELECT data FROM settings WHERE id=?').get(id);
        if(row) {
          let state;
          try {state=JSON.parse(row.data);} catch {throw blocked();}
          if(!Number.isFinite(state?.until)||state.until>time)throw blocked();
        }
        // Reserve before auth/preflight: a failure never silently releases it.
        db.prepare('INSERT INTO settings(id,data,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at')
          .run(id,JSON.stringify({owner,until}),time);
      }).immediate();
      return {id,owner,until};
    },
    complete(ticket,remaining) {
      // Another complete four-request chunk needs at least 59. Unknown or low
      // remaining quota retains the reservation until reset, without a probe.
      if(!Number.isSafeInteger(remaining)||remaining<59)return;
      db.transaction(()=>{
        const row=db.prepare('SELECT data FROM settings WHERE id=?').get(ticket.id);
        if(row&&JSON.parse(row.data).owner===ticket.owner)db.prepare('DELETE FROM settings WHERE id=?').run(ticket.id);
      }).immediate();
    },
  };
}
