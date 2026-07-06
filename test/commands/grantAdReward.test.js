const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGrantAdReward } = require("../../src/commands/grantAdReward");

function mockDb({ userExists = true, createError = null } = {}) {
  const created = [];
  return {
    created,
    user: {
      findUnique: async ({ where }) =>
        userExists ? { id: where.id } : null,
    },
    adRewardGrant: {
      create: async ({ data }) => {
        if (createError) throw createError;
        created.push(data);
        return { id: "grant-1", ...data };
      },
    },
  };
}

test("grantAdReward: inserts a grant row keyed by transactionId", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({ prisma: db });

  const result = await grantAdReward({
    userId: "user-1",
    transactionId: "txn-1",
    adUnit: "unit-9",
    customData: "2026-07-06",
    serverDate: "2026-07-07",
  });

  assert.equal(result.granted, true);
  assert.equal(db.created.length, 1);
  assert.equal(db.created[0].userId, "user-1");
  assert.equal(db.created[0].transactionId, "txn-1");
  assert.equal(db.created[0].adUnit, "unit-9");
  // custom_data carries the user's local date — it wins over the server date.
  assert.equal(db.created[0].grantedDate, "2026-07-06");
  assert.equal(db.created[0].rewardKind, "extra_daily_spin");
});

test("grantAdReward: falls back to serverDate when custom_data is not a date", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({ prisma: db });

  await grantAdReward({
    userId: "user-1",
    transactionId: "txn-2",
    customData: "not-a-date",
    serverDate: "2026-07-07",
  });
  assert.equal(db.created[0].grantedDate, "2026-07-07");
});

test("grantAdReward: duplicate transactionId is a no-op, not an error", async () => {
  const dupe = Object.assign(new Error("unique"), { code: "P2002" });
  const grantAdReward = buildGrantAdReward({ prisma: mockDb({ createError: dupe }) });

  const result = await grantAdReward({
    userId: "user-1",
    transactionId: "txn-1",
    serverDate: "2026-07-07",
  });
  assert.deepEqual(result, { granted: false, reason: "duplicate" });
});

test("grantAdReward: unknown user grants nothing", async () => {
  const db = mockDb({ userExists: false });
  const grantAdReward = buildGrantAdReward({ prisma: db });

  const result = await grantAdReward({
    userId: "ghost",
    transactionId: "txn-1",
    serverDate: "2026-07-07",
  });
  assert.deepEqual(result, { granted: false, reason: "unknown_user" });
  assert.equal(db.created.length, 0);
});

test("grantAdReward: missing userId or transactionId is invalid", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({ prisma: db });

  assert.deepEqual(
    await grantAdReward({ transactionId: "t", serverDate: "2026-07-07" }),
    { granted: false, reason: "invalid" }
  );
  assert.deepEqual(
    await grantAdReward({ userId: "u", serverDate: "2026-07-07" }),
    { granted: false, reason: "invalid" }
  );
  assert.equal(db.created.length, 0);
});
