const { Prisma } = require("@prisma/client");
const { awardCoins: defaultAwardCoins } = require("../../../shared/economy/awardCoins");

function validateParticipant(entry, label) {
  const normalized = {
    participantId: String(entry?.participantId || "").trim(),
    userId: String(entry?.userId || "").trim(),
    raceId: String(entry?.raceId || "").trim(),
    buyInAmount: Number(entry?.buyInAmount),
  };
  if (!normalized.participantId || !normalized.userId || !normalized.raceId || !Number.isInteger(normalized.buyInAmount) || normalized.buyInAmount <= 0) {
    throw new Error(`${label} contains an invalid participant evidence row`);
  }
  return normalized;
}

function validateLedgerRows(rows, label, { negative }) {
  if (!Array.isArray(rows)) throw new Error(`${label} evidence is required`);
  const normalized = rows.map((row) => ({
    refId: String(row?.refId || "").trim(),
    userId: String(row?.userId || "").trim(),
    amount: Number(row?.amount),
  }));
  if (
    normalized.length !== 36 ||
    new Set(normalized.map((row) => row.refId)).size !== 36 ||
    normalized.some((row) =>
      !row.refId || !row.userId || !Number.isInteger(row.amount) ||
      (negative ? row.amount >= 0 : row.amount <= 0))
  ) {
    throw new Error(`${label} must contain exactly 36 distinct signed ledger rows`);
  }
  return normalized.sort((a, b) => a.refId.localeCompare(b.refId));
}

function validateLegacyBuyInPlan(plan) {
  const completedRaceIds = [...new Set((plan?.completedRaceIds || []).map(String))].sort();
  if (completedRaceIds.length !== 8) throw new Error("Legacy buy-in remediation requires exactly eight completed race IDs");
  const pendingRaceId = String(plan?.pendingRaceId || "").trim();
  if (!pendingRaceId || completedRaceIds.includes(pendingRaceId)) throw new Error("Legacy buy-in remediation requires one distinct pending race ID");
  const completedParticipants = (plan?.completedParticipants || []).map((entry) => validateParticipant(entry, "completedParticipants"));
  const pendingParticipants = (plan?.pendingParticipants || []).map((entry) => validateParticipant(entry, "pendingParticipants"));
  if (completedParticipants.length !== 40 || new Set(completedParticipants.map((row) => row.participantId)).size !== 40 || completedParticipants.some((row) => !completedRaceIds.includes(row.raceId)) || completedParticipants.reduce((sum, row) => sum + row.buyInAmount, 0) !== 1155) {
    throw new Error("Legacy buy-in completed evidence must contain 40 unique markers totaling 1,155 nominal coins across exactly eight races");
  }
  if (pendingParticipants.length !== 2 || new Set(pendingParticipants.map((row) => row.participantId)).size !== 2 || pendingParticipants.some((row) => row.raceId !== pendingRaceId) || pendingParticipants.reduce((sum, row) => sum + row.buyInAmount, 0) !== 300) {
    throw new Error("Legacy buy-in pending evidence must contain two unique markers totaling 300 nominal coins");
  }
  const chargedDebits = validateLedgerRows(plan?.chargedDebits, "chargedDebits", { negative: true });
  const expectedRefunds = validateLedgerRows(plan?.expectedRefunds, "expectedRefunds", { negative: false });
  if (chargedDebits.reduce((sum, row) => sum + row.amount, 0) !== -830) {
    throw new Error("chargedDebits must total exactly -830 coins");
  }
  if (expectedRefunds.reduce((sum, row) => sum + row.amount, 0) !== 830) {
    throw new Error("expectedRefunds must total exactly 830 coins");
  }
  const participantByRef = new Map(
    completedParticipants.map((row) => [`${row.raceId}:${row.userId}`, row]),
  );
  for (let index = 0; index < chargedDebits.length; index += 1) {
    const debit = chargedDebits[index];
    const refund = expectedRefunds[index];
    const participant = participantByRef.get(debit.refId);
    if (
      !participant || participant.userId !== debit.userId ||
      refund?.refId !== debit.refId || refund.userId !== debit.userId ||
      refund.amount !== Math.abs(debit.amount)
    ) {
      throw new Error("Legacy buy-in debit/refund evidence must pin exact refId, userId, and amount pairs");
    }
  }
  return {
    completedRaceIds,
    pendingRaceId,
    completedParticipants,
    pendingParticipants,
    chargedDebits,
    expectedRefunds,
  };
}

function exactLedgerMatch(actualRows, expectedRows) {
  const actual = [...actualRows].sort((a, b) => a.refId.localeCompare(b.refId));
  return actual.length === expectedRows.length && expectedRows.every((expected, index) => {
    const row = actual[index];
    return row?.refId === expected.refId &&
      row.userId === expected.userId &&
      row.amount === expected.amount;
  });
}

