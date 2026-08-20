const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildPurchasePowerupItem,
  PowerupPurchaseError,
} = require("../../src/modules/powerups/commands/purchasePowerupItem");

// ---------------------------------------------------------------------------
// Coin-purchasable powerup store. Buying a PowerupShopItem (e.g. Rainstorm, 500
// coins):
//   - debits User.coins by priceCoins
//   - increments UserPowerupItem.quantity for that powerupType (creating the row
//     on first purchase)
//   - is idempotent on (userId, idempotencyKey) via a PowerupPurchaseRequest
//     ledger — replaying the same key never double-charges.
//   - rejects with no debit when the user can't afford it.
//   - is re-buyable (no "already owned" gate — unlike cosmetics).
//   - returns the updated coin balance + the new owned quantity.
//
// Written from the Prisma schema + the cleanse/mirror mock patterns + the spec,
// NOT by mirroring implementation.
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const state = {
    user: { id: "user-1", coins: overrides.coins ?? 1000 },
    item: overrides.item === null
      ? null
      : {
          id: "psi-1",
          sku: overrides.sku ?? "POWERUP_RAINSTORM",
          name: overrides.name ?? "Rainstorm",
          description: overrides.description ?? "Swap positions",
          priceCoins: overrides.priceCoins ?? 500,
          powerupType: overrides.powerupType ?? "RAINSTORM",
          active: overrides.itemActive ?? true,
        },
    // existing inventory quantity for the purchased type
    inventoryQty: overrides.inventoryQty ?? 0,
    // ledger keyed by idempotencyKey
    requests: new Map(),
  };

  const calls = {
    coinDebits: [],
    inventoryIncrements: [],
    coinTransactions: [],
  };

  const deps = {
    // A transactional runner that just passes a tx with the same model surface.
    runTransaction: async (fn) => fn(tx),
    state,
    calls,
  };

  const tx = {
    powerupShopItem: {
      async findFirst({ where }) {
        if (!state.item) return null;
        if (where.active && !state.item.active) return null;
        if (where.sku && where.sku !== state.item.sku) return null;
        if (where.id && where.id !== state.item.id) return null;
        return state.item;
      },
    },
    user: {
      async findUnique() {
        return state.user;
      },
      async updateMany({ where, data }) {
        // Atomic conditional debit: only succeeds if coins >= required.
        const required = where.coins?.gte ?? 0;
        if (state.user.coins < required) return { count: 0 };
        const dec = data.coins?.decrement ?? 0;
        state.user.coins -= dec;
        calls.coinDebits.push(dec);
        return { count: 1 };
      },
    },
    userPowerupItem: {
      async upsert({ where, create, update }) {
        calls.inventoryIncrements.push({ where, create, update });
        const inc = update?.quantity?.increment ?? create?.quantity ?? 0;
        state.inventoryQty += inc;
        return {
          userId: where.userId_powerupType.userId,
          powerupType: where.userId_powerupType.powerupType,
          quantity: state.inventoryQty,
        };
      },
    },
    coinTransaction: {
      async create({ data }) {
        calls.coinTransactions.push(data);
        return { id: "ct-1", ...data };
      },
    },
    powerupPurchaseRequest: {
      async findUnique({ where }) {
        return state.requests.get(where.userId_idempotencyKey.idempotencyKey) || null;
      },
      async create({ data }) {
        state.requests.set(data.idempotencyKey, { ...data });
        return { id: "ppr-1", ...data };
      },
      async update({ where, data }) {
        const existing = state.requests.get(where.userId_idempotencyKey.idempotencyKey);
        const merged = { ...existing, ...data };
        state.requests.set(where.userId_idempotencyKey.idempotencyKey, merged);
        return merged;
      },
    },
  };

  return deps;
}

test("purchase debits coins and increments inventory quantity", async () => {
  const deps = makeDeps({ coins: 1000, priceCoins: 500, inventoryQty: 0 });
  const purchase = buildPurchasePowerupItem(deps);

  const result = await purchase({
    userId: "user-1",
    sku: "POWERUP_RAINSTORM",
    idempotencyKey: "key-1",
  });

  assert.equal(deps.state.user.coins, 500, "coins debited by 500");
  assert.equal(deps.calls.coinDebits[0], 500);
  assert.equal(result.coins, 500, "returns updated balance");
  assert.equal(result.inventory.quantity, 1, "owned quantity is now 1");
  assert.equal(result.inventory.powerupType, "RAINSTORM");
});

