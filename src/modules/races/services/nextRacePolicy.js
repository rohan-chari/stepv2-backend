const { prisma: defaultPrisma } = require("../../../db");
const { withAdvisoryLock } = require("../../../shared/db/withAdvisoryLock");
const {
  liveUserCreatedRaceReadBatch,
} = require("./liveUserCreatedRaceReadBatch");

const FEATURE = "next_race_cta";
const QUICK_SOURCE = "QUICK_CREATE";
const AUTO_START_POLICY = "ON_MINIMUM_PARTICIPANTS";
// A single walking stream earns independently in every quick race. Keep this
// server-authoritative for capable and frozen clients so prize/box reuse stays
// bounded. The owner-approved V1 adjustment raised the bound from 3 to 5.
const MAX_LIVE_QUICK_MEMBERSHIPS = 5;
const QUICK_MEMBERSHIP_LIMIT_MESSAGE =
  `You're already in ${MAX_LIVE_QUICK_MEMBERSHIPS} races that start automatically. ` +
  "Try again after one is over.";

function supportsNextRace(clientFeatures) {
  return clientFeatures?.has(FEATURE) === true;
}

function hasAnyQuickMetadata({ creationSource, startPolicy }) {
  return creationSource != null || startPolicy != null;
}

function isExactQuickPair({ creationSource, startPolicy }) {
  return creationSource === QUICK_SOURCE && startPolicy === AUTO_START_POLICY;
}

function isSupportedQuickConfig(input) {
  return (
    isExactQuickPair(input) &&
    (input.maxDurationDays === 2 || input.maxDurationDays === 7) &&
    input.isPublic === true &&
    Number(input.buyInAmount ?? 0) === 0 &&
    input.payoutPreset === "TOP3_70_20_10" &&
    input.powerupsEnabled === true &&
    Number(input.powerupStepInterval) === 2000 &&
    Number(input.maxParticipants) === 10 &&
    input.isTeamRace !== true
  );
}

async function hasLiveUserCreatedRace(userId, { prisma = defaultPrisma } = {}) {
  if (!userId) return false;
  if (prisma === defaultPrisma) {
    return liveUserCreatedRaceReadBatch.hasLive({ prisma, userId });
  }
  const row = await prisma.raceParticipant.findFirst({
    where: {
      userId,
      status: "ACCEPTED",
      race: {
        creatorId: { not: null },
        status: { in: ["PENDING", "ACTIVE"] },
      },
    },
    select: { id: true },
  });
  return row != null;
}

async function countLiveQuickMemberships(userId, { prisma = defaultPrisma } = {}) {
  return prisma.raceParticipant.count({
    where: {
      userId,
      status: "ACCEPTED",
      race: {
        creationSource: QUICK_SOURCE,
        status: { in: ["PENDING", "ACTIVE"] },
      },
    },
  });
}

function withQuickMembershipLock(userId, callback) {
  return withAdvisoryLock(`quick-membership:${userId}`, callback);
}

module.exports = {
  FEATURE,
  QUICK_SOURCE,
  AUTO_START_POLICY,
  MAX_LIVE_QUICK_MEMBERSHIPS,
  QUICK_MEMBERSHIP_LIMIT_MESSAGE,
  supportsNextRace,
  hasAnyQuickMetadata,
  isExactQuickPair,
  isSupportedQuickConfig,
  hasLiveUserCreatedRace,
  countLiveQuickMemberships,
  withQuickMembershipLock,
};
