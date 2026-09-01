const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUserPresentationCache,
} = require("../../src/modules/social/services/userPresentationCache");

function row(id) {
  return {
    id,
    displayName: id,
    profilePhotoUrl: null,
    equippedAccessories: [],
    clientFeatures: [],
    isReviewAccount: false,
    hiddenFromLeaderboard: false,
  };
}

test("concurrent cold presentation reads share one database query", async () => {
  const calls = [];
  const service = buildUserPresentationCache({
    prisma: {
      user: {
        async findMany({ where }) {
          calls.push([...where.id.in]);
          return where.id.in.map(row);
        },
      },
    },
    redisCache: { isEnabled() { return false; } },
    logger: { info() {} },
  });

  const [first, second, third] = await Promise.all([
    service.getMany(["u1", "u2"], false),
    service.getMany(["u2", "u3"], false),
    service.getMany(["u4"], false),
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(new Set(calls[0]), new Set(["u1", "u2", "u3", "u4"]));
  assert.equal(first.get("u1").id, "u1");
  assert.equal(second.get("u3").id, "u3");
  assert.equal(third.get("u4").id, "u4");
});

test("production presentation loading joins users and cosmetics in one pool checkout", async () => {
  const calls = [];
  const service = buildUserPresentationCache({
    prisma: {
      async $queryRawUnsafe(sql, ids) {
        calls.push({ sql, ids });
        return [{
          id: "u1", displayName: "Runner", profilePhotoUrl: null,
          clientFeatures: ["characters"], isReviewAccount: false,
          hiddenFromLeaderboard: false,
          equippedAccessories: [{ shopItem: {
            id: "item-1", sku: "hat", name: "Hat", slot: "HEAD",
            assetKey: "hat", renderMetadata: null, bobble: true,
            testOnly: false, remoteOnly: false, assetVersion: null,
          } }],
        }];
      },
      user: { async findMany() { throw new Error("nested Prisma relation load must not run"); } },
    },
    redisCache: { isEnabled() { return false; } },
    logger: { info() {} },
  });

  const loaded = await service.loadMany(["u1", "missing"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].ids, ["u1", "missing"]);
  assert.match(calls[0].sql, /LEFT JOIN user_equipped_accessories/);
  assert.match(calls[0].sql, /LEFT JOIN shop_items/);
  assert.equal(loaded.get("u1").equippedAccessories[0].shopItem.sku, "hat");
  assert.equal(loaded.get("missing"), null);
});
