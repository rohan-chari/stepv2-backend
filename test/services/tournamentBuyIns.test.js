const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  reserveTournamentBuyIn,
  refundTournamentBuyIn,
  payoutTournamentPot,
  mintChampionPrize,
} = require("../../src/services/tournamentBuyIns");

function recorder() {
  const calls = [];
  return {
    calls,
    awardCoinsFn: async (payload) => {
      calls.push(payload);
      return { awarded: true, coins: 0 };
    },
  };
}

describe("tournamentBuyIns — versioned, idempotent refIds (§7)", () => {
  it("hold uses <tournamentId>:<userId>:v<version> and a negative amount", async () => {
    const { calls, awardCoinsFn } = recorder();
    await reserveTournamentBuyIn({
      awardCoinsFn,
      userId: "u1",
      tournamentId: "t1",
      amount: 50,
      version: 0,
    });
    assert.deepEqual(calls[0], {
      userId: "u1",
      amount: -50,
      reason: "tournament_buy_in_hold",
      refId: "t1:u1:v0",
    });
  });

  it("refund reverses the SAME version it holds", async () => {
    const { calls, awardCoinsFn } = recorder();
    await refundTournamentBuyIn({
      awardCoinsFn,
      userId: "u1",
      tournamentId: "t1",
      amount: 50,
      version: 2,
    });
    assert.deepEqual(calls[0], {
      userId: "u1",
      amount: 50,
      reason: "tournament_buy_in_refund",
      refId: "t1:u1:v2",
    });
  });

  it("re-hold after leave->rejoin bumps the version so it never no-ops", async () => {
    const { calls, awardCoinsFn } = recorder();
    await reserveTournamentBuyIn({ awardCoinsFn, userId: "u1", tournamentId: "t1", amount: 50, version: 1 });
    assert.equal(calls[0].refId, "t1:u1:v1");
  });

  it("pot payout and minted prize share the champion refId but distinct reasons", async () => {
    const { calls, awardCoinsFn } = recorder();
    await payoutTournamentPot({ awardCoinsFn, userId: "champ", tournamentId: "t1", amount: 800 });
    await mintChampionPrize({ awardCoinsFn, userId: "champ", tournamentId: "t1", amount: 150 });
    assert.deepEqual(calls[0], {
      userId: "champ",
      amount: 800,
      reason: "tournament_payout",
      refId: "t1:champion",
    });
    assert.deepEqual(calls[1], {
      userId: "champ",
      amount: 150,
      reason: "tournament_champion_reward",
      refId: "t1:champion",
    });
  });

  it("a zero/absent amount writes NOTHING (free tournament)", async () => {
    const { calls, awardCoinsFn } = recorder();
    await reserveTournamentBuyIn({ awardCoinsFn, userId: "u1", tournamentId: "t1", amount: 0, version: 0 });
    await refundTournamentBuyIn({ awardCoinsFn, userId: "u1", tournamentId: "t1", amount: 0, version: 0 });
    await payoutTournamentPot({ awardCoinsFn, userId: "u1", tournamentId: "t1", amount: 0 });
    await mintChampionPrize({ awardCoinsFn, userId: "u1", tournamentId: "t1", amount: 0 });
    assert.equal(calls.length, 0);
  });
});
