import { AsyncLocalStorage } from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export const simklFullSyncContext=()=>scope.getStore();
export const withSimklFullSyncContext=(context,work)=>scope.run(context,work);
