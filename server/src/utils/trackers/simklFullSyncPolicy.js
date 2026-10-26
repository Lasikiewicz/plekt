import { nextSimklDailyReset } from './simklTransport.js';

export const SIMKL_FULL_SYNC_SAFETY_RESERVE=55;
export const SIMKL_FULL_SYNC_VERIFY_REQUESTS=18;
export const SIMKL_FULL_SYNC_BATCH_SIZE=100;
export const SIMKL_FULL_SYNC_BATCH_REQUESTS=4;
// User decision 24 October 2026: bulk sends leave 20% of the observed daily
// allowance for normal watches and library checks, plus the safety reserve.
export const SIMKL_FULL_SYNC_NORMAL_POLICY=Object.freeze({mode:'percent',value:0.2});
const integer=value=>Number.isSafeInteger(value)&&value>=0;

// Policy is explicit: callers must supply the user-approved normal-use reserve.
// Missing headers/policy never silently become a 500-request allowance.
export function simklFullSyncProtectedQuota(quotaLimit,policy) {
  if(!integer(quotaLimit)||quotaLimit<1||!policy)return null;
  let normal;
  if(policy.mode==='percent'&&Number.isFinite(policy.value)&&policy.value>=0&&policy.value<=1)normal=Math.ceil(quotaLimit*policy.value);
  else if(policy.mode==='fixed'&&integer(policy.value))normal=policy.value;
  else return null;
  return {normalReserve:normal,safetyReserve:SIMKL_FULL_SYNC_SAFETY_RESERVE,
    protectedQuota:normal+SIMKL_FULL_SYNC_SAFETY_RESERVE};
}

export function estimateSimklFullSync(itemCount,{quotaLimit,quotaRemaining,policy,verificationRequests=SIMKL_FULL_SYNC_VERIFY_REQUESTS,now=Date.now()}={}) {
  const count=integer(itemCount)?itemCount:0;
  const batches=Math.ceil(count/SIMKL_FULL_SYNC_BATCH_SIZE);
  const reserves=simklFullSyncProtectedQuota(quotaLimit,policy);
  const known=Boolean(reserves&&integer(quotaRemaining)&&quotaRemaining<=quotaLimit);
  const totalRequests=batches*SIMKL_FULL_SYNC_BATCH_REQUESTS+(batches?verificationRequests:0);
  const capacity=remaining=>Math.max(0,Math.floor((remaining-reserves.protectedQuota-verificationRequests)/SIMKL_FULL_SYNC_BATCH_REQUESTS));
  const dailyBatches=reserves?capacity(quotaLimit):null;
  const todayBatches=known?Math.min(batches,capacity(quotaRemaining)):null;
  const estimatedDays=!batches?0:known&&dailyBatches>0
    ?1+Math.ceil(Math.max(0,batches-todayBatches)/dailyBatches):null;
  return {itemCount:count,batches,batchRequests:batches*SIMKL_FULL_SYNC_BATCH_REQUESTS,
    verificationRequests:batches?verificationRequests:0,totalRequests,
    quotaLimit:integer(quotaLimit)&&quotaLimit>0?quotaLimit:null,
    quotaRemaining:known?quotaRemaining:null,...(reserves||{normalReserve:null,safetyReserve:SIMKL_FULL_SYNC_SAFETY_RESERVE,protectedQuota:null}),
    estimatedDays,pacingRequired:!batches?false:known?todayBatches<batches:null,
    itemsToday:todayBatches===null?null:Math.min(count,todayBatches*SIMKL_FULL_SYNC_BATCH_SIZE),
    itemsPerFullDay:dailyBatches===null?null:dailyBatches*SIMKL_FULL_SYNC_BATCH_SIZE,
    nextResetAt:nextSimklDailyReset(now),quotaKnown:known};
}
