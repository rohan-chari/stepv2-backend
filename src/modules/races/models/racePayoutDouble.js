const { prisma } = require("../../../db");

const ELIGIBLE_REASONS = [
  "race_prize_pool_payout",
  "race_finish_reward",
];

function exactSources(participant) {
  if (!Number.isInteger(participant?.placement) || participant.placement <= 0) return [];
  return [
    {
      reason: "race_prize_pool_payout",
      refId: `${participant.raceId}:${participant.placement}`,
    },
    {
      reason: "race_finish_reward",
      refId: `${participant.raceId}:rank:${participant.placement}`,
    },
  ];
}

async function eligibleItemsForParticipants(db, userId, participants) {
  if (!participants.length) return [];
  const predicates = participants.flatMap((participant) =>
    exactSources(participant).map((source) => ({
      reason: source.reason,
      refId: source.refId,
    })),
  );
  if (!predicates.length) return [];
  const rows = await db.coinTransaction.findMany({
    where: {
      userId,
      amount: { gt: 0 },
      reason: { in: ELIGIBLE_REASONS },
      OR: predicates,
    },
    select: { reason: true, refId: true, amount: true },
  });
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.reason}\u0000${row.refId}`;
    const list = byKey.get(key) || [];
    list.push(row);
    byKey.set(key, list);
  }
  const items = [];
  for (const participant of participants) {
    const matches = exactSources(participant).flatMap(
      (source) => byKey.get(`${source.reason}\u0000${source.refId}`) || [],
    );
    // A race paid through multiple eligible namespaces is anomalous. Fail it
    // closed rather than combine a malformed/mixed settlement.
    if (matches.length !== 1) continue;
    const source = matches[0];
    items.push({
      raceParticipantId: participant.id,
      raceId: participant.raceId,
      raceIdSnapshot: participant.raceId,
      placementSnapshot: participant.placement,
      eligibleCoins: source.amount,
      sourceReason: source.reason,
      sourceRefId: source.refId,
    });
  }
  return items;
}

function buildRacePayoutDoubleModel(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  return {
    findPending(userId) {
      return db.racePayoutDoubleOffer.findFirst({
        where: { userId, status: "PENDING" },
        include: { items: { orderBy: { raceIdSnapshot: "asc" } } },
      });
    },
    findOfferedParticipantIds(participantIds) {
      if (!participantIds.length) return Promise.resolve([]);
      return db.racePayoutDoubleOfferItem.findMany({
        where: { raceParticipantId: { in: participantIds } },
        select: { raceParticipantId: true },
      });
    },
    eligibleItems(userId, participants) {
      return eligibleItemsForParticipants(db, userId, participants);
    },
  };
}

const RacePayoutDouble = buildRacePayoutDoubleModel();

module.exports = {
  ELIGIBLE_REASONS,
  exactSources,
  eligibleItemsForParticipants,
  buildRacePayoutDoubleModel,
  RacePayoutDouble,
};
