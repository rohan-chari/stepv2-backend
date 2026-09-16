// Server-owned compatibility vocabulary. Keep this intentionally small: tags
// are policy identifiers, not client-provided arbitrary labels, so an admin
// typo cannot silently create an accessory that appears compatible everywhere.
const ACCESSORY_COMPATIBILITY_TAGS = new Set(["eyewear", "full_face", "headwear"]);
const GOLD_CHARACTER_SKUS = new Set(["mouse", "hedgehog", "sea_lion"]);
const HELMET_SKUS = new Set(["knight_helmet", "football_helmet"]);

function compatibilityError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function sanitizeTagArray(value, key) {
  if (!Array.isArray(value)) {
    throw compatibilityError(`compatibility.${key} must be an array of known tag strings`);
  }
  const seen = new Set();
  const tags = [];
  for (const tag of value) {
    if (typeof tag !== "string" || !ACCESSORY_COMPATIBILITY_TAGS.has(tag)) {
      throw compatibilityError(`compatibility.${key} contains an unknown tag`);
    }
    if (seen.has(tag)) {
      throw compatibilityError(`compatibility.${key} must not contain duplicate tags`);
    }
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

// Strictly validates admin input. `undefined` means the caller did not supply
// the field; `null` deliberately clears it. An empty object is retained as
// valid JSON policy metadata (equivalent to no tags) rather than silently
// changing the admin's submitted shape.
function sanitizeCompatibility(input) {
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw compatibilityError("compatibility must be an object or null");
  }
  const allowed = new Set(["tags", "blocksTags"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw compatibilityError(`compatibility.${key} is not supported`);
    }
  }
  const out = {};
  if (input.tags !== undefined) out.tags = sanitizeTagArray(input.tags, "tags");
  if (input.blocksTags !== undefined) {
    out.blocksTags = sanitizeTagArray(input.blocksTags, "blocksTags");
  }
  return out;
}

// Catalog rows can predate this column or have been written outside of the
// admin API. Treat malformed stored JSON as no policy; reads/equips must stay
// available during the additive migration rollout.
function readCompatibility(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { tags: [], blocksTags: [] };
  }
  const readTags = (key) => {
    if (!Array.isArray(input[key])) return [];
    return [...new Set(input[key].filter(
      (tag) => typeof tag === "string" && ACCESSORY_COMPATIBILITY_TAGS.has(tag)
    ))];
  };
  return { tags: readTags("tags"), blocksTags: readTags("blocksTags") };
}

function hasIntersection(left, right) {
  const rightSet = new Set(right);
  return left.some((entry) => rightSet.has(entry));
}

function itemsConflict(candidateItem, equippedItem) {
  const candidate = readCompatibility(candidateItem?.compatibility);
  const equipped = readCompatibility(equippedItem?.compatibility);
  const helmetFaceConflict =
    (HELMET_SKUS.has(candidateItem?.sku) && equippedItem?.slot === "FACE") ||
    (HELMET_SKUS.has(equippedItem?.sku) && candidateItem?.slot === "FACE");
  return helmetFaceConflict || (
    hasIntersection(candidate.blocksTags, equipped.tags) ||
    hasIntersection(equipped.blocksTags, candidate.tags)
  );
}

function characterAllowsAccessory(characterItem, accessoryItem) {
  if (!characterItem || characterItem.slot !== "CHARACTER") return true;
  if (!GOLD_CHARACTER_SKUS.has(characterItem.sku)) return true;
  if (accessoryItem?.sku === "football_helmet") return false;
  if (characterItem.sku === "sea_lion" && accessoryItem?.sku === "trail_shoes") return false;
  return true;
}

function findConflictingEquipment(candidateItem, equippedAccessories) {
  return equippedAccessories
    .filter((entry) => itemsConflict(candidateItem, entry.shopItem))
    .sort((a, b) => String(a.slot).localeCompare(String(b.slot)) || String(a.id).localeCompare(String(b.id)));
}

module.exports = {
  ACCESSORY_COMPATIBILITY_TAGS,
  sanitizeCompatibility,
  readCompatibility,
  itemsConflict,
  findConflictingEquipment,
  characterAllowsAccessory,
  HELMET_SKUS,
};
