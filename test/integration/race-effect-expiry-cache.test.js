const { appSettings } = require("../../src/shared/config/appSettings");
process.env.NODE_ENV = "production";
process.env.STEPS_PROCESS_ROLE = "http";
process.env.DATABASE_POOL_MAX_HTTP = "10";
process.env.CACHE_ENV_PREFIX = `t:expiry-cache:${require("node:crypto").randomUUID()}:`;
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { startTestRedis } = require("./redisTestServer");
const redis = require("../../src/shared/cache/redisCache");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRaceResolutionPostTaskRunner,
} = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");
const {
  buildRaceEffectDeadlineScheduler,
} = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
let server, liveRedis;
async function fixture({ team = false, type = "FANNY_PACK" } = {}) {
  const viewer = await createTestUser();
  const race = await prisma.race.create({
    data: {
      creatorId: viewer.user.id,
      name: "Expiry cache",
      targetSteps: 200000,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 3600000),
      endsAt: new Date(Date.now() + 86400000),
      timezone: "UTC",
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      isTeamRace: team,
      teamSize: team ? 2 : null,
    },
  });
  const p = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId: viewer.user.id,
      status: "ACCEPTED",
      nextBoxAtSteps: 5000,
      team: team ? "TEAM_A" : null,
    },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: p.id,
      userId: viewer.user.id,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  let actor = viewer;
  if (type === "LEG_CRAMP") {
    actor = await createTestUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: actor.user.id,
        status: "ACCEPTED",
        nextBoxAtSteps: 5000,
      },
    });
    const owner = await prisma.raceParticipant.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: actor.user.id } },
    });
    await prisma.racePowerup.update({
      where: { id: powerup.id },
      data: { userId: actor.user.id, participantId: owner.id },
    });
  }
  const used = await request(
    server.baseUrl,
    "POST",
    `/races/${race.id}/powerups/${powerup.id}/use`,
    {
      token: actor.token,
      body: type === "LEG_CRAMP" ? { targetUserId: viewer.user.id } : {},
      headers: { "X-Client-Features": "powerups3,powerups4,powerups5" },
    },
  );
  assert.equal(used.status, 200, JSON.stringify(await used.json()));
  const effect = await prisma.raceActiveEffect.findFirstOrThrow({
    where: { powerupId: powerup.id },
  });
  return { viewer, race, effect };
}
async function read(f, query = "") {
  const r = await request(
    server.baseUrl,
    "GET",
    `/races/${f.race.id}/progress${query}`,
    {
      token: f.viewer.token,
      headers: {
        "X-App-Version": "99.0.0",
        "X-Client-Features":
          "characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging",
        "X-Timezone": "UTC",
      },
    },
  );
  assert.equal(r.status, 200);
  return r.json();
}
async function drain(f) {
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    processRole: "resolution",
  });
  const post = buildRaceResolutionPostTaskRunner();
  for (let i = 0; i < 30; i++) {
    await worker.processOne();
    await post.tick();
    const e = await prisma.raceActiveEffect.findUnique({
      where: { id: f.effect.id },
    });
    if (e.status === "EXPIRED") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("expiry did not converge");
}
describe("deadline cache and API compatibility with production worker ownership", () => {
  before(async () => {
    server = await getSharedServer();
    liveRedis = await startTestRedis();
    assert.ok(liveRedis);
  });
  beforeEach(async () => {
    await cleanDatabase();
    process.env.REDIS_URL = liveRedis.url;
    await redis.close();
    await appSettings.setFlag("redisStandingsEnabled", true);
    await appSettings.setFlag("raceResolutionPostTasksV1Enabled", true);
  });
  after(async () => {
    await redis.close();
    await liveRedis?.close();
  });
  for (const team of [false, true])
    it(`expired effect converges through ${team ? "team" : "full, compact and paged"} HTTP with live Redis`, async () => {
      const f = await fixture({ team });
      const variants = team
        ? [""]
        : ["", "?compact=true", "?view=participants-v1&offset=0&limit=15"];
      for (const q of variants) {
        const body = await read(f, q);
        assert.ok(
          JSON.stringify(body).includes(f.effect.id),
          "existing effect identity preserved " + JSON.stringify(body),
        );
        assert.equal(body.nextEffectBoundaryAt, undefined);
      }
      await prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { expiresAt: new Date(Date.now() - 10) },
      });
      await buildRaceEffectDeadlineScheduler().tick();
      await drain(f);
      for (const q of variants) {
        const body = await read(f, q);
        assert.equal(
          body.progress.powerupData.activeEffects.some(
            (e) => e.id === f.effect.id,
          ),
          false,
        );
      }
    });
  it("a delayed older full snapshot cannot overwrite a newer generation in real Redis", async () => {
    const f = await fixture();
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
    });
    const originalEval = redis.evalLua;
    let release,
      entered,
      held = false;
    const hold = new Promise((r) => (release = r)),
      started = new Promise((r) => (entered = r));
    let fullKey;
    redis.evalLua = async function (script, keys, args) {
      if (
        !held &&
        keys.length === 1 &&
        keys[0].includes(f.race.id) &&
        String(script).includes("current.generation")
      ) {
        held = true;
        fullKey = keys[0];
        entered();
        await hold;
      }
      return originalEval.call(this, script, keys, args);
    };
    const older = (async () => {
      await worker.processRace({ raceId: f.race.id });
      const task = await prisma.raceResolutionPostTask.findFirstOrThrow({
        where: { raceId: f.race.id },
      });
      await buildRaceResolutionPostTaskRunner().processTaskId(task.id);
    })();
    try {
      await Promise.race([
        started,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("full snapshot write did not start")),
            5000,
          ),
        ),
      ]);
      const first = await prisma.raceResolutionPostTask.findFirstOrThrow({
        where: { raceId: f.race.id },
      });
      await prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { expiresAt: new Date(Date.now() - 10) },
      });
      await buildRaceEffectDeadlineScheduler().tick();
      await worker.processRace({ raceId: f.race.id });
      const newer = await prisma.raceResolutionPostTask.findFirstOrThrow({
        where: {
          raceId: f.race.id,
          sourceGeneration: { gt: first.sourceGeneration },
        },
        orderBy: { sourceGeneration: "desc" },
      });
      await buildRaceResolutionPostTaskRunner().processTaskId(newer.id);
      const published = await redis.getJSON(fullKey);
      assert.equal(published.generation, newer.sourceGeneration);
      release();
      await older;
      const after = await redis.getJSON(fullKey);
      assert.equal(
        after.generation,
        newer.sourceGeneration,
        "Lua must reject the old full-generation write",
      );
      assert.equal(
        (await read(f)).progress.powerupData.activeEffects.some(
          (e) => e.id === f.effect.id,
        ),
        false,
      );
      assert.equal(
        (
          await prisma.raceResolutionPostTask.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).snapshotState,
        "failed_no_retry",
      );
    } finally {
      release();
      await older;
      redis.evalLua = originalEval;
    }
  });
  for (const type of ["RUNNERS_HIGH", "COMPRESSION_SOCKS", "LEG_CRAMP"])
    it(`${type} expires through scheduler and real worker with exact sample scoring`, async () => {
      const f = await fixture({ type });
      await prisma.raceParticipant.updateMany({
        where: { raceId: f.race.id },
        data: { joinedAt: new Date(Date.now() - 3600000) },
      });
      const start = new Date(Date.now() - 60000),
        end = new Date(Date.now() - 10000);
      await prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { startsAt: start, expiresAt: end },
      });
      const sample = await request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: f.viewer.token,
        headers: {
          "X-Timezone": "UTC",
          "Idempotency-Key": require("node:crypto").randomUUID(),
        },
        body: {
          date: new Date().toISOString().slice(0, 10),
          steps: 100,
          samples: [
            {
              periodStart: new Date(+start + 10000).toISOString(),
              periodEnd: new Date(+end - 10000).toISOString(),
              steps: 100,
            },
          ],
        },
      });
      assert.equal(sample.status, 202, JSON.stringify(await sample.json()));
      await buildRaceEffectDeadlineScheduler().tick();
      await drain(f);
      const final = await read(f);
      assert.equal(
        final.progress.powerupData.activeEffects.some(
          (e) => e.id === f.effect.id,
        ),
        false,
      );
      const effect = await prisma.raceActiveEffect.findUniqueOrThrow({
        where: { id: f.effect.id },
      });
      assert.equal(effect.status, "EXPIRED");
      const expected =
        type === "LEG_CRAMP" ? 0 : type === "RUNNERS_HIGH" ? 200 : 100;
      assert.ok(Number.isFinite(expected));
      assert.equal(
        final.progress.participants.find((p) => p.userId === f.viewer.user.id)
          .totalSteps,
        expected,
      );
      assert.ok(
        await prisma.raceResolutionPostTask.findFirst({
          where: { raceId: f.race.id, snapshotState: "succeeded" },
        }),
      );
      const later = await request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: f.viewer.token,
        headers: {
          "X-Timezone": "UTC",
          "Idempotency-Key": require("node:crypto").randomUUID(),
        },
        body: {
          date: new Date().toISOString().slice(0, 10),
          steps: 150,
          samples: [
            {
              periodStart: new Date(+end + 1000).toISOString(),
              periodEnd: new Date(+end + 9000).toISOString(),
              steps: 50,
            },
          ],
        },
      });
      assert.equal(later.status, 202, JSON.stringify(await later.json()));
      await buildRaceResolutionWorkerV2({
        bootAt: 0,
        processRole: "resolution",
      }).processRace({ raceId: f.race.id });
      await buildRaceResolutionPostTaskRunner().tick();
      const after = await read(f);
      assert.equal(
        after.progress.participants.find((p) => p.userId === f.viewer.user.id)
          .totalSteps,
        expected + 50,
        "steps recorded after expiry must not receive the expired modifier",
      );
    });
  it("an admission database error preserves the existing best-effort progress read contract", async () => {
    const f = await fixture();
    await prisma.raceParticipant.updateMany({
      where: { raceId: f.race.id },
      data: { nextBoxAtSteps: 0 },
    });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    // A real unavailable relation exercises the DB failure without replacing
    // Prisma proxy methods (which would also corrupt future transaction scopes).
    await prisma.$executeRawUnsafe(
      "ALTER TABLE race_effect_deadlines RENAME TO expiry_test_unavailable_deadlines",
    );
    try {
      await assert.rejects(
        prisma.$queryRawUnsafe("SELECT 1 FROM race_effect_deadlines"),
      );
      const visible = await read(f);
      assert.ok(visible.progress);
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE expiry_test_unavailable_deadlines RENAME TO race_effect_deadlines",
      );
    }
  });
  it("Redis outage still settles independently and failure leaves durable repair", async () => {
    const f = await fixture();
    delete process.env.REDIS_URL;
    await redis.close();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    await buildRaceEffectDeadlineScheduler().tick();
    await drain(f);
    const body = await read(f);
    assert.equal(
      body.progress.powerupData.activeEffects.some((e) => e.id === f.effect.id),
      false,
    );
    const repair = await prisma.$queryRawUnsafe(
      "SELECT * FROM race_snapshot_repair_intents WHERE race_id=$1",
      f.race.id,
    );
    assert.ok(repair.length);
    process.env.REDIS_URL = liveRedis.url;
    await redis.close();
    await buildRaceEffectDeadlineScheduler().tick();
    await buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
    }).processRace({ raceId: f.race.id });
    await buildRaceResolutionPostTaskRunner().tick();
    const published = await prisma.raceResolutionPostTask.findFirst({
      where: { raceId: f.race.id, snapshotState: "succeeded" },
    });
    assert.ok(
      published,
      "cache recovery must produce a successful actual worker publication",
    );
    assert.ok(published.sourceGeneration > repair[0].source_generation);
    const recovered = await read(f);
    assert.equal(
      recovered.progress.powerupData.activeEffects.some(
        (e) => e.id === f.effect.id,
      ),
      false,
    );
  });
  it("new viewers are durably deferred while a real boundary worker computes, then admitted after committed expiry", async () => {
    const f = await fixture();
    const other = await createTestUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: f.race.id,
        userId: other.user.id,
        status: "ACCEPTED",
        nextBoxAtSteps: 0,
      },
    });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    const scheduler = buildRaceEffectDeadlineScheduler();
    await scheduler.tick();
    let release, arrived;
    const blocked = new Promise((r) => (release = r));
    const started = new Promise((r) => (arrived = r));
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
      beforeWriteTransaction: async () => {
        arrived();
        await blocked;
      },
    });
    const running = worker.processOne();
    await started;
    const claimed = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    try {
      await Promise.all(
        Array.from({ length: 20 }, () => read({ ...f, viewer: other })),
      );
      const during = await prisma.raceResolutionJobV2.findUniqueOrThrow({
        where: { raceId: f.race.id },
      });
      assert.equal(during.generation, claimed.generation);
      assert.equal(during.processingGeneration, claimed.processingGeneration);
      const intents = await prisma.$queryRawUnsafe(
        "SELECT * FROM race_progress_refresh_intents WHERE race_id=$1 AND user_id=$2",
        f.race.id,
        other.user.id,
      );
      assert.equal(intents.length, 1);
      assert.equal(
        intents[0].minimum_committed_generation,
        claimed.processingGeneration,
      );
    } finally {
      release();
      await running;
    }
    await buildRaceResolutionPostTaskRunner().tick();
    assert.equal(
      await prisma.raceEffectDeadline.count({
        where: { effectId: f.effect.id },
      }),
      0,
      "source deletion must not erase deferred minimum generation",
    );
    await scheduler.tick();
    const followup = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    assert.equal(followup.generation, claimed.generation + 1);
    assert.ok(followup.triggeredByUserIds.includes(other.user.id));
    assert.equal(
      (
        await prisma.raceParticipant.findUniqueOrThrow({
          where: {
            raceId_userId: { raceId: f.race.id, userId: other.user.id },
          },
        })
      ).nextBoxAtSteps,
      0,
      "unrequested viewer gate remains pending until its followup",
    );
    await buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
    }).processRace({ raceId: f.race.id });
    await buildRaceResolutionPostTaskRunner().tick();
    const visible = await read({ ...f, viewer: other });
    assert.equal(
      (
        await prisma.raceParticipant.findUniqueOrThrow({
          where: {
            raceId_userId: { raceId: f.race.id, userId: other.user.id },
          },
        })
      ).nextBoxAtSteps,
      5000,
    );
    assert.equal(visible.progress.powerupData.stepsUntilNextPowerup, 5000);
    assert.equal(visible.progress.powerupData.inventory.length, 0);
    assert.equal(
      await prisma.raceProgressRefreshIntent.count({
        where: { raceId: f.race.id },
      }),
      0,
    );
  });
  it("repair retains its obligation when C0 is busy and an undispatched deadline disappears", async () => {
    const f = await fixture();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    await prisma.$executeRawUnsafe(
      "INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation) VALUES($1,$2,1)",
      require("node:crypto").randomUUID(),
      f.race.id,
    );
    let release, locked;
    const hold = new Promise((r) => (release = r)),
      acquired = new Promise((r) => (locked = r));
    const locking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT id FROM race_resolution_jobs_v2 WHERE race_id=$1 FOR UPDATE",
          f.race.id,
        );
        locked();
        await hold;
      },
      { timeout: 10000 },
    );
    await acquired;
    try {
      await buildRaceEffectDeadlineScheduler().tick();
      const [intent] = await prisma.$queryRawUnsafe(
        "SELECT * FROM race_snapshot_repair_intents WHERE race_id=$1",
        f.race.id,
      );
      assert.equal(
        intent.terminal_at,
        null,
        "a viewerless busy fallback is not durable publication coverage",
      );
    } finally {
      release();
      await locking;
    }
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: null },
    });
    await prisma.$executeRawUnsafe(
      "UPDATE race_snapshot_repair_intents SET available_at=clock_timestamp() WHERE race_id=$1",
      f.race.id,
    );
    await buildRaceEffectDeadlineScheduler().tick();
    await buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
    }).processRace({ raceId: f.race.id });
    await buildRaceResolutionPostTaskRunner().tick();
    assert.ok(
      await prisma.raceResolutionPostTask.findFirst({
        where: { raceId: f.race.id, snapshotState: "succeeded" },
      }),
    );
    assert.equal(
      (await read(f)).progress.powerupData.activeEffects.some(
        (e) => e.id === f.effect.id,
      ),
      true,
    );
  });
  it("a real C0 lock cannot drop a viewer before deadline dispatch", async () => {
    const f = await fixture();
    const other = await createTestUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: f.race.id,
        userId: other.user.id,
        status: "ACCEPTED",
        nextBoxAtSteps: 5000,
      },
    });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    let release, locked;
    const hold = new Promise((r) => (release = r));
    const acquired = new Promise((r) => (locked = r));
    const locking = prisma.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(
          "SELECT id FROM race_resolution_jobs_v2 WHERE race_id=$1 FOR UPDATE",
          f.race.id,
        );
        locked();
        await hold;
      },
      { timeout: 10000 },
    );
    await acquired;
    try {
      await read({ ...f, viewer: other });
      const intents = await prisma.raceProgressRefreshIntent.findMany({
        where: { raceId: f.race.id, userId: other.user.id },
      });
      assert.equal(intents.length, 1);
      assert.equal(intents[0].minimumCommittedGeneration, 0);
    } finally {
      release();
      await locking;
    }
    const scheduler = buildRaceEffectDeadlineScheduler();
    await scheduler.tick();
    const initial = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    assert.equal(
      await prisma.raceProgressRefreshIntent.count({
        where: { raceId: f.race.id },
      }),
      1,
    );
    await drain(f);
    await prisma.raceProgressRefreshIntent.updateMany({
      where: { raceId: f.race.id },
      data: { availableAt: new Date(Date.now() - 1) },
    });
    await scheduler.tick();
    const next = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    assert.ok(next.generation > initial.generation);
    assert.ok(next.triggeredByUserIds.includes(other.user.id));
  });
  it("failed generation with a removed source deadline cannot strand viewer intake", async () => {
    const f = await fixture();
    const other = await createTestUser();
    await prisma.raceParticipant.create({
      data: {
        raceId: f.race.id,
        userId: other.user.id,
        status: "ACCEPTED",
        nextBoxAtSteps: 5000,
      },
    });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    const scheduler = buildRaceEffectDeadlineScheduler();
    await scheduler.tick();
    await read({ ...f, viewer: other });
    const before = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: null },
    });
    await prisma.raceResolutionJobV2.update({
      where: { raceId: f.race.id },
      data: {
        state: "FAILED",
        attempts: 3,
        lastErrorCode: "TEST_FAILED",
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    await scheduler.tick();
    const next = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    assert.equal(next.state, "QUEUED");
    assert.ok(next.generation > before.generation);
    assert.ok(next.triggeredByUserIds.includes(other.user.id));
    assert.equal(
      await prisma.raceProgressRefreshIntent.count({
        where: { raceId: f.race.id },
      }),
      0,
    );
  });
  it("a nonboundary worker adopting a due boundary retains durable publication with legacy post tasks off", async () => {
    await appSettings.setFlag("raceResolutionPostTasksV1Enabled", false);
    await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
    const f = await fixture();
    delete process.env.REDIS_URL;
    await redis.close();
    const upload = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: f.viewer.token,
      headers: {
        "X-Timezone": "UTC",
        "Idempotency-Key": require("node:crypto").randomUUID(),
      },
      body: {
        date: new Date().toISOString().slice(0, 10),
        steps: 300,
        samples: [],
      },
    });
    assert.equal(upload.status, 202, JSON.stringify(await upload.json()));
    let release, arrived;
    let first = true;
    const hold = new Promise((r) => (release = r));
    const started = new Promise((r) => (arrived = r));
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      processRole: "resolution",
      beforeWriteTransaction: async () => {
        if (first) {
          first = false;
          arrived();
          await hold;
        }
      },
    });
    const running = worker.processOne();
    await started;
    try {
      await prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { expiresAt: new Date(Date.now() - 10) },
      });
      await buildRaceEffectDeadlineScheduler().tick();
    } finally {
      release();
      await running;
    }
    await buildRaceResolutionPostTaskRunner().tick();
    assert.ok(
      await prisma.raceResolutionPostTask.count({
        where: { raceId: f.race.id },
      }),
    );
    assert.ok(
      await prisma.raceSnapshotRepairIntent.count({
        where: { raceId: f.race.id },
      }),
    );
  });
});
