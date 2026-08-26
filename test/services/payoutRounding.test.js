const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  PAYOUT_ROUNDING_V1,
  roundUpToFive,
  buildPayoutPlan,
} = require("../../src/modules/races/services/payoutRounding");
const { buildRaceMoneyView } = require("../../src/modules/races/racePrizePool");

describe("payout rounding v1 — canonical award plan", () => {
  it("keeps zero at zero and rounds every positive recipient award exactly once", () => {
    assert.equal(roundUpToFive(0), 0);
    assert.equal(roundUpToFive(1), 10);
    assert.equal(roundUpToFive(5), 10);
    assert.equal(roundUpToFive(6), 10);
    assert.equal(roundUpToFive(10), 10);
  });

  it("rounds an already-selected raw split per recipient without redistributing it", () => {
    const plan = buildPayoutPlan({
      payoutRoundingVersion: PAYOUT_ROUNDING_V1,
      awards: [
        { recipientId: "first", placement: 1, rawAwardCoins: 7 },
        { recipientId: "second", placement: 2, rawAwardCoins: 2 },
        { recipientId: "third", placement: 3, rawAwardCoins: 1 },
        { recipientId: "zero", placement: 4, rawAwardCoins: 0 },
      ],
    });

    assert.deepEqual(plan.awards, [
      { recipientId: "first", placement: 1, rawAwardCoins: 7, awardCoins: 10, roundingSubsidyCoins: 3 },
      { recipientId: "second", placement: 2, rawAwardCoins: 2, awardCoins: 10, roundingSubsidyCoins: 8 },
      { recipientId: "third", placement: 3, rawAwardCoins: 1, awardCoins: 10, roundingSubsidyCoins: 9 },
      { recipientId: "zero", placement: 4, rawAwardCoins: 0, awardCoins: 0, roundingSubsidyCoins: 0 },
    ]);
    assert.deepEqual(plan.totals, {
      rawAwardCoins: 10,
      awardCoins: 30,
      roundingSubsidyCoins: 20,
      recipientCount: 3,
      smallAwardRecipientCount: 2,
    });
  });

  it("keeps historical and missing version rows byte-for-byte on the legacy split", () => {
    for (const payoutRoundingVersion of [0, null, undefined]) {
      const plan = buildPayoutPlan({
        payoutRoundingVersion,
        awards: [{ recipientId: "winner", placement: 1, rawAwardCoins: 7 }],
      });
      assert.deepEqual(plan.awards, [
        { recipientId: "winner", placement: 1, rawAwardCoins: 7, awardCoins: 7, roundingSubsidyCoins: 0 },
      ]);
      assert.equal(plan.totals.roundingSubsidyCoins, 0);
    }
  });

  it("publishes the v1 team projection from acceptedCount when compact recipients are unavailable", () => {
    const money = buildRaceMoneyView({
      race: {
        status: "ACTIVE",
        fundedPrize: true,
        payoutRoundingVersion: PAYOUT_ROUNDING_V1,
        isTeamRace: true,
        maxDurationDays: 1,
      },
      acceptedCount: 4,
      participants: [],
    });

    assert.equal(money.projectedPotCoins, 80);
    assert.equal(money.prizePool.coins, 80);
    assert.equal(money.prizePool.projected, true);
    assert.deepEqual(money.payouts, [80]);
  });

  it("keeps an explicit funded payout representation for a zero-player forming race", () => {
    const money = buildRaceMoneyView({
      race: {
        status: "PENDING",
        fundedPrize: true,
        payoutRoundingVersion: PAYOUT_ROUNDING_V1,
        isTeamRace: true,
        maxDurationDays: 1,
      },
      acceptedCount: 0,
      participants: [],
    });

    assert.equal(money.projectedPotCoins, 0);
    assert.equal(money.prizePool.coins, 0);
    assert.equal(money.prizePool.projected, true);
    assert.deepEqual(money.payouts, []);
  });
});
