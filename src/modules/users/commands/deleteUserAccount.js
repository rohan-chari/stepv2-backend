const { prisma } = require("../../../db");
const {
  profilePhotoStorage: defaultProfilePhotoStorage,
} = require("../services/profilePhotoStorage");

const SENTINEL_APPLE_ID = "__deleted_user_sentinel__";
const {
  providerSubHash,
  cohortBucket,
} = require("../../races/services/racePayoutDoublePolicy");
const { buildLeaderboardEligibilityEpoch } = require("../../../shared/config/leaderboardEligibilityEpoch");
const {
  lockFundedExposureUsers,
} = require("../../races/services/fundedExposure");
const {
  acquireRaceWriteFences,
  lockCompetitionRows,
} = require("../../races/services/raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
} = require("../../steps/services/globalEventEnrollment");

const MEMBERSHIP_SCOPE_DRIFT = "MEMBERSHIP_SCOPE_DRIFT";

class DeleteUserAccountError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "DeleteUserAccountError";
    if (statusCode) this.statusCode = statusCode;
  }
}

async function ensureSentinelUser(prismaClient) {
  const existing = await prismaClient.user.findUnique({
    where: { appleId: SENTINEL_APPLE_ID },
  });
  if (existing) return existing;

  return prismaClient.user.create({
    data: {
      appleId: SENTINEL_APPLE_ID,
      name: "Deleted User",
    },
  });
}

