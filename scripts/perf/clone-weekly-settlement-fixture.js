// Clone the production weekly settlement's scoring inputs into the local
// integration database. Production is read-only; the destination must be the
// dedicated integration DB. This is intentionally a repeatable performance
// fixture, not a production migration.
const crypto = require("node:crypto");
require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");

const SOURCE_RACE_ID = process.env.WEEKLY_FIXTURE_SOURCE_RACE_ID ||
  "fb882a74-ad84-4f87-906f-31dd190f512c";
const FIXTURE_RACE_ID = "weekly-settlement-performance-fixture";
const localUrl = process.env.DATABASE_URL || "";
if (!/localhost|127\.0\.0\.1/.test(localUrl) || !/integration|test/.test(localUrl)) {
  throw new Error("Refusing to write: DATABASE_URL must be the local integration/test database");
}
if (!process.env.PROD_DATABASE_URL) throw new Error("PROD_DATABASE_URL is required for the read-only source");

const source = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.PROD_DATABASE_URL }) });
const target = new PrismaClient({ adapter: new PrismaPg({ connectionString: localUrl }) });
const id = () => crypto.randomUUID();
const fixtureTag = id().slice(0, 8);
const chunks = (rows, size = 1000) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

async function main() {
  const race = await source.race.findUnique({ where: { id: SOURCE_RACE_ID } });
  if (!race) throw new Error(`Source race ${SOURCE_RACE_ID} not found`);
  const participants = await source.raceParticipant.findMany({ where: { raceId: SOURCE_RACE_ID } });
  const userIds = [...new Set(participants.map((row) => row.userId))];
  const users = await source.user.findMany({ where: { id: { in: userIds } }, select: {
    id: true, displayName: true, name: true, email: true, profilePhotoUrl: true,
    timezone: true, globalEventTimezone: true, coins: true,
  } });
  const samples = await source.stepSample.findMany({ where: { userId: { in: userIds } } });
  const effects = await source.raceActiveEffect.findMany({ where: { raceId: SOURCE_RACE_ID } });
  const powerups = await source.racePowerup.findMany({ where: { raceId: SOURCE_RACE_ID } });
  const powerupEvents = await source.racePowerupEvent.findMany({ where: { raceId: SOURCE_RACE_ID } });
  const globalImpacts = await source.globalEventRaceImpact.findMany({ where: { raceId: SOURCE_RACE_ID } });
  const eventIds = [...new Set(globalImpacts.map((row) => row.eventId))];
  const events = await source.globalStepEvent.findMany({ where: { id: { in: eventIds } } });

  await target.$transaction(async (tx) => {
    await tx.globalEventRaceImpact.deleteMany({ where: { raceId: FIXTURE_RACE_ID } });
    await tx.raceResolutionJobV2.deleteMany({ where: { raceId: FIXTURE_RACE_ID } });
    await tx.raceEffectImpact.deleteMany({ where: { raceId: FIXTURE_RACE_ID } });
    await tx.appReviewPromptAttempt.deleteMany({ where: { raceId: FIXTURE_RACE_ID } });
    await tx.race.deleteMany({ where: { id: FIXTURE_RACE_ID } });
    const userMap = new Map(users.map((row) => [row.id, id()]));
    const participantMap = new Map(participants.map((row) => [row.id, id()]));
    const powerupMap = new Map(powerups.map((row) => [row.id, id()]));
    const eventMap = new Map(events.map((row) => [row.id, id()]));

    await tx.user.createMany({ data: users.map((row) => ({ ...row, id: userMap.get(row.id), displayName: `fixture-${fixtureTag}-${row.id.slice(0, 12)}` })) });
    await tx.race.create({ data: { ...race, id: FIXTURE_RACE_ID, creatorId: null, winnerUserId: null, seededBucketId: null, shareToken: null, status: "ACTIVE", name: "Weekly Challenge — settlement fixture" } });
    await tx.raceParticipant.createMany({ data: participants.map((row) => ({
      id: participantMap.get(row.id), raceId: FIXTURE_RACE_ID, userId: userMap.get(row.userId), status: row.status,
      totalSteps: row.totalSteps, rawSteps: row.rawSteps, baselineSteps: row.baselineSteps, nextBoxAtSteps: row.nextBoxAtSteps,
      bonusSteps: row.bonusSteps, maxBonusSteps: row.maxBonusSteps, powerupSlots: row.powerupSlots,
      buyInAmount: 0, buyInStatus: "NONE", joinedAt: row.joinedAt, finishedAt: null, finishTotalSteps: null,
    })) });
    for (const batch of chunks(samples)) await tx.stepSample.createMany({ data: batch.map((row) => ({ ...row, id: id(), userId: userMap.get(row.userId) })) });
    await tx.racePowerup.createMany({ data: powerups.map((row) => ({ ...row, id: powerupMap.get(row.id), raceId: FIXTURE_RACE_ID, participantId: participantMap.get(row.participantId), userId: userMap.get(row.userId) })) });
    await tx.raceActiveEffect.createMany({ data: effects.map((row) => ({ ...row, id: id(), raceId: FIXTURE_RACE_ID, targetParticipantId: participantMap.get(row.targetParticipantId), targetUserId: userMap.get(row.targetUserId), sourceUserId: userMap.get(row.sourceUserId), powerupId: powerupMap.get(row.powerupId) })) });
    await tx.racePowerupEvent.createMany({ data: powerupEvents.map((row) => ({ ...row, id: id(), raceId: FIXTURE_RACE_ID, actorUserId: userMap.get(row.actorUserId), targetUserId: row.targetUserId ? userMap.get(row.targetUserId) : null })) });
    await tx.globalStepEvent.createMany({ data: events.map((row) => ({ ...row, id: eventMap.get(row.id), eventDay: null })) });
    await tx.globalEventRaceImpact.createMany({ data: globalImpacts.map((row) => ({ ...row, id: id(), eventId: eventMap.get(row.eventId), raceId: FIXTURE_RACE_ID, userId: userMap.get(row.userId) })) });
    console.log(JSON.stringify({ fixtureRaceId: FIXTURE_RACE_ID, participants: participants.length, samples: samples.length, powerups: powerups.length, effects: effects.length, powerupEvents: powerupEvents.length, events: events.length, globalImpacts: globalImpacts.length }));
  }, { timeout: 120000, maxWait: 15000 });
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await source.$disconnect(); await target.$disconnect(); });
