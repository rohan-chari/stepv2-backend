const assert = require("node:assert/strict");
const { afterEach, before, beforeEach, describe, it } = require("node:test");
const { Client } = require("pg");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildActiveImpactBoundaryStamp,
  buildActiveImpactRetention,
} = require("../../src/modules/races/jobs/activeRaceImpactMaintenance");

process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const ACTIVE_CAPABILITY = {
  "X-Client-Features": "active_impact_notices_v1,impact_notices",
};
const ACTIVE_POWERUP_CAPABILITY = {
  "X-Client-Features": "active_impact_notices_v1,impact_notices,characters,powerups3,powerups4,powerups5",
};

let server;

async function createRaceWithParticipants(users, status = "ACTIVE", overrides = {}) {
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: "Active impact contract race",
      targetSteps: 10000,
      status,
      startedAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      powerupsEnabled: true,
      ...overrides,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map((entry) => ({
      raceId: race.id,
      userId: entry.user.id,
      status: "ACCEPTED",
    })),
  });
  return race;
}

async function grantHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  return prisma.racePowerup.create({ data: {
    raceId,
    participantId: participant.id,
    userId,
    type,
    rarity: "COMMON",
    status: "HELD",
    earnedAtSteps,
  } });
}

async function usePowerupPublicly(user, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    token: user.token,
    headers: ACTIVE_POWERUP_CAPABILITY,
    body,
  });
}

async function drainActiveImpactWorker(maxAttempts = 20) {
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    logger: { log() {}, error() {} },
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!(await worker.processOne())) break;
  }
}

