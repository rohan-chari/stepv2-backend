const {
  ACCESSORY_SLOTS,
  CHARACTER_SLOT,
  buildEquipmentMap,
} = require("./shopCosmetics");
const { findConflictingEquipment } = require("./accessoryCompatibility");

class AccessoryEquipError extends Error {
  constructor(message, statusCode = 400, extras = {}) {
    super(message);
    this.name = "AccessoryEquipError";
    this.statusCode = statusCode;
    Object.assign(this, extras);
  }
}

async function equipAccessory({
  userId,
  slot,
  itemId,
  channel = "prod",
  supportsCharacters = false,
}) {
  if (!ACCESSORY_SLOTS.includes(slot)) {
    throw new AccessoryEquipError("Accessory slot is invalid", 400);
  }

  // A client that can't render characters has no business equipping one; only
  // builds that send the `characters` capability may touch this slot.
  if (slot === CHARACTER_SLOT && !supportsCharacters) {
    throw new AccessoryEquipError("Accessory slot is invalid", 400);
  }

  if (
    itemId !== null &&
    (typeof itemId !== "string" || itemId.trim().length === 0)
  ) {
    throw new AccessoryEquipError("itemId must be a shop item id or null", 400);
  }
  const {
    withWriter,
    activeKey,
    outfitState,
    checkpoint,
    writeWardrobe,
    project,
  } = require("./characterWardrobeState");
  const outcome = await withWriter(
    userId,
    slot === CHARACTER_SLOT && itemId ? [itemId] : ["default"],
    async (tx, state) => {
      let ownership = null;
      if (itemId !== null) {
        await tx.$queryRaw`SELECT id FROM shop_items WHERE id=${itemId} FOR SHARE`;
        ownership = await tx.userShopItem.findUnique({
          where: { userId_shopItemId: { userId, shopItemId: itemId } },
          include: { shopItem: true },
        });

        if (!ownership) {
          throw new AccessoryEquipError("You do not own this shop item", 403);
        }

        if (!ownership.shopItem.active) {
          throw new AccessoryEquipError(
            "Shop item is no longer available",
            400,
          );
        }

        // A prod-channel session can't equip a still-hidden (test-only) item, even
        // one the user bought from a TestFlight build — keeps it off prod avatars.
        if (channel !== "testflight" && ownership.shopItem.testOnly) {
          throw new AccessoryEquipError(
            "Shop item is no longer available",
            400,
          );
        }

        if (ownership.shopItem.slot !== slot) {
          throw new AccessoryEquipError(
            "Shop item does not fit this slot",
            400,
          );
        }

        {
          const equippedAccessories = state.equipment;
          // The same-slot item is being replaced by the candidate and is therefore
          // not part of the resulting loadout.
          const conflicts = findConflictingEquipment(
            ownership.shopItem,
            equippedAccessories.filter((entry) => entry.slot !== slot),
          );
          if (conflicts.length > 0) {
            const first = conflicts[0];
            throw new AccessoryEquipError(
              `That accessory conflicts with ${first.shopItem.name}.`,
              409,
              {
                code: "ACCESSORY_CONFLICT",
                conflictingItemIds: conflicts.map((entry) => entry.shopItemId),
                conflictingSlots: conflicts.map((entry) => entry.slot),
              },
            );
          }
        }
      }
      const before = state.equipment;
      const after = before.filter((entry) => entry.slot !== slot);
      if (ownership)
        after.push({ slot, shopItemId: itemId, shopItem: ownership.shopItem });
      const changed =
        before.find((entry) => entry.slot === slot)?.shopItemId !==
        (itemId || undefined);
      if (changed) {
        await checkpoint(tx, userId, state);
        const source = activeKey(before),
          target = activeKey(after);
        // A frozen client switches bodies with accessory carry-over. Never
        // reinterpret that old request as restoration of a different outfit.
        await writeWardrobe(
          tx,
          userId,
          target,
          outfitState(state, target),
          after,
          { force: source !== target },
        );
        await project(tx, userId, before, after);
      }
      return {
        equipped: buildEquipmentMap(
          supportsCharacters
            ? after
            : after.filter((e) => e.slot !== CHARACTER_SLOT),
        ),
        appearanceChanged: changed,
      };
    },
  );
  return { equipped: outcome.equipped };
}

module.exports = { equipAccessory, AccessoryEquipError };
