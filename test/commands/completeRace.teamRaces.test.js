const assert = require("node:assert/strict");
const test = require("node:test");

const { buildCompleteRace } = require("../../src/modules/races/commands/completeRace");

function member(userId, team, overrides = {}) {
  return {
    id: `rp-${userId}`,
    userId,
    status: "ACCEPTED",
    team,
    totalSteps: 0,
    buyInAmount: 0,
    buyInStatus: "NONE",
    forfeitedAt: null,
    placement: null,
    joinedAt: new Date("2026-07-01T00:00:00Z"),
    user: { displayName: userId },
    ...overrides,
  };
}

function makeDeps({ race }) {
  const state = {
    raceUpdate: null,
    placements: {},
    payouts: [],
    awards: [],
    participantUpdates: [],
  };
  return {
    state,
    deps: {
      Race: {
        async updateIfActive(id, fields) {
          state.raceUpdate = fields;
          race.status = "COMPLETED";
          return { count: 1 };
        },
        async findById() {
          return race;
        },
        async update(id, fields) {
          Object.assign(race, fields);
          return race;
        },
      },
      RaceParticipant: {
        async setPlacement(id, placement) {
          state.placements[id] = placement;
        },
        async incrementPayoutCoins(id, amount) {
          state.payouts.push({ id, amount });
        },
        async update(id, fields) {
          state.participantUpdates.push({ id, fields });
        },
      },
      RacePowerup: {
        async expireAllForRace() {},
      },
      RaceActiveEffect: {
        async expireAllForRace() {},
      },
      awardCoins: async (payload) => {
        state.awards.push(payload);
        return {};
      },
      grantReferralRewardsForRace: async () => [],
      eventBus: { emit() {} },
    },
  };
}

function teamRace(participants, overrides = {}) {
  return {
    id: "race-1",
    name: "Team Battle",
    status: "ACTIVE",
    isTeamRace: true,
    teamSize: 3,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    buyInAmount: 30,
    potCoins: 0,
    payoutPreset: "WINNER_TAKES_ALL",
    seedId: null,
    participants,
    ...overrides,
  };
}

// ── TR-402: winnerTeam recorded, winnerUserId null ──────────────────────────
test("TR-402 completeRace records winnerTeam and keeps winnerUserId null", async () => {
  const race = teamRace([
    member("a1", "TEAM_A", { totalSteps: 100 }),
    member("b1", "TEAM_B", { totalSteps: 50 }),
  ]);
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: "TEAM_A",
    participantUserIds: ["a1", "b1"],
  });
  assert.equal(ctx.state.raceUpdate.winnerTeam, "TEAM_A");
  assert.equal(ctx.state.raceUpdate.winnerUserId, null);
});

// ── TR-403: placements 1 for winners, 2 for losers (forfeiters included) ────
test("TR-403 winning team all placement 1, losing team 2, forfeiters keep team placement", async () => {
  const race = teamRace([
    member("a1", "TEAM_A", { totalSteps: 100 }),
    member("a2", "TEAM_A", {
      totalSteps: 40,
      forfeitedAt: new Date("2026-07-02T00:00:00Z"),
    }),
    member("b1", "TEAM_B", { totalSteps: 90 }),
    member("b2", "TEAM_B", { totalSteps: 10 }),
  ]);
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: "TEAM_A",
    participantUserIds: ["a1", "a2", "b1", "b2"],
  });
  assert.equal(ctx.state.placements["rp-a1"], 1);
  assert.equal(ctx.state.placements["rp-a2"], 1);
  assert.equal(ctx.state.placements["rp-b1"], 2);
  assert.equal(ctx.state.placements["rp-b2"], 2);
});

