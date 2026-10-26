// Concurrent eligible dispatches share a chunk, serially per generation.
export function createSimklBatchQueue({ prepare, claim, send, finish, current, matches, maxItems = 100, partition=()=>'' }) {
  const queues = new Map(), flights = new Map(),accountTails=new Map();
  async function drain(key, queue) {
    while (queue.items.length) {
      const chunk = queue.items.splice(0, maxItems);
      const previous=accountTails.get(queue.accountKey)||Promise.resolve();let release;
      const lock=new Promise(resolve=>{release=resolve;});accountTails.set(queue.accountKey,lock);
      await previous;
      try {
        current(queue.connection);
        let competing;
        try { competing = chunk.some((a, i) => chunk.some((b, j) => j < i && matches(a.media, b.media))); }
        catch (error) { error.reviewBeforeSend = true; throw error; }
        if (competing) {
          throw Object.assign(new Error('Competing Simkl watched intents need review'), { reviewBeforeSend: true });
        }
        const prepared = await prepare(queue.connection, chunk, queue.trigger);
        current(queue.connection);
        claim(chunk);
        let results;
        try {
          results = await send(queue.connection, chunk.map(item => item.media), { trigger: queue.trigger, ...prepared });
          current(queue.connection);
          if (!Array.isArray(results) || results.length !== chunk.length || results.some(r => !['settled', 'rejected', 'review'].includes(r.status))) throw new Error('Simkl batch readback did not establish every outcome');
        } catch (error) {
          // A failed readback never authorizes another POST.
          for (const item of chunk) finish(item, 'review', 'Simkl batch outcome is unconfirmed; check remote state before another send');
          throw error;
        }
        for (let i = 0; i < chunk.length; i++) {
          const result = results[i];
          finish(chunk[i], result.status, result.detail || '');
          if (result.status === 'settled') chunk[i].resolve({ alreadySatisfied: false });
          else chunk[i].reject(Object.assign(new Error(result.detail || 'Simkl batch item needs review'), { code: result.status === 'rejected' ? 'not_found' : 'TRACKER_REVIEW_REQUIRED' }));
        }
      } catch (error) {
        if (error.reviewBeforeSend) for (const item of chunk) finish(item, 'review', error.message);
        for (const item of chunk) item.reject(error);
      } finally {
        for (const item of chunk) flights.delete(item.intent.id);
        release();if(accountTails.get(queue.accountKey)===lock)accountTails.delete(queue.accountKey);
      }
    }
    queues.delete(key);
  }
  return function enqueue(connection, intent, media, trigger) {
    if (flights.has(intent.id)) return flights.get(intent.id);
    const accountKey=`${connection.id}:${connection.remoteUserId}`,key = `${accountKey}:${partition()}`;
    let queue = queues.get(key);
    if (!queue) {
      queue = { connection, trigger, items: [],accountKey };
      queues.set(key, queue);
      setImmediate(() => { void drain(key, queue); });
    }
    const promise = new Promise((resolve, reject) => queue.items.push({ intent, media, resolve, reject }));
    flights.set(intent.id, promise);
    return promise;
  };
}
