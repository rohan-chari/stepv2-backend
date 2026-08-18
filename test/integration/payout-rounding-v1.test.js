const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const {
  buildCompleteRace,
  completeRace,
} = require("../../src/modules/races/commands/completeRace");
const { awardCoins } = require("../../src/shared/economy/awardCoins");

let server;

describe("payout rounding v1 — real settlement and read contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(cleanDatabase);

  it("credits and serializes the per-recipient rounded funded split exactly once", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const startedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const race = await prisma.race.create({
      data: {
        name: "Rounded split", targetSteps: 0, status: "ACTIVE", isPublic: true,
        timeBased: true, maxDurationDays: 1, startedAt,
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        fundedPrize: true, payoutRoundingVersion: 1,
        // 4 walkers yield raw pool 80, whose TOP3 split is 56/16/8.
        teamPoolMultBps: 2500, payoutPreset: "TOP3_70_20_10",
      },
    });
    for (const [index, entry] of users.entries()) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id, userId: entry.user.id, status: "ACCEPTED",
          totalSteps: 10000 - index, placement: index + 1,
        },
      });
    }

    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });
    // The completion call is safe to retry: no second ledger credits appear.
    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { placement: "asc" },
    });
    assert.deepEqual(participants.map((row) => row.payoutCoins), [60, 20, 10, 0]);
    const credits = await prisma.coinTransaction.findMany({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: `${race.id}:` } },
      orderBy: { refId: "asc" },
    });
    assert.deepEqual(credits.map((row) => row.amount).sort((a, b) => b - a), [60, 20, 10]);
    assert.equal(credits.length, 3);
    assert.deepEqual(credits[0].payoutMetadata, {
      recipientId: participants.find((row) => row.payoutCoins === credits[0].amount)?.id,
      placement: 1,
      rawAwardCoins: 56,
      awardCoins: 60,
      roundingSubsidyCoins: 4,
    });

    const detail = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: users[0].token,
    });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.deepEqual(body.payoutTiers.map((row) => row.amount), [60, 20, 10]);
    assert.equal(body.projectedPotCoins, 90);
    assert.equal(body.prizePool.coins, 90);
  });

  it("reconciles a v1 credit that committed before participant/result persistence", async () => {
    const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
    const race = await prisma.race.create({
      data: {
        name: "Rounded recovery", targetSteps: 0, status: "ACTIVE", isPublic: true,
        timeBased: true, maxDurationDays: 1,
        startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        fundedPrize: true, payoutRoundingVersion: 1,
        teamPoolMultBps: 2500, payoutPreset: "TOP3_70_20_10",
      },
    });
    for (const [index, entry] of users.entries()) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id, userId: entry.user.id, status: "ACCEPTED",
          totalSteps: 10000 - index, placement: index + 1,
        },
      });
    }

    let crashAfterCredit = true;
    const crashesAfterFirstCommittedCredit = buildCompleteRace({
      awardCoins: async (input) => {
        const outcome = await awardCoins(input);
        if (crashAfterCredit && outcome.awarded) {
          crashAfterCredit = false;
          throw new Error("simulated crash after durable credit");
        }
        return outcome;
      },
    });
    await assert.rejects(
      crashesAfterFirstCommittedCredit({
        raceId: race.id,
        winnerUserId: users[0].user.id,
        participantUserIds: users.map(({ user }) => user.id),
      }),
      /simulated crash/
    );

    await completeRace({
      raceId: race.id,
      winnerUserId: users[0].user.id,
      participantUserIds: users.map(({ user }) => user.id),
    });

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id }, orderBy: { placement: "asc" },
    });
    assert.deepEqual(participants.map((row) => row.payoutCoins), [60, 20, 10, 0]);
    const credits = await prisma.coinTransaction.findMany({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: `${race.id}:` } },
    });
    assert.equal(credits.length, 3);
    const completed = await prisma.race.findUnique({ where: { id: race.id } });
    assert.equal(completed.prizePoolCoins, 90);
    assert.equal(completed.payoutRoundingMetadata.roundingSubsidyCoins, 10);
  });
});
