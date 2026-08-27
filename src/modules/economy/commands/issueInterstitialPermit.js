const { prisma: defaultPrisma } = require("../../../db");
const {
  SHOW_WINDOW_MS,
  RESERVATION_WINDOW_MS,
} = require("../constants/interstitialAds");
const { localDateKey, capDateValue } = require("../lib/interstitialTime");
const {
  ensureAndLockInterstitialCap,
  createInterstitialPermit,
} = require("../models/interstitialAdState");
const {
  buildGetInterstitialEligibility,
  invalidTimezoneEligibility,
} = require("../queries/getInterstitialEligibility");

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds);
}

function buildIssueInterstitialPermit(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  const getEligibility = dependencies.getInterstitialEligibility ||
    buildGetInterstitialEligibility({ ...dependencies, prisma: db });

  return async function issueInterstitialPermit({
    userId,
    userCreatedAt,
    placement,
    sessionId,
    sessionStartedAt,
    appVersion,
    platform,
    timeZone,
    now,
  }) {
    if (!timeZone) {
      return { status: 200, body: { ...invalidTimezoneEligibility(now), permit: null } };
    }
    return db.$transaction(async (tx) => {
      await ensureAndLockInterstitialCap(tx, userId);
      const eligibility = await getEligibility({
        userId,
        userCreatedAt,
        sessionId,
        sessionStartedAt,
        timeZone,
        now,
        dbOverride: tx,
      });
      if (!eligibility.eligible) {
        return { status: 200, body: { ...eligibility, permit: null } };
      }

      const showBy = addMilliseconds(now, SHOW_WINDOW_MS);
      const reservationUntil = addMilliseconds(now, RESERVATION_WINDOW_MS);
      const permit = await createInterstitialPermit(tx, {
        userId,
        placement,
        sessionId,
        capDate: capDateValue(localDateKey(now, timeZone)),
        timeZone,
        appVersion,
        platform,
        createdAt: now,
        showBy,
        reservationUntil,
      });
      return {
        status: 201,
        body: {
          eligible: true,
          permit: {
            id: permit.id,
            placement: permit.placement,
            sessionId: permit.sessionId,
            showBy: permit.showBy.toISOString(),
            reservationUntil: permit.reservationUntil.toISOString(),
          },
          capDate: localDateKey(now, timeZone),
          timeZone,
          serverTime: now.toISOString(),
        },
      };
    });
  };
}

const issueInterstitialPermit = buildIssueInterstitialPermit();

module.exports = { buildIssueInterstitialPermit, issueInterstitialPermit };
