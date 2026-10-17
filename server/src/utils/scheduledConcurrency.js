// Bounded-concurrency worker pool used by the scheduled sync paths (split from scheduled.js).
export async function runWithConcurrency(items, concurrency, handler) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), items.length || 1);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await handler(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}
