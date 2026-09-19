const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildReturnRedeemedPowerupToStash,
  ReturnRedeemedPowerupError,
} = require("../../src/modules/powerups/commands/returnRedeemedPowerupToStash");

function makeDeps(overrides = {}) {
  const row = {
    id: "pw-1",
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    type: "RAINSTORM",
    status: overrides.status || "HELD",
    redeemedFromInventory: overrides.redeemedFromInventory ?? true,
  };
  let quantity = overrides.quantity ?? 0;
  let claims = 0;
  let upserts = 0;

  const tx = {
    racePowerup: {
      async updateMany({ where, data }) {
        if (
          row.id === where.id &&
          row.status === "HELD" &&
          row.userId === where.userId &&
          row.raceId === where.raceId &&
          row.participantId === where.participantId &&
          row.type === where.type &&
          row.redeemedFromInventory === true
        ) {
          row.status = data.status;
          claims += 1;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    userPowerupItem: {
      async upsert() {
        quantity += 1;
        upserts += 1;
        return { quantity };
      },
    },
  };

  return {
    row,
    get quantity() { return quantity; },
    get claims() { return claims; },
    get upserts() { return upserts; },
    deps: {
      prisma: {
        userPowerupItem: {
          async findUnique() {
            return { quantity };
          },
        },
        async $transaction(fn) { return fn(tx); },
      },
      RacePowerup: {
        async findById() { return { ...row }; },
      },
      async slotsChanged() {},
      async invalidateInventory() {},
    },
  };
}

test("returns a redeemed HELD race item to global stash exactly once", async () => {
  const ctx = makeDeps();
  const returnToStash = buildReturnRedeemedPowerupToStash(ctx.deps);

  const result = await returnToStash({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(result.returned, true);
  assert.equal(result.powerupType, "RAINSTORM");
  assert.equal(result.quantity, 1);
  assert.equal(ctx.row.status, "DISCARDED");
  assert.equal(ctx.quantity, 1);
  assert.equal(ctx.claims, 1);
  assert.equal(ctx.upserts, 1);
});

test("retry after a successful return is idempotent and never increments stash twice", async () => {
  const ctx = makeDeps();
  const returnToStash = buildReturnRedeemedPowerupToStash(ctx.deps);

  await returnToStash({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });
  const retry = await returnToStash({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.equal(retry.returned, false);
  assert.equal(retry.alreadyReturned, true);
  assert.equal(retry.quantity, 1);
  assert.equal(ctx.quantity, 1);
  assert.equal(ctx.upserts, 1);
});

test("never returns a race-earned HELD item to stash", async () => {
  const ctx = makeDeps({ redeemedFromInventory: false });
  const returnToStash = buildReturnRedeemedPowerupToStash(ctx.deps);

  await assert.rejects(
    () => returnToStash({
      userId: "user-1",
      raceId: "race-1",
      powerupId: "pw-1",
    }),
    (error) =>
      error instanceof ReturnRedeemedPowerupError &&
      error.code === "NOT_REDEEMED_FROM_INVENTORY",
  );

  assert.equal(ctx.quantity, 0);
  assert.equal(ctx.claims, 0);
});

test("never returns a consumed redeemed item to stash", async () => {
  const ctx = makeDeps({ status: "USED" });
  const returnToStash = buildReturnRedeemedPowerupToStash(ctx.deps);

  await assert.rejects(
    () => returnToStash({
      userId: "user-1",
      raceId: "race-1",
      powerupId: "pw-1",
    }),
    (error) =>
      error instanceof ReturnRedeemedPowerupError &&
      error.code === "POWERUP_NOT_HELD",
  );

  assert.equal(ctx.quantity, 0);
  assert.equal(ctx.claims, 0);
});
