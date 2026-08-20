const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateImposterRetirementPlan,
} = require("../../src/modules/powerups/services/imposterRetirementRemediation");
const {
  validateLegacyBuyInPlan,
} = require("../../src/modules/races/services/legacyBuyInRemediation");

function validImposterPlan() {
  return {
    owners: [
      { userId: "u1", units: [{ source: "paid", amount: 300 }, { source: "free", amount: 75 }] },
      { userId: "u2", units: [{ source: "paid", amount: 275 }] },
      { userId: "u3", units: [{ source: "free", amount: 75 }] },
      { userId: "u4", units: [{ source: "free", amount: 75 }] },
    ],
  };
}

test("Imposter retirement plan pins four owners, five units, and exactly 800 coins", () => {
  const result = validateImposterRetirementPlan(validImposterPlan());
  assert.deepEqual(
    { owners: result.ownerCount, units: result.unitCount, paid: result.paidCoins, free: result.freeCoins, total: result.totalCoins },
    { owners: 4, units: 5, paid: 575, free: 225, total: 800 },
  );
});

test("Imposter retirement plan rejects inferred or mismatched compensation", () => {
  const bad = validImposterPlan();
  bad.owners[0].units[0].amount = 301;
  assert.throws(() => validateImposterRetirementPlan(bad), /exactly 800 coins/);
});

test("legacy buy-in plan pins eight completed races and one pending lobby", () => {
  const completedRaceIds = Array.from({ length: 8 }, (_, index) => `done-${index}`);
  const completedParticipants = Array.from({ length: 40 }, (_, index) => ({
    participantId: `participant-${index}`,
    userId: `user-${index}`,
    raceId: completedRaceIds[index % completedRaceIds.length],
    buyInAmount: index < 39 ? 25 : 180,
  }));
  const chargedDebits = completedParticipants.slice(0, 36).map((row, index) => ({
    refId: `${row.raceId}:${row.userId}`,
    userId: row.userId,
    amount: index === 35 ? -130 : -20,
  }));
  const result = validateLegacyBuyInPlan({
    completedRaceIds,
    completedParticipants,
    pendingRaceId: "pending-1",
    pendingParticipants: [
      { participantId: "pending-p1", userId: "pending-u1", raceId: "pending-1", buyInAmount: 150 },
      { participantId: "pending-p2", userId: "pending-u2", raceId: "pending-1", buyInAmount: 150 },
    ],
    chargedDebits,
    expectedRefunds: chargedDebits.map((row) => ({
      ...row,
      amount: Math.abs(row.amount),
    })),
  });
  assert.equal(result.completedRaceIds.length, 8);
  assert.equal(result.pendingRaceId, "pending-1");
  assert.equal(result.completedParticipants.length, 40);
  assert.equal(result.chargedDebits.length, 36);
});

test("legacy buy-in plan rejects duplicate or incomplete evidence", () => {
  assert.throws(
    () => validateLegacyBuyInPlan({ completedRaceIds: ["one"], pendingRaceId: "pending" }),
    /exactly eight/,
  );
});
