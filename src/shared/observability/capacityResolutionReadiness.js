// Process-local bridge between the capacity-only resolution scheduler and the
// capacity health response. Ordinary startup never registers a reader, and the
// field is emitted only while CAPACITY_MODE is active.

let workerReadiness = null;

function registerCapacityResolutionWorker(worker) {
  if (!worker || typeof worker.startupReadiness !== "function") {
    throw new Error("capacity resolution worker readiness is unavailable");
  }
  workerReadiness = () => worker.startupReadiness();
}

function readCapacityResolutionReadiness() {
  if (!workerReadiness) {
    return {
      state: "not-scheduled",
      ready: false,
      quietPeriodElapsed: false,
      oldQueueDrainedObserved: false,
      quietPeriodMs: null,
      remainingQuietMs: null,
    };
  }
  return workerReadiness();
}

function resetCapacityResolutionReadiness() {
  workerReadiness = null;
}

module.exports = {
  readCapacityResolutionReadiness,
  registerCapacityResolutionWorker,
  resetCapacityResolutionReadiness,
};
