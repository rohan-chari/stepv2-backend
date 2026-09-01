function scheduleBoundedBatchDrain(queue, flush, delayMs = 0) {
  if (queue.draining) return;
  queue.draining = true;
  const schedule = delayMs > 0
    ? (callback) => setTimeout(callback, delayMs)
    : setImmediate;
  schedule(async () => {
    try {
      while (queue.pending.length > 0) {
        const pending = queue.pending.splice(0);
        try {
          await flush(pending);
        } catch (error) {
          for (const request of pending) request.reject(error);
        }
      }
    } finally {
      queue.draining = false;
      // No await occurs between the final length check and clearing `draining`,
      // but retain this guard so future scheduler changes cannot strand work.
      if (queue.pending.length > 0) scheduleBoundedBatchDrain(queue, flush, delayMs);
    }
  });
}

module.exports = { scheduleBoundedBatchDrain };
