const { prisma: defaultPrisma } = require("../../../db");
const {
  FriendshipAutoLinkSuppression,
} = require("../models/friendshipAutoLinkSuppression");
const {
  lockFriendshipPair,
  withFriendshipPairLock,
} = require("./friendshipPairLock");

function buildApplyAutomaticFriendship(dependencies = {}) {
  const suppressionModel =
    dependencies.FriendshipAutoLinkSuppression ||
    FriendshipAutoLinkSuppression;
  const beforeWrite = dependencies.beforeAutoFriendWrite || (async () => {});
  const db = dependencies.prisma || defaultPrisma;

  return async function applyAutomaticFriendship({
    userAId,
    userBId,
    prisma = null,
    transactionClient = null,
  }) {
    if (!userAId || !userBId || userAId === userBId) return null;

    const applyLocked = async (tx, lockAlreadyHeld = false) => {
      if (!lockAlreadyHeld) {
        await lockFriendshipPair(tx, userAId, userBId);
      }
      const existingRows = await tx.friendship.findMany({
        where: {
          OR: [
            { requesterId: userAId, addresseeId: userBId },
            { requesterId: userBId, addresseeId: userAId },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      const accepted = existingRows.find((row) => row.status === "ACCEPTED");
      if (accepted) return accepted;

      const existing =
        existingRows.find((row) => row.status === "DECLINED") ||
        existingRows.find((row) => row.status === "PENDING") ||
        null;
      const suppression = await suppressionModel.find(userAId, userBId, tx);
      if (suppression || existing?.status === "DECLINED") return existing;

      await beforeWrite({ userAId, userBId, existing, prisma: tx });
      if (existing?.status === "PENDING") {
        return tx.friendship.update({
          where: { id: existing.id },
          data: { status: "ACCEPTED" },
        });
      }
      return tx.friendship.create({
        data: {
          requesterId: userAId,
          addresseeId: userBId,
          status: "ACCEPTED",
        },
      });
    };

    // Quick-share joins already own a race transaction and must put the pair
    // lock plus friendship write in that SAME transaction. Referral callers
    // pass the root Prisma client and get a short dedicated pair transaction.
    const suppliedClient = transactionClient || prisma;
    if (
      suppliedClient &&
      typeof suppliedClient.$transaction !== "function"
    ) {
      return applyLocked(suppliedClient);
    }
    const rootClient = suppliedClient || db;
    return withFriendshipPairLock(
      userAId,
      userBId,
      (tx) => applyLocked(tx, true),
      { prisma: rootClient }
    );
  };
}

const applyAutomaticFriendship = buildApplyAutomaticFriendship();

module.exports = {
  buildApplyAutomaticFriendship,
  applyAutomaticFriendship,
};
