const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGrantAdReward } = require("../../src/modules/economy/commands/grantAdReward");

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

test("grantAdReward: coins:<date> custom_data mints a coin_reward grant", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({ prisma: db });

  const result = await grantAdReward({
    userId: "user-1",
    transactionId: "txn-coins-1",
    customData: "coins:2026-07-06",
    serverDate: "2026-07-07",
  });

  assert.equal(result.granted, true);
  assert.equal(db.created[0].rewardKind, "coin_reward");
  assert.equal(db.created[0].grantedDate, "2026-07-06");
});

test("grantAdReward: malformed coins: custom_data falls back to the default kind", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({ prisma: db });

  await grantAdReward({
    userId: "user-1",
    transactionId: "txn-coins-2",
    customData: "coins:not-a-date",
    serverDate: "2026-07-07",
  });

  assert.equal(db.created[0].rewardKind, "extra_daily_spin");
  assert.equal(db.created[0].grantedDate, "2026-07-07");
});

test("grantAdReward: exact race payout double namespace binds context and dedicated unit", async () => {
  const db = mockDb();
  const grantAdReward = buildGrantAdReward({
    prisma: db,
    racePayoutDoubleAdUnitIds: () => ["race-unit"],
    logger: { info() {} },
  });
  const offerId = "d05cb2a4-16b7-463f-977d-58231987a0ac";
  const result = await grantAdReward({
    userId: "user-1",
    transactionId: "txn-race-1",
    adUnit: "race-unit",
    customData: `race_payout_double:user-1:${offerId}`,
    serverDate: "2026-08-12",
  });
  assert.deepEqual(result, { granted: true });
  assert.equal(db.created[0].rewardKind, "race_payout_double");
  assert.equal(db.created[0].contextId, offerId);
  assert.equal(db.created[0].shopItemId, null);
});

for (const [label, customData, unit] of [
  ["malformed UUID", "race_payout_double:user-1:not-a-uuid", "race-unit"],
  ["mismatched user", "race_payout_double:user-2:d05cb2a4-16b7-463f-977d-58231987a0ac", "race-unit"],
  ["foreign unit", "race_payout_double:user-1:d05cb2a4-16b7-463f-977d-58231987a0ac", "extra-spin-unit"],
]) {
  test(`grantAdReward: reserved race namespace rejects ${label} without legacy fallback`, async () => {
    const db = mockDb();
    const grantAdReward = buildGrantAdReward({
      prisma: db,
      racePayoutDoubleAdUnitIds: () => ["race-unit"],
      logger: { info() { throw new Error("logger down"); } },
    });
    const result = await grantAdReward({
      userId: "user-1",
      transactionId: `txn-${label}`,
      adUnit: unit,
      customData,
      serverDate: "2026-08-12",
    });
    assert.equal(result.granted, false);
    assert.equal(db.created.length, 0);
  });
}

test("grantAdReward: rejected-Promise observability never changes valid, rejected, duplicate, or invalid outcomes", async () => {
  const logger = {
    info() { return Promise.reject(new Error("async logger down")); },
  };
  const offerId = "d05cb2a4-16b7-463f-977d-58231987a0ac";
  const args = {
    userId: "user-1",
    adUnit: "race-unit",
    customData: `race_payout_double:user-1:${offerId}`,
    serverDate: "2026-08-12",
  };

  const valid = buildGrantAdReward({
    prisma: mockDb(),
    racePayoutDoubleAdUnitIds: () => ["race-unit"],
    logger,
  });
  assert.deepEqual(await valid({ ...args, transactionId: "valid" }), { granted: true });

  const rejected = buildGrantAdReward({
    prisma: mockDb(),
    racePayoutDoubleAdUnitIds: () => ["race-unit"],
    logger,
  });
  assert.deepEqual(
    await rejected({ ...args, transactionId: "rejected", adUnit: "wrong-unit" }),
    { granted: false, reason: "invalid_race_payout_double" },
  );

  const duplicate = buildGrantAdReward({
    prisma: mockDb({ createError: Object.assign(new Error("unique"), { code: "P2002" }) }),
    racePayoutDoubleAdUnitIds: () => ["race-unit"],
    logger,
  });
  assert.deepEqual(await duplicate({ ...args, transactionId: "duplicate" }), {
    granted: false,
    reason: "duplicate",
  });

  const invalid = buildGrantAdReward({ prisma: mockDb(), logger });
  assert.deepEqual(await invalid({ transactionId: "invalid" }), {
    granted: false,
    reason: "invalid",
  });
  await new Promise((resolve) => setImmediate(resolve));
});
