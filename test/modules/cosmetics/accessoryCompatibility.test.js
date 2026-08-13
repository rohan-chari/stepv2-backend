const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  findConflictingEquipment,
  sanitizeCompatibility,
} = require("../../../src/modules/cosmetics/accessoryCompatibility");
const {
  partitionCompatibleEquipment,
} = require("../../../src/modules/cosmetics/cleanupAccessoryCompatibility");

test("compatibility policy is bidirectional and malformed stored metadata is inert", () => {
  const helmet = {
    id: "helmet-row",
    slot: "HEAD",
    updatedAt: new Date("2026-08-12T12:00:00.000Z"),
    shopItem: {
      id: "helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    },
  };
  const glasses = {
    id: "glasses-row",
    slot: "FACE",
    updatedAt: new Date("2026-08-12T11:00:00.000Z"),
    shopItem: { id: "glasses", compatibility: { tags: ["eyewear"] } },
  };

  assert.equal(findConflictingEquipment(glasses.shopItem, [helmet]).length, 1);
  assert.equal(findConflictingEquipment(helmet.shopItem, [glasses]).length, 1);
  assert.equal(
    findConflictingEquipment({ compatibility: { tags: ["not-a-real-tag"] } }, [helmet])
      .length,
    0
  );
});

test("legacy cleanup keeps the most recently updated compatible loadout", () => {
  const helmet = {
    id: "helmet-row",
    slot: "HEAD",
    updatedAt: new Date("2026-08-12T12:00:00.000Z"),
    shopItem: {
      id: "helmet",
      compatibility: { tags: ["full_face"], blocksTags: ["eyewear"] },
    },
  };
  const glasses = {
    id: "glasses-row",
    slot: "FACE",
    updatedAt: new Date("2026-08-12T11:00:00.000Z"),
    shopItem: { id: "glasses", compatibility: { tags: ["eyewear"] } },
  };
  const chain = {
    id: "chain-row",
    slot: "NECK",
    updatedAt: new Date("2026-08-12T10:00:00.000Z"),
    shopItem: { id: "chain", compatibility: null },
  };

  const { kept, removed } = partitionCompatibleEquipment([glasses, chain, helmet]);
  assert.deepEqual(kept.map((entry) => entry.id), ["helmet-row", "chain-row"]);
  assert.deepEqual(removed.map((entry) => entry.id), ["glasses-row"]);
});

test("admin compatibility input rejects unknown, duplicate and non-string tags", () => {
  assert.deepEqual(sanitizeCompatibility({ tags: ["eyewear"] }), {
    tags: ["eyewear"],
  });
  for (const input of [
    { tags: ["unknown"] },
    { tags: ["eyewear", "eyewear"] },
    { tags: [1] },
    { unknown: [] },
  ]) {
    assert.throws(() => sanitizeCompatibility(input));
  }
});
