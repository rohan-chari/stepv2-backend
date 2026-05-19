const { prisma } = require("../db");
const {
  profilePhotoStorage: defaultProfilePhotoStorage,
} = require("../services/profilePhotoStorage");

const SENTINEL_APPLE_ID = "__deleted_user_sentinel__";

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

    await db.$transaction(async (tx) => {
      // 1) Race participations: forfeit any held buy-ins into the pot, then
      //    detach the user from each race depending on race lifecycle.
      const participations = await tx.raceParticipant.findMany({
        where: { userId },
        include: { race: { select: { id: true, status: true } } },
      });

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

      // 2) Anonymize Race creator/winner references so other users keep history.
      await tx.race.updateMany({
        where: { creatorId: userId },
        data: { creatorId: sentinelId },
      });
      await tx.race.updateMany({
        where: { winnerUserId: userId },
        data: { winnerUserId: sentinelId },
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
      await tx.friendship.deleteMany({
        where: {
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
      });

      // 6) DailyRewardClaim, UserShopItem, UserEquippedAccessory, and
      //    ShopPurchaseRequest all cascade on user delete.
      await tx.user.delete({ where: { id: userId } });
    });
  };
}

const deleteUserAccount = buildDeleteUserAccount();

module.exports = {
  deleteUserAccount,
  buildDeleteUserAccount,
  DeleteUserAccountError,
  SENTINEL_APPLE_ID,
};
