const { prisma: defaultPrisma } = require("../../../db");
const {
  DAILY_LIMIT,
  SDK_CALLBACK_GRACE_MS,
} = require("../constants/interstitialAds");
const {
  ensureAndLockInterstitialCap,
  findInterstitialPermit,
  findInterstitialImpressionByEvent,
  createInterstitialImpression,
  countInterstitialImpressionsForCapDate,
  markInterstitialPermitConfirmed,
} = require("../models/interstitialAdState");
const { InterstitialEventConflictError } = require("../errors/interstitialAds");

function responseBody({ idempotent, dailyCount }) {
  return {
    recorded: true,
    idempotent,
    eligible: false,
    reason: "session_cap",
    dailyCount,
    dailyLimit: DAILY_LIMIT,
    nextEligibleAt: null,
  };
}

function permitMatchesRequest(permit, input) {
  return (
    permit &&
    permit.userId === input.userId &&
    permit.placement === input.placement &&
    permit.sessionId === input.sessionId &&
    permit.appVersion === input.appVersion &&
    permit.platform === input.platform
  );
}

function impressionMatchesReplay(impression, input) {
  return (
    impression &&
    impression.userId === input.userId &&
    impression.permitId === input.permitId &&
    impression.placement === input.placement &&
    impression.sessionId === input.sessionId
  );
}

function withinPermitPresentationWindow(permit, occurredAt) {
  return (
    occurredAt >= permit.createdAt &&
    occurredAt <= new Date(permit.showBy.getTime() + SDK_CALLBACK_GRACE_MS)
  );
}

function buildConfirmInterstitialImpression(dependencies = {}) {
  const db = dependencies.prisma || defaultPrisma;

  return async function confirmInterstitialImpression(input) {
    try {
      return await db.$transaction(async (tx) => {
        await ensureAndLockInterstitialCap(tx, input.userId);
        const [permit, existingEvent] = await Promise.all([
          findInterstitialPermit(tx, input.permitId),
          findInterstitialImpressionByEvent(tx, input.eventId),
        ]);

        if (existingEvent) {
          if (!permitMatchesRequest(permit, input) || !impressionMatchesReplay(existingEvent, input)) {
            throw new InterstitialEventConflictError();
          }
          const dailyCount = await countInterstitialImpressionsForCapDate(tx, {
            userId: input.userId,
            capDate: existingEvent.capDate,
          });
          return responseBody({ idempotent: true, dailyCount });
        }

        if (
          !permitMatchesRequest(permit, input) ||
          permit.cancelledAt ||
          permit.confirmedAt ||
          input.now > permit.reservationUntil ||
          !withinPermitPresentationWindow(permit, input.occurredAt)
        ) {
          throw new InterstitialEventConflictError();
        }

        await createInterstitialImpression(tx, {
          eventId: input.eventId,
          permitId: permit.id,
          userId: input.userId,
          placement: input.placement,
          capDate: permit.capDate,
          timeZone: permit.timeZone,
          sessionId: input.sessionId,
          occurredAt: input.occurredAt,
          receivedAt: input.now,
          appVersion: input.appVersion,
          platform: input.platform,
        });
        await markInterstitialPermitConfirmed(tx, permit.id, input.now);
        const dailyCount = await countInterstitialImpressionsForCapDate(tx, {
          userId: input.userId,
          capDate: permit.capDate,
        });
        return responseBody({ idempotent: false, dailyCount });
      });
    } catch (error) {
      // Cross-account callers lock different cap rows, so a deliberately reused
      // global event ID can race at the unique constraint. It still receives
      // the same opaque conflict contract as every other ownership mismatch.
      if (error?.code === "P2002") throw new InterstitialEventConflictError();
      throw error;
    }
  };
}

const confirmInterstitialImpression = buildConfirmInterstitialImpression();

module.exports = {
  responseBody,
  buildConfirmInterstitialImpression,
  confirmInterstitialImpression,
};