async function remediateLegacyBuyIns({ tx, plan, awardCoins = defaultAwardCoins }) {
  const validated = validateLegacyBuyInPlan(plan);
  const raceIds = [...validated.completedRaceIds, validated.pendingRaceId];
  const participantIds = [...validated.completedParticipants, ...validated.pendingParticipants].map((row) => row.participantId);
  await tx.$queryRaw`SELECT id FROM races WHERE id IN (${Prisma.join(raceIds)}) ORDER BY id FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM race_participants WHERE id IN (${Prisma.join(participantIds)}) ORDER BY id FOR UPDATE`;
  const races = await tx.race.findMany({ where: { id: { in: raceIds } }, select: { id: true, status: true } });
  const participants = await tx.raceParticipant.findMany({ where: { id: { in: participantIds } }, select: { id: true, userId: true, raceId: true, buyInAmount: true, buyInStatus: true } });
  if (races.length !== 9 || validated.completedRaceIds.some((id) => races.find((race) => race.id === id)?.status !== "COMPLETED")) throw new Error("Audited completed races no longer match completed immutable state");
  const pendingRace = races.find((race) => race.id === validated.pendingRaceId);
  if (!pendingRace || !["PENDING", "CANCELLED"].includes(pendingRace.status)) throw new Error("Audited pending lobby no longer matches pending/cancelled state");
  const actualById = new Map(participants.map((row) => [row.id, row]));
  for (const expected of [...validated.completedParticipants, ...validated.pendingParticipants]) {
    const actual = actualById.get(expected.participantId);
    if (!actual || actual.userId !== expected.userId || actual.raceId !== expected.raceId || actual.buyInAmount !== expected.buyInAmount) throw new Error(`Participant evidence drift for ${expected.participantId}`);
  }
  const refs = validated.chargedDebits.map((row) => row.refId);
  const holds = await tx.coinTransaction.findMany({ where: { reason: "race_buy_in_hold", refId: { in: refs } }, select: { userId: true, amount: true, refId: true } });
  const refunds = await tx.coinTransaction.findMany({ where: { reason: "race_buy_in_refund", refId: { in: refs } }, select: { userId: true, amount: true, refId: true } });
  const pendingHolds = await tx.coinTransaction.findMany({ where: { reason: "race_buy_in_hold", refId: { in: validated.pendingParticipants.map((row) => `${row.raceId}:${row.userId}`) } }, select: { id: true } });
  if (pendingHolds.length !== 0) throw new Error("Pending May lobby unexpectedly has a debit; refusing to mint or cancel automatically");
  if (!exactLedgerMatch(holds, validated.chargedDebits)) {
    throw new Error("Completed buy-in debit ledger does not exactly match audited refId/userId/amount evidence");
  }
  const chargedRefs = new Set(refs);
  const charged = validated.completedParticipants.filter((row) => chargedRefs.has(`${row.raceId}:${row.userId}`));
  const fullyApplied = exactLedgerMatch(refunds, validated.expectedRefunds) &&
    charged.every((row) => actualById.get(row.participantId)?.buyInStatus === "REFUNDED") &&
    validated.completedParticipants.filter((row) => !chargedRefs.has(`${row.raceId}:${row.userId}`)).every((row) => actualById.get(row.participantId)?.buyInStatus === "NONE") && validated.pendingParticipants.every((row) => actualById.get(row.participantId)?.buyInStatus === "NONE") && pendingRace.status === "CANCELLED";
  if (fullyApplied) return { alreadyApplied: true, refundedCoins: 830, refundedParticipants: 36, unchargedParticipants: 6 };
  if (refunds.length !== 0 || participants.some((row) => row.buyInStatus !== "HELD") || pendingRace.status !== "PENDING") throw new Error("Partial legacy buy-in remediation detected; refusing non-audited recovery");
  for (const row of charged) {
    const refId = `${row.raceId}:${row.userId}`;
    const refund = validated.expectedRefunds.find((entry) => entry.refId === refId);
    await awardCoins({ tx, userId: refund.userId, amount: refund.amount, reason: "race_buy_in_refund", refId });
    await tx.raceParticipant.update({ where: { id: row.participantId }, data: { buyInStatus: "REFUNDED" } });
  }
  const unchargedIds = validated.completedParticipants.filter((row) => !chargedRefs.has(`${row.raceId}:${row.userId}`)).map((row) => row.participantId);
  await tx.raceParticipant.updateMany({ where: { id: { in: [...unchargedIds, ...validated.pendingParticipants.map((row) => row.participantId)] } }, data: { buyInStatus: "NONE" } });
  await tx.race.update({ where: { id: validated.pendingRaceId }, data: { status: "CANCELLED" } });
  return { alreadyApplied: false, refundedCoins: 830, refundedParticipants: 36, unchargedParticipants: 6 };
}

module.exports = { remediateLegacyBuyIns, validateLegacyBuyInPlan };
