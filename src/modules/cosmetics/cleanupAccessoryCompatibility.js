const { prisma: defaultPrisma } = require("../../db");
const { findConflictingEquipment } = require("./accessoryCompatibility");

// Deterministic legacy repair policy: newest equipment wins, then the UUID is
// a stable tie-breaker. Walk newest-to-oldest and keep an item only when it is
// compatible with every already-kept (therefore newer) item.
function partitionCompatibleEquipment(equippedAccessories) {
  const ordered = [...equippedAccessories].sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() ||
      String(a.id).localeCompare(String(b.id))
  );
  const kept = [];
  const removed = [];
  for (const accessory of ordered) {
    if (findConflictingEquipment(accessory.shopItem, kept).length > 0) {
      removed.push(accessory);
    } else {
      kept.push(accessory);
    }
  }
  return { kept, removed };
}

// This is deliberately a separately-invoked, idempotent rollout command — it
// must run while enforcement is still OFF, after the migration/backfill and
// before enabling the flag. It never modifies an already-compatible loadout.
async function cleanupAccessoryCompatibility({ prisma = defaultPrisma, apply = false } = {}) {
  const users = await prisma.user.findMany({ select: { id: true } });
  const summary = { usersChecked: users.length, conflictingRows: 0, removed: 0 };

  for (const { id: userId } of users) {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT 1 FROM "users" WHERE "id" = ${userId} FOR UPDATE
      `;
      const equipped = await tx.userEquippedAccessory.findMany({
        where: { userId },
        include: { shopItem: true },
      });
      const { removed } = partitionCompatibleEquipment(equipped);
      summary.conflictingRows += removed.length;
      if (apply && removed.length > 0) {
        const result = await tx.userEquippedAccessory.deleteMany({
          where: { id: { in: removed.map((entry) => entry.id) } },
        });
        summary.removed += result.count;
      }
    });
  }
  return summary;
}

module.exports = { partitionCompatibleEquipment, cleanupAccessoryCompatibility };
