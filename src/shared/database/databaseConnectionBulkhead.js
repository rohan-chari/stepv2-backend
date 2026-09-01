function createDatabaseConnectionBulkhead({
  connect,
  maximum,
  maximumStep,
  isStep = () => false,
} = {}) {
  if (typeof connect !== "function") throw new TypeError("connect is required");
  if (!Number.isInteger(maximum) || maximum < 1) throw new TypeError("maximum must be positive");
  if (!Number.isInteger(maximumStep) || maximumStep < 1 || maximumStep > maximum) {
    throw new TypeError("maximumStep must be between one and maximum");
  }
  let active = 0;
  let activeStep = 0;
  let draining = false;
  const stepQueue = [];
  const otherQueue = [];

  const snapshot = () => ({
    active,
    activeStep,
    queued: stepQueue.length + otherQueue.length,
    queuedStep: stepQueue.length,
  });

  function releaseReservation(step) {
    active = Math.max(0, active - 1);
    if (step) activeStep = Math.max(0, activeStep - 1);
    drain();
  }

  function wrapClient(client, step) {
    const originalRelease = client.release.bind(client);
    let released = false;
    client.release = (error) => {
      if (released) return;
      released = true;
      try {
        return originalRelease(error);
      } finally {
        releaseReservation(step);
      }
    };
    return client;
  }

  function dispatch(waiter) {
    active += 1;
    if (waiter.step) activeStep += 1;
    Promise.resolve().then(() => connect()).then(
      (client) => waiter.resolve(wrapClient(client, waiter.step)),
      (error) => {
        releaseReservation(waiter.step);
        waiter.reject(error);
      },
    );
  }

  function drain() {
    if (draining) return;
    draining = true;
    try {
      while (active < maximum) {
        let waiter = null;
        if (stepQueue.length > 0 && activeStep < maximumStep) {
          waiter = stepQueue.shift();
        } else if (otherQueue.length > 0) {
          waiter = otherQueue.shift();
        }
        if (!waiter) break;
        dispatch(waiter);
      }
    } finally {
      draining = false;
    }
  }

  function acquire() {
    const step = isStep() === true;
    return new Promise((resolve, reject) => {
      (step ? stepQueue : otherQueue).push({ step, resolve, reject });
      drain();
    });
  }

  function wrappedConnect(callback) {
    const promise = acquire();
    if (typeof callback !== "function") return promise;
    promise.then(
      (client) => callback(null, client, client.release.bind(client)),
      (error) => callback(error),
    );
    return undefined;
  }

  return { connect: wrappedConnect, snapshot };
}

module.exports = { createDatabaseConnectionBulkhead };
