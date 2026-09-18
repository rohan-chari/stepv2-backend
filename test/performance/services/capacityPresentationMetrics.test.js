const assert = require("node:assert/strict");
const test = require("node:test");

const {
  runCapacityMetricsEntry,
} = require("../../src/shared/observability/capacityPhaseMetrics");
const {
  buildUserPresentationCache,
} = require("../../src/modules/social/services/userPresentationCache");

function user(id) {
  return {
    id,
    displayName: id,
    profilePhotoUrl: null,
    equippedAccessories: [],
    clientFeatures: [],
    isReviewAccount: false,
    hiddenFromLeaderboard: false,
  };
}

async function capturePresentationMetric(buildDependencies, enabled, ids) {
  const logs = [];
  const service = buildUserPresentationCache(buildDependencies);
  await runCapacityMetricsEntry(
    {
      settings: { async getFlag() { return true; } },
      logger: { log(message, fields) { logs.push({ message, fields }); } },
      env: { CAPACITY_PHASE_METRICS_SAMPLE_RATE: "1" },
      random: () => 0,
      queryCaptureAvailable: true,
    },
    () => service.getMany(ids, enabled),
  );
  return logs.find((entry) => entry.fields.surface === "presentation_cache").fields;
}

test("capacity presentation metrics distinguish bypasses from misses and count load operations versus identities", async () => {
  const metric = await capturePresentationMetric({
    prisma: {
      user: {
        async findMany() { return [user("u1")]; },
      },
    },
    redisCache: { isEnabled() { return false; } },
    logger: { info() {} },
  }, false, ["u1", "missing"]);

  assert.deepEqual(metric.counts, {
    requestedIdentities: 2,
    cacheHits: 0,
    cacheMisses: 0,
    cacheBypassedIdentities: 2,
    cacheErrorOperations: 0,
    cacheErrorFallbackIdentities: 0,
    databaseLoadOperations: 1,
    databaseLoadedIdentities: 1,
    databaseLoadErrorOperations: 0,
    cacheInstallOperations: 0,
    cacheInstalledIdentities: 0,
  });
});

test("capacity presentation metrics report actual batch hits, misses, loads, and installs", async () => {
  const metric = await capturePresentationMetric({
    prisma: {
      user: {
        async findMany({ where }) { return where.id.in.map(user); },
      },
    },
    appSettings: {
      async getFlag(key) {
        return key === "redisPresentationGenerationGuardEnabled";
      },
    },
    derivedCache: {
      isBypassed() { return false; },
      ensureSubscribed() {},
    },
    cacheKeys: {
      PREFIX: { USER_COSMETICS: "uc:" },
      userCosmetics(id) { return `uc:${id}`; },
      userCosmeticsVersion(id) { return `ucv:${id}`; },
    },
    redisCache: {
      isEnabled() { return true; },
      async getManyJSON() {
        return {
          ok: true,
          values: [
            { v: user("hit"), generation: 3 }, 3,
            null, null,
          ],
        };
      },
      async withWatch(_keys, callback) {
        await callback({ async get() { return 0; } });
        return { installed: true, disabled: false, aborted: false };
      },
    },
    logger: { info() {} },
  }, true, ["hit", "miss"]);

  assert.equal(metric.counts.cacheHits, 1);
  assert.equal(metric.counts.cacheMisses, 1);
  assert.equal(metric.counts.databaseLoadOperations, 1);
  assert.equal(metric.counts.databaseLoadedIdentities, 1);
  assert.equal(metric.counts.databaseLoadErrorOperations, 0);
  assert.equal(metric.counts.cacheInstallOperations, 1);
  assert.equal(metric.counts.cacheInstalledIdentities, 1);
});

test("capacity presentation metrics separate cache errors from misses before fallback loading", async () => {
  const metric = await capturePresentationMetric({
    prisma: {
      user: {
        async findMany({ where }) { return where.id.in.map(user); },
      },
    },
    appSettings: {
      async getFlag(key) {
        return key === "redisPresentationGenerationGuardEnabled";
      },
    },
    derivedCache: {
      isBypassed() { return false; },
      ensureSubscribed() {},
    },
    cacheKeys: {
      PREFIX: { USER_COSMETICS: "uc:" },
      userCosmetics(id) { return `uc:${id}`; },
      userCosmeticsVersion(id) { return `ucv:${id}`; },
    },
    redisCache: {
      isEnabled() { return true; },
      async getManyJSON() { return { ok: false, values: [] }; },
    },
    logger: { info() {} },
  }, true, ["u1", "u2"]);

  assert.equal(metric.counts.cacheHits, 0);
  assert.equal(metric.counts.cacheMisses, 0);
  assert.equal(metric.counts.cacheErrorOperations, 1);
  assert.equal(metric.counts.cacheErrorFallbackIdentities, 2);
  assert.equal(metric.counts.databaseLoadOperations, 1);
  assert.equal(metric.counts.databaseLoadedIdentities, 2);
  assert.equal(metric.counts.databaseLoadErrorOperations, 0);
});
