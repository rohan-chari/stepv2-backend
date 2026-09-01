const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");
const {
  scheduleBoundedBatchDrain,
} = require("../../../shared/batching/boundedBatchDrain");

const REQUIRED_GENERATION = 2;
const HEARTBEAT_INTERVAL_MS = 15_000;
const OWNER_TTL_MS = 45_000;
const READY_WINDOW_MS = 90_000;
const EXPECTED_LOGICAL_OWNERS = Object.freeze([
  "http:0",
  "http:1",
  "resolution:0",
  "cron:0",
]);
const GENERATION_CAPABILITIES = Object.freeze([
  "SCHEDULED_EVENT_CONSUMER",
  "UNIVERSAL_C0_LOCK_ORDER",
  "TOKEN_LIFECYCLE",
  "TARGET_AWARE_SENDER",
  "RECONCILER_OWNERSHIP",
]);

function sortedStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string"))].sort();
}

function hasAllCapabilities(owner) {
  const actual = new Set(Array.isArray(owner.capabilities) ? owner.capabilities : []);
  return GENERATION_CAPABILITIES.every((capability) => actual.has(capability));
}

function exactCensusReady(live) {
  if (live.length !== EXPECTED_LOGICAL_OWNERS.length) return false;
  const byLogical = new Map();
  for (const owner of live) {
    if (!owner.logicalOwnerId || byLogical.has(owner.logicalOwnerId)) return false;
    byLogical.set(owner.logicalOwnerId, owner);
  }
  return EXPECTED_LOGICAL_OWNERS.every((logicalOwnerId) => {
    const owner = byLogical.get(logicalOwnerId);
    return owner && owner.generation >= REQUIRED_GENERATION && hasAllCapabilities(owner);
  });
}

async function evaluateReadiness(tx, current) {
  // Narrow unit-test collaborators and mixed-schema startup probes may not
  // expose the generation tables yet. Generation-two work must fail closed;
  // legacy-safe entitlement/gameplay behavior remains available.
  if (!tx?.globalStepEventCronOwner?.findMany ||
      !tx?.globalStepEventGenerationState?.upsert ||
      !tx?.globalStepEventGenerationState?.update) {
    return false;
  }
  const live = await tx.globalStepEventCronOwner.findMany({
    // Every live row participates in the census. During a rolling deploy an
    // older binary writes rows without logicalOwnerId; excluding those rows
    // would let generation two become usable while legacy work is still live.
    where: { expiresAt: { gt: current } },
    select: { logicalOwnerId: true, generation: true, capabilities: true },
  });
  const ready = exactCensusReady(live);
  const state = await tx.globalStepEventGenerationState.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      requiredGeneration: REQUIRED_GENERATION,
      readySince: ready ? current : null,
    },
    update: ready
      ? { readySince: undefined }
      : { readySince: null },
  });
  let readySince = state.readySince;
  if (ready && !readySince) {
    const set = await tx.globalStepEventGenerationState.update({
      where: { id: 1 },
      data: { readySince: current, requiredGeneration: REQUIRED_GENERATION },
    });
    readySince = set.readySince;
  }
  return ready && readySince != null &&
    current.getTime() - new Date(readySince).getTime() >= READY_WINDOW_MS;
}

