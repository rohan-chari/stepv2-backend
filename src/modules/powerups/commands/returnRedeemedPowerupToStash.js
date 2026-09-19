const { prisma: defaultPrisma } = require("../../../db");
const { RacePowerup } = require("../models/racePowerup");
const {
  slotsChanged: defaultSlotsChanged,
} = require("../services/raceSlotCacheInvalidation");
const {
  invalidateSafe: defaultInvalidateInventory,
} = require("../services/powerupInventoryCache");

class ReturnRedeemedPowerupError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = "ReturnRedeemedPowerupError";
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildReturnRedeemedPowerupToStash(deps = {}) {
  const db = deps.prisma || defaultPrisma;
  const powerupModel = deps.RacePowerup || RacePowerup;
  const slotsChanged = deps.slotsChanged || defaultSlotsChanged;
  const invalidateInventory =
    deps.invalidateInventory || defaultInvalidateInventory;

  return async function returnRedeemedPowerupToStash({
    userId,
    raceId,
    powerupId,
  }) {
    async function currentStashQuantity(powerupType) {
      const row = await db.userPowerupItem.findUnique({
        where: {
          userId_powerupType: {
            userId,
            powerupType,
          },
        },
        select: { quantity: true },
      });
      return Math.max(0, Number(row?.quantity) || 0);
    }
    const powerup = await powerupModel.findById(powerupId);
    if (
      !powerup ||
      powerup.userId !== userId ||
      powerup.raceId !== raceId
    ) {
      throw new ReturnRedeemedPowerupError(
        "Powerup not found",
        404,
        "POWERUP_NOT_FOUND",
      );
    }
    if (powerup.redeemedFromInventory !== true) {
      throw new ReturnRedeemedPowerupError(
        "Only a stash-redeemed powerup can be returned",
        400,
        "NOT_REDEEMED_FROM_INVENTORY",
      );
    }

    // A prior rejection refund or return already performed the one allowed
    // HELD -> DISCARDED transition. Treat a retry as a no-op; never mint twice.
    if (powerup.status === "DISCARDED") {
      return {
        returned: false,
        alreadyReturned: true,
        powerupType: powerup.type,
        quantity: await currentStashQuantity(powerup.type),
      };
    }
    if (powerup.status !== "HELD") {
      throw new ReturnRedeemedPowerupError(
        "This powerup can no longer be returned to your stash",
        409,
        "POWERUP_NOT_HELD",
      );
    }

    const returnResult = await db.$transaction(async (tx) => {
      const claimed = await tx.racePowerup.updateMany({
        where: {
          id: powerupId,
          raceId,
          userId,
          participantId: powerup.participantId,
          type: powerup.type,
          status: "HELD",
          redeemedFromInventory: true,
        },
        data: { status: "DISCARDED" },
      });
      if (claimed.count !== 1) return null;

      const stashRow = await tx.userPowerupItem.upsert({
        where: {
          userId_powerupType: {
            userId,
            powerupType: powerup.type,
          },
        },
        create: {
          userId,
          powerupType: powerup.type,
          quantity: 1,
        },
        update: {
          quantity: { increment: 1 },
        },
      });
      return {
        quantity: Math.max(0, Number(stashRow?.quantity) || 0),
      };
    });

    if (!returnResult) {
      const latest = await powerupModel.findById(powerupId);
      if (latest?.status === "DISCARDED") {
        return {
          returned: false,
          alreadyReturned: true,
          powerupType: powerup.type,
          quantity: await currentStashQuantity(powerup.type),
        };
      }
      throw new ReturnRedeemedPowerupError(
        "This powerup changed before it could be returned",
        409,
        "POWERUP_NOT_HELD",
      );
    }

    try {
      await slotsChanged({
        raceId,
        participantId: powerup.participantId,
      });
    } catch {}
    try {
      await invalidateInventory(userId);
    } catch {}

    return {
      returned: true,
      alreadyReturned: false,
      powerupType: powerup.type,
      quantity: returnResult.quantity,
    };
  };
}

const returnRedeemedPowerupToStash =
  buildReturnRedeemedPowerupToStash();

module.exports = {
  buildReturnRedeemedPowerupToStash,
  returnRedeemedPowerupToStash,
  ReturnRedeemedPowerupError,
};
