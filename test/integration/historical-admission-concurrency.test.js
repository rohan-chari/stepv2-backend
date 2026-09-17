const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { randomUUID } = require("node:crypto");
const { prisma, cleanDatabase, createTestUser } = require("./setup");
const { buildHistoricalRaceReconciliationIntentModel } = require("../../src/modules/races/models/historicalRaceReconciliationIntent");

describe("historical admission concurrency and leasing", () => {
  beforeEach(cleanDatabase);
  it("coalesces sequential generations and ranges into one durable intent", async () => {
    const account = await createTestUser();
    const now = new Date("2026-09-16T14:00:00.000Z");
    const race = await prisma.race.create({ data: { id: randomUUID(), creatorId: account.user.id, name: "Sequential admission", status: "COMPLETED", targetSteps: 1000, startedAt: new Date("2026-09-16T10:00:00.000Z"), endsAt: new Date("2026-09-16T13:30:00.000Z"), completedAt: new Date("2026-09-16T13:30:00.000Z"), maxParticipants: 10 } });
    await prisma.raceParticipant.create({ data: { raceId: race.id, userId: account.user.id, status: "ACCEPTED" } });
    const model = buildHistoricalRaceReconciliationIntentModel(prisma);
    const at = (hour, minute) => new Date(`2026-09-16T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
    const read = () => prisma.historicalRaceReconciliationIntent.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: account.user.id } } });
    const admit = (sourceGeneration, changedStart, changedEnd) => model.admitMany({ rows: [{ raceId: race.id, userId: account.user.id }], changedStart, changedEnd, sourceGeneration, now });
    const assertState = async (sourceGeneration, changedStart, changedEnd) => {
      assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId: race.id, userId: account.user.id } }), 1);
      const intent = await read();
      assert.equal(intent.requestedSourceGeneration, BigInt(sourceGeneration));
      assert.equal(+intent.changedStart, +changedStart);
      assert.equal(+intent.changedEnd, +changedEnd);
      assert.equal(intent.status, "QUEUED");
      return intent;
    };

    await admit(100, at(12, 0), at(12, 15));
    await assertState(100, at(12, 0), at(12, 15));
    await admit(101, at(11, 45), at(12, 30));
    await assertState(101, at(11, 45), at(12, 30));
    await admit(102, at(12, 25), at(12, 50));
    await assertState(102, at(11, 45), at(12, 50));
    await admit(103, at(11, 30), at(13, 0));
    await assertState(103, at(11, 30), at(13, 0));

    await admit(99, at(12, 5), at(12, 10));
    await assertState(103, at(11, 30), at(13, 0));
    await admit(103, at(11, 0), at(13, 30));
    await assertState(103, at(11, 0), at(13, 30));
    await admit(103, at(11, 0), at(13, 30));
    await assertState(103, at(11, 0), at(13, 30));

    const claimed = (await model.claimBatch({ now: new Date("2026-09-16T14:01:00.000Z") }))[0];
    assert.ok(claimed);
    assert.equal(claimed.requested_source_generation, 103n);
    assert.equal(+claimed.changed_start, +at(11, 0));
    assert.equal(+claimed.changed_end, +at(13, 30));
    await admit(104, at(10, 45), at(14, 0));
    const superseded = await read();
    assert.equal(superseded.status, "RUNNING");
    assert.equal(superseded.requestedSourceGeneration, 104n);
    assert.equal(+superseded.changedStart, +at(10, 45));
    assert.equal(+superseded.changedEnd, +at(14, 0));
    const acknowledged = await model.acknowledgeDryRun({ id: claimed.id, leaseToken: claimed.lease_token, claimedGeneration: claimed.requested_source_generation, now: new Date("2026-09-16T14:02:00.000Z") });
    assert.equal(acknowledged.status, "queued");
    assert.equal((await read()).requestedSourceGeneration, 104n);
  });

  it("coalesces concurrent generations and reclaims an expired lease", async () => {
    const account = await createTestUser();
    const race = await prisma.race.create({ data: { id: randomUUID(), creatorId: account.user.id, name: "Admission", status: "COMPLETED", targetSteps: 1000, startedAt: new Date(Date.now() - 3600000), endsAt: new Date(Date.now() - 1800000), completedAt: new Date(Date.now() - 1800000), maxParticipants: 10 } });
    const model = buildHistoricalRaceReconciliationIntentModel(prisma);
    const start = new Date(Date.now() - 120000);
    const end = new Date(Date.now() - 60000);
    await Promise.all([
      model.admitMany({ rows: [{ raceId: race.id, userId: account.user.id }], changedStart: start, changedEnd: end, sourceGeneration: 100 }),
      model.admitMany({ rows: [{ raceId: race.id, userId: account.user.id }], changedStart: new Date(start - 60000), changedEnd: new Date(end.getTime() + 60000), sourceGeneration: 103 }),
    ]);
    const intent = await prisma.historicalRaceReconciliationIntent.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: account.user.id } } });
    assert.equal(intent.requestedSourceGeneration, 103n);
    assert.equal(+intent.changedStart, +new Date(start - 60000));
    assert.equal(+intent.changedEnd, +new Date(end.getTime() + 60000));
    const first = (await model.claimBatch({ now: new Date() }))[0];
    assert.ok(first);
    assert.equal((await model.claimBatch({ now: new Date() })).length, 0);
    await prisma.$executeRawUnsafe("UPDATE historical_race_reconciliation_intents SET lease_expires_at=$1 WHERE id=$2", new Date(Date.now() - 1000), first.id);
    const second = (await model.claimBatch({ now: new Date() }))[0];
    assert.ok(second);
    assert.equal(second.id, first.id);
    assert.equal(second.attempt_count, first.attempt_count + 1);
  });
});