async function heartbeatGeneration({
  client = defaultPrisma,
  now = new Date(),
  logicalOwnerId,
  bootId,
  role = logicalOwnerId?.split(":")[0] || "unknown",
  generation = REQUIRED_GENERATION,
  capabilities = GENERATION_CAPABILITIES,
} = {}) {
  if (!logicalOwnerId || !bootId) throw new TypeError("logicalOwnerId and bootId are required");
  const current = new Date(now);
  const ownerId = `${logicalOwnerId}:${bootId}`;
  return client.$transaction(async (tx) => {
    await tx.globalStepEventCronOwner.upsert({
      where: { ownerId },
      create: {
        ownerId,
        logicalOwnerId,
        bootId,
        role,
        generation,
        localAware: generation >= REQUIRED_GENERATION,
        capabilities: sortedStrings(capabilities),
        heartbeatAt: current,
        expiresAt: new Date(current.getTime() + OWNER_TTL_MS),
      },
      update: {
        logicalOwnerId,
        bootId,
        role,
        generation,
        localAware: generation >= REQUIRED_GENERATION,
        capabilities: sortedStrings(capabilities),
        heartbeatAt: current,
        expiresAt: new Date(current.getTime() + OWNER_TTL_MS),
      },
    });
    return evaluateReadiness(tx, current);
  });
}

async function isGenerationUsable({ client = defaultPrisma, now = new Date() } = {}) {
  const current = new Date(now);
  return typeof client.$transaction === "function"
    ? client.$transaction((tx) => evaluateReadiness(tx, current))
    : evaluateReadiness(client, current);
}

async function readTokenLifecycleRequired({ client = defaultPrisma, now = new Date() } = {}) {
  if (!client?.globalStepEventGenerationState?.findUnique) return false;
  const state = await client.globalStepEventGenerationState.findUnique({
    where: { id: 1 },
    select: { quarantineStartedAt: true },
  });
  if (state?.quarantineStartedAt) return true;
  return isGenerationUsable({ client, now });
}

function createTokenLifecycleRequirementBatch(loadDecision = readTokenLifecycleRequired) {
  const states = new WeakMap();
  function load({ client = defaultPrisma, now = new Date() } = {}) {
    let state = states.get(client);
    if (!state) {
      state = { pending: [], draining: false };
      states.set(client, state);
    }
    const promise = new Promise((resolve, reject) => {
      state.pending.push({ now, resolve, reject });
    });
    scheduleBoundedBatchDrain(state, async (requests) => {
      const latestNow = new Date(Math.max(...requests.map(({ now: at }) =>
        new Date(at).getTime())));
      const required = await loadDecision({ client, now: latestNow });
      for (const request of requests) request.resolve(required);
    });
    return promise;
  }
  return { load };
}

const tokenLifecycleRequirementBatch = createTokenLifecycleRequirementBatch();

async function isTokenLifecycleRequired({ client = defaultPrisma, now = new Date() } = {}) {
  return tokenLifecycleRequirementBatch.load({ client, now });
}

function logicalOwnerIdForProcess(env = process.env) {
  const role = env.STEPS_PROCESS_ROLE || "all";
  const instance = env.NODE_APP_INSTANCE == null ? "0" : String(env.NODE_APP_INSTANCE);
  return `${role}:${instance}`;
}

function scheduleGenerationHeartbeat(dependencies = {}) {
  const client = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const logicalOwnerId = dependencies.logicalOwnerId || logicalOwnerIdForProcess(dependencies.env || process.env);
  const bootId = dependencies.bootId || crypto.randomUUID();
  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return running;
    running = heartbeatGeneration({ client, now: now(), logicalOwnerId, bootId })
      .catch((error) => logger.error?.("[GLOBAL_EVENT] generation heartbeat failed", {
        logicalOwnerId,
        errorCode: error?.code || "GENERATION_HEARTBEAT_FAILED",
      }))
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const timer = setInterval(tick, dependencies.intervalMs || HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    tick,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}

module.exports = {
  REQUIRED_GENERATION,
  HEARTBEAT_INTERVAL_MS,
  OWNER_TTL_MS,
  READY_WINDOW_MS,
  EXPECTED_LOGICAL_OWNERS,
  GENERATION_CAPABILITIES,
  exactCensusReady,
  heartbeatGeneration,
  isGenerationUsable,
  isTokenLifecycleRequired,
  createTokenLifecycleRequirementBatch,
  logicalOwnerIdForProcess,
  scheduleGenerationHeartbeat,
};
