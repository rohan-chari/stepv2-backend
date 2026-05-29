const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCompleteRace } = require("../../src/commands/completeRace");

// ---------------------------------------------------------------------------
// Seeded-race finish reward — on completion, the top 50% of finishers in the
// seeded daily/weekly races split a minted coin pool (graded by placement).
// These races have no buy-in pot, so the legacy pot-payout path is skipped.
// ---------------------------------------------------------------------------

function makeParticipant(id, userId, placement, totalSteps, overrides = {}) {
  return {
    id,
    userId,
    placement,
    totalSteps,
    status: "ACCEPTED",
    ...overrides,
  };
}

function makeDeps({ race, updateCount = 1 } = {}) {
  const awardCalls = [];
  const payoutIncrements = [];
  const events = [];

  return {
    awardCalls,
    payoutIncrements,
    events,
    deps: {
      Race: {
        async updateIfActive() {
          return { count: updateCount };
        },
        async findById() {
          return race;
        },
      },
      RaceParticipant: {
        async incrementPayoutCoins(id, amount) {
          payoutIncrements.push({ id, amount });
        },
      },
      RacePowerup: {
        async expireAllForRace() {},
      },
      RaceActiveEffect: {
        async expireAllForRace() {},
      },
      awardCoins: async (args) => {
        awardCalls.push(args);
        return { awarded: true, coins: 0 };
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
    },
  };
}

function finishRewardCalls(awardCalls) {
  return awardCalls.filter((c) => c.reason === "race_finish_reward");
}

test("daily seeded race pays the top 50% with a graded, descending split", async () => {
  const ctx = makeDeps({
    race: {
      id: "race-1",
      seedId: "seed-daily-10k",
      potCoins: 0,
      participants: [
        makeParticipant("rp-1", "user-1", 1, 12000),
        makeParticipant("rp-2", "user-2", 2, 9000),
        makeParticipant("rp-3", "user-3", 3, 7000),
        makeParticipant("rp-4", "user-4", 4, 5000),
        makeParticipant("rp-5", "user-5", 5, 3000),
        makeParticipant("rp-6", "user-6", 6, 1000),
      ],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: [] });

  const rewards = finishRewardCalls(ctx.awardCalls);
  // ceil(6 * 0.5) = 3 paid; pool 100 split 3:2:1 → 51/33/16
  assert.equal(rewards.length, 3);
  assert.deepEqual(
    rewards.map((c) => c.userId),
    ["user-1", "user-2", "user-3"]
  );
  assert.deepEqual(
    rewards.map((c) => c.amount),
    [51, 33, 16]
  );
  // strictly decreasing — higher placement earns more
  assert.ok(rewards[0].amount > rewards[1].amount);
  assert.ok(rewards[1].amount > rewards[2].amount);
  // rank-based refId keyed on placement for idempotency
  assert.deepEqual(
    rewards.map((c) => c.refId),
    ["race-1:rank:1", "race-1:rank:2", "race-1:rank:3"]
  );
  // payoutCoins audit trail mirrors the awards
  assert.deepEqual(ctx.payoutIncrements, [
    { id: "rp-1", amount: 51 },
    { id: "rp-2", amount: 33 },
    { id: "rp-3", amount: 16 },
  ]);
});

test("weekly seeded race uses the larger weekly pool", async () => {
  const participants = [];
  for (let i = 1; i <= 10; i++) {
    participants.push(makeParticipant(`rp-${i}`, `user-${i}`, i, 60000 - i * 1000));
  }
  const ctx = makeDeps({
    race: { id: "race-w", seedId: "seed-weekly-50k", potCoins: 0, participants },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-w", winnerUserId: "user-1", participantUserIds: [] });

  const rewards = finishRewardCalls(ctx.awardCalls);
  // ceil(10 * 0.5) = 5 paid; pool 500
  assert.equal(rewards.length, 5);
  assert.equal(rewards[0].amount, 168);
  assert.equal(
    rewards.reduce((sum, c) => sum + c.amount, 0),
    500
  );
});

test("only people who actually walked are eligible (zero-step entries excluded)", async () => {
  const ctx = makeDeps({
    race: {
      id: "race-1",
      seedId: "seed-daily-10k",
      potCoins: 0,
      participants: [
        makeParticipant("rp-1", "user-1", 1, 5000),
        makeParticipant("rp-2", "user-2", 2, 3000),
        makeParticipant("rp-3", "user-3", 3, 0), // joined, never walked
        makeParticipant("rp-4", "user-4", 4, 0), // joined, never walked
      ],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: [] });

  const rewards = finishRewardCalls(ctx.awardCalls);
  // eligible = 2 walkers → ceil(2 * 0.5) = 1 paid, full pool to placement 1
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].userId, "user-1");
  assert.equal(rewards[0].amount, 100);
});

test("a solo finisher takes the whole pool (no minimum-participant gate)", async () => {
  const ctx = makeDeps({
    race: {
      id: "race-1",
      seedId: "seed-daily-10k",
      potCoins: 0,
      participants: [makeParticipant("rp-1", "user-1", 1, 8000)],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: [] });

  const rewards = finishRewardCalls(ctx.awardCalls);
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].amount, 100);
});

test("non-seeded races pay no finish reward", async () => {
  const ctx = makeDeps({
    race: {
      id: "race-user",
      seedId: null,
      potCoins: 0,
      participants: [
        makeParticipant("rp-1", "user-1", 1, 9000),
        makeParticipant("rp-2", "user-2", 2, 5000),
      ],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-user", winnerUserId: "user-1", participantUserIds: [] });

  assert.equal(finishRewardCalls(ctx.awardCalls).length, 0);
});

test("buy-in pot payouts still work and do not trigger a finish reward", async () => {
  const ctx = makeDeps({
    race: {
      id: "race-1",
      seedId: null,
      potCoins: 375,
      payoutPreset: "WINNER_TAKES_ALL",
      participants: [
        makeParticipant("rp-1", "user-1", 1, 12000),
        makeParticipant("rp-2", "user-2", 2, 9000),
      ],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: [] });

  // legacy pot path pays the winner the full pot
  const potCalls = ctx.awardCalls.filter((c) => c.reason === "race_buy_in_payout");
  assert.equal(potCalls.length, 1);
  assert.equal(potCalls[0].userId, "user-1");
  assert.equal(potCalls[0].amount, 375);
  // and no finish reward on a non-seeded race
  assert.equal(finishRewardCalls(ctx.awardCalls).length, 0);
});

test("an already-completed race pays nothing (single-fire guard)", async () => {
  const ctx = makeDeps({
    updateCount: 0, // updateIfActive matched no ACTIVE row → already completed
    race: {
      id: "race-1",
      seedId: "seed-daily-10k",
      potCoins: 0,
      participants: [makeParticipant("rp-1", "user-1", 1, 8000)],
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  const result = await complete({ raceId: "race-1", winnerUserId: "user-1", participantUserIds: [] });

  assert.equal(result, null);
  assert.equal(ctx.awardCalls.length, 0);
  assert.equal(ctx.payoutIncrements.length, 0);
});
