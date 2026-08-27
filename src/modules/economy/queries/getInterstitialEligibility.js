const { prisma: defaultPrisma } = require("../../../db");
const {
  DAILY_LIMIT,
  ACQUISITION_GRACE_MS,
  SESSION_GRACE_MS,
  COOLDOWN_MS,
} = require("../constants/interstitialAds");
const { localDateKey, nextLocalMidnight } = require("../lib/interstitialTime");
const { readInterstitialState } = require("../models/interstitialAdState");

function addMilliseconds(date, milliseconds) {
  return new Date(date.getTime() + milliseconds);
}

function baseResponse({ now, capDate, timeZone, dailyCount = 0 }) {
  return {
    eligible: true,
    reason: null,
    dailyCount,
    dailyLimit: DAILY_LIMIT,
    nextEligibleAt: null,
    capDate,
    timeZone,
    serverTime: now.toISOString(),
  };
}

function invalidTimezoneEligibility(now) {
  return {
    ...baseResponse({ now, capDate: null, timeZone: null }),
    eligible: false,
    reason: "invalid_timezone",
  };
}

function evaluateInterstitialEligibility({
  now,
  userCreatedAt,
  sessionStartedAt,
  capDate,
  timeZone,
  state,
}) {
  const response = baseResponse({
    now,
    capDate,
    timeZone,
    dailyCount: state?.dailyCount || 0,
  });
  const acquisitionEndsAt = addMilliseconds(new Date(userCreatedAt), ACQUISITION_GRACE_MS);
  if (now < acquisitionEndsAt) {
    return {
      ...response,
      eligible: false,
      reason: "acquisition_grace",
      nextEligibleAt: acquisitionEndsAt.toISOString(),
    };
  }
  const sessionGraceEndsAt = addMilliseconds(sessionStartedAt, SESSION_GRACE_MS);
  if (now < sessionGraceEndsAt) {
    return {
      ...response,
      eligible: false,
      reason: "session_grace",
      nextEligibleAt: sessionGraceEndsAt.toISOString(),
    };
  }
  if (state.sessionCapped) {
    return { ...response, eligible: false, reason: "session_cap" };
  }
  if (state.activePermit) {
    return {
      ...response,
      eligible: false,
      reason: "permit_active",
      nextEligibleAt: state.activePermit.reservationUntil.toISOString(),
    };
  }
  if (state.dailyCount + state.activeDailyReservations >= DAILY_LIMIT) {
    return {
      ...response,
      eligible: false,
      reason: "daily_cap",
      nextEligibleAt: nextLocalMidnight(now, timeZone).toISOString(),
    };
  }
  if (state.latestReceivedAt) {
    const cooldownEndsAt = addMilliseconds(state.latestReceivedAt, COOLDOWN_MS);
    if (now < cooldownEndsAt) {
      return {
        ...response,
        eligible: false,
        reason: "cooldown",
        nextEligibleAt: cooldownEndsAt.toISOString(),
      };
    }
  }
  return response;
}

function buildGetInterstitialEligibility(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;
  return async function getInterstitialEligibility({
    userId,
    userCreatedAt,
    sessionId,
    sessionStartedAt,
    timeZone,
    now,
    dbOverride,
  }) {
    if (!timeZone) return invalidTimezoneEligibility(now);
    const capDate = localDateKey(now, timeZone);
    const state = await readInterstitialState(dbOverride || db, {
      userId,
      sessionId,
      capDate,
      now,
    });
    return evaluateInterstitialEligibility({
      now,
      userCreatedAt,
      sessionStartedAt,
      capDate,
      timeZone,
      state,
    });
  };
}

const getInterstitialEligibility = buildGetInterstitialEligibility();

module.exports = {
  baseResponse,
  invalidTimezoneEligibility,
  evaluateInterstitialEligibility,
  buildGetInterstitialEligibility,
  getInterstitialEligibility,
};
