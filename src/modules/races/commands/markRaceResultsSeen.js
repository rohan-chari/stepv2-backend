const { prisma } = require("../../../db");
const {
  providerSubHash,
  cohortBucket,
} = require("../services/racePayoutDoublePolicy");
const {
  withRacePayoutDoubleTransaction,
} = require("../services/withRacePayoutDoubleTransaction");

class MarkRaceResultsSeenError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "MarkRaceResultsSeenError";
    this.statusCode = statusCode;
  }
}

// Mark the calling user's race-results popup as "seen" for a batch of races.
// Display-only ack: does NOT feed the box/powerup roll gate. Idempotent — a
// single updateMany sets results_seen_at = now() for this user's participant
// rows in the given races. Unknown / non-participant raceIds simply match no
// rows (updateMany ignores them), so the operation is always safe.
function buildMarkRaceResultsSeen(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  return async function markRaceResultsSeen({
    userId,
    raceIds,
    racePayoutDoubleCapability = false,
  }) {
    if (!Array.isArray(raceIds) || raceIds.length === 0) {
      throw new MarkRaceResultsSeenError("raceIds must be a non-empty array", 400);
    }
    if (!raceIds.every((id) => typeof id === "string" && id.length > 0)) {
      throw new MarkRaceResultsSeenError("raceIds must be an array of strings", 400);
    }
    if (!racePayoutDoubleCapability) {
      return db.raceParticipant.updateMany({
        where: { userId, raceId: { in: raceIds } },
        data: { resultsSeenAt: new Date() },
      });
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { appleId: true, googleSub: true },
    });
    const hash = providerSubHash(user);
    return withRacePayoutDoubleTransaction(async (tx) => {
      if (hash) {
        await tx.racePayoutDoubleIdentity.upsert({
          where: { providerSubHash: hash },
          create: { providerSubHash: hash, cohortBucket: cohortBucket(hash) },
          update: {},
        });
        await tx.$queryRaw`SELECT provider_sub_hash FROM race_payout_double_identities WHERE provider_sub_hash = ${hash} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const pendingOffers = await tx.racePayoutDoubleOffer.findMany({
            where: {
              userId,
              status: "PENDING",
              items: { some: { raceIdSnapshot: { in: raceIds } } },
            },
            select: { id: true },
            orderBy: { id: "asc" },
          });
      for (const offer of pendingOffers) {
        await tx.$queryRaw`SELECT id FROM race_payout_double_offers WHERE id = ${offer.id} FOR UPDATE`;
      }
      const lockedItems = pendingOffers.length
        ? await tx.racePayoutDoubleOfferItem.findMany({
            where: { offerId: { in: pendingOffers.map((offer) => offer.id) } },
            select: { id: true, raceParticipantId: true },
            orderBy: { raceParticipantId: "asc" },
          })
        : [];
      for (const item of lockedItems) {
        await tx.$queryRaw`SELECT id FROM race_payout_double_offer_items WHERE id = ${item.id} FOR UPDATE`;
      }
      const participantIds = lockedItems
        .map((item) => item.raceParticipantId)
        .filter(Boolean)
        .sort();
      for (const participantId of participantIds) {
        await tx.$queryRaw`SELECT id FROM race_participants WHERE id = ${participantId} FOR UPDATE`;
      }
      const seen = await tx.raceParticipant.updateMany({
        where: { userId, raceId: { in: raceIds } },
        data: { resultsSeenAt: new Date() },
      });
      if (pendingOffers.length) {
        await tx.racePayoutDoubleOffer.updateMany({
          where: {
            id: { in: pendingOffers.map((offer) => offer.id) },
            status: "PENDING",
          },
          data: { status: "FORFEITED", forfeitedAt: new Date() },
        });
      }
      return seen;
    }, { ...dependencies, prisma: db });
  };
}

const markRaceResultsSeen = buildMarkRaceResultsSeen();

module.exports = {
  buildMarkRaceResultsSeen,
  markRaceResultsSeen,
  MarkRaceResultsSeenError,
};
