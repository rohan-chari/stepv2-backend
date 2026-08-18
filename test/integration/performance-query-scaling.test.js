// Query-event instrumentation is test-only and must be enabled before db.js is
// loaded. Production does not attach the global Prisma query listener.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");
const {
  buildStepSyncPushService,
} = require("../../src/shared/push/stepSyncPush");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let activeQueries = null;
prisma.$on("query", (event) => {
  if (activeQueries) activeQueries.push(event);
});

async function recordQueries(fn) {
  const events = [];
  activeQueries = events;
  try {
    const result = await fn();
    return { result, events };
  } finally {
    activeQueries = null;
  }
}

async function seedSneaky(candidateCount, { withActiveEffects = false } = {}) {
  const viewer = await createTestUser({ displayName: "Query Viewer" });
  const race = await prisma.race.create({
    data: {
      creatorId: viewer.user.id,
      name: `Sneaky Query ${candidateCount}`,
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      timezone: "UTC",
      powerupsEnabled: true,
      powerupStepInterval: 1000,
    },
  });
  const candidates = Array.from({ length: candidateCount }, (_, index) => ({
    userId: randomUUID(),
    participantId: randomUUID(),
    powerupId: randomUUID(),
    appleId: `sneaky-query-${candidateCount}-${index}`,
    joinedAt: new Date(Date.now() - candidateCount + index),
  }));
  await prisma.user.createMany({
    data: candidates.map((candidate) => ({
      id: candidate.userId,
      appleId: candidate.appleId,
      displayName: candidate.appleId,
    })),
  });
  await prisma.raceParticipant.createMany({
    data: [
      {
        raceId: race.id,
        userId: viewer.user.id,
        status: "ACCEPTED",
        joinedAt: new Date(Date.now() - 10_000),
      },
      ...candidates.map((candidate) => ({
        id: candidate.participantId,
        raceId: race.id,
        userId: candidate.userId,
        status: "ACCEPTED",
        joinedAt: candidate.joinedAt,
      })),
    ],
  });
  await prisma.racePowerup.createMany({
    data: candidates.map((candidate, index) => ({
      id: candidate.powerupId,
      raceId: race.id,
      participantId: candidate.participantId,
      userId: candidate.userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 1000 + index,
    })),
  });
  if (withActiveEffects) {
    await prisma.raceActiveEffect.createMany({
      data: candidates
        .filter((_, index) => index % 2 === 0)
        .map((candidate) => ({
          raceId: race.id,
          targetParticipantId: candidate.participantId,
          targetUserId: candidate.userId,
          sourceUserId: viewer.user.id,
          powerupId: candidate.powerupId,
          type: "STEALTH_MODE",
          status: "ACTIVE",
          startsAt: new Date("2026-08-13T11:00:00.000Z"),
          expiresAt: new Date("2026-08-13T13:00:00.000Z"),
        })),
    });
  }
  return { viewer, race, candidates };
}

