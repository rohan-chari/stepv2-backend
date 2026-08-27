const { capDateValue } = require("../lib/interstitialTime");

async function readInterstitialState(db, {
  userId,
  sessionId,
  capDate,
  now,
}) {
  const capDateAsDate = capDateValue(capDate);
  const activePermitWhere = {
    userId,
    cancelledAt: null,
    confirmedAt: null,
    reservationUntil: { gt: now },
  };
  const [dailyCount, sessionImpression, activePermit, activeDailyReservations, latestImpression] =
    await Promise.all([
      db.interstitialAdImpression.count({ where: { userId, capDate: capDateAsDate } }),
      db.interstitialAdImpression.findFirst({
        where: { userId, sessionId },
        select: { id: true },
      }),
      db.interstitialAdPermit.findFirst({
        where: activePermitWhere,
        orderBy: [{ reservationUntil: "asc" }, { id: "asc" }],
        select: { id: true, reservationUntil: true },
      }),
      db.interstitialAdPermit.count({
        where: { ...activePermitWhere, capDate: capDateAsDate },
      }),
      db.interstitialAdImpression.findFirst({
        where: { userId },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        select: { receivedAt: true },
      }),
    ]);

  return {
    dailyCount,
    sessionCapped: Boolean(sessionImpression),
    activePermit,
    activeDailyReservations,
    latestReceivedAt: latestImpression?.receivedAt || null,
  };
}

async function ensureAndLockInterstitialCap(tx, userId) {
  // Prisma's emulated upsert can race when two independent processes create
  // the first row simultaneously. Postgres ON CONFLICT is the required lazy,
  // atomic initializer; the following FOR UPDATE is the shared admission lock.
  await tx.$executeRaw`
    INSERT INTO "interstitial_ad_caps" ("user_id")
    VALUES (${userId})
    ON CONFLICT ("user_id") DO NOTHING
  `;
  await tx.$queryRaw`
    SELECT "user_id"
    FROM "interstitial_ad_caps"
    WHERE "user_id" = ${userId}
    FOR UPDATE
  `;
}

async function createInterstitialPermit(tx, data) {
  return tx.interstitialAdPermit.create({ data });
}

async function findInterstitialPermit(tx, id) {
  return tx.interstitialAdPermit.findUnique({ where: { id } });
}

async function findInterstitialImpressionByEvent(tx, eventId) {
  return tx.interstitialAdImpression.findUnique({ where: { eventId } });
}

async function createInterstitialImpression(tx, data) {
  return tx.interstitialAdImpression.create({ data });
}

async function countInterstitialImpressionsForCapDate(db, { userId, capDate }) {
  return db.interstitialAdImpression.count({ where: { userId, capDate } });
}

async function markInterstitialPermitConfirmed(tx, permitId, confirmedAt) {
  return tx.interstitialAdPermit.update({
    where: { id: permitId },
    data: { confirmedAt },
  });
}

async function cancelOwnedInterstitialPermit(db, { userId, permitId, now }) {
  return db.interstitialAdPermit.updateMany({
    where: {
      id: permitId,
      userId,
      cancelledAt: null,
      confirmedAt: null,
      reservationUntil: { gt: now },
    },
    data: { cancelledAt: now },
  });
}

module.exports = {
  readInterstitialState,
  ensureAndLockInterstitialCap,
  createInterstitialPermit,
  findInterstitialPermit,
  findInterstitialImpressionByEvent,
  createInterstitialImpression,
  countInterstitialImpressionsForCapDate,
  markInterstitialPermitConfirmed,
  cancelOwnedInterstitialPermit,
};
