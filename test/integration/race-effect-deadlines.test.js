const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
let server;
async function fixture() {
  const viewer = await createTestUser();
  const race = await prisma.race.create({
    data: {
      creatorId: viewer.user.id,
      name: "Deadline race",
      status: "ACTIVE",
      targetSteps: 200000,
      startedAt: new Date(Date.now() - 3600000),
      endsAt: new Date(Date.now() + 86400000),
      timezone: "UTC",
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
  });
  const participant = await prisma.raceParticipant.create({
    data: {
      raceId: race.id,
      userId: viewer.user.id,
      status: "ACCEPTED",
      nextBoxAtSteps: 5000,
    },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: race.id,
      participantId: participant.id,
      userId: viewer.user.id,
      type: "FANNY_PACK",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  const response = await request(
    server.baseUrl,
    "POST",
    `/races/${race.id}/powerups/${powerup.id}/use`,
    { token: viewer.token, body: {} },
  );
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const effect = await prisma.raceActiveEffect.findFirstOrThrow({
    where: { powerupId: powerup.id },
  });
  return { viewer, race, participant, effect };
}
async function deadline(id) {
  return (
    await prisma.$queryRawUnsafe(
      "SELECT * FROM race_effect_deadlines WHERE effect_id=$1",
      id,
    )
  )[0];
}
describe("durable timed effect delivery through HTTP activation", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(cleanDatabase);
  it("atomically captures HTTP activation and legacy SQL extension, but does not rearm metadata", async () => {
    const f = await fixture();
    const initial = await deadline(f.effect.id);
    assert.ok(initial);
    assert.equal(+initial.deadline_at, +f.effect.expiresAt);
    await prisma.$executeRawUnsafe(
      "UPDATE race_active_effects SET metadata=coalesce(metadata,'{}'::jsonb)||'{\"test\":true}'::jsonb WHERE id=$1",
      f.effect.id,
    );
    assert.equal((await deadline(f.effect.id)).revision, initial.revision);
    await prisma.$executeRawUnsafe(
      "UPDATE race_active_effects SET expires_at=expires_at + interval '1 hour' WHERE id=$1",
      f.effect.id,
    );
    const extended = await deadline(f.effect.id);
    assert.notEqual(extended.revision, initial.revision);
    assert.equal(extended.dispatched_revision, null);
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: null },
    });
    assert.equal(await deadline(f.effect.id), undefined);
  });
  it("two schedulers dispatch a due revision once, without polling a client", async () => {
    const f = await fixture();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const a = buildRaceEffectDeadlineScheduler();
    const b = buildRaceEffectDeadlineScheduler();
    await Promise.all([a.tick(), b.tick()]);
    const d = await deadline(f.effect.id);
    assert.equal(d.dispatched_revision, d.revision);
    assert.ok(d.dispatched_generation > 0);
    const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: f.race.id },
    });
    assert.ok(job.dirtyReasons.includes("EFFECT_BOUNDARY"));
    await a.tick();
    assert.equal(
      (
        await prisma.raceResolutionJobV2.findUniqueOrThrow({
          where: { raceId: f.race.id },
        })
      ).generation,
      job.generation,
    );
  });
  it("extension after dispatch creates a new revision and old delivery cannot rearm it", async () => {
    const f = await fixture();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const scheduler = buildRaceEffectDeadlineScheduler();
    await scheduler.tick();
    const prior = await deadline(f.effect.id);
    const extension = new Date(Date.now() + 3600000);
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: extension },
    });
    await scheduler.tick();
    const next = await deadline(f.effect.id);
    assert.notEqual(next.revision, prior.revision);
    assert.equal(next.dispatched_revision, null);
    assert.equal(+next.deadline_at, +extension);
    const {
      buildRaceResolutionWorkerV2,
    } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
    const {
      buildRaceResolutionPostTaskRunner,
    } = require("../../src/modules/races/jobs/raceResolutionPostTaskRunner");
    await buildRaceResolutionWorkerV2({ bootAt: 0 }).processOne();
    await buildRaceResolutionPostTaskRunner().tick();
    const response = await request(
      server.baseUrl,
      "GET",
      `/races/${f.race.id}/progress`,
      { token: f.viewer.token },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const visible = body.progress.powerupData.activeEffects.find(
      (effect) => effect.id === f.effect.id,
    );
    assert.ok(visible);
    assert.equal(visible.expiresAt, extension.toISOString());
    assert.equal(body.progress.powerupData.powerupSlots, 4);
    assert.equal(
      await prisma.racePowerupEvent.count({
        where: { raceId: f.race.id, eventType: "EFFECT_EXPIRED" },
      }),
      0,
    );
  });
  it("rollback before dispatch commit leaves no delivered revision or advanced generation", async () => {
    const f = await fixture();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const before = await prisma.raceResolutionJobV2.findUnique({
      where: { raceId: f.race.id },
    });
    await prisma.$executeRawUnsafe(
      "CREATE FUNCTION test_deadline_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispatch aborted'; END $$",
    );
    await prisma.$executeRawUnsafe(
      "CREATE TRIGGER test_deadline_abort BEFORE UPDATE ON race_effect_deadlines FOR EACH ROW EXECUTE FUNCTION test_deadline_abort()",
    );
    try {
      const {
        buildRaceEffectDeadlineScheduler,
      } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
      await assert.rejects(
        buildRaceEffectDeadlineScheduler().tick(),
        /dispatch aborted/,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER test_deadline_abort ON race_effect_deadlines",
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION test_deadline_abort()");
    }
    assert.equal((await deadline(f.effect.id)).dispatched_revision, null);
    assert.equal(
      (
        await prisma.raceResolutionJobV2.findUnique({
          where: { raceId: f.race.id },
        })
      )?.generation,
      before?.generation,
    );
  });
  it("backfill is bounded, repeatable and serializes with source extension", async () => {
    const f = await fixture();
    await prisma.$executeRawUnsafe(
      "DELETE FROM race_effect_deadlines WHERE effect_id=$1",
      f.effect.id,
    );
    const {
      RaceEffectDeadline,
    } = require("../../src/modules/races/models/raceEffectDeadline");
    await Promise.all([
      RaceEffectDeadline.backfill({ limit: 1 }),
      prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { expiresAt: new Date(Date.now() + 7200000) },
      }),
    ]);
    const source = await prisma.raceActiveEffect.findUniqueOrThrow({
      where: { id: f.effect.id },
    });
    assert.equal(+(await deadline(f.effect.id)).deadline_at, +source.expiresAt);
    const before = await deadline(f.effect.id);
    await RaceEffectDeadline.backfill({ limit: 1 });
    assert.equal((await deadline(f.effect.id)).revision, before.revision);
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { status: "EXPIRED" },
    });
    assert.equal(await deadline(f.effect.id), undefined);
  });
  it("terminal race cleanup does not dispatch settlement-owned effects", async () => {
    const f = await fixture();
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.race.update({
      where: { id: f.race.id },
      data: { status: "COMPLETED" },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const scheduler = buildRaceEffectDeadlineScheduler();
    assert.equal(await scheduler.tick(), 0);
    await scheduler.recover();
    assert.equal(await deadline(f.effect.id), undefined);
  });
  it("pending post-task on oldest recovery page cannot starve a later failed race", async () => {
    const first = await fixture();
    const second = await fixture();
    const uuid = require("node:crypto").randomUUID;
    const users = Array.from({ length: 99 }, () => ({ id: uuid() }));
    await prisma.user.createMany({ data: users });
    const participants = users.map((u) => ({
      id: uuid(),
      raceId: first.race.id,
      userId: u.id,
      status: "ACCEPTED",
    }));
    await prisma.raceParticipant.createMany({ data: participants });
    const powers = participants.map((p) => ({
      id: uuid(),
      raceId: p.raceId,
      participantId: p.id,
      userId: p.userId,
      status: "USED",
      type: "FANNY_PACK",
      rarity: "RARE",
      earnedAtSteps: 0,
    }));
    await prisma.racePowerup.createMany({ data: powers });
    await prisma.raceActiveEffect.createMany({
      data: participants.map((p, i) => ({
        raceId: p.raceId,
        targetParticipantId: p.id,
        targetUserId: p.userId,
        sourceUserId: p.userId,
        powerupId: powers[i].id,
        type: "FANNY_PACK",
        startsAt: new Date(Date.now() - 10000),
        expiresAt: new Date(Date.now() - 1000),
      })),
    });
    await prisma.raceActiveEffect.updateMany({
      where: { raceId: { in: [first.race.id, second.race.id] } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    const scheduler = buildRaceEffectDeadlineScheduler();
    await scheduler.tick();
    await scheduler.tick();
    await prisma.raceEffectDeadline.updateMany({
      where: { raceId: first.race.id },
      data: { dispatchedAt: new Date(Date.now() - 120000) },
    });
    await prisma.raceEffectDeadline.updateMany({
      where: { raceId: second.race.id },
      data: { dispatchedAt: new Date(Date.now() - 60000) },
    });
    const job = await prisma.raceResolutionJobV2.update({
      where: { raceId: first.race.id },
      data: { state: "SUCCEEDED" },
    });
    await prisma.raceResolutionJobV2.update({
      where: { raceId: second.race.id },
      data: { state: "FAILED" },
    });
    const {
      RaceResolutionPostTask,
    } = require("../../src/modules/races/models/raceResolutionPostTask");
    await RaceResolutionPostTask.create({
      raceId: first.race.id,
      sourceGeneration: job.generation,
      snapshotCommand: { raceId: first.race.id, timeZone: "UTC" },
      intents: [],
    });
    await scheduler.recover();
    await scheduler.recover();
    assert.equal((await deadline(second.effect.id)).dispatched_revision, null);
  });
  for (const state of ["QUEUED", "RUNNING"])
    it(`retained five-minute sweep preserves ${state.toLowerCase()} deadline generation`, async () => {
      const f = await fixture();
      await prisma.raceActiveEffect.update({
        where: { id: f.effect.id },
        data: { expiresAt: new Date(Date.now() - 10) },
      });
      const {
        buildRaceEffectDeadlineScheduler,
      } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
      await buildRaceEffectDeadlineScheduler().tick();
      const original = await prisma.raceResolutionJobV2.findUniqueOrThrow({
        where: { raceId: f.race.id },
      });
      if (state === "RUNNING")
        await prisma.raceResolutionJobV2.update({
          where: { raceId: f.race.id },
          data: {
            state,
            processingGeneration: original.generation,
            processingDirtyReasons: original.dirtyReasons,
            processingTriggeredByUserIds: original.triggeredByUserIds,
            dirtyReasons: [],
            triggeredByUserIds: [],
            leaseToken: "held-worker",
            leaseExpiresAt: new Date(Date.now() + 30000),
          },
        });
      await require("../../src/modules/races/jobs/placementRecompute").buildRecomputePlacements()();
      assert.equal(
        (
          await prisma.raceResolutionJobV2.findUniqueOrThrow({
            where: { raceId: f.race.id },
          })
        ).generation,
        original.generation,
      );
    });
  it("null race timezone retains creator day buckets through worker and HTTP expiry", async () => {
    const f = await fixture();
    // Choose a real timezone whose current date differs from UTC at any hour.
    const now = new Date(),
      utcDay = new Date(now.toISOString().slice(0, 10));
    const behind = now.getUTCHours() < 10;
    const timezone = behind ? "Pacific/Honolulu" : "Pacific/Kiritimati";
    await prisma.user.update({
      where: { id: f.viewer.user.id },
      data: { timezone },
    });
    await prisma.race.update({
      where: { id: f.race.id },
      data: { timezone: null, startedAt: new Date(Date.now() - 3 * 86400000) },
    });
    await prisma.raceParticipant.update({
      where: { id: f.participant.id },
      data: { joinedAt: new Date(Date.now() - 3 * 86400000) },
    });
    for (const [offset, steps] of [
      [-1, 100],
      [0, 900],
      [1, 1000],
    ])
      await prisma.step.create({
        data: {
          userId: f.viewer.user.id,
          date: new Date(+utcDay + offset * 86400000),
          steps,
        },
      });
    await prisma.raceActiveEffect.update({
      where: { id: f.effect.id },
      data: { expiresAt: new Date(Date.now() - 10) },
    });
    const {
      buildRaceEffectDeadlineScheduler,
    } = require("../../src/modules/races/jobs/raceEffectDeadlineScheduler");
    await buildRaceEffectDeadlineScheduler().tick();
    assert.equal(
      (
        await prisma.raceResolutionJobV2.findUniqueOrThrow({
          where: { raceId: f.race.id },
        })
      ).resolutionTimeZone,
      timezone,
    );
    await require("../../src/modules/races/jobs/raceResolutionQueueV2")
      .buildRaceResolutionWorkerV2({ bootAt: 0, processRole: "resolution" })
      .processRace({ raceId: f.race.id });
    await require("../../src/modules/races/jobs/raceResolutionPostTaskRunner")
      .buildRaceResolutionPostTaskRunner()
      .tick();
    const expected = behind ? 100 : 2000;
    assert.equal(
      (
        await prisma.raceParticipant.findUniqueOrThrow({
          where: { id: f.participant.id },
        })
      ).totalSteps,
      expected,
    );
    const response = await request(
      server.baseUrl,
      "GET",
      `/races/${f.race.id}/progress`,
      {
        token: f.viewer.token,
        headers: {
          "X-Timezone": timezone,
          "X-App-Version": "99.0.0",
          "X-Client-Features": "powerups3,powerups4,powerups5",
        },
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(
      body.progress.participants.find((p) => p.userId === f.viewer.user.id)
        .totalSteps,
      expected,
    );
    assert.equal(
      body.progress.powerupData.activeEffects.some((e) => e.id === f.effect.id),
      false,
    );
  });
});