function buildDeleteUserAccount(dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const storage =
    dependencies.profilePhotoStorage || defaultProfilePhotoStorage;
  const logger = dependencies.logger || console;
  const eligibilityEpoch = dependencies.leaderboardEligibilityEpoch ||
    buildLeaderboardEligibilityEpoch({ prisma: db });

  async function discoverMembershipScope(userId) {
    const raceRows = await db.raceParticipant.findMany({
      where: { userId },
      select: { raceId: true },
    });
    const tournamentRows = await db.tournamentParticipant.findMany({
      where: { userId },
      select: { tournamentId: true },
    });
    return {
      raceIds: [...new Set(raceRows.map((row) => row.raceId))].sort(),
      tournamentIds: [
        ...new Set(tournamentRows.map((row) => row.tournamentId)),
      ].sort(),
    };
  }

  return async function deleteUserAccount({ userId }) {
    if (!userId) {
      throw new DeleteUserAccountError("userId is required", 400);
    }

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new DeleteUserAccountError("User not found", 404);
    }
    if (user.appleId === SENTINEL_APPLE_ID) {
      throw new DeleteUserAccountError(
        "Cannot delete the sentinel user",
        400
      );
    }

    const sentinel = await ensureSentinelUser(db);
    const sentinelId = sentinel.id;
    const payoutDoubleProviderHash = providerSubHash(user);

    // Best-effort profile photo cleanup (outside the transaction).
    if (user.profilePhotoKey) {
      try {
        await storage.deleteObject(user.profilePhotoKey);
      } catch (error) {
        logger.warn(
          `Failed to delete profile photo for user ${userId}: ${error.message || error}`
        );
      }
    }

    let counterpartIds = [];
    let deletionComplete = false;
    for (let attempt = 0; attempt < 3 && !deletionComplete; attempt += 1) {
      const scope = await discoverMembershipScope(userId);
      try {
        await db.$transaction(async (tx) => {
      // Universal membership order. The scope is discovered optimistically;
      // after these locks, an admission into a new competition either precedes
      // the user guard and is detected by the reread below, or follows deletion.
      await acquireRaceWriteFences(tx, scope.raceIds);
      if (scope.raceIds.length > 0) await acquireGlobalEnrollmentLock(tx);
      await lockFundedExposureUsers(tx, [userId]);
      await lockCompetitionRows(tx, scope);

      const participations = await tx.raceParticipant.findMany({
        where: { userId },
        include: { race: { select: { id: true, status: true } } },
      });
      const tournamentEntries = await tx.tournamentParticipant.findMany({
        where: { userId },
        include: { tournament: { select: { id: true, status: true } } },
      });
      const raceScope = new Set(scope.raceIds);
      const tournamentScope = new Set(scope.tournamentIds);
      if (
        participations.some((row) => !raceScope.has(row.raceId)) ||
        tournamentEntries.some(
          (row) => !tournamentScope.has(row.tournamentId),
        )
      ) {
        const drift = new Error("Account membership scope changed; retrying");
        drift.code = MEMBERSHIP_SCOPE_DRIFT;
        throw drift;
      }

      // Shared race-payout-double lock order: durable provider identity first,
      // then user. Tombstone receipts before the user cascade removes offers,
      // grants and ledger rows so reconciliation can distinguish deletion from
      // settlement corruption without retaining raw provider identity.
      if (payoutDoubleProviderHash) {
        await tx.racePayoutDoubleIdentity.upsert({
          where: { providerSubHash: payoutDoubleProviderHash },
          create: {
            providerSubHash: payoutDoubleProviderHash,
            cohortBucket: cohortBucket(payoutDoubleProviderHash),
          },
          update: {},
        });
        await tx.$queryRaw`SELECT provider_sub_hash FROM race_payout_double_identities WHERE provider_sub_hash = ${payoutDoubleProviderHash} FOR UPDATE`;
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const claimedPayoutOffers = await tx.racePayoutDoubleOffer.findMany({
        where: { userId, status: "CLAIMED" },
        select: { id: true },
      });
      if (claimedPayoutOffers.length > 0) {
        await tx.racePayoutDoubleClaimReceipt.updateMany({
          where: { offerId: { in: claimedPayoutOffers.map((offer) => offer.id) } },
          data: { accountDeletedAt: new Date() },
        });
      }

      // 1) Race participations: forfeit any held buy-ins into the pot, then
      //    detach the user from each race depending on race lifecycle.
      for (const participant of participations) {
        if (
          participant.buyInStatus === "HELD" &&
          participant.buyInAmount > 0
        ) {
          await tx.race.update({
            where: { id: participant.raceId },
            data: { potCoins: { increment: participant.buyInAmount } },
          });
        }

        const raceStatus = participant.race?.status;
        const isLive = raceStatus === "PENDING" || raceStatus === "ACTIVE";

        if (isLive) {
          // Remove the user from live races. Any committed/held coins remain
          // in the pot for the remaining racers.
          await tx.raceParticipant.delete({ where: { id: participant.id } });
        } else {
          // Finished/cancelled — preserve history by reassigning to sentinel.
          const sentinelAlreadyIn = await tx.raceParticipant.findUnique({
            where: {
              raceId_userId: { raceId: participant.raceId, userId: sentinelId },
            },
          });

          if (sentinelAlreadyIn) {
            await tx.raceParticipant.delete({
              where: { id: participant.id },
            });
          } else {
            await tx.raceParticipant.update({
              where: { id: participant.id },
              data: { userId: sentinelId },
            });
          }
        }
      }

      // 1b) Tournament participations: same lifecycle split as races above.
      //     tournament_participants FKs the user with RESTRICT, so an
      //     unhandled row here blocks the whole delete.
      for (const entry of tournamentEntries) {
        if (entry.buyInStatus === "HELD" && entry.buyInAmount > 0) {
          await tx.tournament.update({
            where: { id: entry.tournamentId },
            data: { potCoins: { increment: entry.buyInAmount } },
          });
        }

        const tournamentStatus = entry.tournament?.status;
        const isLive =
          tournamentStatus === "PENDING" || tournamentStatus === "ACTIVE";

        if (isLive) {
          await tx.tournamentParticipant.delete({ where: { id: entry.id } });
        } else {
          // Finished/cancelled — preserve the bracket by reassigning to the
          // sentinel, unless it already holds a slot in this tournament
          // (the (tournamentId, userId) unique would collide).
          const sentinelAlreadyIn =
            await tx.tournamentParticipant.findUnique({
              where: {
                tournamentId_userId: {
                  tournamentId: entry.tournamentId,
                  userId: sentinelId,
                },
              },
            });

          if (sentinelAlreadyIn) {
            await tx.tournamentParticipant.delete({ where: { id: entry.id } });
          } else {
            await tx.tournamentParticipant.update({
              where: { id: entry.id },
              data: { userId: sentinelId },
            });
          }
        }
      }

      // 2) Anonymize Race creator/winner references so other users keep history.
      await tx.race.updateMany({
        where: { creatorId: userId },
        data: { creatorId: sentinelId },
      });
      await tx.race.updateMany({
        where: { winnerUserId: userId },
        data: { winnerUserId: sentinelId },
      });

      // 2b) Same for Tournament creator/champion. The FK is SET NULL, so this
      //     is not required to unblock the delete — it keeps a deleted user's
      //     brackets showing "Deleted User" instead of silently losing the
      //     creator, matching the Race behaviour above.
      await tx.tournament.updateMany({
        where: { creatorId: userId },
        data: { creatorId: sentinelId },
      });
      await tx.tournament.updateMany({
        where: { championUserId: userId },
        data: { championUserId: sentinelId },
      });

      // 3) Anonymize ChallengeInstance references.
      await tx.challengeInstance.updateMany({
        where: { userAId: userId },
        data: { userAId: sentinelId },
      });
      await tx.challengeInstance.updateMany({
        where: { userBId: userId },
        data: { userBId: sentinelId },
      });
      await tx.challengeInstance.updateMany({
        where: { winnerUserId: userId },
        data: { winnerUserId: sentinelId },
      });
      await tx.challengeInstance.updateMany({
        where: { proposedById: userId },
        data: { proposedById: sentinelId },
      });

      // 4) RaceMessage.senderId is nullable — null it out rather than reassign.
      await tx.raceMessage.updateMany({
        where: { senderId: userId },
        data: { senderId: null },
      });

      // 5) Hard-delete personal data.
      await tx.step.deleteMany({ where: { userId } });
      await tx.stepSample.deleteMany({ where: { userId } });
      await tx.deviceToken.deleteMany({ where: { userId } });
      await tx.coinTransaction.deleteMany({ where: { userId } });
      await tx.powerupUpgradeEvent.deleteMany({ where: { userId } });
      // Final-score impact rows intentionally use RESTRICT FKs (a race
      // retention job owns their historical lifecycle), so account deletion
      // removes this user's private rows explicitly in its existing transaction.
      await tx.activeRaceEffectImpact.deleteMany({ where: { userId } });
      await tx.activeRaceImpactWork.deleteMany({ where: { recipientUserId: userId } });
      await tx.raceEffectImpact.deleteMany({ where: { userId } });
      await tx.globalEventRaceImpact.deleteMany({ where: { userId } });
      await tx.globalEventUserSummary.deleteMany({ where: { userId } });
      await tx.globalStepEventEntitlement.deleteMany({ where: { userId } });
      await tx.appReviewPromptAttempt.deleteMany({ where: { userId } });
      await tx.inboxAlert.deleteMany({ where: { userId } });
      await tx.feedbackThread.deleteMany({ where: { userId } });
      // Referral contests retain only the versioned pseudonymous acceptance /
      // abuse key. Remove the public snapshot immediately and make the entry
      // permanently non-participating before the user FK is set null.
      await tx.giveawayEntrant.updateMany({
        where: { userId },
        data: {
          status: "WITHDRAWN",
          displayNameSnapshot: null,
          withdrawnAt: new Date(),
        },
      });
      // Free-text feedback (batch 2026-08-08 item 7). The FK is ON DELETE
      // CASCADE so this is not required for correctness, but deleting it
      // explicitly keeps the row removal inside this transaction — and inside
      // the 5s timeout — rather than deferring it to the cascade at
      // tx.user.delete.
      await tx.suggestion.deleteMany({ where: { userId } });
      const friendshipRows = await tx.friendship.findMany({
        where: {
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      });
      counterpartIds = friendshipRows.map((row) =>
        row.requesterId === userId ? row.addresseeId : row.requesterId
      );
      await tx.friendship.deleteMany({
        where: { OR: [{ requesterId: userId }, { addresseeId: userId }] },
      });

      // 6) DailyRewardClaim, UserShopItem, UserEquippedAccessory, and
      //    ShopPurchaseRequest all cascade on user delete.
      await tx.user.delete({ where: { id: userId } });
      await eligibilityEpoch.advance(tx);
        }, { timeout: 15_000, maxWait: 10_000 });
        deletionComplete = true;
      } catch (error) {
        if (error?.code !== MEMBERSHIP_SCOPE_DRIFT || attempt === 2) throw error;
      }
    }
    // C2 invalidation (spec §3): drop the user's presentation bundle. Note the
    // cached chat lists are NOT invalidated here — that fan-out is unbounded
    // (this delete nulls `race_messages.sender_id` across every race the user
    // ever posted in). Instead, hydration treats a MISSING presentation as the
    // deleted case and emits the same null senderId/name/photo Postgres would,
    // so a stale list stays correct. See getRaceMessages.
    try {
      const {
        invalidate,
      } = require("../../social/services/userPresentationCache");
      await invalidate(userId);
    } catch {}
    // C5 (spec §5 Phase E2, "account state change"): a warm `/auth/me` would
    // describe an account that no longer exists.
    try {
      const authMeCache = require("../services/authMeCache");
      await Promise.all(
        [userId, ...counterpartIds].map((id) => authMeCache.invalidateSafe(id))
      );
    } catch {}
    try {
      await require("../../social/services/friendsTopologyCache")
        .invalidateUsersSafe([userId, ...counterpartIds]);
    } catch {}
    await require("../../steps/services/globalStepEventEntitlement")
      .invalidateHomeActiveGlobalEvent([userId]);
  };
}

const deleteUserAccount = buildDeleteUserAccount();

module.exports = {
  deleteUserAccount,
  buildDeleteUserAccount,
  DeleteUserAccountError,
  SENTINEL_APPLE_ID,
};
