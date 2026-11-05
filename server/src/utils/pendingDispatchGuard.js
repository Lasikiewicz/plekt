// Prevent a just-recorded watch from being dispatched once by its live webhook
// and again by the scheduler while that first send is still finishing.
const activePendingDispatches = new Set();

export function acquirePendingDispatch(recordId) {
  const id = String(recordId || "").trim();
  if (!id || activePendingDispatches.has(id)) return null;
  activePendingDispatches.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePendingDispatches.delete(id);
  };
}
