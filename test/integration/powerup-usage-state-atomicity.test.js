const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const { cleanDatabase, prisma, createTestUser } = require("./setup");
const { PowerupUsageState } = require("../../src/modules/powerups/models/powerupUsageState");

async function fixture() {
  const { user } = await createTestUser({ displayName: "Atomicity owner" });
  const race = await prisma.race.create({ data: {
    creatorId: user.id, name: "Usage state atomicity", status: "ACTIVE", timeBased: true,
    maxDurationDays: 7, targetSteps: 100000, powerupsEnabled: true,
    startedAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 86_400_000), timezone: "UTC",
  } });
  const participant = await prisma.raceParticipant.create({ data: {
    raceId: race.id, userId: user.id, status: "ACCEPTED", totalSteps: 0,
  } });
  const powerup = await prisma.racePowerup.create({ data: {
    raceId: race.id, participantId: participant.id, userId: user.id,
    type: "LEECH", rarity: "RARE", status: "HELD", earnedAtSteps: 1,
  } });
  return { user, race, participant, powerup };
}

describe("power-up usage state transaction authority", () => {
  beforeEach(cleanDatabase);

  it("rolls back usage state and inventory transition together", async () => {
    const f = await fixture();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), activeUntil: new Date(Date.now() + 3600000), nextUsableAt: new Date(Date.now() + 7200000), sourcePowerupId: f.powerup.id });
      await tx.racePowerup.update({ where: { id: f.powerup.id }, data: { status: "USED", usedAt: new Date() } });
      throw new Error("forced usage-state rollback");
    }), /forced usage-state rollback/);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 0);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.powerup.id } })).status, "HELD");
  });

  it("rolls back an effect and usage state together", async () => {
    const f = await fixture();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participant.id, targetUserId: f.user.id,
        sourceUserId: f.user.id, powerupId: f.powerup.id, type: "LEECH", status: "ACTIVE",
        startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
      } });
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), nextUsableAt: new Date(Date.now() + 3600000), sourcePowerupId: f.powerup.id });
      throw new Error("forced effect rollback");
    }), /forced effect rollback/);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id } }), 0);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 0);
  });

  it("commits usage state, effect, and USED transition together", async () => {
    const f = await fixture();
    await prisma.$transaction(async (tx) => {
      await tx.raceActiveEffect.create({ data: {
        raceId: f.race.id, targetParticipantId: f.participant.id, targetUserId: f.user.id,
        sourceUserId: f.user.id, powerupId: f.powerup.id, type: "LEECH", status: "ACTIVE",
        startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
      } });
      await PowerupUsageState.upsertUsed({ db: tx, raceId: f.race.id, userId: f.user.id, powerupType: "LEECH",
        lastUsedAt: new Date(), nextUsableAt: new Date(Date.now() + 3600000), sourcePowerupId: f.powerup.id });
      await tx.racePowerup.update({ where: { id: f.powerup.id }, data: { status: "USED", usedAt: new Date() } });
    });
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id } }), 1);
    assert.equal(await prisma.powerupUsageState.count({ where: { raceId: f.race.id } }), 1);
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.powerup.id } })).status, "USED");
  });
});
