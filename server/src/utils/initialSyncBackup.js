import { db } from '../db.js';

export function initialSyncBackupCollection() {
  return {
    table:'initial_sync_items',key:'rowid',numericKey:true,
    rowToData:({rowid,...row})=>row,
    insert:db.prepare('INSERT OR REPLACE INTO initial_sync_items(job_id,destination,item_id,item_json,status,detail) VALUES(@job_id,@destination,@item_id,@item_json,@status,@detail)'),
    dataToRow:(_id,data)=>({job_id:data.job_id,destination:data.destination,item_id:data.item_id,item_json:data.item_json,
      status:data.status==='completed'?'completed':'review',detail:data.status==='completed'?(data.detail||''):'Restored initial-sync work needs review; it will not replay automatically'}),
  };
}
export function quarantineInitialSyncSetting(id,data) {
  const interrupted=job=>({...job,status:'interrupted',completedAt:Date.now(),error:'Restored initial-sync progress needs review; no automatic sends were resumed'});
  if(id==='initial-outward-sync'&&['waiting','planning','running'].includes(data?.status))return interrupted(data);
  if(id==='onboarding'&&['waiting','planning','running'].includes(data?.pushSync?.status))return {...data,pushSync:interrupted(data.pushSync)};
  return data;
}
