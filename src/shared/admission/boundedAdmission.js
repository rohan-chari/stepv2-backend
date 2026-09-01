class AdmissionTimeoutError extends Error {
  constructor(message = "request admission timed out") {
    super(message);
    this.name = "AdmissionTimeoutError";
    this.code = "ADMISSION_TIMEOUT";
  }
}

function createBoundedAdmission({
  concurrency,
  maximumQueued,
  waitMs,
  nowMs = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = null,
} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("concurrency must be positive");
  if (!Number.isInteger(maximumQueued) || maximumQueued < 0) throw new TypeError("maximumQueued must be non-negative");
  if (!Number.isFinite(waitMs) || waitMs < 1) throw new TypeError("waitMs must be positive");
  let active = 0;
  let admitted = 0;
  let rejected = 0;
  const queue = [];

  const snapshot = () => ({ active, queued: queue.length, admitted, rejected });
  const changed = () => {
    try { onChange?.(snapshot()); } catch {}
  };
  const releaseFor = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      while (active < concurrency && queue.length > 0) {
        const waiter = queue.shift();
        clearTimer(waiter.timer);
        if (waiter.settled) continue;
        waiter.settled = true;
        active += 1;
        admitted += 1;
        waiter.resolve(releaseFor());
      }
      changed();
    };
  };

  async function acquire() {
    if (active < concurrency) {
      active += 1;
      admitted += 1;
      changed();
      return releaseFor();
    }
    if (queue.length >= maximumQueued) {
      rejected += 1;
      changed();
      throw new AdmissionTimeoutError("request admission queue is full");
    }
    const enqueuedAt = nowMs();
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false, enqueuedAt, timer: null };
      waiter.timer = setTimer(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        rejected += 1;
        changed();
        reject(new AdmissionTimeoutError());
      }, waitMs);
      waiter.timer?.unref?.();
      queue.push(waiter);
      changed();
    });
  }

  return { acquire, snapshot };
}

module.exports = { AdmissionTimeoutError, createBoundedAdmission };
