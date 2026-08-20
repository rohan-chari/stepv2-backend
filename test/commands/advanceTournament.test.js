const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAdvanceTournament,
} = require("../../src/modules/tournaments/commands/advanceTournament");

test("featured final pays the lobby prize snapshot instead of a later seed edit", async () => {
  const awards = [];
  const events = [];
  const guardedUsers = [];
  const tournament = {
    id: "tournament-8",
    name: "8 Racer Tourney",
    status: "ACTIVE",
    bracketSize: 8,
    currentRound: 3,
    totalRounds: 3,
    buyInAmount: 0,
    potCoins: 0,
    seedId: "seed-tournament-weekly-showdown",
    championPrizeCoinsSnapshot: 300,
    seed: { championPrizeCoins: 999 },
  };
  const tx = {
    $queryRaw: async () => [{ id: tournament.id }],
    tournament: {
      findUnique: async () => tournament,
      update: async () => tournament,
    },
    race: {
      findMany: async () => [
        {
          id: "final-race",
          status: "COMPLETED",
          winnerUserId: "winner",
          participants: [
            { userId: "winner", user: { displayName: "Winner" } },
            { userId: "runner-up", user: { displayName: "Runner" } },
          ],
        },
      ],
    },
    tournamentParticipant: {
      findMany: async () => [{ userId: "winner" }, { userId: "runner-up" }],
    },
  };
  const advance = buildAdvanceTournament({
    prisma: { $transaction: async (callback) => callback(tx) },
    now: () => new Date("2026-08-12T00:00:00.000Z"),
    awardCoins: async (entry) => awards.push(entry),
    lockFundedExposureUsers: async (_tx, userIds) => guardedUsers.push(userIds),
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
  });

  await advance({ tournamentId: tournament.id });

  assert.deepEqual(guardedUsers, [["runner-up", "winner"]]);
  assert.deepEqual(awards, [
    {
      userId: "winner",
      amount: 300,
      reason: "tournament_champion_reward",
      refId: "tournament-8:champion",
    },
  ]);
  assert.equal(events.find((event) => event.type === "TOURNAMENT_CHAMPION").payload.prizeCoins, 300);
});