// ── TR-502/503: pot split among non-forfeited winners, forfeiter gets 0 ─────
test("TR-502/503 3v3 pot 180, one winner forfeited -> two active winners get 90 each", async () => {
  const race = teamRace(
    [
      member("a1", "TEAM_A", { totalSteps: 100, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("a2", "TEAM_A", { totalSteps: 80, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("a3", "TEAM_A", {
        totalSteps: 60,
        buyInAmount: 30,
        buyInStatus: "COMMITTED",
        forfeitedAt: new Date("2026-07-02T00:00:00Z"),
      }),
      member("b1", "TEAM_B", { totalSteps: 90, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("b2", "TEAM_B", { totalSteps: 70, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("b3", "TEAM_B", { totalSteps: 50, buyInAmount: 30, buyInStatus: "COMMITTED" }),
    ],
    { potCoins: 180 }
  );
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: "TEAM_A",
    participantUserIds: ["a1", "a2", "a3", "b1", "b2", "b3"],
  });

  const byUser = {};
  for (const award of ctx.state.awards) {
    byUser[award.userId] = (byUser[award.userId] || 0) + award.amount;
  }
  assert.equal(byUser.a1, 90);
  assert.equal(byUser.a2, 90);
  assert.equal(byUser.a3 ?? 0, 0, "forfeiter gets no cut");
  assert.equal(byUser.b1 ?? 0, 0);
});

// ── TR-504: floor + remainder to top stepper, earliest joinedAt tiebreak ────
test("TR-504 pot 100 / 3 winners -> 33/33/33 + 1 extra to top stepper", async () => {
  const race = teamRace(
    [
      member("a1", "TEAM_A", { totalSteps: 50, buyInAmount: 0 }),
      member("a2", "TEAM_A", { totalSteps: 90, buyInAmount: 0 }),
      member("a3", "TEAM_A", { totalSteps: 70, buyInAmount: 0 }),
      member("b1", "TEAM_B", { totalSteps: 10 }),
      member("b2", "TEAM_B", { totalSteps: 10 }),
      member("b3", "TEAM_B", { totalSteps: 10 }),
    ],
    { potCoins: 100 }
  );
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: "TEAM_A",
    participantUserIds: ["a1", "a2", "a3", "b1", "b2", "b3"],
  });
  const byUser = {};
  for (const award of ctx.state.awards) {
    byUser[award.userId] = (byUser[award.userId] || 0) + award.amount;
  }
  assert.equal(byUser.a2, 34, "top stepper gets the remainder");
  assert.equal(byUser.a1, 33);
  assert.equal(byUser.a3, 33);
});

test("TR-504 remainder tiebreak: equal steps -> earliest joinedAt wins the extra coin", async () => {
  const race = teamRace(
    [
      member("a1", "TEAM_A", {
        totalSteps: 90,
        joinedAt: new Date("2026-07-01T10:00:00Z"),
      }),
      member("a2", "TEAM_A", {
        totalSteps: 90,
        joinedAt: new Date("2026-07-01T09:00:00Z"),
      }),
      member("b1", "TEAM_B", { totalSteps: 10 }),
      member("b2", "TEAM_B", { totalSteps: 10 }),
    ],
    { potCoins: 101 }
  );
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: "TEAM_A",
    participantUserIds: ["a1", "a2", "b1", "b2"],
  });
  const byUser = {};
  for (const award of ctx.state.awards) {
    byUser[award.userId] = (byUser[award.userId] || 0) + award.amount;
  }
  assert.equal(byUser.a2, 51, "earliest joinedAt takes the extra coin");
  assert.equal(byUser.a1, 50);
});

// ── TR-404: tie refunds everyone, all placement 1 ───────────────────────────
test("TR-404 tie: winnerTeam null, all placement 1, every paid buy-in refunded incl. forfeiters", async () => {
  const race = teamRace(
    [
      member("a1", "TEAM_A", { totalSteps: 50, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("a2", "TEAM_A", {
        totalSteps: 50,
        buyInAmount: 30,
        buyInStatus: "COMMITTED",
        forfeitedAt: new Date("2026-07-02T00:00:00Z"),
      }),
      member("b1", "TEAM_B", { totalSteps: 60, buyInAmount: 30, buyInStatus: "COMMITTED" }),
      member("b2", "TEAM_B", { totalSteps: 40, buyInAmount: 30, buyInStatus: "COMMITTED" }),
    ],
    { potCoins: 120 }
  );
  const ctx = makeDeps({ race });
  const completeRace = buildCompleteRace(ctx.deps);
  await completeRace({
    raceId: "race-1",
    winnerTeam: null,
    tie: true,
    participantUserIds: ["a1", "a2", "b1", "b2"],
  });

  assert.equal(ctx.state.raceUpdate.winnerTeam, null);
  for (const id of ["rp-a1", "rp-a2", "rp-b1", "rp-b2"]) {
    assert.equal(ctx.state.placements[id], 1, `${id} placement 1 on tie`);
  }
  const refunds = ctx.state.awards.filter(
    (a) => a.reason === "race_buy_in_refund"
  );
  assert.equal(refunds.length, 4, "all four refunded, incl. the forfeiter");
  for (const refund of refunds) assert.equal(refund.amount, 30);
  const refundedRows = ctx.state.participantUpdates.filter(
    (u) => u.fields.buyInStatus === "REFUNDED"
  );
  assert.equal(refundedRows.length, 4);
  const payouts = ctx.state.awards.filter(
    (a) => a.reason === "race_buy_in_payout"
  );
  assert.equal(payouts.length, 0, "no payouts on a tie");
});
