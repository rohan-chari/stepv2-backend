const { Prisma } = require("@prisma/client");
const { prisma: defaultPrisma } = require("../../db");
const { AppError } = require("../../shared/errors/AppError");
const SLOTS = ["HEAD", "FACE", "NECK", "BACK", "FEET"];
const CONTRACT = "character-wardrobes-v1";
const emptySlots = () => Object.fromEntries(SLOTS.map((s) => [s, null]));
const activeKey = (rows) =>
  rows.find((r) => r.slot === "CHARACTER")?.shopItemId || "default";
const slotMap = (rows) =>
  Object.assign(
    emptySlots(),
    Object.fromEntries(
      rows
        .filter((r) => SLOTS.includes(r.slot))
        .map((r) => [r.slot, r.shopItemId]),
    ),
  );
const sameSlots = (a, b) => SLOTS.every((s) => a[s] === b[s]);
function itemFromDb(row) {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
}
function entries(rows) {
  return (rows || []).map((r) => ({ ...r, shopItem: itemFromDb(r.shopItem) }));
}
async function readState(tx, userId, keys = []) {
  const [row] = await tx.$queryRaw`
 SELECT u.coins, u.appearance_revision AS "appearanceRevision",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'slot',e.slot,'shopItemId',e.shop_item_id,'updatedAt',e.updated_at,'shopItem',to_jsonb(i))) FROM user_equipped_accessories e JOIN shop_items i ON i.id=e.shop_item_id WHERE e.user_id=u.id),'[]') AS equipment,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'characterKey',w.character_key,'revision',w.revision,'items',COALESCE((SELECT jsonb_agg(jsonb_build_object('slot',wi.slot,'shopItemId',wi.shop_item_id,'shopItem',to_jsonb(i))) FROM character_wardrobe_items wi JOIN shop_items i ON i.id=wi.shop_item_id WHERE wi.wardrobe_id=w.id),'[]'))) FROM character_wardrobes w WHERE w.user_id=u.id AND (w.character_key=ANY(${keys}::text[]) OR w.character_key=COALESCE((SELECT e.shop_item_id FROM user_equipped_accessories e WHERE e.user_id=u.id AND e.slot='CHARACTER'),'default'))),'[]') AS wardrobes
 FROM users u WHERE u.id=${userId}`;
  if (!row) throw new AppError("User not found", "UNAUTHORIZED", 401);
  row.equipment = entries(row.equipment);
  row.wardrobes = row.wardrobes.map((w) => ({ ...w, items: entries(w.items) }));
  return row;
}
function outfitState(state, key) {
  const stored = state.wardrobes.find((w) => w.characterKey === key);
  return {
    id: stored?.id,
    revision: stored?.revision || 0,
    items:
      activeKey(state.equipment) === key
        ? state.equipment.filter((r) => SLOTS.includes(r.slot))
        : stored?.items || [],
  };
}
async function writeWardrobe(
  tx,
  userId,
  key,
  before,
  rows,
  { force = false } = {},
) {
  const changed = !sameSlots(slotMap(before.items), slotMap(rows));
  if (!changed && !force) return before;
  const w = before.id
    ? await tx.characterWardrobe.update({
        where: { id: before.id },
        data: { revision: { increment: changed ? 1 : 0 } },
      })
    : await tx.characterWardrobe.create({
        data: {
          userId,
          characterKey: key,
          characterShopItemId: key === "default" ? null : key,
          revision: before.revision + (changed ? 1 : 0),
        },
      });
  // Only changed slots are replaced. Initial checkpoint captures projection with
  // revision zero; it is not itself a user-visible outfit change.
  const old = before.id ? slotMap(before.items) : emptySlots(),
    next = slotMap(rows);
  const changedSlots = SLOTS.filter((s) => old[s] !== next[s]);
  if (changedSlots.length) {
    await tx.characterWardrobeItem.deleteMany({
      where: { wardrobeId: w.id, slot: { in: changedSlots } },
    });
    const data = changedSlots
      .filter((s) => next[s])
      .map((slot) => ({ wardrobeId: w.id, slot, shopItemId: next[slot] }));
    if (data.length) await tx.characterWardrobeItem.createMany({ data });
  }
  return {
    id: w.id,
    revision: w.revision,
    items: rows.filter((r) => SLOTS.includes(r.slot)),
  };
}
async function checkpoint(tx, userId, state) {
  const key = activeKey(state.equipment),
    current = outfitState(state, key);
  if (!current.id) {
    const w = await writeWardrobe(tx, userId, key, current, current.items, {
      force: true,
    });
    state.wardrobes.push({ ...w, characterKey: key });
  }
}
async function project(tx, userId, before, after) {
  const old = Object.fromEntries(before.map((r) => [r.slot, r.shopItemId]));
  const next = Object.fromEntries(after.map((r) => [r.slot, r.shopItemId]));
  const changed = [...SLOTS, "CHARACTER"].filter((s) => old[s] !== next[s]);
  if (!changed.length) return false;
  const deleted = changed.filter((s) => !next[s]);
  if (deleted.length)
    await tx.userEquippedAccessory.deleteMany({
      where: { userId, slot: { in: deleted } },
    });
  const added = changed.filter((s) => next[s]);
  if (added.length)
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO user_equipped_accessories(id,user_id,slot,shop_item_id,updated_at) VALUES ${Prisma.join(added.map((s) => Prisma.sql`(${crypto.randomUUID()},${userId},${s}::"AccessorySlot",${next[s]},CURRENT_TIMESTAMP)`))} ON CONFLICT(user_id,slot) DO UPDATE SET shop_item_id=EXCLUDED.shop_item_id, updated_at=EXCLUDED.updated_at`,
    );
  await tx.user.update({
    where: { id: userId },
    data: { appearanceRevision: { increment: 1 } },
  });
  return true;
}
async function invalidateAppearance(userId) {
  try {
    await require("../social/services/userPresentationCache").invalidate(
      userId,
    );
  } catch {}
  try {
    await require("../users/services/authMeCache").invalidateSafe(userId);
  } catch {}
}
async function withWriter(
  userId,
  keys,
  callback,
  { prisma = defaultPrisma } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
          const state = await readState(tx, userId, keys);
          return callback(tx, state);
        },
        { timeout: 10000 },
      );
      if (result.appearanceChanged) await invalidateAppearance(userId);
      return result;
    } catch (e) {
      const code =
        e.code === "P2010"
          ? e.meta?.code ||
            e.meta?.driverAdapterError?.cause?.originalCode ||
            e.meta?.driverAdapterError?.cause?.code ||
            e.code
          : e.code || e.meta?.code || e.cause?.code;
      if (!["P2034", "40P01", "40001"].includes(code)) throw e;
      if (attempt >= 2)
        throw new AppError(
          "Your wardrobe is busy. Please retry.",
          "WARDROBE_BUSY",
          503,
        );
    }
  }
}
module.exports = {
  SLOTS,
  CONTRACT,
  emptySlots,
  activeKey,
  slotMap,
  sameSlots,
  itemFromDb,
  entries,
  readState,
  outfitState,
  writeWardrobe,
  checkpoint,
  project,
  withWriter,
  invalidateAppearance,
};
