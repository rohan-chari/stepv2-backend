const { Prisma } = require("@prisma/client");
const { prisma } = require("../../db");
const { AppError } = require("../../shared/errors/AppError");
const {
  serializeShopItem,
  serializeEquippedAccessory,
  buildEquipmentMap,
} = require("./shopCosmetics");
const { findConflictingEquipment, itemsConflict } = require("./accessoryCompatibility");
const {
  memberDiscount,
  priceFields,
} = require("../billing/services/memberPrice");
const { buildAdUnlockBlock } = require("../economy/services/adUnlockPolicy");
const {
  SLOTS,
  CONTRACT,
  emptySlots,
  activeKey,
  slotMap,
  itemFromDb,
  readState,
  outfitState,
  writeWardrobe,
  checkpoint,
  project,
  withWriter,
} = require("./characterWardrobeState");
const fail = (code, status = 409, meta) => {
  throw new AppError(
    {
      OUTFIT_CHANGED: "Your outfit changed on another device.",
      APPEARANCE_CHANGED: "Your active character changed on another device.",
    }[code] || code.replaceAll("_", " ").toLowerCase(),
    code,
    status,
    meta,
  );
};
function keySyntax(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key))
    fail("INVALID_WARDROBE_REQUEST", 400);
}
function revisionSyntax(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("INVALID_WARDROBE_REQUEST", 400);
}
function visible(i, opts) {
  return (
    !!i &&
    (opts.channel === "testflight" || !i.testOnly) &&
    (opts.supportsRemoteAssets || !i.remoteOnly) &&
    (opts.supportsCharacters || i.slot !== "CHARACTER")
  );
}
function identity(state, opts) {
  const key = activeKey(state.equipment),
    i = state.equipment.find((e) => e.slot === "CHARACTER")?.shopItem;
  const shown = key === "default" || visible(i, opts);
  return {
    appearanceRevision: state.appearanceRevision,
    activeCharacterKey: shown ? key : null,
    activeCharacterVisible: shown,
  };
}
function outfitView(state, key, opts, available = true) {
  const o = outfitState(state, key),
    slots = emptySlots(),
    items = [],
    unavailableItemIds = [];
  let hasHiddenItems = false;
  for (const r of o.items) {
    if (!visible(r.shopItem, opts)) {
      hasHiddenItems = true;
      continue;
    }
    slots[r.slot] = r.shopItemId;
    items.push(serializeEquippedAccessory(r));
    if (!r.shopItem.active) unavailableItemIds.push(r.shopItemId);
  }
  return {
    revision: o.revision,
    editable: available && !hasHiddenItems,
    hasHiddenItems,
    slots,
    items,
    unavailableItemIds,
  };
}
function paging(opts, resource) {
  const limit = opts.limit === undefined ? 24 : Number(opts.limit);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 48 ||
    typeof opts.limit === "object"
  )
    fail("INVALID_WARDROBE_REQUEST", 400);
  const bind = `${resource}|${opts.channel || "prod"}|${!!opts.supportsRemoteAssets}|${!!opts.supportsCharacters}`;
  let last = null;
  if (opts.cursor !== undefined) {
    try {
      if (
        typeof opts.cursor !== "string" ||
        Buffer.byteLength(opts.cursor) > 512 ||
        !/^[\w-]+$/.test(opts.cursor)
      )
        throw 0;
      const c = JSON.parse(Buffer.from(opts.cursor, "base64url").toString());
      if (
        c.v !== 1 ||
        c.bind !== bind ||
        !Number.isInteger(c.sort) ||
        c.sort < -2147483648 ||
        c.sort > 2147483647 ||
        typeof c.id !== "string"
      )
        throw 0;
      last = c;
    } catch {
      fail("INVALID_WARDROBE_REQUEST", 400);
    }
  }
  return {
    limit,
    last,
    cursor: (i) =>
      Buffer.from(
        JSON.stringify({ v: 1, bind, sort: i.sortOrder, id: i.id }),
      ).toString("base64url"),
  };
}
const visibilitySql = (opts) =>
  Prisma.sql`(${opts.channel === "testflight"} OR NOT i.test_only) AND (${!!opts.supportsRemoteAssets} OR NOT i.remote_only)`;
