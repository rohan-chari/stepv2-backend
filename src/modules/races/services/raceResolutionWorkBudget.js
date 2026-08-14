const DEFAULT_MAX_ACTIVE = 2;

function buildRaceResolutionWorkBudget({ maxActive = DEFAULT_MAX_ACTIVE } = {}) {
  const cap = Math.max(1, Math.min(2, Number(maxActive) || DEFAULT_MAX_ACTIVE));
  const queued = [];
  let active = 0;
  let sequence = 0;
  let lastGrantedLane = null;

  function nextWaiterIndex() {
    if (lastGrantedLane === "post") {
      const coreIndex = queued.findIndex((waiter) => waiter.lane === "core");
      if (coreIndex >= 0) return coreIndex;
    }
    let selected = 0;
    for (let index = 1; index < queued.length; index += 1) {
      if (queued[index].sequence < queued[selected].sequence) selected = index;
    }
    return selected;
  }

  function drain() {
    while (active < cap && queued.length > 0) {
      const index = nextWaiterIndex();
      const [waiter] = queued.splice(index, 1);
      active += 1;
      lastGrantedLane = waiter.lane;
      waiter.resolve();
    }
  }

  async function acquire(lane) {
    if (lane !== "core" && lane !== "post") {
      throw new TypeError("invalid lane");
    }
    await new Promise((resolve) => {
      queued.push({ lane, resolve, sequence: sequence++ });
      drain();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      drain();
    };
  }

  return {
    async run(lane, handler) {
      if (typeof handler !== "function") throw new TypeError("handler required");
      const release = await acquire(lane);
      try {
        return await handler();
      } finally {
        release();
      }
    },
    snapshot() {
      return {
        active,
        queuedCore: queued.filter((waiter) => waiter.lane === "core").length,
        queuedPost: queued.filter((waiter) => waiter.lane === "post").length,
      };
    },
  };
}

const raceResolutionWorkBudget = buildRaceResolutionWorkBudget();

module.exports = {
  DEFAULT_MAX_ACTIVE,
  buildRaceResolutionWorkBudget,
  raceResolutionWorkBudget,
};