async function waitUntilBlockedBy(lockingPid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pid, query
         FROM pg_stat_activity
        WHERE $1::int = ANY(pg_blocking_pids(pid))
          AND datname = current_database()`,
      lockingPid,
    );
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("public powerup use never reached the durable active-impact flag lock");
}

describe("active-race impact notification contracts", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["apiActiveImpactNoticesV1Enabled", true],
      ["apiImpactNoticesEnabled", true],
      ["apiCompletedImpactPopupEnabled", false],
    ]);
    // Most resolution fixtures intentionally backdate an effect window so a
    // real worker can cross hours of wall time in milliseconds. Treat those
    // synthetic windows as belonging to an already-enabled test rollout. The
    // dedicated flag-boundary cases below toggle the flag themselves, which
    // atomically installs a fresh epoch and still exercise no-backfill.
    await prisma.appSetting.update({
      where: { key: "apiActiveImpactNoticesV1EnabledFrom" },
      data: { value: "2000-01-01T00:00:00.000Z" },
    });
  });
  afterEach(async () => {
    await appSettings.setFlagsAtomically([
      ["apiActiveImpactNoticesV1Enabled", false],
      ["apiImpactNoticesEnabled", false],
      ["apiCompletedImpactPopupEnabled", false],
    ]);
  });

  it("capability-gates the active endpoint and keeps the legacy popup separate from private Activity", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);

    const missingCapability = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token },
    );
    assert.equal(missingCapability.status, 404);

    const enabled = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), { notices: [] });

    const legacyPopup = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/impact-notices`,
      { token: owner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(legacyPopup.status, 404);

    const privateFeed = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed`,
      { token: owner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(privateFeed.status, 200);
  });

  it("serves only the authenticated active participant and binds acknowledgement to race and recipient", async () => {
    const owner = await createTestUser();
    const teammate = await createTestUser();
    const outsider = await createTestUser();
    const race = await createRaceWithParticipants([owner, teammate]);
    const resolvedAt = new Date("2026-08-19T16:30:00.000Z");
    const work = await prisma.activeRaceImpactWork.create({
      data: {
        raceId: race.id,
        recipientUserId: owner.user.id,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: "effect-contract-1",
        powerupType: "LEECH",
        status: "CREATED",
        resolvedAt,
        processedGeneration: 7,
      },
    });
    const notice = await prisma.activeRaceEffectImpact.create({
      data: {
        raceId: race.id,
        userId: owner.user.id,
        workId: work.id,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: "effect-contract-1",
        powerupType: "LEECH",
        deltaSteps: -426,
        sourceGeneration: 7,
        resolvedAt,
      },
    });

    const mine = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(mine.status, 200);
    assert.deepEqual(await mine.json(), {
      notices: [{
        id: notice.id,
        powerupType: "LEECH",
        deltaSteps: -426,
        valueStatus: "SYNCED_SNAPSHOT",
        resolvedAt: resolvedAt.toISOString(),
      }],
    });

    const teammateRead = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: teammate.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(teammateRead.status, 200);
    assert.deepEqual(await teammateRead.json(), { notices: [] });

    const outsiderRead = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: outsider.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(outsiderRead.status, 403);

    const foreignAck = await request(server.baseUrl, "POST", `/races/${race.id}/active-impact-notices/${notice.id}/acknowledge`, {
      token: teammate.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(foreignAck.status, 404);

    const ack = await request(server.baseUrl, "POST", `/races/${race.id}/active-impact-notices/${notice.id}/acknowledge`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { acknowledged: true });

    const repeatedAck = await request(server.baseUrl, "POST", `/races/${race.id}/active-impact-notices/${notice.id}/acknowledge`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(repeatedAck.status, 200);
  });

  it("suppresses terminal delivery and returns RACE_NOT_ACTIVE when completion wins the ack race", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const work = await prisma.activeRaceImpactWork.create({
      data: {
        raceId: race.id,
        recipientUserId: owner.user.id,
        sourceKind: "POWERUP_EVENT",
        sourceId: "event-contract-1",
        powerupType: "PROTEIN_SHAKE",
        status: "CREATED",
        resolvedAt: new Date(),
        processedGeneration: 2,
      },
    });
    const notice = await prisma.activeRaceEffectImpact.create({
      data: {
        raceId: race.id,
        userId: owner.user.id,
        workId: work.id,
        sourceKind: "POWERUP_EVENT",
        sourceId: "event-contract-1",
        powerupType: "PROTEIN_SHAKE",
        deltaSteps: 250,
        sourceGeneration: 2,
        resolvedAt: new Date(),
      },
    });
    const pending = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: owner.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: "still-pending-effect",
      powerupType: "LEECH",
      status: "PENDING",
      resolvedAt: new Date(),
    } });
    const cancelled = await request(server.baseUrl, "DELETE", `/races/${race.id}`, {
      token: owner.token,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(
      (await prisma.activeRaceImpactWork.findUnique({ where: { id: pending.id } })).status,
      "SUPPRESSED_TERMINAL",
      "the terminal transition suppresses pending presentation work atomically",
    );

    const read = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { notices: [] });

    const ack = await request(server.baseUrl, "POST", `/races/${race.id}/active-impact-notices/${notice.id}/acknowledge`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(ack.status, 409);
    assert.equal((await ack.json()).code, "RACE_NOT_ACTIVE");
  });

  it("cascades race deletion and bounds account deletion over active presentation rows", async () => {
    const owner = await createTestUser({ displayName: "Lifecycle Owner" });
    const teammate = await createTestUser({ displayName: "Lifecycle Teammate" });
    const race = await createRaceWithParticipants([owner, teammate]);
    const work = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: owner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "lifecycle-event",
      powerupType: "PROTEIN_SHAKE",
      status: "CREATED",
      resolvedAt: new Date(),
      processedGeneration: 1,
    } });
    await prisma.activeRaceEffectImpact.create({ data: {
      raceId: race.id,
      userId: owner.user.id,
      workId: work.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "lifecycle-event",
      powerupType: "PROTEIN_SHAKE",
      deltaSteps: 250,
      sourceGeneration: 1,
      resolvedAt: new Date(),
    } });

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: owner.token,
    });
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { recipientUserId: owner.user.id },
    }), 0);
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { userId: owner.user.id },
    }), 0);

    const remainingWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: teammate.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: "race-delete-effect",
      powerupType: "LEECH",
      status: "PENDING",
      resolvedAt: new Date(),
    } });
    await prisma.race.delete({ where: { id: race.id } });
    assert.equal(await prisma.activeRaceImpactWork.findUnique({
      where: { id: remainingWork.id },
    }), null);
  });

  it("acknowledges an actor-only inline receipt without acknowledging another recipient", async () => {
    const actor = await createTestUser();
    const victim = await createTestUser();
    const race = await createRaceWithParticipants([actor, victim]);
    const actorWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: actor.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "shortcut-event",
      powerupType: "SHORTCUT",
      status: "PENDING",
      resolvedAt: new Date(),
      inlineReceiptId: "11111111-1111-4111-8111-111111111111",
    } });
    const victimWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: victim.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "shortcut-event",
      powerupType: "SHORTCUT",
      status: "PENDING",
      resolvedAt: new Date(),
    } });

    const ack = await request(server.baseUrl, "POST", `/races/${race.id}/active-impact-receipts/${actorWork.inlineReceiptId}/acknowledge`, {
      token: actor.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { acknowledged: true });
    assert.ok((await prisma.activeRaceImpactWork.findUnique({ where: { id: actorWork.id } })).inlineAcknowledgedAt);
    assert.equal((await prisma.activeRaceImpactWork.findUnique({ where: { id: victimWork.id } })).inlineAcknowledgedAt, null);

    const materializedWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: actor.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "protein-event",
      powerupType: "PROTEIN_SHAKE",
      status: "CREATED",
      resolvedAt: new Date(),
      processedGeneration: 9,
      inlineReceiptId: "22222222-2222-4222-8222-222222222222",
    } });
    const materializedImpact = await prisma.activeRaceEffectImpact.create({ data: {
      raceId: race.id,
      userId: actor.user.id,
      workId: materializedWork.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "protein-event",
      powerupType: "PROTEIN_SHAKE",
      deltaSteps: 1500,
      valueStatus: "SYNCED_SNAPSHOT",
      sourceGeneration: 9,
      resolvedAt: materializedWork.resolvedAt,
    } });
    const materializedAck = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-receipts/${materializedWork.inlineReceiptId}/acknowledge`,
      { token: actor.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(materializedAck.status, 200);
    assert.ok((await prisma.activeRaceImpactWork.findUnique({
      where: { id: materializedWork.id },
    })).inlineAcknowledgedAt);
    assert.ok((await prisma.activeRaceEffectImpact.findUnique({
      where: { id: materializedImpact.id },
    })).acknowledgedAt, "receipt ack atomically suppresses an already-materialized notice");
  });

  it("keeps a receipt acknowledgement when it commits while materialization is blocked before insert", async () => {
    const actor = await createTestUser({ displayName: "Concurrent Receipt Actor" });
    const race = await createRaceWithParticipants([actor]);
    const event = await prisma.racePowerupEvent.create({ data: {
      raceId: race.id,
      actorUserId: actor.user.id,
      eventType: "POWERUP_USED",
      powerupType: "PROTEIN_SHAKE",
      description: "Concurrent receipt source",
      metadata: {
        activeImpactCalculationVersion: 1,
        activeImpactPowerupType: "PROTEIN_SHAKE",
        activeImpactDeltas: [{ userId: actor.user.id, deltaSteps: 500 }],
      },
    } });
    const work = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: actor.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: event.id,
      powerupType: "PROTEIN_SHAKE",
      status: "PENDING",
      resolvedAt: event.createdAt,
      inlineReceiptId: "33333333-3333-4333-8333-333333333333",
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: actor.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(sync.status, 200);

    const lockKey = 810191001;
    const blocker = new Client({ connectionString: process.env.DATABASE_URL });
    await blocker.connect();
    await blocker.query("SELECT pg_advisory_lock($1)", [lockKey]);
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_block_active_impact_insert()
      RETURNS trigger AS $trigger$
      BEGIN
        PERFORM pg_advisory_xact_lock(${lockKey});
        RETURN NEW;
      END;
      $trigger$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_block_active_impact_insert_trigger
      BEFORE INSERT ON active_race_effect_impacts
      FOR EACH ROW EXECUTE FUNCTION test_block_active_impact_insert()
    `);

    try {
      const worker = buildRaceResolutionWorkerV2({
        bootAt: 0,
        logger: { log() {}, error() {} },
      });
      const materializing = worker.processOne();
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT 1 FROM pg_locks
           WHERE locktype = 'advisory'
             AND granted = false
             AND objid = $1::bigint
           LIMIT 1`,
          lockKey,
        );
        if (rows.length > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true, "materialization must be waiting after its work-row read");

      const ack = await request(
        server.baseUrl,
        "POST",
        `/races/${race.id}/active-impact-receipts/${work.inlineReceiptId}/acknowledge`,
        { token: actor.token, headers: ACTIVE_CAPABILITY },
      );
      assert.equal(ack.status, 200);
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      assert.ok(await materializing);

      const [storedWork, impact] = await Promise.all([
        prisma.activeRaceImpactWork.findUnique({ where: { id: work.id } }),
        prisma.activeRaceEffectImpact.findFirst({ where: { workId: work.id } }),
      ]);
      assert.ok(storedWork.inlineAcknowledgedAt);
      assert.ok(impact?.acknowledgedAt,
        "the insert must re-read the acknowledgement that won during materialization");
      assert.equal(
        impact.acknowledgedAt.getTime(),
        storedWork.inlineAcknowledgedAt.getTime(),
      );
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
      await blocker.end().catch(() => {});
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS test_block_active_impact_insert_trigger ON active_race_effect_impacts",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS test_block_active_impact_insert()",
      );
    }
  });

  it("returns the capability-gated 202 generation handoff while durable work is pending", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: owner.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: "pending-effect",
      powerupType: "LEECH",
      status: "PENDING",
      resolvedAt: new Date(),
    } });

    const response = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.deepEqual(body.notices, []);
    assert.equal(body.resolution.state, "PENDING");
    assert.equal(body.resolution.retryAfterMs, 500);
    assert.equal(typeof body.resolution.jobId, "string");
    assert.ok(Number.isInteger(body.resolution.generation));

    const status = await request(
      server.baseUrl,
      "GET",
      `/steps/race-resolution/${body.resolution.jobId}?generation=${body.resolution.generation}`,
      { token: owner.token },
    );
    assert.equal(status.status, 200);
    assert.ok((await status.json()).raceResolution);
  });

  it("hides and preserves pending work while disabled, then resumes only an active race", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const work = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: owner.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: "flag-lifecycle-effect",
      powerupType: "LEECH",
      status: "PENDING",
      resolvedAt: new Date(),
    } });

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const hidden = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(hidden.status, 404);
    assert.equal((await prisma.activeRaceImpactWork.findUnique({ where: { id: work.id } })).status, "PENDING");

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const resumed = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(resumed.status, 202);

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const cancelled = await request(server.baseUrl, "DELETE", `/races/${race.id}`, {
      token: owner.token,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(
      (await prisma.activeRaceImpactWork.findUnique({ where: { id: work.id } })).status,
      "SUPPRESSED_TERMINAL",
    );

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const terminal = await request(server.baseUrl, "GET", `/races/${race.id}/active-impact-notices`, {
      token: owner.token,
      headers: ACTIVE_CAPABILITY,
    });
    assert.equal(terminal.status, 200);
    assert.deepEqual(await terminal.json(), { notices: [] });
  });

  it("gates direct source eligibility at resolution time without backfilling old events", async () => {
    const runner = await createTestUser({ displayName: "Source Gate Runner" });
    const race = await createRaceWithParticipants([runner]);
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const createProtein = (earnedAtSteps) => prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps,
    } });

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const disabledPowerup = await createProtein(920001);
    const disabledUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${disabledPowerup.id}/use`,
      { token: runner.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(disabledUse.status, 200);
    assert.equal((await disabledUse.json()).activeImpactReceipt, undefined);
    const disabledEvent = await prisma.racePowerupEvent.findFirst({
      where: { raceId: race.id, actorUserId: runner.user.id, powerupType: "PROTEIN_SHAKE" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(disabledEvent.metadata.activeImpactCalculationVersion, undefined);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: disabledEvent.id },
    }), 0);

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const enabledPowerup = await createProtein(920002);
    const enabledUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${enabledPowerup.id}/use`,
      { token: runner.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(enabledUse.status, 200);
    assert.equal(typeof (await enabledUse.json()).activeImpactReceipt?.id, "string");
    const enabledEvent = await prisma.racePowerupEvent.findFirst({
      where: {
        raceId: race.id,
        actorUserId: runner.user.id,
        powerupType: "PROTEIN_SHAKE",
        id: { not: disabledEvent.id },
      },
    });
    assert.equal(enabledEvent.metadata.activeImpactCalculationVersion, 1);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: enabledEvent.id },
    }), 1);
  });

  it("serializes a public direct source against the durable disable boundary despite a stale enabled cache", async () => {
    const runner = await createTestUser({ displayName: "Concurrent Disable Runner" });
    const race = await createRaceWithParticipants([runner]);
    const powerup = await grantHeldPowerup(race.id, runner.user.id, "PROTEIN_SHAKE", 920003);

    assert.equal(await appSettings.getFlag("apiActiveImpactNoticesV1Enabled"), true);
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let committed = false;
    try {
      await locker.query("BEGIN");
      const pid = Number((await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await locker.query(
        `SELECT key
           FROM app_settings
          WHERE key IN ('apiActiveImpactNoticesV1Enabled', 'apiActiveImpactNoticesV1EnabledFrom')
          ORDER BY key ASC
          FOR UPDATE`,
      );

      const usePromise = usePowerupPublicly(runner, race.id, powerup.id);
      await waitUntilBlockedBy(pid);
      await locker.query(
        `UPDATE app_settings
            SET value = 'false'::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE key = 'apiActiveImpactNoticesV1Enabled'`,
      );
      await locker.query("COMMIT");
      committed = true;

      const response = await usePromise;
      assert.equal(response.status, 200);
      assert.equal((await response.json()).activeImpactReceipt, undefined);
    } finally {
      if (!committed) await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
      appSettings.bustCache();
    }

    const event = await prisma.racePowerupEvent.findFirst({
      where: { raceId: race.id, powerupType: "PROTEIN_SHAKE" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(event.metadata.activeImpactCalculationVersion, undefined);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: event.id },
    }), 0);
  });

  it("does not backfill a stamped direct event from before the current enable epoch", async () => {
    const runner = await createTestUser({ displayName: "Direct Epoch Runner" });
    const race = await createRaceWithParticipants([runner]);
    const source = await prisma.racePowerupEvent.create({ data: {
      raceId: race.id,
      actorUserId: runner.user.id,
      eventType: "POWERUP_USED",
      powerupType: "SECOND_WIND",
      description: "Pre-epoch direct source",
      createdAt: new Date("2026-08-19T10:00:00.000Z"),
      metadata: {
        activeImpactCalculationVersion: 1,
        activeImpactPowerupType: "SECOND_WIND",
        activeImpactDeltas: [{ userId: runner.user.id, deltaSteps: 750 }],
      },
    } });
    await prisma.appSetting.update({
      where: { key: "apiActiveImpactNoticesV1EnabledFrom" },
      data: { value: "2026-08-19T11:00:00.000Z" },
    });

    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(sync.status, 200);
    await drainActiveImpactWorker();
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: source.id },
    }), 0);
  });

  it("materializes one immutable signed Leech snapshot per recipient through the C0 worker", async () => {
    const caster = await createTestUser({ displayName: "Caster" });
    const victim = await createTestUser({ displayName: "Victim" });
    const race = await createRaceWithParticipants([caster, victim]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: { startedAt, endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId: race.id }, data: { joinedAt: startedAt } });
    const victimParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
    });
    await prisma.stepSample.create({ data: {
      userId: victim.user.id,
      periodStart: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      periodEnd: new Date(now.getTime() - 150 * 60 * 1000),
      steps: 2000,
    } });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: victimParticipant.id,
      userId: victim.user.id,
      type: "LEECH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900001,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: victimParticipant.id,
      targetUserId: victim.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 20 * 60 * 1000),
      metadata: { ratio: 2, scoringVersion: 2 },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: caster.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 852,
      }] },
    });
    assert.equal(sync.status, 200);

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());

    const rows = await prisma.activeRaceEffectImpact.findMany({
      where: { raceId: race.id, sourceId: effect.id },
      orderBy: { deltaSteps: "asc" },
    });
    assert.deepEqual(rows.map((row) => [row.userId, row.deltaSteps, row.valueStatus]), [
      [victim.user.id, -426, "SYNCED_SNAPSHOT"],
      [caster.user.id, 426, "SYNCED_SNAPSHOT"],
    ]);
    await worker.processOne();
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 2, "a retry/generation cannot duplicate either immutable recipient row");
  });

  it("reuses canonical counterfactual scoring for an expired timed multiplier", async () => {
    const runner = await createTestUser({ displayName: "Timed Runner" });
    const rival = await createTestUser({ displayName: "Timed Rival" });
    const race = await createRaceWithParticipants([runner, rival]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: { startedAt, endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900002,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 20 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 1000,
      }] },
    });
    assert.equal(sync.status, 200);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    const impact = await prisma.activeRaceEffectImpact.findFirst({
      where: { raceId: race.id, userId: runner.user.id, sourceId: effect.id },
    });
    assert.equal(impact?.powerupType, "RUNNERS_HIGH");
    assert.equal(impact?.deltaSteps, 1000);
    assert.equal(impact?.valueStatus, "SYNCED_SNAPSHOT");
  });

  it("freezes independent timed, Leech, and Hitchhike work atomically when an ordinary racer leaves", async () => {
    const creator = await createTestUser({ displayName: "Freeze Creator" });
    const leaver = await createTestUser({ displayName: "Freeze Leaver" });
    const now = new Date();
    const startedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const race = await createRaceWithParticipants([creator, leaver], "ACTIVE", {
      startedAt,
      endsAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
      timezone: "UTC",
      exitActionsEnabled: true,
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const [creatorParticipant, leaverParticipant] = await Promise.all([
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: creator.user.id } },
      }),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: leaver.user.id } },
      }),
    ]);
    await prisma.stepSample.createMany({ data: [
      {
        userId: creator.user.id,
        periodStart: new Date(now.getTime() - 90 * 60 * 1000),
        periodEnd: new Date(now.getTime() - 80 * 60 * 1000),
        steps: 400,
      },
      {
        userId: leaver.user.id,
        periodStart: new Date(now.getTime() - 90 * 60 * 1000),
        periodEnd: new Date(now.getTime() - 80 * 60 * 1000),
        steps: 1000,
      },
    ] });
    const powerups = await Promise.all([
      prisma.racePowerup.create({ data: {
        raceId: race.id, participantId: leaverParticipant.id,
        userId: leaver.user.id, type: "RUNNERS_HIGH", rarity: "RARE",
        status: "USED", earnedAtSteps: 910001,
      } }),
      prisma.racePowerup.create({ data: {
        raceId: race.id, participantId: creatorParticipant.id,
        userId: creator.user.id, type: "LEECH", rarity: "RARE",
        status: "USED", earnedAtSteps: 910002,
      } }),
      prisma.racePowerup.create({ data: {
        raceId: race.id, participantId: leaverParticipant.id,
        userId: leaver.user.id, type: "HITCHHIKE", rarity: "RARE",
        status: "USED", earnedAtSteps: 910003,
      } }),
    ]);
    const [timed, leech, hitchhike] = await Promise.all([
      prisma.raceActiveEffect.create({ data: {
        raceId: race.id, targetParticipantId: leaverParticipant.id,
        targetUserId: leaver.user.id, sourceUserId: leaver.user.id,
        powerupId: powerups[0].id, type: "RUNNERS_HIGH", status: "ACTIVE",
        startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        metadata: { multiplier: 2 },
      } }),
      prisma.raceActiveEffect.create({ data: {
        raceId: race.id, targetParticipantId: leaverParticipant.id,
        targetUserId: leaver.user.id, sourceUserId: creator.user.id,
        powerupId: powerups[1].id, type: "LEECH", status: "ACTIVE",
        startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        metadata: { ratio: 2 },
      } }),
      prisma.raceActiveEffect.create({ data: {
        raceId: race.id, targetParticipantId: creatorParticipant.id,
        targetUserId: creator.user.id, sourceUserId: leaver.user.id,
        powerupId: powerups[2].id, type: "HITCHHIKE", status: "ACTIVE",
        startsAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
        metadata: { copyRatio: 1 },
      } }),
    ]);

    const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: leaver.token,
      headers: { "X-Client-Features": "race_leave,active_impact_notices_v1" },
      body: {},
    });
    assert.equal(response.status, 200);
    const work = await prisma.activeRaceImpactWork.findMany({
      where: { raceId: race.id, recipientUserId: leaver.user.id },
      orderBy: { sourceId: "asc" },
    });
    assert.deepEqual(
      work.map((row) => [row.sourceId, row.powerupType, row.capturedDeltaSteps]).sort(),
      [
        [timed.id, "RUNNERS_HIGH", 1000],
        [leech.id, "LEECH", -200],
        [hitchhike.id, "HITCHHIKE", 400],
      ].sort(),
    );
    assert.ok(work.every((row) => row.status === "PENDING"));
  });

  it("freezes recipient-scoped active impact work in the team-forfeit transaction", async () => {
    const runner = await createTestUser({ displayName: "Team Runner" });
    const forfeiter = await createTestUser({ displayName: "Team Forfeiter" });
    const teammate = await createTestUser({ displayName: "Team Survivor" });
    const race = await createRaceWithParticipants([runner, forfeiter, teammate], "ACTIVE", {
      isTeamRace: true,
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
      data: { team: "TEAM_A" },
    });
    const forfeiterParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: forfeiter.user.id } },
      data: { team: "TEAM_B" },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: teammate.user.id } },
      data: { team: "TEAM_B" },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: forfeiterParticipant.id,
      userId: forfeiter.user.id, type: "RUNNERS_HIGH", rarity: "RARE",
      status: "USED", earnedAtSteps: 920001,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: forfeiterParticipant.id,
      targetUserId: forfeiter.user.id, sourceUserId: forfeiter.user.id,
      powerupId: powerup.id, type: "RUNNERS_HIGH", status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    const response = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
      token: forfeiter.token,
      body: {},
    });
    assert.equal(response.status, 200);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: {
        raceId: race.id,
        recipientUserId: forfeiter.user.id,
        sourceId: effect.id,
        status: "PENDING",
      },
    }), 1);
  });

  it("rolls back a forfeit when its recipient work insert fails", async () => {
    const creator = await createTestUser({ displayName: "Atomic Creator" });
    const leaver = await createTestUser({ displayName: "Atomic Leaver" });
    const race = await createRaceWithParticipants([creator, leaver], "ACTIVE", {
      exitActionsEnabled: true,
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: leaver.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: participant.id, userId: leaver.user.id,
      type: "RUNNERS_HIGH", rarity: "RARE", status: "USED", earnedAtSteps: 930001,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: participant.id,
      targetUserId: leaver.user.id, sourceUserId: leaver.user.id,
      powerupId: powerup.id, type: "RUNNERS_HIGH", status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_active_impact_work()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected active work failure'; END $$;
      CREATE TRIGGER test_fail_active_impact_work_trigger
      BEFORE INSERT ON active_race_impact_work
      FOR EACH ROW EXECUTE FUNCTION test_fail_active_impact_work();
    `);
    try {
      const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
        token: leaver.token,
        headers: { "X-Client-Features": "race_leave,active_impact_notices_v1" },
        body: {},
      });
      assert.equal(response.status, 500);
      const unchanged = await prisma.raceParticipant.findUnique({ where: { id: participant.id } });
      assert.equal(unchanged.forfeitedAt, null);
      assert.equal(await prisma.activeRaceImpactWork.count({ where: { raceId: race.id } }), 0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_active_impact_work_trigger ON active_race_impact_work;
        DROP FUNCTION IF EXISTS test_fail_active_impact_work();
      `);
    }
  });

  it("does not backfill a timed effect resolved while the active flag was off", async () => {
    const runner = await createTestUser({ displayName: "Flagged Runner" });
    const rival = await createTestUser({ displayName: "Flagged Rival" });
    const race = await createRaceWithParticipants([runner, rival]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900003,
    } });
    const skippedEffect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 20 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const firstSync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 1000,
      }] },
    });
    assert.equal(firstSync.status, 200);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    const progress = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress`,
      { token: runner.token },
    );
    assert.equal(progress.status, 200);
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: skippedEffect.id } })).status,
      "EXPIRED",
    );
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: skippedEffect.id },
    }), 0);

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const secondSync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(secondSync.status, 200);
    assert.ok(await worker.processOne());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: skippedEffect.id },
    }), 0, "enabling later must not backfill a source resolved while disabled");

    const eligiblePowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900004,
    } });
    const eligibleEffect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: eligiblePowerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 25 * 60 * 1000),
      // This source resolves after the enable transition. Backdating its
      // boundary before the durable enable epoch would correctly classify it
      // as an off-period boundary even though the fixture inserted it later.
      expiresAt: new Date(),
      metadata: { multiplier: 2 },
    } });
    const thirdSync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
        steps: 200,
      }] },
    });
    assert.equal(thirdSync.status, 200);
    assert.ok(await worker.processOne());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: eligibleEffect.id },
    }), 1, "a newly resolved source is eligible after the flag is enabled");
  });

  it("always stamps due boundaries while delivery is off, even without a race open", async () => {
    const runner = await createTestUser({ displayName: "Dormant Runner" });
    const race = await createRaceWithParticipants([runner]);
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "COMMON",
      status: "USED",
      earnedAtSteps: 980001,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 70 * 60 * 1000),
      expiresAt: new Date(Date.now() - 10 * 60 * 1000),
      metadata: {},
    } });
    await appSettings.setFlagsAtomically([["apiActiveImpactNoticesV1Enabled", false]]);
    const stamp = buildActiveImpactBoundaryStamp({ prisma, appSettings });
    assert.equal((await stamp()).count, 1);
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } }))
        .metadata.activeImpactResolutionSkippedVersion,
      1,
    );

    await appSettings.setFlagsAtomically([["apiActiveImpactNoticesV1Enabled", true]]);
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        steps: 500,
      }] },
    });
    assert.equal(sync.status, 200);
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0, logger: { log() {}, error() {} } });
    assert.ok(await worker.processOne());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 0);
  });

  it("retains active presentation for 30 days, deletes only aged processed work, and honors its kill switch", async () => {
    const runner = await createTestUser({ displayName: "Retention Runner" });
    const race = await createRaceWithParticipants([runner]);
    const oldWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "old-active-source",
      powerupType: "PROTEIN_SHAKE",
      status: "CREATED",
      resolvedAt: new Date(Date.now() - 40 * 86400000),
      processedGeneration: 1,
    } });
    await prisma.activeRaceEffectImpact.create({ data: {
      raceId: race.id,
      userId: runner.user.id,
      workId: oldWork.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "old-active-source",
      powerupType: "PROTEIN_SHAKE",
      deltaSteps: 100,
      sourceGeneration: 1,
      resolvedAt: oldWork.resolvedAt,
    } });
    const freshWork = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "fresh-active-source",
      powerupType: "PROTEIN_SHAKE",
      status: "CREATED",
      resolvedAt: new Date(),
      processedGeneration: 2,
    } });
    await prisma.raceEffectImpact.create({ data: {
      raceId: race.id,
      userId: runner.user.id,
      effectId: "final-impact-must-survive",
      powerupType: "RUNNERS_HIGH",
      deltaSteps: 100,
    } });
    await prisma.$executeRawUnsafe(
      `UPDATE active_race_impact_work SET updated_at = $2 WHERE id = $1`,
      oldWork.id,
      new Date(Date.now() - 31 * 86400000).toISOString(),
    );
    const retention = buildActiveImpactRetention({
      prisma,
      JobRun: { async lastRanFor() { return null; }, async claimRun() { return true; } },
      now: () => new Date(),
      logger: { log() {}, error() {} },
    });
    process.env.ACTIVE_RACE_IMPACT_RETENTION_DISABLED = "true";
    assert.equal(await retention(), null);
    assert.ok(await prisma.activeRaceImpactWork.findUnique({ where: { id: oldWork.id } }));
    delete process.env.ACTIVE_RACE_IMPACT_RETENTION_DISABLED;
    assert.equal((await retention()).count, 1);
    assert.equal(await prisma.activeRaceImpactWork.findUnique({ where: { id: oldWork.id } }), null);
    assert.ok(await prisma.activeRaceImpactWork.findUnique({ where: { id: freshWork.id } }));
    assert.equal(await prisma.raceEffectImpact.count({
      where: { raceId: race.id, effectId: "final-impact-must-survive" },
    }), 1);
  });

  it("creates durable Cleanse boundary work before the response and snapshots the clamped window", async () => {
    const attacker = await createTestUser({ displayName: "Cramp Attacker" });
    const runner = await createTestUser({ displayName: "Cleanse Runner" });
    const race = await createRaceWithParticipants([attacker, runner]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const runnerParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    await prisma.stepSample.create({ data: {
      userId: runner.user.id,
      periodStart: new Date(now.getTime() - 50 * 60 * 1000),
      periodEnd: new Date(now.getTime() - 40 * 60 * 1000),
      steps: 1000,
    } });
    const crampPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: runnerParticipant.id,
      userId: attacker.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900009,
    } });
    const cramp = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: runnerParticipant.id,
      targetUserId: runner.user.id,
      sourceUserId: attacker.user.id,
      powerupId: crampPowerup.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      metadata: { stepsAtFreezeStart: 0 },
    } });
    const cleanse = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: runnerParticipant.id,
      userId: runner.user.id,
      type: "CLEANSE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900010,
    } });
    const use = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${cleanse.id}/use`,
      { token: runner.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(use.status, 200);
    assert.equal((await use.json()).result.cleared, 1);
    const clamped = await prisma.raceActiveEffect.findUnique({ where: { id: cramp.id } });
    assert.equal(clamped.status, "EXPIRED");
    assert.ok(new Date(clamped.expiresAt) < new Date(now.getTime() + 5000));
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: cramp.id, status: "PENDING" },
    }), 1, "the request commits retryable work before returning");

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    const impact = await prisma.activeRaceEffectImpact.findFirst({
      where: { raceId: race.id, userId: runner.user.id, sourceId: cramp.id },
    });
    assert.equal(impact?.powerupType, "LEG_CRAMP");
    assert.equal(impact?.deltaSteps, -1000);
  });

  it("does not resolve Quick Rinse or Pocket Watch edits before the edited boundary", async () => {
    const attacker = await createTestUser({ displayName: "Boundary Attacker" });
    const runner = await createTestUser({ displayName: "Boundary Runner" });
    const race = await createRaceWithParticipants([attacker, runner]);
    const now = new Date();
    const [attackerParticipant, runnerParticipant] = await Promise.all([
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
      }),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
      }),
    ]);
    const source = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900020,
    } });
    const cramp = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: runnerParticipant.id,
      targetUserId: runner.user.id,
      sourceUserId: attacker.user.id,
      powerupId: source.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 10 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      metadata: { stepsAtFreezeStart: 0 },
    } });
    const rinse = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: runnerParticipant.id,
      userId: runner.user.id,
      type: "QUICK_RINSE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900021,
    } });
    const rinseUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${rinse.id}/use`,
      { token: runner.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(rinseUse.status, 200);
    const shortened = await prisma.raceActiveEffect.findUnique({ where: { id: cramp.id } });
    assert.equal(shortened.status, "ACTIVE");
    assert.ok(new Date(shortened.expiresAt) > now);
    assert.ok(new Date(shortened.expiresAt) < new Date(now.getTime() + 60 * 60 * 1000));
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: cramp.id },
    }), 0, "Quick Rinse changes only the future boundary");

    const watch = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "POCKET_WATCH",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900022,
    } });
    const shortenedExpiry = new Date(shortened.expiresAt);
    const watchUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${watch.id}/use`,
      {
        token: attacker.token,
        headers: ACTIVE_CAPABILITY,
        body: { targetEffectId: cramp.id },
      },
    );
    assert.equal(watchUse.status, 200);
    const extended = await prisma.raceActiveEffect.findUnique({ where: { id: cramp.id } });
    assert.equal(extended.status, "ACTIVE");
    assert.ok(new Date(extended.expiresAt) > shortenedExpiry);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: cramp.id },
    }), 0, "Pocket Watch changes only the future boundary");
  });

  it("creates early work for a true Wrong Turn clamp but not for a status-only Leg Cramp reset", async () => {
    const attacker = await createTestUser({ displayName: "Clamp Attacker" });
    const reflector = await createTestUser({ displayName: "Clamp Reflector" });
    const race = await createRaceWithParticipants([attacker, reflector]);
    const now = new Date();
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    const [attackerParticipant, reflectorParticipant] = await Promise.all([
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
      }),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: reflector.user.id } },
      }),
    ]);
    const oldCrampPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: reflectorParticipant.id,
      userId: reflector.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900030,
    } });
    const originalExpiry = new Date(now.getTime() + 60 * 60 * 1000);
    const oldCramp = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: attackerParticipant.id,
      targetUserId: attacker.user.id,
      sourceUserId: reflector.user.id,
      powerupId: oldCrampPowerup.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 30 * 60 * 1000),
      expiresAt: originalExpiry,
      metadata: { stepsAtFreezeStart: 0 },
    } });
    const mirrorPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: reflectorParticipant.id,
      userId: reflector.user.id,
      type: "MIRROR",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900031,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: reflectorParticipant.id,
      targetUserId: reflector.user.id,
      sourceUserId: reflector.user.id,
      powerupId: mirrorPowerup.id,
      type: "MIRROR",
      status: "ACTIVE",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    } });
    const replacementCramp = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900032,
    } });
    const resetUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${replacementCramp.id}/use`,
      {
        token: attacker.token,
        headers: ACTIVE_CAPABILITY,
        body: { targetUserId: reflector.user.id },
      },
    );
    assert.equal(resetUse.status, 200);
    const reset = await prisma.raceActiveEffect.findUnique({ where: { id: oldCramp.id } });
    assert.equal(reset.status, "EXPIRED");
    assert.equal(new Date(reset.expiresAt).getTime(), originalExpiry.getTime());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: oldCramp.id },
    }), 0, "a status-only reset keeps the original scoring boundary");
    await prisma.raceActiveEffect.updateMany({
      where: {
        raceId: race.id,
        targetParticipantId: attackerParticipant.id,
        type: "LEG_CRAMP",
        status: "ACTIVE",
      },
      data: { status: "EXPIRED" },
    });

    const secondOldCrampPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: reflectorParticipant.id,
      userId: reflector.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900033,
    } });
    const secondOldCramp = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: attackerParticipant.id,
      targetUserId: attacker.user.id,
      sourceUserId: reflector.user.id,
      powerupId: secondOldCrampPowerup.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 30 * 60 * 1000),
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      metadata: { stepsAtFreezeStart: 0 },
    } });
    const secondMirrorPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: reflectorParticipant.id,
      userId: reflector.user.id,
      type: "MIRROR",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900034,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: reflectorParticipant.id,
      targetUserId: reflector.user.id,
      sourceUserId: reflector.user.id,
      powerupId: secondMirrorPowerup.id,
      type: "MIRROR",
      status: "ACTIVE",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    } });
    const wrongTurn = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "WRONG_TURN",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900035,
    } });
    const clampUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${wrongTurn.id}/use`,
      {
        token: attacker.token,
        headers: ACTIVE_CAPABILITY,
        body: { targetUserId: reflector.user.id },
      },
    );
    assert.equal(clampUse.status, 200);
    const clamped = await prisma.raceActiveEffect.findUnique({ where: { id: secondOldCramp.id } });
    assert.equal(clamped.status, "EXPIRED");
    assert.ok(new Date(clamped.expiresAt) < new Date(now.getTime() + 5000));
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: secondOldCramp.id, status: "PENDING" },
    }), 1, "a true scoring-window clamp creates durable work immediately");

    await prisma.raceActiveEffect.update({
      where: { id: oldCramp.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await worker.processOne())) break;
    }
    const resetBoundaryWork = await prisma.activeRaceImpactWork.findMany({
      where: { raceId: race.id, sourceId: oldCramp.id },
    });
    assert.equal(resetBoundaryWork.length, 1);
    assert.ok(
      ["CREATED", "ZERO"].includes(resetBoundaryWork[0].status),
      "the status-only reset is processed once its stored boundary actually arrives",
    );
  });

  it("materializes the exact post-floor Trail Mine detonation for only its victim", async () => {
    const owner = await createTestUser({ displayName: "Mine Owner" });
    const victim = await createTestUser({ displayName: "Mine Victim" });
    const race = await createRaceWithParticipants([owner, victim]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const [ownerParticipant, victimParticipant] = await Promise.all([
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: owner.user.id } },
      }),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
      }),
    ]);
    await prisma.stepSample.create({ data: {
      userId: owner.user.id,
      periodStart: new Date(now.getTime() - 6 * 60 * 60 * 1000),
      periodEnd: new Date(now.getTime() - 5 * 60 * 60 * 1000),
      steps: 10_000,
    } });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: ownerParticipant.id,
      userId: owner.user.id,
      type: "TRAIL_MINE",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900005,
    } });
    const mine = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: ownerParticipant.id,
      targetUserId: owner.user.id,
      sourceUserId: owner.user.id,
      powerupId: powerup.id,
      type: "TRAIL_MINE",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 4 * 60 * 60 * 1000),
      expiresAt: null,
      metadata: {
        ownerParticipantId: ownerParticipant.id,
        positionSteps: 10_000,
        penaltyPercent: 0.03,
        aheadParticipantIds: [],
      },
    } });

    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: victim.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(),
        steps: 13_000,
      }] },
    });
    assert.equal(sync.status, 200);
    const failingWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
      processActiveRaceImpacts: async () => {
        throw Object.assign(new Error("injected Trail Mine presentation failure"), {
          code: "INJECTED_TRAIL_MINE_PRESENTATION_FAILURE",
        });
      },
    });
    assert.ok(await failingWorker.processOne());
    const durableMineWork = await prisma.activeRaceImpactWork.findFirst({
      where: { raceId: race.id, sourceId: mine.id, recipientUserId: victim.user.id },
    });
    assert.equal(durableMineWork?.status, "PENDING");
    assert.equal(durableMineWork?.capturedDeltaSteps, -390);
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: mine.id },
    }), 0);
    const pendingNotice = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: victim.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(pendingNotice.status, 202);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());

    const impact = await prisma.activeRaceEffectImpact.findUnique({
      where: {
        raceId_userId_sourceKind_sourceId_calculationVersion: {
          raceId: race.id,
          userId: victim.user.id,
          sourceKind: "ACTIVE_EFFECT",
          sourceId: mine.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(impact?.powerupType, "TRAIL_MINE");
    assert.equal(impact?.deltaSteps, -390);
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: mine.id },
    }), 1);
    assert.equal(
      (await prisma.raceParticipant.findUnique({ where: { id: victimParticipant.id } })).bonusSteps,
      -390,
    );
    const progressResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress`,
      { token: victim.token },
    );
    assert.equal(progressResponse.status, 200);
    const progress = (await progressResponse.json()).progress;
    assert.equal(
      progress.participants.find((entry) => entry.userId === victim.user.id).totalSteps,
      12_610,
    );

    const victimNotices = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: victim.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(victimNotices.status, 200);
    assert.deepEqual(
      (await victimNotices.json()).notices.map((notice) => [notice.powerupType, notice.deltaSteps]),
      [["TRAIL_MINE", -390]],
    );
    const ownerNotices = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.deepEqual(await ownerNotices.json(), { notices: [] });
  });

  it("materializes the exact committed Drill Sergeant penalty after judgement", async () => {
    const caster = await createTestUser({ displayName: "Drill Caster" });
    const target = await createTestUser({ displayName: "Drill Target" });
    const race = await createRaceWithParticipants([caster, target]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const targetParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: targetParticipant.id,
      userId: caster.user.id,
      type: "DRILL_SERGEANT",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900006,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "DRILL_SERGEANT",
      status: "ACTIVE",
      startsAt: new Date(now.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(now.getTime() - 5 * 60 * 1000),
      metadata: {
        goalSteps: 3000,
        penaltySteps: 1500,
        stepsAtStart: 0,
      },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: target.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(sync.status, 200);
    const failingWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
      processActiveRaceImpacts: async () => {
        throw Object.assign(new Error("injected Drill presentation failure"), {
          code: "INJECTED_DRILL_PRESENTATION_FAILURE",
        });
      },
    });
    assert.ok(await failingWorker.processOne());
    const durableWork = await prisma.activeRaceImpactWork.findFirst({
      where: { raceId: race.id, sourceId: effect.id, recipientUserId: target.user.id },
    });
    assert.equal(durableWork?.status, "PENDING");
    assert.equal(durableWork?.capturedDeltaSteps, -100);
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 0);
    const pending = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: target.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(pending.status, 202);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());

    const progress = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress`,
      { token: target.token },
    );
    assert.equal(progress.status, 200);
    const judged = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(judged.status, "EXPIRED");
    assert.equal(judged.metadata.activeImpactCalculationVersion, 1);
    assert.equal(judged.metadata.activeImpactDeltaSteps, -100);
    assert.equal(
      (await prisma.raceParticipant.findUnique({ where: { id: targetParticipant.id } })).bonusSteps,
      -100,
    );

    const handoff = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: target.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(handoff.status, 200);
    const notice = await prisma.activeRaceEffectImpact.findUnique({
      where: {
        raceId_userId_sourceKind_sourceId_calculationVersion: {
          raceId: race.id,
          userId: target.user.id,
          sourceKind: "ACTIVE_EFFECT",
          sourceId: effect.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(notice?.powerupType, "DRILL_SERGEANT");
    assert.equal(notice?.deltaSteps, -100);
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 1);
  });

  it("never backfills Drill Sergeant when judgement crosses while delivery is disabled", async () => {
    const caster = await createTestUser({ displayName: "Disabled Drill Caster" });
    const target = await createTestUser({ displayName: "Disabled Drill Target" });
    const race = await createRaceWithParticipants([caster, target]);
    const targetParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
      data: { totalSteps: 500, rawSteps: 500 },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: targetParticipant.id,
      userId: caster.user.id,
      type: "DRILL_SERGEANT",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 9000061,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "DRILL_SERGEANT",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { goalSteps: 3000, penaltySteps: 500, stepsAtStart: 0 },
    } });
    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: target.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(sync.status, 200);
    const disabledWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await disabledWorker.processOne());
    const judged = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(judged.status, "EXPIRED");
    assert.equal(judged.metadata.activeImpactResolutionSkippedVersion, 1);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 0);

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const resync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: target.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        steps: 50,
      }] },
    });
    assert.equal(resync.status, 200);
    const enabledWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await enabledWorker.processOne());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 0, "re-enable cannot discover a Drill judgement skipped while disabled");
  });

  it("routes a progress-discovered Drill boundary through C0 and lets a concurrent durable disable win", async () => {
    const caster = await createTestUser({ displayName: "Progress Drill Caster" });
    const target = await createTestUser({ displayName: "Progress Drill Target" });
    const race = await createRaceWithParticipants([caster, target], "ACTIVE", {
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    const targetParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
      data: { joinedAt: race.startedAt },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: targetParticipant.id,
      userId: caster.user.id, type: "DRILL_SERGEANT", rarity: "RARE",
      status: "USED", earnedAtSteps: 9000062,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id, sourceUserId: caster.user.id,
      powerupId: powerup.id, type: "DRILL_SERGEANT", status: "ACTIVE",
      startsAt: new Date(Date.now() - 70 * 60 * 1000),
      expiresAt: new Date(Date.now() - 1000),
      metadata: { goalSteps: 3000, penaltySteps: 500, stepsAtStart: 0 },
    } });
    await prisma.stepSample.create({ data: {
      userId: target.user.id,
      periodStart: new Date(Date.now() - 60 * 60 * 1000),
      periodEnd: new Date(Date.now() - 50 * 60 * 1000),
      steps: 100,
    } });

    assert.equal(await appSettings.getFlag("apiActiveImpactNoticesV1Enabled"), true);
    const locker = new Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let committed = false;
    let progressSettled = false;
    let progressPromise = null;
    try {
      await locker.query("BEGIN");
      const pid = Number((await locker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await locker.query(
        `SELECT key FROM app_settings
          WHERE key IN ('apiActiveImpactNoticesV1Enabled', 'apiActiveImpactNoticesV1EnabledFrom')
          ORDER BY key ASC FOR UPDATE`,
      );
      progressPromise = request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
        token: target.token,
      }).then((response) => {
        progressSettled = true;
        return response;
      });
      await waitUntilBlockedBy(pid);
      assert.equal(progressSettled, false, "progress awaits the race-keyed C0 fence");
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
        "ACTIVE",
        "the request cannot judge Drill outside C0 while its durable fence is blocked",
      );
      await locker.query(
        `UPDATE app_settings
            SET value = 'false'::jsonb, updated_at = CURRENT_TIMESTAMP
          WHERE key = 'apiActiveImpactNoticesV1Enabled'`,
      );
      await locker.query("COMMIT");
      committed = true;
      assert.equal((await progressPromise).status, 200);
    } finally {
      if (!committed) await locker.query("ROLLBACK").catch(() => {});
      await locker.end();
      if (progressPromise) await progressPromise.catch(() => {});
      appSettings.bustCache();
    }

    const judged = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(judged.status, "EXPIRED");
    assert.equal(judged.metadata.activeImpactResolutionSkippedVersion, 1);
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 0);
    assert.equal(
      (await prisma.raceParticipant.findUnique({ where: { id: targetParticipant.id } })).bonusSteps,
      -100,
    );
  });

  it("rolls back progress-enqueued Drill judgement when durable work insertion fails", async () => {
    const caster = await createTestUser({ displayName: "Rollback Drill Caster" });
    const target = await createTestUser({ displayName: "Rollback Drill Target" });
    const race = await createRaceWithParticipants([caster, target], "ACTIVE", {
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    const targetParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
      data: { joinedAt: race.startedAt },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: targetParticipant.id,
      userId: caster.user.id, type: "DRILL_SERGEANT", rarity: "RARE",
      status: "USED", earnedAtSteps: 9000063,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id, sourceUserId: caster.user.id,
      powerupId: powerup.id, type: "DRILL_SERGEANT", status: "ACTIVE",
      startsAt: new Date(Date.now() - 70 * 60 * 1000),
      expiresAt: new Date(Date.now() - 1000),
      metadata: { goalSteps: 3000, penaltySteps: 500, stepsAtStart: 0 },
    } });
    await prisma.stepSample.create({ data: {
      userId: target.user.id,
      periodStart: new Date(Date.now() - 60 * 60 * 1000),
      periodEnd: new Date(Date.now() - 50 * 60 * 1000),
      steps: 100,
    } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_progress_drill_work()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected progress Drill work failure'; END $$;
      CREATE TRIGGER test_fail_progress_drill_work_trigger
      BEFORE INSERT ON active_race_impact_work
      FOR EACH ROW EXECUTE FUNCTION test_fail_progress_drill_work();
    `);
    try {
      const progress = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
        token: target.token,
      });
      assert.equal(progress.status, 200);
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
        "ACTIVE",
      );
      const worker = buildRaceResolutionWorkerV2({
        bootAt: 0,
        logger: { log() {}, error() {} },
      });
      await worker.processOne();
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
        "ACTIVE",
        "effect judgement rolls back with failed durable source insertion",
      );
      assert.equal(
        (await prisma.raceParticipant.findUnique({ where: { id: targetParticipant.id } })).bonusSteps,
        0,
      );
      assert.equal(await prisma.activeRaceImpactWork.count({
        where: { raceId: race.id, sourceId: effect.id },
      }), 0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_progress_drill_work_trigger ON active_race_impact_work;
        DROP FUNCTION IF EXISTS test_fail_progress_drill_work();
      `);
    }
  });

  it("leaves progress-discovered Drill queued while the C0 claiming switch is disabled", async () => {
    const caster = await createTestUser({ displayName: "Paused Drill Caster" });
    const target = await createTestUser({ displayName: "Paused Drill Target" });
    const race = await createRaceWithParticipants([caster, target], "ACTIVE", {
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    const targetParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
      data: { joinedAt: race.startedAt },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: targetParticipant.id,
      userId: caster.user.id,
      type: "DRILL_SERGEANT",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 9000064,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: targetParticipant.id,
      targetUserId: target.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "DRILL_SERGEANT",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 70 * 60 * 1000),
      expiresAt: new Date(Date.now() - 1000),
      metadata: { goalSteps: 3000, penaltySteps: 500, stepsAtStart: 0 },
    } });
    await prisma.stepSample.create({ data: {
      userId: target.user.id,
      periodStart: new Date(Date.now() - 60 * 60 * 1000),
      periodEnd: new Date(Date.now() - 50 * 60 * 1000),
      steps: 100,
    } });

    await appSettings.setFlag("raceQueueV2ClaimingDisabled", true);
    const paused = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token: target.token,
    });
    assert.equal(paused.status, 200, "the emergency switch remains fail-soft for reads");
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
      "ACTIVE",
      "targeted progress processing must not bypass the global claiming switch",
    );
    assert.equal(
      (await prisma.raceParticipant.findUnique({ where: { id: targetParticipant.id } })).bonusSteps,
      0,
    );
    const queued = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: race.id },
    });
    assert.equal(queued?.state, "QUEUED");

    await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
    const resumed = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token: target.token,
    });
    assert.equal(resumed.status, 200);
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status,
      "EXPIRED",
    );
    assert.equal(
      (await prisma.raceParticipant.findUnique({ where: { id: targetParticipant.id } })).bonusSteps,
      -100,
    );
  });

  it("resolves an Umbrella notice at the intercepted Rainstorm loss boundary", async () => {
    const defender = await createTestUser({ displayName: "Umbrella Defender" });
    const attacker = await createTestUser({ displayName: "Rain Attacker" });
    const race = await createRaceWithParticipants([defender, attacker]);
    const now = new Date();
    const startedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const [defenderParticipant, attackerParticipant] = await Promise.all([
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: defender.user.id } },
      }),
      prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
      }),
    ]);
    const umbrellaPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: defenderParticipant.id,
      userId: defender.user.id,
      type: "UMBRELLA",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900007,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: defenderParticipant.id,
      targetUserId: defender.user.id,
      sourceUserId: defender.user.id,
      powerupId: umbrellaPowerup.id,
      type: "UMBRELLA",
      status: "ACTIVE",
      startsAt: now,
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    } });
    const rainstorm = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "RAINSTORM",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 900008,
    } });
    const cast = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${rainstorm.id}/use`,
      { token: attacker.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(cast.status, 200);
    const defense = await prisma.racePowerupEvent.findFirst({
      where: {
        raceId: race.id,
        actorUserId: attacker.user.id,
        targetUserId: defender.user.id,
        powerupType: "UMBRELLA",
      },
    });
    assert.equal(defense.metadata.activeImpactDefenseCalculationVersion, 1);
    assert.equal(defense.metadata.hiddenFromFeed, true);
    await prisma.racePowerupEvent.update({
      where: { id: defense.id },
      data: { metadata: {
        ...defense.metadata,
        activeImpactDefenseWindowStart: new Date(now.getTime() - 70 * 60 * 1000).toISOString(),
        activeImpactDefenseWindowEnd: new Date(now.getTime() - 40 * 60 * 1000).toISOString(),
      } },
    });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: defender.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 1000,
      }] },
    });
    assert.equal(sync.status, 200);
    let uploadedLate = false;
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
      beforeWriteTransaction: async () => {
        if (uploadedLate) return;
        uploadedLate = true;
        const late = await request(server.baseUrl, "POST", "/steps/samples", {
          token: defender.token,
          body: { samples: [{
            periodStart: new Date(now.getTime() - 49 * 60 * 1000).toISOString(),
            periodEnd: new Date(now.getTime() - 45 * 60 * 1000).toISOString(),
            steps: 1000,
          }] },
        });
        assert.equal(late.status, 200);
      },
    });
    assert.ok(await worker.processOne());
    const impact = await prisma.activeRaceEffectImpact.findUnique({
      where: {
        raceId_userId_sourceKind_sourceId_calculationVersion: {
          raceId: race.id,
          userId: defender.user.id,
          sourceKind: "DEFENSE_RESOLUTION",
          sourceId: defense.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(impact?.powerupType, "UMBRELLA");
    assert.equal(impact?.deltaSteps, 500);
    await worker.processOne();
    assert.equal((await prisma.activeRaceEffectImpact.findUnique({
      where: { id: impact.id },
    })).deltaSteps, 500, "a newer generation cannot mutate the captured snapshot");
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: defense.id },
    }), 1);
  });

  it("never backfills an Umbrella interception whose boundary crosses while disabled", async () => {
    const defender = await createTestUser({ displayName: "Disabled Umbrella Defender" });
    const attacker = await createTestUser({ displayName: "Disabled Rain Attacker" });
    const race = await createRaceWithParticipants([defender, attacker]);
    const defenderParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: defender.user.id } },
    });
    const umbrellaPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: defenderParticipant.id,
      userId: defender.user.id,
      type: "UMBRELLA",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 9000081,
    } });
    const futureEnd = new Date(Date.now() + 60 * 60 * 1000);
    const umbrella = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: defenderParticipant.id,
      targetUserId: defender.user.id,
      sourceUserId: defender.user.id,
      powerupId: umbrellaPowerup.id,
      type: "UMBRELLA",
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt: futureEnd,
    } });
    const defense = await prisma.racePowerupEvent.create({ data: {
      raceId: race.id,
      actorUserId: attacker.user.id,
      eventType: "POWERUP_USED",
      powerupType: "RAINSTORM",
      targetUserId: defender.user.id,
      description: "Umbrella interception crossing while disabled",
      metadata: {
        hiddenFromFeed: true,
        activeImpactDefenseCalculationVersion: 1,
        activeImpactDefenseType: "UMBRELLA",
        activeImpactDefenseTargetUserId: defender.user.id,
        activeImpactDefenseEffectId: umbrella.id,
        activeImpactDefenseWindowStart: new Date().toISOString(),
        activeImpactDefenseWindowEnd: futureEnd.toISOString(),
        activeImpactDefenseMultiplier: 0.5,
      },
    } });

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const crossedAt = new Date(Date.now() - 1000);
    await prisma.raceActiveEffect.update({
      where: { id: umbrella.id },
      data: { expiresAt: crossedAt },
    });
    await prisma.racePowerupEvent.update({
      where: { id: defense.id },
      data: { metadata: {
        ...defense.metadata,
        activeImpactDefenseWindowStart: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        activeImpactDefenseWindowEnd: crossedAt.toISOString(),
      } },
    });
    const stamp = buildActiveImpactBoundaryStamp({
      prisma,
      appSettings,
      now: () => new Date(),
    });
    assert.ok((await stamp()).count >= 1);
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: umbrella.id } }))
        .metadata.activeImpactResolutionSkippedVersion,
      1,
    );

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: defender.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        steps: 1000,
      }] },
    });
    assert.equal(sync.status, 200);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal(await prisma.activeRaceImpactWork.count({
      where: { raceId: race.id, sourceKind: "DEFENSE_RESOLUTION", sourceId: defense.id },
    }), 0, "re-enable cannot discover an Umbrella boundary skipped while disabled");
  });

  it("persists a private Umbrella defense intent while off and resolves it when enabled before the boundary", async () => {
    const defender = await createTestUser({ displayName: "Off-cast Umbrella Defender" });
    const attacker = await createTestUser({ displayName: "Off-cast Rain Attacker" });
    const race = await createRaceWithParticipants([defender, attacker], "ACTIVE", {
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    const defenderParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: defender.user.id } },
    });
    const umbrellaPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: defenderParticipant.id,
      userId: defender.user.id, type: "UMBRELLA", rarity: "RARE",
      status: "USED", earnedAtSteps: 9000082,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: defenderParticipant.id,
      targetUserId: defender.user.id, sourceUserId: defender.user.id,
      powerupId: umbrellaPowerup.id, type: "UMBRELLA", status: "ACTIVE",
      startsAt: new Date(), expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    } });
    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", false);
    const rainstorm = await grantHeldPowerup(race.id, attacker.user.id, "RAINSTORM", 9000083);
    const cast = await usePowerupPublicly(attacker, race.id, rainstorm.id);
    assert.equal(cast.status, 200);
    const defense = await prisma.racePowerupEvent.findFirst({
      where: {
        raceId: race.id,
        targetUserId: defender.user.id,
        powerupType: "UMBRELLA",
        metadata: { path: ["activeImpactDefenseCalculationVersion"], equals: 1 },
      },
    });
    assert.ok(defense, "the private scoring intent exists independently of delivery state");
    assert.equal(defense.metadata.hiddenFromFeed, true);

    await appSettings.setFlag("apiActiveImpactNoticesV1Enabled", true);
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 20 * 60 * 1000);
    await prisma.racePowerupEvent.update({
      where: { id: defense.id },
      data: { metadata: {
        ...defense.metadata,
        activeImpactDefenseWindowStart: windowStart.toISOString(),
        activeImpactDefenseWindowEnd: windowEnd.toISOString(),
      } },
    });
    await prisma.stepSample.create({ data: {
      userId: defender.user.id,
      periodStart: new Date(windowStart.getTime() + 60 * 1000),
      periodEnd: new Date(windowEnd.getTime() - 60 * 1000),
      steps: 1000,
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: defender.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 50 * 1000).toISOString(),
        periodEnd: new Date(Date.now() - 40 * 1000).toISOString(),
        steps: 1,
      }] },
    });
    assert.equal(sync.status, 200);
    await drainActiveImpactWorker();
    const impact = await prisma.activeRaceEffectImpact.findUnique({
      where: {
        raceId_userId_sourceKind_sourceId_calculationVersion: {
          raceId: race.id,
          userId: defender.user.id,
          sourceKind: "DEFENSE_RESOLUTION",
          sourceId: defense.id,
          calculationVersion: 1,
        },
      },
    });
    assert.equal(impact?.powerupType, "UMBRELLA");
    assert.equal(impact?.deltaSteps, 500);
  });

  it("stamps direct effects server-side and honors actor receipt ack without suppressing victims", async () => {
    const actor = await createTestUser({ displayName: "Direct Actor" });
    const victim = await createTestUser({ displayName: "Direct Victim" });
    const race = await createRaceWithParticipants([actor, victim]);
    const actorParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: actor.user.id } },
    });
    const victimParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
      data: { totalSteps: 1200 },
    });
    const protein = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: actorParticipant.id,
      userId: actor.user.id,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 910001,
    } });
    const proteinUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${protein.id}/use`,
      { token: actor.token, headers: ACTIVE_CAPABILITY, body: {} },
    );
    assert.equal(proteinUse.status, 200);
    const proteinBody = await proteinUse.json();
    assert.equal(proteinBody.activeImpactReceipt.raceId, race.id);
    const proteinAck = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-receipts/${proteinBody.activeImpactReceipt.id}/acknowledge`,
      { token: actor.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(proteinAck.status, 200);

    const shortcut = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: actorParticipant.id,
      userId: actor.user.id,
      type: "SHORTCUT",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 910002,
    } });
    const shortcutUse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${shortcut.id}/use`,
      {
        token: actor.token,
        headers: ACTIVE_CAPABILITY,
        body: { targetUserId: victim.user.id },
      },
    );
    assert.equal(shortcutUse.status, 200);
    const shortcutBody = await shortcutUse.json();
    assert.equal(shortcutBody.result.stolen, 1000);
    assert.equal(shortcutBody.activeImpactReceipt.raceId, race.id);

    const stamped = await prisma.racePowerupEvent.findMany({
      where: { raceId: race.id, eventType: "POWERUP_USED" },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(
      stamped.map((event) => [
        event.powerupType,
        event.metadata.activeImpactCalculationVersion,
        event.metadata.activeImpactDeltas,
      ]),
      [
        ["PROTEIN_SHAKE", 1, [{ userId: actor.user.id, deltaSteps: 1500 }]],
        ["SHORTCUT", 1, [
          { userId: victim.user.id, deltaSteps: -1000 },
          { userId: actor.user.id, deltaSteps: 1000 },
        ]],
      ],
    );

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await worker.processOne())) break;
    }
    const impacts = await prisma.activeRaceEffectImpact.findMany({
      where: { raceId: race.id, sourceKind: "POWERUP_EVENT" },
      orderBy: [{ resolvedAt: "asc" }, { deltaSteps: "asc" }],
    });
    assert.equal(impacts.length, 3);
    const proteinImpact = impacts.find((row) => row.powerupType === "PROTEIN_SHAKE");
    assert.equal(proteinImpact.deltaSteps, 1500);
    assert.ok(proteinImpact.acknowledgedAt, "confirmed inline dismissal suppresses only this actor row");
    const shortcutImpacts = impacts.filter((row) => row.powerupType === "SHORTCUT");
    assert.deepEqual(
      shortcutImpacts.map((row) => [row.userId, row.deltaSteps, row.acknowledgedAt]),
      [
        [victim.user.id, -1000, null],
        [actor.user.id, 1000, null],
      ],
    );
    assert.equal(victimParticipant.userId, victim.user.id);
  });

  it("attributes a reflected Shortcut to its actual debit and credit recipients", async () => {
    const attacker = await createTestUser({ displayName: "Shortcut Attacker" });
    const defender = await createTestUser({ displayName: "Mirror Defender" });
    const race = await createRaceWithParticipants([attacker, defender]);
    const [attackerParticipant, defenderParticipant] = await Promise.all([
      prisma.raceParticipant.update({
        where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
        data: { totalSteps: 5000 },
      }),
      prisma.raceParticipant.update({
        where: { raceId_userId: { raceId: race.id, userId: defender.user.id } },
        data: { totalSteps: 5000 },
      }),
    ]);
    const mirrorPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: defenderParticipant.id,
      userId: defender.user.id, type: "MIRROR", rarity: "RARE",
      status: "USED", earnedAtSteps: 940001,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id, targetParticipantId: defenderParticipant.id,
      targetUserId: defender.user.id, sourceUserId: defender.user.id,
      powerupId: mirrorPowerup.id, type: "MIRROR", status: "ACTIVE",
      startsAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    const shortcut = await prisma.racePowerup.create({ data: {
      raceId: race.id, participantId: attackerParticipant.id,
      userId: attacker.user.id, type: "SHORTCUT", rarity: "RARE",
      status: "HELD", earnedAtSteps: 940002,
    } });
    const use = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${shortcut.id}/use`,
      {
        token: attacker.token,
        headers: ACTIVE_CAPABILITY,
        body: { targetUserId: defender.user.id },
      },
    );
    assert.equal(use.status, 200);
    assert.equal((await use.json()).result.outcome, "REFLECTED");
    const source = await prisma.racePowerupEvent.findFirst({
      where: {
        raceId: race.id,
        eventType: "POWERUP_USED",
        powerupType: "SHORTCUT",
        metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
      },
    });
    assert.deepEqual(
      [...source.metadata.activeImpactDeltas]
        .map((entry) => [entry.userId, entry.deltaSteps])
        .sort(),
      [
        [attacker.user.id, -1000],
        [defender.user.id, 1000],
      ].sort(),
    );
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    const impacts = await prisma.activeRaceEffectImpact.findMany({
      where: { raceId: race.id, sourceId: source.id },
      orderBy: { deltaSteps: "asc" },
    });
    assert.deepEqual(
      impacts.map((row) => [row.userId, row.deltaSteps]),
      [
        [attacker.user.id, -1000],
        [defender.user.id, 1000],
      ],
    );
  });

  it("covers every remaining timed-effect family through public powerup use and the real worker", async () => {
    const timedCases = [
      { type: "CAMPFIRE_REST", sampleOffsetMinutes: -20 },
      { type: "COIN_FLIP", sampleOffsetMinutes: -50 },
      { type: "GHOST_PEPPER", sampleOffsetMinutes: -50 },
      { type: "RAINSTORM", sampleOffsetMinutes: -50, sampleVictim: true },
      { type: "UPRISING", sampleOffsetMinutes: -50, teamRace: true, losingGate: true },
      { type: "RALLY_FLAG", sampleOffsetMinutes: -50, teamRace: true },
    ];

    for (let index = 0; index < timedCases.length; index += 1) {
      const scenario = timedCases[index];
      const runner = await createTestUser({ displayName: `${scenario.type} Runner` });
      const rival = await createTestUser({ displayName: `${scenario.type} Rival` });
      const now = new Date();
      const startedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const race = await createRaceWithParticipants([runner, rival], "ACTIVE", {
        startedAt,
        endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
        timezone: "UTC",
        isTeamRace: scenario.teamRace === true,
      });
      await prisma.raceParticipant.updateMany({
        where: { raceId: race.id },
        data: { joinedAt: startedAt },
      });
      if (scenario.teamRace) {
        await prisma.raceParticipant.update({
          where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
          data: { team: "TEAM_A", totalSteps: 0 },
        });
        await prisma.raceParticipant.update({
          where: { raceId_userId: { raceId: race.id, userId: rival.user.id } },
          data: { team: "TEAM_B", totalSteps: scenario.losingGate ? 5000 : 0 },
        });
        if (scenario.losingGate) {
          await prisma.stepSample.create({ data: {
            userId: rival.user.id,
            periodStart: new Date(now.getTime() - 90 * 60 * 1000),
            periodEnd: new Date(now.getTime() - 80 * 60 * 1000),
            steps: 5000,
          } });
        }
      }

      const held = await grantHeldPowerup(race.id, runner.user.id, scenario.type, 960000 + index);
      const used = await usePowerupPublicly(runner, race.id, held.id);
      assert.equal(used.status, 200, `${scenario.type} public use should succeed`);
      const effects = await prisma.raceActiveEffect.findMany({
        where: { raceId: race.id, powerupId: held.id, type: scenario.type },
      });
      assert.ok(effects.length >= 1, `${scenario.type} should create its real timed source`);

      const startsAt = new Date(now.getTime() - 70 * 60 * 1000);
      const expiresAt = new Date();
      for (const effect of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: effect.id },
          data: { startsAt, expiresAt },
        });
      }
      const sampleStart = new Date(now.getTime() + scenario.sampleOffsetMinutes * 60 * 1000);
      await prisma.stepSample.create({ data: {
        userId: scenario.sampleVictim ? rival.user.id : runner.user.id,
        periodStart: sampleStart,
        periodEnd: new Date(sampleStart.getTime() + 10 * 60 * 1000),
        steps: 1000,
      } });
      await drainActiveImpactWorker();

      const sourceIds = effects.map((effect) => effect.id);
      const work = await prisma.activeRaceImpactWork.findMany({
        where: { raceId: race.id, sourceId: { in: sourceIds }, powerupType: scenario.type },
      });
      assert.equal(work.length, effects.length, `${scenario.type} should freeze each public source once`);
      assert.ok(work.every((row) => row.status === "CREATED"), `${scenario.type} should be nonzero`);
      assert.equal(await prisma.activeRaceEffectImpact.count({
        where: { raceId: race.id, sourceId: { in: sourceIds }, powerupType: scenario.type },
      }), effects.length);
    }

    const caster = await createTestUser({ displayName: "Quicksand Caster" });
    const blocked = await createTestUser({ displayName: "Quicksand Blocked" });
    const applied = await createTestUser({ displayName: "Quicksand Applied" });
    const now = new Date();
    const startedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const race = await createRaceWithParticipants([caster, blocked, applied], "ACTIVE", {
      startedAt,
      endsAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    await prisma.raceParticipant.updateMany({ where: { raceId: race.id }, data: { joinedAt: startedAt } });
    const socks = await grantHeldPowerup(race.id, blocked.user.id, "COMPRESSION_SOCKS", 960100);
    assert.equal((await usePowerupPublicly(blocked, race.id, socks.id)).status, 200);
    const sand = await grantHeldPowerup(race.id, caster.user.id, "QUICKSAND", 960101);
    const sandUse = await usePowerupPublicly(caster, race.id, sand.id, {
      targetUserIds: [blocked.user.id, applied.user.id],
    });
    assert.equal(sandUse.status, 200);
    const sandResult = (await sandUse.json()).result;
    assert.equal(sandResult.outcome, "PARTIAL");
    assert.deepEqual(
      sandResult.targetResults.map((entry) => [entry.targetUserId, entry.outcome]),
      [[blocked.user.id, "BLOCKED"], [applied.user.id, "APPLIED"]],
    );
    const sandEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId: race.id, powerupId: sand.id, type: "QUICKSAND" },
    });
    assert.equal(await prisma.raceActiveEffect.count({
      where: { raceId: race.id, powerupId: sand.id, type: "QUICKSAND" },
    }), 1, "the blocked target has no effect source");
    await prisma.raceActiveEffect.update({
      where: { id: sandEffect.id },
      data: {
        startsAt: new Date(now.getTime() - 60 * 60 * 1000),
        expiresAt: new Date(),
      },
    });
    await prisma.stepSample.create({ data: {
      userId: applied.user.id,
      periodStart: new Date(now.getTime() - 50 * 60 * 1000),
      periodEnd: new Date(now.getTime() - 40 * 60 * 1000),
      steps: 1000,
    } });
    await drainActiveImpactWorker();
    const sandWork = await prisma.activeRaceImpactWork.findFirst({
      where: { raceId: race.id, sourceId: sandEffect.id, powerupType: "QUICKSAND" },
    });
    assert.equal(sandWork?.status, "CREATED");
    assert.equal((await prisma.activeRaceEffectImpact.findFirst({
      where: { raceId: race.id, sourceId: sandEffect.id },
    }))?.deltaSteps, -1000);
  });

  it("covers the remaining direct-effect families through public powerup use", async () => {
    const runner = await createTestUser({ displayName: "Direct Matrix Runner" });
    const leader = await createTestUser({ displayName: "Direct Matrix Leader" });
    const race = await createRaceWithParticipants([runner, leader]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
      data: { totalSteps: 1000 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: leader.user.id } },
      data: { totalSteps: 10000 },
    });

    const uses = [
      ["RED_CARD", {}],
      ["PINECONE_TOSS", { targetDirection: "FRONT" }],
      ["SECOND_WIND", {}],
      ["TRAIL_MIX", {}],
    ];
    for (let index = 0; index < uses.length; index += 1) {
      const [type, body] = uses[index];
      const held = await grantHeldPowerup(race.id, runner.user.id, type, 961000 + index);
      const response = await usePowerupPublicly(runner, race.id, held.id, body);
      assert.equal(response.status, 200, `${type} public use should succeed`);
    }
    await drainActiveImpactWorker();

    const stamped = await prisma.racePowerupEvent.findMany({
      where: {
        raceId: race.id,
        powerupType: { in: uses.map(([type]) => type) },
        metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
      },
    });
    assert.deepEqual(
      new Set(stamped.map((event) => event.powerupType)),
      new Set(uses.map(([type]) => type)),
    );
    const impactTypes = await prisma.activeRaceEffectImpact.findMany({
      where: { raceId: race.id, sourceKind: "POWERUP_EVENT" },
      select: { powerupType: true },
    });
    assert.deepEqual(
      new Set(impactTypes.map((row) => row.powerupType)),
      new Set(uses.map(([type]) => type)),
    );

    const socks = await grantHeldPowerup(race.id, leader.user.id, "COMPRESSION_SOCKS", 961100);
    assert.equal((await usePowerupPublicly(leader, race.id, socks.id)).status, 200);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: leader.user.id } },
      data: { totalSteps: 100000 },
    });
    const workBefore = await prisma.activeRaceImpactWork.count({ where: { raceId: race.id } });
    const stampedBefore = await prisma.racePowerupEvent.count({
      where: {
        raceId: race.id,
        powerupType: "PINECONE_TOSS",
        metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
      },
    });
    const blockedPinecone = await grantHeldPowerup(race.id, runner.user.id, "PINECONE_TOSS", 961101);
    const blockedUse = await usePowerupPublicly(runner, race.id, blockedPinecone.id, {
      targetDirection: "FRONT",
    });
    const blockedBody = await blockedUse.json();
    assert.equal(blockedUse.status, 200, JSON.stringify(blockedBody));
    assert.equal(blockedBody.result.outcome, "BLOCKED");
    assert.equal(await prisma.activeRaceImpactWork.count({ where: { raceId: race.id } }), workBefore);
    assert.equal(await prisma.racePowerupEvent.count({
      where: {
        raceId: race.id,
        powerupType: "PINECONE_TOSS",
        metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
      },
    }), stampedBefore, "a blocked direct attack has no eligible durable source");
  });

  it("covers positive, offensive, and blocked Mystery Potion variants through public use", async () => {
    const caster = await createTestUser({ displayName: "Potion Matrix Caster" });
    const victim = await createTestUser({ displayName: "Potion Matrix Victim" });
    const race = await createRaceWithParticipants([caster, victim]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: caster.user.id } },
      data: { totalSteps: 5000 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
      data: { totalSteps: 100000 },
    });

    const wantedOffense = new Set(["PINECONE_TOSS", "SHORTCUT"]);
    let sawPositive = false;
    let sawOffense = false;
    for (let attempt = 0; attempt < 80 && (!sawPositive || !sawOffense); attempt += 1) {
      const potion = await grantHeldPowerup(race.id, caster.user.id, "MYSTERY_POTION", 962000 + attempt);
      const response = await usePowerupPublicly(caster, race.id, potion.id);
      assert.equal(response.status, 200, `Mystery Potion cast ${attempt} should succeed`);
      const result = (await response.json()).result;
      if (result.rolled === "PROTEIN_SHAKE") sawPositive = true;
      if (wantedOffense.has(result.rolled) && result.blocked !== true) sawOffense = true;
    }
    assert.equal(sawPositive, true, "the public path should exercise a positive potion roll");
    assert.equal(sawOffense, true, "the public path should exercise an offensive potion roll");
    await drainActiveImpactWorker();
    const stamped = await prisma.racePowerupEvent.findMany({
      where: {
        raceId: race.id,
        powerupType: "MYSTERY_POTION",
        metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
      },
    });
    const resolvedTypes = new Set(stamped.map((event) => event.metadata.activeImpactPowerupType));
    assert.ok(resolvedTypes.has("PROTEIN_SHAKE"));
    assert.ok([...wantedOffense].some((type) => resolvedTypes.has(type)));
    const potionWork = await prisma.activeRaceImpactWork.findMany({
      where: { raceId: race.id, sourceKind: "POWERUP_EVENT" },
      select: { powerupType: true },
    });
    assert.ok(potionWork.some((row) => row.powerupType === "PROTEIN_SHAKE"));
    assert.ok(potionWork.some((row) => wantedOffense.has(row.powerupType)));

    const blockedCaster = await createTestUser({ displayName: "Blocked Potion Caster" });
    const shieldedVictim = await createTestUser({ displayName: "Blocked Potion Victim" });
    const blockedRace = await createRaceWithParticipants([blockedCaster, shieldedVictim]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: blockedRace.id, userId: shieldedVictim.user.id } },
      data: { totalSteps: 100000 },
    });
    const socks = await grantHeldPowerup(blockedRace.id, shieldedVictim.user.id, "COMPRESSION_SOCKS", 963000);
    assert.equal((await usePowerupPublicly(shieldedVictim, blockedRace.id, socks.id)).status, 200);
    let blockedAttack = false;
    for (let attempt = 0; attempt < 80 && !blockedAttack; attempt += 1) {
      const potion = await grantHeldPowerup(blockedRace.id, blockedCaster.user.id, "MYSTERY_POTION", 963100 + attempt);
      const workBefore = await prisma.activeRaceImpactWork.count({ where: { raceId: blockedRace.id } });
      const stampedBefore = await prisma.racePowerupEvent.count({
        where: {
          raceId: blockedRace.id,
          powerupType: "MYSTERY_POTION",
          metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
        },
      });
      const response = await usePowerupPublicly(blockedCaster, blockedRace.id, potion.id);
      assert.equal(response.status, 200, `blocked Mystery Potion cast ${attempt} should succeed`);
      const result = (await response.json()).result;
      if (result.blocked === true) {
        blockedAttack = true;
        assert.ok(["PINECONE_TOSS", "SHORTCUT", "LEG_CRAMP"].includes(result.rolled));
        assert.equal(await prisma.activeRaceImpactWork.count({ where: { raceId: blockedRace.id } }), workBefore);
        assert.equal(await prisma.racePowerupEvent.count({
          where: {
            raceId: blockedRace.id,
            powerupType: "MYSTERY_POTION",
            metadata: { path: ["activeImpactCalculationVersion"], equals: 1 },
          },
        }), stampedBefore, "a blocked potion attack creates no direct eligible source");
      }
    }
    assert.equal(blockedAttack, true, "the public path should exercise a blocked potion attack");
  });

  it("nets duplicate direct-effect entries for one recipient before deciding ZERO", async () => {
    const runner = await createTestUser({ displayName: "Reflected Runner" });
    const race = await createRaceWithParticipants([runner]);
    const event = await prisma.racePowerupEvent.create({
      data: {
        raceId: race.id,
        actorUserId: runner.user.id,
        eventType: "POWERUP_USED",
        powerupType: "MYSTERY_POTION",
        description: "A reflected transfer resolved back onto the same runner.",
        metadata: {
          activeImpactCalculationVersion: 1,
          activeImpactPowerupType: "SHORTCUT",
          activeImpactDeltas: [
            { userId: runner.user.id, deltaSteps: -500 },
            { userId: runner.user.id, deltaSteps: 500 },
          ],
        },
      },
    });
    await prisma.activeRaceImpactWork.create({
      data: {
        raceId: race.id,
        recipientUserId: runner.user.id,
        sourceKind: "POWERUP_EVENT",
        sourceId: event.id,
        powerupType: "SHORTCUT",
        status: "PENDING",
        resolvedAt: event.createdAt,
      },
    });

    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: {
        samples: [{
          periodStart: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          periodEnd: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          steps: 100,
        }],
      },
    });
    assert.equal(sync.status, 200);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());

    const work = await prisma.activeRaceImpactWork.findFirst({
      where: { raceId: race.id, sourceId: event.id },
    });
    assert.equal(work.status, "ZERO");
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { raceId: race.id, sourceId: event.id },
    }), 0);
  });

  it("commits race resolution when impact materialization fails and retries pending work later", async () => {
    const runner = await createTestUser({ displayName: "Retry Runner" });
    const race = await createRaceWithParticipants([runner]);
    const raceStartedAt = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: { startedAt: raceStartedAt, timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: raceStartedAt },
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const source = await prisma.racePowerupEvent.create({ data: {
      raceId: race.id,
      actorUserId: runner.user.id,
      eventType: "POWERUP_USED",
      powerupType: "PROTEIN_SHAKE",
      description: "Retryable active impact source",
      metadata: {
        activeImpactCalculationVersion: 1,
        activeImpactPowerupType: "PROTEIN_SHAKE",
        activeImpactDeltas: [{ userId: runner.user.id, deltaSteps: 1500 }],
      },
    } });
    const work = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: source.id,
      powerupType: "PROTEIN_SHAKE",
      status: "PENDING",
      resolvedAt: source.createdAt,
    } });
    const now = new Date();
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(now.getTime() - 20 * 60 * 1000).toISOString(),
        periodEnd: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
        steps: 1000,
      }] },
    });
    assert.equal(sync.status, 200);
    const errors = [];
    const failingWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error(message) { errors.push(String(message)); } },
      processActiveRaceImpacts: async () => {
        const error = new Error("injected presentation write failure");
        error.code = "INJECTED_PRESENTATION_FAILURE";
        throw error;
      },
    });
    assert.ok(await failingWorker.processOne());
    const committedParticipant = await prisma.raceParticipant.findUnique({
      where: { id: participant.id },
    });
    assert.equal(committedParticipant.totalSteps, 1000);
    assert.equal(
      (await prisma.activeRaceImpactWork.findUnique({ where: { id: work.id } })).status,
      "PENDING",
    );
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: { workId: work.id },
    }), 0);
    assert.ok(errors.some((line) => line.includes("retryable_failure")));

    const handoff = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: runner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(handoff.status, 202);
    const retryWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await retryWorker.processOne());
    const impact = await prisma.activeRaceEffectImpact.findUnique({
      where: { workId: work.id },
    });
    assert.equal(impact?.deltaSteps, 1500);
    assert.equal(
      (await prisma.activeRaceImpactWork.findUnique({ where: { id: work.id } })).status,
      "CREATED",
    );
  });

  it("deduplicates one immutable impact when two workers race the same source", async () => {
    const runner = await createTestUser({ displayName: "Concurrent Runner" });
    const race = await createRaceWithParticipants([runner]);
    const source = await prisma.racePowerupEvent.create({ data: {
      raceId: race.id,
      actorUserId: runner.user.id,
      eventType: "POWERUP_USED",
      powerupType: "SECOND_WIND",
      description: "Concurrent active impact source",
      metadata: {
        activeImpactCalculationVersion: 1,
        activeImpactPowerupType: "SECOND_WIND",
        activeImpactDeltas: [{ userId: runner.user.id, deltaSteps: 750 }],
      },
    } });
    await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: source.id,
      powerupType: "SECOND_WIND",
      status: "PENDING",
      resolvedAt: source.createdAt,
    } });
    const handoff = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: runner.token, headers: ACTIVE_CAPABILITY },
    );
    assert.equal(handoff.status, 202);
    const workers = [0, 1].map(() => buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    }));
    await Promise.all(workers.map((worker) => worker.processOne()));
    assert.equal(await prisma.activeRaceEffectImpact.count({
      where: {
        raceId: race.id,
        userId: runner.user.id,
        sourceId: source.id,
      },
    }), 1);
    const impact = await prisma.activeRaceEffectImpact.findFirst({
      where: { raceId: race.id, userId: runner.user.id, sourceId: source.id },
    });
    assert.equal(impact.deltaSteps, 750);
  });

  it("omits an existing all-zero 2x summary from both Home builders and preserves mixed net-zero", async () => {
    const user = await createTestUser();
    await appSettings.setFlagsAtomically([
      ["apiImpactSummariesEnabled", true],
      ["apiHomeShellV1Enabled", true],
      ["redisCacheHomeImpactSummaryEnabled", false],
    ]);
    const event = await prisma.globalStepEvent.create({ data: {
      startsAt: new Date(Date.now() - 120_000),
      endsAt: new Date(Date.now() - 60_000),
      multiplier: 2,
    } });
    const raceA = await createRaceWithParticipants([user], "COMPLETED");
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id,
      raceId: raceA.id,
      userId: user.user.id,
      status: "FINAL",
      deltaSteps: 0,
      settledAt: new Date(),
    } });
    const allZero = await prisma.globalEventUserSummary.create({ data: {
      eventId: event.id,
      userId: user.user.id,
      extraRaceSteps: 0,
      raceCount: 1,
    } });

    for (const features of ["impact_summaries", "impact_summaries,home_shell_v1"]) {
      const response = await request(server.baseUrl, "GET", "/home/race-card", {
        token: user.token,
        headers: { "X-Client-Features": features },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).globalEventSummary, undefined);
    }

    const raceB = await createRaceWithParticipants([user], "COMPLETED");
    await prisma.globalEventRaceImpact.createMany({ data: [
      {
        eventId: event.id, raceId: raceA.id, userId: user.user.id,
        status: "FINAL", deltaSteps: 100, settledAt: new Date(),
      },
      {
        eventId: event.id, raceId: raceB.id, userId: user.user.id,
        status: "FINAL", deltaSteps: -100, settledAt: new Date(),
      },
    ], skipDuplicates: true });
    await prisma.globalEventRaceImpact.update({
      where: { eventId_raceId_userId: { eventId: event.id, raceId: raceA.id, userId: user.user.id } },
      data: { deltaSteps: 100 },
    });

    const eligible = await request(server.baseUrl, "GET", "/home/race-card", {
      token: user.token,
      headers: { "X-Client-Features": "impact_summaries" },
    });
    assert.equal(eligible.status, 200);
    assert.equal((await eligible.json()).globalEventSummary.id, allZero.id);
  });
});