async function character(tx, key, opts, requireOwned = true) {
  if (key === "default")
    return { id: "default", name: "Capybara", owned: true, active: true };
  const rows =
    await tx.$queryRaw`SELECT i.*, EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned FROM shop_items i WHERE i.id=${key} AND i.slot='CHARACTER'`;
  const i = itemFromDb(rows[0]);
  if (!visible(i, opts)) fail("CHARACTER_NOT_FOUND", 404);
  if (requireOwned && !i.owned) fail("CHARACTER_NOT_OWNED", 403);
  return i;
}
async function quotes(opts) {
  const discount = await memberDiscount(prisma, opts.userId);
  let adUnlock = null;
  try {
    adUnlock = await buildAdUnlockBlock(prisma, opts.userId, {
      localDate: opts.localDate,
    });
  } catch {}
  return { discount, adUnlock };
}
const serialized = (i, discount) =>
  serializeShopItem({ ...i, ...priceFields(i.priceCoins, discount) });
async function readSnapshot(callback, db = prisma) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return callback(tx);
    },
    { isolationLevel: "RepeatableRead", timeout: 10000 },
  );
}
async function getCharacters(opts, db = prisma) {
  const page = paging(opts, "characters");
  const result = await readSnapshot(async (tx) => {
    const count = page.limit - (!page.last ? 1 : 0),
      last = page.last;
    const rows = await tx.$queryRaw(
      Prisma.sql`SELECT i.*, EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned FROM shop_items i WHERE i.slot='CHARACTER' AND ${!!opts.supportsCharacters} AND ${visibilitySql(opts)} AND ((i.active AND NOT i.earn_only) OR EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id)) ${last && last.id !== "default" ? Prisma.sql`AND (i.sort_order,i.id)>(${last.sort},${last.id})` : Prisma.empty} ORDER BY i.sort_order,i.id LIMIT ${count + 1}`,
    );
    const hasMore = rows.length > count,
      items = rows.slice(0, count).map(itemFromDb);
    const state = await readState(
      tx,
      opts.userId,
      items.map((i) => i.id),
    );
    return {
      state,
      items,
      hasMore,
      nextCursor: hasMore
        ? page.cursor(items.at(-1) || { id: "default", sortOrder: 0 })
        : null,
    };
  }, db);
  const { discount, adUnlock } = await quotes(opts);
  const { state } = result;
  const characterRow = (i) => {
    const key = i.id,
      owned = i.owned,
      o = owned ? outfitView(state, key, opts, i.active) : null;
    return {
      characterKey: key,
      name: i.name,
      item: key === "default" ? null : serialized(i, discount),
      owned,
      active: owned && activeKey(state.equipment) === key,
      canPurchase: key !== "default" && !owned && i.active && !i.earnOnly,
      canActivate: owned && i.active,
      canEdit: !!o?.editable,
      availability: i.active ? "available" : "unavailable",
      outfit: o,
    };
  };
  return {
    contract: CONTRACT,
    ...identity(state, opts),
    coins: state.coins,
    adUnlock,
    characters: [
      ...(!page.last
        ? [
            characterRow({
              id: "default",
              name: "Capybara",
              owned: true,
              active: true,
            }),
          ]
        : []),
      ...result.items.map(characterRow),
    ],
    nextCursor: result.nextCursor,
  };
}
async function getCharacterWardrobe(opts, db = prisma) {
  keySyntax(opts.characterKey);
  const page = paging(opts, `wardrobe:${opts.characterKey}`);
  const result = await readSnapshot(async (tx) => {
    const c = await character(tx, opts.characterKey, opts),
      state = await readState(tx, opts.userId, [opts.characterKey]);
    const retained = outfitState(state, opts.characterKey).items.map(
        (r) => r.shopItemId,
      ),
      last = page.last;
    const rows = await tx.$queryRaw(
      Prisma.sql`SELECT i.*, EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned, EXISTS(SELECT 1 FROM shop_item_character_fits f WHERE f.accessory_shop_item_id=i.id AND f.character_key=${opts.characterKey}) AS approved FROM shop_items i WHERE i.slot<>'CHARACTER' AND ${visibilitySql(opts)} AND (EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) OR i.id=ANY(${retained}::text[]) OR (i.active AND NOT i.earn_only AND EXISTS(SELECT 1 FROM shop_item_character_fits f WHERE f.accessory_shop_item_id=i.id AND f.character_key=${opts.characterKey}))) ${last ? Prisma.sql`AND (i.sort_order,i.id)>(${last.sort},${last.id})` : Prisma.empty} ORDER BY i.sort_order,i.id LIMIT ${page.limit + 1}`,
    );
    return { c, state, retained, rows: rows.map(itemFromDb) };
  }, db);
  const { discount, adUnlock } = await quotes(opts),
    { c, state, retained, rows } = result;
  return {
    contract: CONTRACT,
    ...identity(state, opts),
    characterKey: opts.characterKey,
    name: c.name,
    active: activeKey(state.equipment) === opts.characterKey,
    canActivate: c.active,
    outfit: outfitView(state, opts.characterKey, opts, c.active),
    coins: state.coins,
    adUnlock,
    accessories: rows.slice(0, page.limit).map((i) => {
      const fit = i.approved
        ? "approved"
        : retained.includes(i.id)
          ? "legacy-preserved"
          : "preservation-only";
      return {
        item: serialized(i, discount),
        owned: i.owned,
        canPurchase: !i.owned && i.active && !i.earnOnly && i.approved,
        canPreview:
          c.active &&
          i.active &&
          fit !== "preservation-only" &&
          (i.owned || (i.approved && !i.earnOnly)),
        canSelect:
          i.owned && i.active && fit !== "preservation-only" && c.active,
        fit,
        unavailableReason: !i.active
          ? "inactive"
          : fit === "preservation-only"
            ? "incompatible"
            : null,
      };
    }),
    nextCursor:
      rows.length > page.limit ? page.cursor(rows[page.limit - 1]) : null,
  };
}
// Read-only mannequin projection. Every collection is bounded by one chosen
// character or the five outfit slots; never fetch the user's full catalog.
async function getAccessoryPreview(opts, db = prisma) {
  return readSnapshot(async (tx) => {
    const candidates = await tx.$queryRaw`
      SELECT i.*, EXISTS(SELECT 1 FROM user_shop_items o
        WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned
      FROM shop_items i WHERE i.id=${opts.itemId} LIMIT 1`;
    const candidate = itemFromDb(candidates[0]);
    if (!visible(candidate, opts) || !SLOTS.includes(candidate.slot) ||
        (candidate.earnOnly && !candidate.owned)) {
      throw new AppError("Shop item not found", "ITEM_NOT_FOUND", 404);
    }
    const unavailable = (reason) => ({
      itemId: candidate.id, canPreview: false, unavailableReason: reason,
      usedFallbackCharacter: false, character: null, accessories: [],
    });
    if (!candidate.active) return unavailable("inactive");

    // The existing composite fit indexes support candidate/character lookups.
    // Rank eligible rows in SQL and return only the chosen mannequin.
    const characters = await tx.$queryRaw`
      WITH current_character AS (
        SELECT COALESCE((SELECT e.shop_item_id FROM user_equipped_accessories e
          WHERE e.user_id=${opts.userId} AND e.slot='CHARACTER'), 'default') AS key
      ), eligible AS (
        SELECT 'default' AS key, 'Capybara' AS name, true AS owned,
          NULL::jsonb AS item, 0 AS sort_order
        WHERE EXISTS(SELECT 1 FROM shop_item_character_fits f
          WHERE f.accessory_shop_item_id=${candidate.id} AND f.character_key='default')
        UNION ALL
        SELECT i.id AS key, i.name, EXISTS(SELECT 1 FROM user_shop_items o
          WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned,
          to_jsonb(i) AS item, i.sort_order
        FROM shop_items i
        WHERE i.slot='CHARACTER' AND i.active AND ${!!opts.supportsCharacters}
          AND (${opts.channel === "testflight"} OR NOT i.test_only)
          AND (${!!opts.supportsRemoteAssets} OR NOT i.remote_only)
          AND (NOT i.earn_only OR EXISTS(SELECT 1 FROM user_shop_items o
            WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id))
          AND EXISTS(SELECT 1 FROM shop_item_character_fits f
            WHERE f.accessory_shop_item_id=${candidate.id} AND f.character_key=i.id)
      )
      SELECT e.*, c.key AS "activeCharacterKey" FROM eligible e CROSS JOIN current_character c
      ORDER BY CASE WHEN e.key=c.key THEN 0 WHEN e.key='default' THEN 1 ELSE 2 END,
        e.sort_order,e.key LIMIT 1`;
    const chosen = characters[0];
    if (!chosen) return unavailable("no_compatible_character");

    let savedItems = [];
    if (chosen.owned) {
      const state = await readState(tx, opts.userId, [chosen.key]);
      const ids = outfitState(state, chosen.key).items
        .filter((r) => SLOTS.includes(r.slot)).map((r) => r.shopItemId);
      if (ids.length) {
        const rows = await tx.$queryRaw`
          SELECT i.* FROM shop_items i WHERE i.id=ANY(${ids}::text[])
            AND i.active AND EXISTS(SELECT 1 FROM user_shop_items o
              WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id)
            AND EXISTS(SELECT 1 FROM shop_item_character_fits f
              WHERE f.accessory_shop_item_id=i.id AND f.character_key=${chosen.key})`;
        savedItems = rows.map(itemFromDb).filter((i) => visible(i, opts));
      }
    }
    // Candidate wins its slot and every tag conflict. Remaining legacy
    // conflicts resolve in the established bounded slot order, without repair.
    const outfit = [candidate];
    for (const slot of SLOTS) {
      if (slot === candidate.slot) continue;
      const i = savedItems.find((row) => row.slot === slot);
      if (i && !outfit.some((kept) => itemsConflict(i, kept))) outfit.push(i);
    }
    outfit.sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
    return {
      itemId: candidate.id, canPreview: true, unavailableReason: null,
      usedFallbackCharacter: chosen.key !== chosen.activeCharacterKey,
      character: {
        characterKey: chosen.key, name: chosen.name,
        item: chosen.item ? serializeEquippedAccessory({ shopItem: itemFromDb(chosen.item) }) : null,
      },
      accessories: outfit.map((shopItem) => serializeEquippedAccessory({ shopItem })),
    };
  }, db);
}
function conflict(state, key, opts, code) {
  fail(code, 409, {
    current: {
      characterKey: key,
      outfitRevision: outfitState(state, key).revision,
      appearanceRevision: state.appearanceRevision,
      activeCharacterKey: identity(state, opts).activeCharacterKey,
    },
  });
}
async function validateItems(tx, opts, slots, before, c) {
  const ids = Object.values(slots).filter(Boolean);
  if (!ids.length) return [];
  // Item-policy updates/retirement cannot race validation and commit. Use a
  // bounded, stable lock order after the user lock shared with legacy writers.
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM shop_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`,
  );
  const raw =
    await tx.$queryRaw`SELECT i.*, EXISTS(SELECT 1 FROM user_shop_items o WHERE o.user_id=${opts.userId} AND o.shop_item_id=i.id) AS owned, EXISTS(SELECT 1 FROM shop_item_character_fits f WHERE f.accessory_shop_item_id=i.id AND f.character_key=${opts.characterKey}) AS approved FROM shop_items i WHERE i.id=ANY(${ids}::text[])`;
  const items = raw.map(itemFromDb),
    old = slotMap(before.items),
    rows = [];
  for (const slot of SLOTS) {
    const id = slots[slot];
    if (!id) continue;
    const i = items.find((x) => x.id === id);
    if (!i || !visible(i, opts)) fail("ITEM_UNAVAILABLE");
    if (!i.owned) fail("ITEM_NOT_OWNED", 403);
    if (!i.active || i.slot !== slot)
      fail("ITEM_UNAVAILABLE", 409, { itemIds: [id] });
    if (!i.approved && old[slot] !== id)
      fail("CHARACTER_FIT_CONFLICT", 409, { itemIds: [id] });
    rows.push({ slot, shopItemId: id, shopItem: i });
  }
  for (const r of rows) {
    const conflicts = findConflictingEquipment(r.shopItem, [
      ...rows.filter((x) => x !== r),
      ...(c.id === "default"
        ? []
        : [{ slot: "CHARACTER", shopItemId: c.id, shopItem: c }]),
    ]);
    if (conflicts.length)
      fail("ACCESSORY_CONFLICT", 409, {
        conflictingItemIds: conflicts.map((x) => x.shopItemId),
        conflictingSlots: conflicts.map((x) => x.slot),
      });
  }
  return rows;
}
function resultEnvelope(state, key, opts, appearanceChanged) {
  return {
    contract: CONTRACT,
    characterKey: key,
    ...identity(state, opts),
    outfit: outfitView(state, key, opts),
    appearanceChanged,
    equipped: buildEquipmentMap(
      state.equipment.filter((r) => visible(r.shopItem, opts)),
    ),
  };
}
async function mutate(opts, activation) {
  keySyntax(opts.characterKey);
  revisionSyntax(opts.expectedOutfitRevision);
  if (activation) revisionSyntax(opts.expectedAppearanceRevision);
  else {
    const s = opts.slots;
    if (
      !s ||
      Array.isArray(s) ||
      typeof s !== "object" ||
      Object.keys(s).length !== 5 ||
      SLOTS.some((k) => !Object.hasOwn(s, k))
    )
      fail("INVALID_WARDROBE_REQUEST", 400);
    const ids = Object.values(s).filter((x) => x !== null);
    ids.forEach(keySyntax);
    if (new Set(ids).size !== ids.length) fail("INVALID_WARDROBE_REQUEST", 400);
  }
  return withWriter(opts.userId, [opts.characterKey], async (tx, state) => {
    if (opts.characterKey !== "default")
      await tx.$queryRaw`SELECT id FROM shop_items WHERE id=${opts.characterKey} FOR SHARE`;
    const c = await character(tx, opts.characterKey, opts),
      before = outfitState(state, opts.characterKey);
    if (
      activation &&
      state.appearanceRevision !== opts.expectedAppearanceRevision
    )
      conflict(state, opts.characterKey, opts, "APPEARANCE_CHANGED");
    if (before.revision !== opts.expectedOutfitRevision)
      conflict(state, opts.characterKey, opts, "OUTFIT_CHANGED");
    if (!outfitView(state, opts.characterKey, opts, c.active).editable)
      fail("WARDROBE_NOT_EDITABLE");
    const rows = await validateItems(
      tx,
      opts,
      activation ? slotMap(before.items) : opts.slots,
      before,
      c,
    );
    const active = activeKey(state.equipment) === opts.characterKey;
    const changed = !SLOTS.every(
      (s) => slotMap(before.items)[s] === slotMap(rows)[s],
    );
    const switchCharacter = activation && !active;
    if (!changed && !switchCharacter)
      return resultEnvelope(state, opts.characterKey, opts, false);
    await checkpoint(tx, opts.userId, state);
    const saved = await writeWardrobe(
      tx,
      opts.userId,
      opts.characterKey,
      outfitState(state, opts.characterKey),
      rows,
      { force: switchCharacter },
    );
    state.wardrobes = state.wardrobes.filter(
      (w) => w.characterKey !== opts.characterKey,
    );
    state.wardrobes.push({ ...saved, characterKey: opts.characterKey });
    let appearanceChanged = false;
    if (active || activation) {
      const after = [
        ...rows,
        ...(c.id === "default"
          ? []
          : [{ slot: "CHARACTER", shopItemId: c.id, shopItem: c }]),
      ];
      appearanceChanged = await project(
        tx,
        opts.userId,
        state.equipment,
        after,
      );
      state.equipment = after;
      if (appearanceChanged) state.appearanceRevision++;
    }
    return resultEnvelope(state, opts.characterKey, opts, appearanceChanged);
  });
}
const saveCharacterOutfit = (opts) => mutate(opts, false);
const activateCharacter = (opts) => mutate(opts, true);
module.exports = {
  getAccessoryPreview,
  getCharacters,
  getCharacterWardrobe,
  saveCharacterOutfit,
  activateCharacter,
};
