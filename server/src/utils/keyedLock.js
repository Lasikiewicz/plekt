// In-process mutex keyed by string. Callers that check and then write shared state
// for one item take the key first, so two concurrent checks cannot both see
// "nothing recorded yet". Waiters for a key run in arrival order; a key is dropped
// once its last holder releases it.
const queueTails = new Map();

export async function acquireKeyedLock(key) {
  const id = String(key || "");
  const previous = queueTails.get(id) || null;
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous ? previous.then(() => current) : current;
  queueTails.set(id, tail);
  if (previous) await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (queueTails.get(id) === tail) queueTails.delete(id);
  };
}
