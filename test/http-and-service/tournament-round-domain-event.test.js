const assert = require("node:assert/strict");
const { beforeEach, test } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
} = require("../integration/setup");
const {
  advanceTournament,
} = require("../../src/modules/tournaments/commands/advanceTournament");

beforeEach(cleanDatabase);

test("real tournament advancement appends TOURNAMENT_ROUND_STARTED_V1 for the next-round survivors", async () => {
  const [creator, racerB, racerC, racerD] = await Promise.all([
    createTestUser({ displayName: "Creator" }),
    createTestUser({ displayName: "Racer B" }),
    createTestUser({ displayName: "Racer C" }),
    createTestUser({ displayName: "Racer D" }),
  ]);

  const users = [
    creator.user.id,
    racerB.user.id,
    racerC.user.id,
    racerD.user.id,
  ];
  const winners = [creator.user.id, racerC.user.id];
  const losers = [racerB.user.id, racerD.user.id];
  const now = new Date();

  const tournament = await prisma.tournament.create({
    data: {
      creatorId: creator.user.id,
      name: "Round advance evidence",
      status: "ACTIVE",
      bracketSize: 4,
      matchupDurationDays: 2,
      buyInAmount: 0,
      potCoins: 0,
      powerupsEnabled: false,
      isPublic: false,
      currentRound: 1,
      totalRounds: 2,
      startedAt: now,
    },
  });

  for (const userId of users) {
    await prisma.tournamentParticipant.create({
      data: {
        tournamentId: tournament.id,
        userId,
        status: "ACCEPTED",
        joinedAt: now,
        ...(losers.includes(userId) ? { eliminatedInRound: 1 } : {}),
      },
    });
  }

  for (let matchIndex = 0; matchIndex < 2; matchIndex += 1) {
    const pair = users.slice(matchIndex * 2, matchIndex * 2 + 2);
    const race = await prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: `Round 1 match ${matchIndex + 1}`,
        targetSteps: 0,
        status: "COMPLETED",
        startedAt: now,
        maxDurationDays: 2,
        timeBased: true,
        isPublic: false,
        maxParticipants: 2,
        powerupsEnabled: false,
        tournamentId: tournament.id,
        tournamentRound: 1,
        tournamentMatchIndex: matchIndex,
        winnerUserId: winners[matchIndex],
      },
    });

    for (const userId of pair) {
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId,
          status: "ACCEPTED",
          joinedAt: now,
          baselineSteps: 0,
        },
      });
    }
  }

  await advanceTournament({ tournamentId: tournament.id });

  const events = await prisma.domainEventOutbox.findMany({
    where: {
      aggregateId: tournament.id,
      eventType: "TOURNAMENT_ROUND_STARTED_V1",
    },
    include: { audience: true },
    orderBy: { eventKey: "asc" },
  });

  assert.equal(events.length, 2);
  assert.deepEqual(
    new Set(events.flatMap((event) => event.audience.map((row) => row.recipientId))),
    new Set(winners),
  );
  assert.ok(events.every((event) => event.payload.roundId === `${tournament.id}:round:2`));

  const updated = await prisma.tournament.findUnique({
    where: { id: tournament.id },
    select: { currentRound: true },
  });
  assert.equal(updated.currentRound, 2);
});
