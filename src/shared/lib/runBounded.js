async function runBounded(items, concurrency, worker) {
  const values = Array.from(items || []);
  if (values.length === 0) return [];
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }

  const count = Math.max(1, Math.min(values.length, concurrency || 1));
  await Promise.all(Array.from({ length: count }, runWorker));
  return results;
}

module.exports = { runBounded };
