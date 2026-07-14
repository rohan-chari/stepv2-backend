const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCompleteRace } = require("../../src/commands/completeRace");

// ---------------------------------------------------------------------------
// Seeded-race finish reward — on completion, a minted coin pool is split across
// a CONCENTRATED set of top finishers (graded by placement). Both the pool size
// and the number of paid places scale with the field (see
// src/constants/raceFinishReward.js): more racers mint a bigger prize, but the
// paid places are capped so each share stays meaningful rather than dissolving
// into a long 0-coin tail. These races have no buy-in pot, so the legacy
// pot-payout path is skipped.
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

test("daily seeded race splits a graded, descending pool across the concentrated top places", async () => {
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
  // 6 finishers → pool clamps to the 100 floor, places clamp to the 3 minimum;
  // pool 100 split 3:2:1 → 51/33/16.
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
  // 10 finishers → weekly pool clamps to its 500 floor (40*10=400 < floor),
  // places clamp to the 3 minimum; pool 500 split 3:2:1 → 251/166/83.
  assert.equal(rewards.length, 3);
  assert.deepEqual(
    rewards.map((c) => c.amount),
    [251, 166, 83]
  );
  assert.equal(
    rewards.reduce((sum, c) => sum + c.amount, 0),
    500
  );
});

test("a large daily field mints a bigger pool and concentrates the paid places", async () => {
  // The bug being fixed: with a fixed 100-coin pool split across the top 50% of
  // a 100-person field, most "winners" got 0 and 1st earned ~10. Now the pool
  // scales to the minting cap and pays a small, capped set of places — every one
  // of which is a real reward.
  const participants = [];
  for (let i = 1; i <= 100; i++) {
    participants.push(makeParticipant(`rp-${i}`, `user-${i}`, i, 20000 - i * 50));
  }
  const ctx = makeDeps({
    race: { id: "race-big", seedId: "seed-daily-10k", potCoins: 0, participants },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-big", winnerUserId: "user-1", participantUserIds: [] });

  const rewards = finishRewardCalls(ctx.awardCalls);
  // 100 finishers → pool 1500 (cap), 15 paid places (cap), NOT 50.
  assert.equal(rewards.length, 15);
  assert.deepEqual(
    rewards.map((c) => c.userId),
    Array.from({ length: 15 }, (_, i) => `user-${i + 1}`)
  );
  // The whole minted pool is handed out, nothing minted beyond it.
  assert.equal(
    rewards.reduce((sum, c) => sum + c.amount, 0),
    1500
  );
  // Descending, and crucially every paid place clears a meaningful amount —
  // the minTailPayout floor keeps the last place >= 10, no 0-coin "winners".
  for (let i = 1; i < rewards.length; i++) {
    assert.ok(rewards[i - 1].amount >= rewards[i].amount);
  }
  assert.ok(rewards[rewards.length - 1].amount >= 10);
  // 1st place winning a 100-person daily is worth real coins, not ~10.
  assert.ok(rewards[0].amount >= 150);
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
  // eligible = 2 walkers → places clamp down to the field (2), pool 100 split
  // 2:1 → 67/33. The two zero-step entries are excluded entirely.
  assert.equal(rewards.length, 2);
  assert.deepEqual(
    rewards.map((c) => c.userId),
    ["user-1", "user-2"]
  );
  assert.deepEqual(
    rewards.map((c) => c.amount),
    [67, 33]
  );
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

test("field-scaled buy-in payout pays every place but last, descending", async () => {
  // 5-runner buy-in race, everyone ranked at the deadline → 4 paid, last gets 0.
  const participants = [];
  for (let i = 1; i <= 5; i++) {
    participants.push(makeParticipant(`rp-${i}`, `user-${i}`, i, 6000 - i * 500));
  }
  const ctx = makeDeps({
    race: {
      id: "race-abl",
      seedId: null,
      potCoins: 500,
      payoutPreset: "ALL_BUT_LAST",
      participants,
    },
  });
  const complete = buildCompleteRace(ctx.deps);

  await complete({ raceId: "race-abl", winnerUserId: "user-1", participantUserIds: [] });

  const potCalls = ctx.awardCalls.filter((c) => c.reason === "race_buy_in_payout");
  // 5 runners → all but last → 4 paid places (last place, user-5, gets nothing).
  assert.equal(potCalls.length, 4);
  assert.deepEqual(
    potCalls.map((c) => c.userId),
    ["user-1", "user-2", "user-3", "user-4"]
  );
  // descending, distinct refId per placement, and the whole pot is handed out
  for (let i = 1; i < potCalls.length; i++) {
    assert.ok(potCalls[i - 1].amount >= potCalls[i].amount);
  }
  assert.deepEqual(
    potCalls.map((c) => c.refId),
    ["race-abl:1", "race-abl:2", "race-abl:3", "race-abl:4"]
  );
  assert.equal(
    potCalls.reduce((sum, c) => sum + c.amount, 0),
    500
  );
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