async function runSneaky(candidateCount) {
  await cleanDatabase();
  const { viewer, race } = await seedSneaky(candidateCount);
  // Capacity metrics reads the DB-backed flag before every request, with the
  // established settings cache making that query cold-start-only. Warm it
  // outside the measured request so both field sizes measure the same steady
  // state and the scaling assertion remains exact.
  await appSettings.getFlag("capacityPhaseMetricsV1Enabled");
  const { result: response, events } = await recordQueries(() =>
    request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/powerups/sneaky-swap-targets`,
      { token: viewer.token }
    )
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).targets.length, candidateCount);
  return events;
}

async function seedEligibleStepSyncUsers(count, prefix) {
  const users = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    appleId: `${prefix}-${index}`,
  }));
  await prisma.user.createMany({ data: users });
  await prisma.deviceToken.createMany({
    data: users.map((user, index) => ({
      userId: user.id,
      token: `${prefix}-token-${index}`,
      platform: "ios",
    })),
  });
  return users;
}

async function runBulkStepSync(count) {
  await cleanDatabase();
  const users = await seedEligibleStepSyncUsers(count, `step-query-${count}`);
  const service = buildStepSyncPushService({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({
      stepSyncBulkEnabled: true,
      stepSyncPushConcurrency: 16,
    }),
    apnsService: {
      async sendSilentNotification() { return { success: true }; },
    },
    logger: { log() {}, warn() {}, error() {} },
  });
  const { events } = await recordQueries(() =>
    service.requestStepSyncForUsers(users.map((user) => user.id))
  );
  return events;
}

async function seedParityFixture() {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const specs = [
    { key: "recent-sync", lastStepSyncAt: new Date(now.getTime() - 5 * 60_000) },
    { key: "recent-push", lastSilentPushSentAt: new Date(now.getTime() - 5 * 60_000) },
    { key: "no-token" },
    { key: "ios", tokens: [["ios-ok", "ios"]] },
    { key: "android", tokens: [["android-ok", "android"]] },
    { key: "mixed", tokens: [["stale", "ios"], ["mixed-ok", "android"]] },
    { key: "throws", tokens: [["throws", "ios"]] },
  ].map((spec) => ({ ...spec, id: randomUUID(), appleId: `parity-${spec.key}` }));
  await prisma.user.createMany({
    data: specs.map(({ id, appleId, lastStepSyncAt, lastSilentPushSentAt }) => ({
      id,
      appleId,
      lastStepSyncAt,
      lastSilentPushSentAt,
    })),
  });
  await prisma.deviceToken.createMany({
    data: specs.flatMap((spec) =>
      (spec.tokens || []).map(([token, platform]) => ({
        userId: spec.id,
        token,
        platform,
      }))
    ),
  });
  return specs;
}

async function paritySnapshot() {
  const users = await prisma.user.findMany({
    where: { appleId: { startsWith: "parity-" } },
    select: { appleId: true, lastSilentPushSentAt: true },
    orderBy: { appleId: "asc" },
  });
  const tokens = await prisma.deviceToken.findMany({
    where: { user: { appleId: { startsWith: "parity-" } } },
    select: { token: true, platform: true, user: { select: { appleId: true } } },
    orderBy: [{ token: "asc" }],
  });
  return {
    users: users.map((user) => ({
      appleId: user.appleId,
      sentAt: user.lastSilentPushSentAt?.toISOString() || null,
    })),
    tokens: tokens.map((token) => ({
      appleId: token.user.appleId,
      token: token.token,
      platform: token.platform,
    })),
  };
}

async function runParityMode(stepSyncBulkEnabled) {
  await cleanDatabase();
  const specs = await seedParityFixture();
  const sends = [];
  const sender = async ({ deviceToken }) => {
    sends.push(deviceToken);
    if (deviceToken === "stale") return { success: false, unregistered: true };
    if (deviceToken === "throws") throw new Error("provider unavailable");
    return { success: true };
  };
  const service = buildStepSyncPushService({
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    getPerformanceFlags: () => ({ stepSyncBulkEnabled, stepSyncPushConcurrency: 3 }),
    apnsService: { sendSilentNotification: sender },
    fcmService: { sendSilentNotification: sender },
    logger: { log() {}, warn() {}, error() {} },
  });
  const { events } = await recordQueries(() =>
    service.requestStepSyncForUsers(specs.map((spec) => spec.id), {
      minIntervalMs: 30 * 60_000,
    })
  );
  return { snapshot: await paritySnapshot(), sends: sends.sort(), queryCount: events.length };
}

function sqlUuidArray(ids) {
  // All values originate from randomUUID()/fixed UUID fixtures in this test.
  // Prisma's String IDs are PostgreSQL text columns, despite containing UUIDs.
  return `ARRAY[${ids.map((id) => `'${id}'::text`).join(",")}]`;
}

async function explain(sql) {
  const rows = await prisma.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
  return rows.map((row) => row["QUERY PLAN"]);
}

function concisePlan(plan) {
  // Keep the actual executor/buffer/timing lines in test output without dumping
  // 300/750 random fixture IDs from PostgreSQL's rendered ANY-array filter.
  return plan.filter((line) => !line.includes("ANY ('{"));
}

describe("Prisma query-event performance scaling", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  it("keeps public Sneaky SQL count constant from 10 to 300 candidates", async () => {
    const ten = await runSneaky(10);
    const threeHundred = await runSneaky(300);
    console.log("[PERF_EVIDENCE] sneaky_query_count", {
      candidates10: ten.length,
      candidates300: threeHundred.length,
    });
    assert.ok(ten.length > 0, "Prisma query-event harness must observe real SQL");
    assert.equal(
      threeHundred.length,
      ten.length,
      `observed Sneaky query counts: 10=${ten.length}, 300=${threeHundred.length}`
    );
    // Includes authentication/user hydration around the three domain reads.
    assert.ok(
      threeHundred.length <= 10,
      `observed ${threeHundred.length} public-request queries`
    );
  });

  it("keeps bulk step-sync SQL count constant from 10 to 750 users", async () => {
    const ten = await runBulkStepSync(10);
    const sevenFifty = await runBulkStepSync(750);
    console.log("[PERF_EVIDENCE] step_sync_query_count", {
      users10: ten.length,
      users750: sevenFifty.length,
    });
    assert.ok(ten.length > 0, "Prisma query-event harness must observe real SQL");
    assert.equal(
      sevenFifty.length,
      ten.length,
      `observed step-sync query counts: 10=${ten.length}, 750=${sevenFifty.length}`
    );
    assert.ok(sevenFifty.length <= 4, `observed ${sevenFifty.length} bulk queries`);
  });

  it("bulk and legacy step-sync produce identical real-storage outcomes", async () => {
    const legacy = await runParityMode(false);
    const bulk = await runParityMode(true);
    console.log("[PERF_EVIDENCE] step_sync_parity_query_count", {
      legacy: legacy.queryCount,
      bulk: bulk.queryCount,
    });
    assert.deepEqual(bulk.snapshot, legacy.snapshot);
    assert.deepEqual(bulk.sends, legacy.sends);
    assert.ok(bulk.queryCount < legacy.queryCount);
  });

  it("captures actual EXPLAIN ANALYZE plans for the 300/750 production read shapes", async () => {
    const { candidates } = await seedSneaky(300, { withActiveEffects: true });
    const users = await seedEligibleStepSyncUsers(750, "explain-step-query");
    const participantIds = sqlUuidArray(candidates.map(({ participantId }) => participantId));
    const userIds = sqlUuidArray(users.map(({ id }) => id));

    const plans = {
      activeEffects: await explain(`
        SELECT target_participant_id
        FROM race_active_effects
        WHERE target_participant_id = ANY (${participantIds})
          AND type = 'stealth_mode'
          AND status = 'active_effect'
      `),
      heldInventory: await explain(`
        SELECT participant_id, type
        FROM race_powerups
        WHERE participant_id = ANY (${participantIds})
          AND status = 'held'
        ORDER BY created_at ASC
      `),
      deviceTokens: await explain(`
        SELECT user_id, token, platform
        FROM device_tokens
        WHERE user_id = ANY (${userIds})
      `),
    };
    console.log(
      "[PERF_EVIDENCE] explain_analyze",
      JSON.stringify(Object.fromEntries(
        Object.entries(plans).map(([name, plan]) => [name, concisePlan(plan)])
      ), null, 2)
    );
    for (const [name, plan] of Object.entries(plans)) {
      assert.ok(plan.some((line) => line.includes("Execution Time:")), `${name} has execution timing`);
      assert.ok(plan.some((line) => line.includes("Buffers:")), `${name} has buffer evidence`);
    }
  });
});
