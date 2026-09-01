const DEFAULT_TTL_MS = 5_000;

function createActiveAdminMetricsEpochCache({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  const states = new WeakMap();

  async function get(prisma) {
    const current = now();
    let state = states.get(prisma);
    if (state?.expiresAt > current) return state.value;
    if (state?.inFlight) return state.inFlight;

    state ||= { value: null, expiresAt: 0, inFlight: null };
    state.inFlight = prisma.adminMetricsCollectionEpoch.findFirst({
      where: { endedAt: null },
      orderBy: { startedAt: "desc" },
    }).then((value) => {
      state.value = value;
      state.expiresAt = now() + ttlMs;
      return value;
    }).finally(() => {
      state.inFlight = null;
    });
    states.set(prisma, state);
    return state.inFlight;
  }

  function clear(prisma) {
    if (prisma) states.delete(prisma);
  }

  return { clear, get };
}

const activeAdminMetricsEpochCache = createActiveAdminMetricsEpochCache();

module.exports = {
  DEFAULT_TTL_MS,
  activeAdminMetricsEpochCache,
  createActiveAdminMetricsEpochCache,
};
