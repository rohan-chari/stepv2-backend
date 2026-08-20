const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");

const REASON = "imposter_retirement";

function validateImposterRetirementPlan(plan) {
  if (!plan || !Array.isArray(plan.owners)) throw new Error("Imposter retirement plan owners are required");
  const owners = plan.owners.map((owner) => ({
    userId: String(owner?.userId || "").trim(),
    units: Array.isArray(owner?.units) ? owner.units : [],
  }));
  if (owners.length !== 4 || new Set(owners.map((owner) => owner.userId)).size !== 4 || owners.some((owner) => !owner.userId)) {
    throw new Error("Imposter retirement requires exactly four distinct owners");
  }
  const units = [];
  for (const owner of owners.sort((a, b) => a.userId.localeCompare(b.userId))) {
    owner.units.forEach((unit, index) => {
      const source = unit?.source;
      const amount = Number(unit?.amount);
      if (!Number.isInteger(amount) || amount <= 0 || !["paid", "free"].includes(source)) {
        throw new Error("Every Imposter unit needs a paid/free source and positive integer amount");
      }
      units.push({
        userId: owner.userId,
        source,
        amount,
        refId: `imposter-retirement:${owner.userId}:${index + 1}`,
      });
    });
  }
  const paid = units.filter((unit) => unit.source === "paid");
  const free = units.filter((unit) => unit.source === "free");
  const paidCoins = paid.reduce((sum, unit) => sum + unit.amount, 0);
  const freeCoins = free.reduce((sum, unit) => sum + unit.amount, 0);
  const totalCoins = paidCoins + freeCoins;
  if (units.length !== 5 || paidCoins !== 575 || free.length !== 3 || free.some((unit) => unit.amount !== 75) || freeCoins !== 225 || totalCoins !== 800) {
    throw new Error("Imposter retirement must compensate exactly 800 coins for five units (575 paid + three free at 75)");
  }
  return { owners, units, ownerCount: owners.length, unitCount: units.length, paidCoins, freeCoins, totalCoins };
}

async function remediateImposterInventory({ tx, plan, awardCoins = defaultAwardCoins }) {
  const validated = validateImposterRetirementPlan(plan);
  await tx.$queryRaw`SELECT id FROM user_powerup_items WHERE powerup_type::text = 'imposter' ORDER BY user_id FOR UPDATE`;
  const inventory = await tx.userPowerupItem.findMany({ where: { powerupType: "IMPOSTER", quantity: { gt: 0 } }, orderBy: { userId: "asc" } });
  const heldCount = await tx.racePowerup.count({ where: { type: "IMPOSTER", status: "HELD" } });
  const liveEffectCount = await tx.raceActiveEffect.count({ where: { type: "IMPOSTER", status: "ACTIVE" } });
  const existingLedger = await tx.coinTransaction.findMany({
    where: { reason: REASON },
    select: { userId: true, amount: true, refId: true },
    orderBy: { refId: "asc" },
  });
  if (heldCount !== 0 || liveEffectCount !== 0) throw new Error("Imposter remediation requires zero HELD units and zero live effects");

  const expectedByUser = new Map(validated.owners.map((owner) => [owner.userId, owner.units.length]));
  const inventoryTotal = inventory.reduce((sum, row) => sum + row.quantity, 0);
  const expectedLedger = [...validated.units]
    .map(({ refId, userId, amount }) => ({ refId, userId, amount }))
    .sort((a, b) => a.refId.localeCompare(b.refId));
  const actualLedger = [...existingLedger].sort((a, b) => a.refId.localeCompare(b.refId));
  const ledgerComplete =
    actualLedger.length === 5 &&
    actualLedger.reduce((sum, row) => sum + row.amount, 0) === 800 &&
    expectedLedger.every((expected, index) => {
      const actual = actualLedger[index];
      return actual?.refId === expected.refId &&
        actual.userId === expected.userId &&
        actual.amount === expected.amount;
    });
  if (inventoryTotal === 0) {
    if (!ledgerComplete) {
      throw new Error("Imposter inventory is zero without the exact five-row retirement ledger totaling 800 coins");
    }
    return { alreadyApplied: true, unitsRemoved: 5, coinsAwarded: 800 };
  }
  if (existingLedger.length !== 0) {
    throw new Error("First Imposter apply requires zero retirement-reason ledger rows");
  }
  if (inventoryTotal !== 5 || inventory.length !== 4 || inventory.some((row) => expectedByUser.get(row.userId) !== row.quantity)) {
    throw new Error("Live Imposter inventory does not exactly match the audited four-owner/five-unit plan");
  }
  for (const unit of validated.units) {
    await awardCoins({ tx, userId: unit.userId, amount: unit.amount, reason: REASON, refId: unit.refId });
  }
  await tx.userPowerupItem.updateMany({ where: { powerupType: "IMPOSTER", quantity: { gt: 0 } }, data: { quantity: 0 } });
  return { alreadyApplied: false, unitsRemoved: 5, coinsAwarded: 800 };
}

module.exports = { REASON, remediateImposterInventory, validateImposterRetirementPlan };