test("purchase is re-buyable: a second buy increments quantity again", async () => {
  const deps = makeDeps({ coins: 2000, priceCoins: 500, inventoryQty: 3 });
  const purchase = buildPurchasePowerupItem(deps);

  const result = await purchase({
    userId: "user-1",
    sku: "POWERUP_RAINSTORM",
    idempotencyKey: "key-rebuy",
  });

  assert.equal(deps.state.user.coins, 1500);
  assert.equal(result.inventory.quantity, 4, "quantity went 3 -> 4");
});

test("insufficient coins is rejected and does NOT debit", async () => {
  const deps = makeDeps({ coins: 100, priceCoins: 500 });
  const purchase = buildPurchasePowerupItem(deps);

  await assert.rejects(
    () =>
      purchase({
        userId: "user-1",
        sku: "POWERUP_RAINSTORM",
        idempotencyKey: "key-poor",
      }),
    (err) => {
      assert.ok(err instanceof PowerupPurchaseError);
      assert.match(err.message, /coin/i);
      return true;
    }
  );

  assert.equal(deps.state.user.coins, 100, "coins unchanged");
  assert.equal(deps.calls.coinDebits.length, 0, "no debit happened");
  assert.equal(deps.state.inventoryQty, 0, "no inventory granted");
});

test("inactive / missing item is rejected", async () => {
  const deps = makeDeps({ item: null });
  const purchase = buildPurchasePowerupItem(deps);

  await assert.rejects(
    () =>
      purchase({
        userId: "user-1",
        sku: "POWERUP_RAINSTORM",
        idempotencyKey: "key-missing",
      }),
    (err) => err instanceof PowerupPurchaseError
  );
});

test("idempotent: replaying the same key returns the prior result and does not double-charge", async () => {
  const deps = makeDeps({ coins: 1000, priceCoins: 500 });
  const purchase = buildPurchasePowerupItem(deps);

  const first = await purchase({
    userId: "user-1",
    sku: "POWERUP_RAINSTORM",
    idempotencyKey: "dup-key",
  });
  assert.equal(deps.state.user.coins, 500);

  const second = await purchase({
    userId: "user-1",
    sku: "POWERUP_RAINSTORM",
    idempotencyKey: "dup-key",
  });

  assert.equal(deps.state.user.coins, 500, "balance unchanged on replay");
  assert.equal(deps.calls.coinDebits.length, 1, "debit happened exactly once");
  assert.equal(second.coins, first.coins);
  assert.equal(second.purchase.idempotent, true, "marked idempotent replay");
});

test("Cleanse (POWERUP_CLEANSE, 150 coins) purchases like any other shop powerup", async () => {
  const deps = makeDeps({
    coins: 400,
    sku: "POWERUP_CLEANSE",
    name: "Cleanse",
    powerupType: "CLEANSE",
    priceCoins: 150,
    inventoryQty: 0,
  });
  const purchase = buildPurchasePowerupItem(deps);

  const result = await purchase({
    userId: "user-1",
    sku: "POWERUP_CLEANSE",
    idempotencyKey: "cleanse-buy-1",
  });

  assert.equal(deps.state.user.coins, 250, "coins debited by 150");
  assert.equal(deps.calls.coinDebits[0], 150);
  assert.equal(result.coins, 250);
  assert.equal(result.inventory.powerupType, "CLEANSE");
  assert.equal(result.inventory.quantity, 1);
  assert.equal(result.item.powerupType, "CLEANSE");
  assert.equal(result.item.priceCoins, 150);
});

test("missing idempotency key is rejected", async () => {
  const deps = makeDeps();
  const purchase = buildPurchasePowerupItem(deps);

  await assert.rejects(
    () => purchase({ userId: "user-1", sku: "POWERUP_RAINSTORM" }),
    (err) => err instanceof PowerupPurchaseError
  );
});
