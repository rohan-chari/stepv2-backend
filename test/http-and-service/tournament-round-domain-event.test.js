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

test("real tournament advancement appends matchup, elimination, and next-round domain events", async () => {
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
      eventType: {
        in: [
          "TOURNAMENT_MATCHUP_WON_V1",
          "TOURNAMENT_ELIMINATED_V1",
          "TOURNAMENT_ROUND_STARTED_V1",
        ],
      },
    },
    include: { audience: true },
    orderBy: { eventKey: "asc" },
  });

  const byType = (eventType) => events.filter((event) => event.eventType === eventType);

  const matchupWonEvents = byType("TOURNAMENT_MATCHUP_WON_V1");
  assert.equal(matchupWonEvents.length, 2);
  assert.deepEqual(
    new Set(matchupWonEvents.flatMap((event) => event.audience.map((row) => row.recipientId))),
    new Set(winners),
  );

  const eliminatedEvents = byType("TOURNAMENT_ELIMINATED_V1");
  assert.equal(eliminatedEvents.length, 2);
  assert.deepEqual(
    new Set(eliminatedEvents.flatMap((event) => event.audience.map((row) => row.recipientId))),
    new Set(losers),
  );

  const roundStartedEvents = byType("TOURNAMENT_ROUND_STARTED_V1");
  assert.equal(roundStartedEvents.length, 2);
  assert.deepEqual(
    new Set(roundStartedEvents.flatMap((event) => event.audience.map((row) => row.recipientId))),
    new Set(winners),
  );
  assert.ok(
    roundStartedEvents.every((event) => event.payload.roundId === `${tournament.id}:round:2`),
  );

  const updated = await prisma.tournament.findUnique({
    where: { id: tournament.id },
    select: { currentRound: true },
  });
  assert.equal(updated.currentRound, 2);
});


test("real tournament final appends champion and runner-up elimination domain events", async () => {
  const [creator, runnerUp, earlierLoserA, earlierLoserB] = await Promise.all([
    createTestUser({ displayName: "Champion" }),
    createTestUser({ displayName: "Runner Up" }),
    createTestUser({ displayName: "Earlier Loser A" }),
    createTestUser({ displayName: "Earlier Loser B" }),
  ]);

  const championUserId = creator.user.id;
  const runnerUpUserId = runnerUp.user.id;
  const now = new Date();

  const tournament = await prisma.tournament.create({
    data: {
      creatorId: championUserId,
      name: "Final advance evidence",
      status: "ACTIVE",
      bracketSize: 4,
      matchupDurationDays: 2,
      buyInAmount: 0,
      potCoins: 0,
      powerupsEnabled: false,
      isPublic: false,
      currentRound: 2,
      totalRounds: 2,
      startedAt: now,
    },
  });

  for (const [userId, eliminatedInRound] of [
    [championUserId, null],
    [runnerUpUserId, null],
    [earlierLoserA.user.id, 1],
    [earlierLoserB.user.id, 1],
  ]) {
    await prisma.tournamentParticipant.create({
      data: {
        tournamentId: tournament.id,
        userId,
        status: "ACCEPTED",
        joinedAt: now,
        ...(eliminatedInRound == null ? {} : { eliminatedInRound }),
      },
    });
  }

  const finalRace = await prisma.race.create({
    data: {
      creatorId: championUserId,
      name: "Tournament Final",
      targetSteps: 0,
      status: "COMPLETED",
      startedAt: now,
      maxDurationDays: 2,
      timeBased: true,
      isPublic: false,
      maxParticipants: 2,
      powerupsEnabled: false,
      tournamentId: tournament.id,
      tournamentRound: 2,
      tournamentMatchIndex: 0,
      winnerUserId: championUserId,
    },
  });

  for (const userId of [championUserId, runnerUpUserId]) {
    await prisma.raceParticipant.create({
      data: {
        raceId: finalRace.id,
        userId,
        status: "ACCEPTED",
        joinedAt: now,
        baselineSteps: 0,
      },
    });
  }

  await advanceTournament({ tournamentId: tournament.id });

  const events = await prisma.domainEventOutbox.findMany({
    where: {
      aggregateId: tournament.id,
      eventType: {
        in: [
          "TOURNAMENT_CHAMPION_V1",
          "TOURNAMENT_ELIMINATED_V1",
        ],
      },
    },
    include: { audience: true },
    orderBy: { eventKey: "asc" },
  });

  const championEvents = events.filter(
    (event) => event.eventType === "TOURNAMENT_CHAMPION_V1",
  );
  assert.equal(championEvents.length, 1);
  assert.deepEqual(
    championEvents[0].audience.map((row) => row.recipientId),
    [championUserId],
  );

  const runnerUpEvents = events.filter(
    (event) => event.eventType === "TOURNAMENT_ELIMINATED_V1",
  );
  assert.equal(runnerUpEvents.length, 1);
  assert.deepEqual(
    runnerUpEvents[0].audience.map((row) => row.recipientId),
    [runnerUpUserId],
  );

  const updated = await prisma.tournament.findUnique({
    where: { id: tournament.id },
    select: { status: true, championUserId: true },
  });
  assert.deepEqual(updated, {
    status: "COMPLETED",
    championUserId,
  });
});
