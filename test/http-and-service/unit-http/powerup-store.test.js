const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// New additive endpoints for the powerup store + global inventory:
//   GET  /shop/powerups            -> active catalog + coins + owned quantities
//   POST /shop/powerups/purchase   -> buy a powerup (idempotent), returns balance + inventory
//   GET  /powerups/inventory       -> the user's owned powerup quantities
//   POST /races/:raceId/powerups/redeem -> spend a global powerup into a race
//
// Mirrors the stubbed-auth DI pattern of the other HTTP route tests.

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

const ME = "user-me";

function depsWithStubAuth(overrides = {}) {
  return {
    requireAuth(req, _res, next) {
      req.user = { id: ME, appleId: "apple-sub-me", displayName: "Me" };
      next();
    },
    ...overrides,
  };
}

async function getJson(baseUrl, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: "Bearer t" },
  });
  return { status: res.status, body: await res.json() };
}

async function postJson(baseUrl, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json() };
}

test("GET /shop/powerups returns the catalog with coins + owned quantities", async () => {
  const server = await startServer(
    depsWithStubAuth({
      getPowerupShopCatalog: async (userId) => {
        assert.equal(userId, ME);
        return {
          coins: 750,
          items: [
            {
              sku: "POWERUP_RAINSTORM",
              name: "Rainstorm",
              description: "Swap positions",
              priceCoins: 75,
              powerupType: "RAINSTORM",
              ownedQuantity: 2,
            },
          ],
        };
      },
    })
  );
  try {
    const { status, body } = await getJson(server.baseUrl, "/shop/powerups");
    assert.equal(status, 200);
    assert.equal(body.coins, 750);
    assert.equal(body.items[0].sku, "POWERUP_RAINSTORM");
    assert.equal(body.items[0].priceCoins, 75);
    assert.equal(body.items[0].ownedQuantity, 2);
  } finally {
    await server.close();
  }
});

test("GET /shop/powerups includes Cleanse (POWERUP_CLEANSE, 150 coins)", async () => {
  const server = await startServer(
    depsWithStubAuth({
      getPowerupShopCatalog: async () => ({
        coins: 500,
        items: [
          {
            sku: "POWERUP_CLEANSE",
            name: "Cleanse",
            description: "Wash away every debuff a rival stuck on you",
            priceCoins: 150,
            powerupType: "CLEANSE",
            ownedQuantity: 0,
          },
        ],
      }),
    })
  );
  try {
    const { status, body } = await getJson(server.baseUrl, "/shop/powerups");
    assert.equal(status, 200);
    assert.equal(body.items[0].sku, "POWERUP_CLEANSE");
    assert.equal(body.items[0].powerupType, "CLEANSE");
    assert.equal(body.items[0].priceCoins, 150);
  } finally {
    await server.close();
  }
});

test("POST /shop/powerups/purchase buys a powerup and returns balance + inventory", async () => {
  const server = await startServer(
    depsWithStubAuth({
      purchasePowerupItem: async ({ userId, sku, idempotencyKey }) => {
        assert.equal(userId, ME);
        assert.equal(sku, "POWERUP_RAINSTORM");
        assert.equal(idempotencyKey, "idem-1");
        return {
          coins: 250,
          inventory: { powerupType: "RAINSTORM", quantity: 1 },
          purchase: { idempotent: false, coinsSpent: 75 },
        };
      },
    })
  );
  try {
    const { status, body } = await postJson(
      server.baseUrl,
      "/shop/powerups/purchase",
      { sku: "POWERUP_RAINSTORM" },
      { "Idempotency-Key": "idem-1" }
    );
    assert.equal(status, 200);
    assert.equal(body.coins, 250);
    assert.equal(body.inventory.quantity, 1);
  } finally {
    await server.close();
  }
});

test("POST /shop/powerups/purchase maps PowerupPurchaseError to its status code", async () => {
  const server = await startServer(
    depsWithStubAuth({
      purchasePowerupItem: async () => {
        const err = new Error("Insufficient coins");
        err.name = "PowerupPurchaseError";
        err.statusCode = 400;
        throw err;
      },
    })
  );
  try {
    const { status, body } = await postJson(
      server.baseUrl,
      "/shop/powerups/purchase",
      { sku: "POWERUP_RAINSTORM" },
      { "Idempotency-Key": "idem-2" }
    );
    assert.equal(status, 400);
    assert.match(body.error, /coin/i);
  } finally {
    await server.close();
  }
});

test("GET /powerups/inventory returns owned quantities", async () => {
  const server = await startServer(
    depsWithStubAuth({
      getPowerupInventory: async (userId) => {
        assert.equal(userId, ME);
        return { items: [{ powerupType: "RAINSTORM", quantity: 3 }] };
      },
    })
  );
  try {
    const { status, body } = await getJson(server.baseUrl, "/powerups/inventory");
    assert.equal(status, 200);
    assert.equal(body.items[0].powerupType, "RAINSTORM");
    assert.equal(body.items[0].quantity, 3);
  } finally {
    await server.close();
  }
});

test("POST /races/:raceId/powerups/redeem spends a global powerup into the race", async () => {
  const server = await startServer(
    depsWithStubAuth({
      redeemPowerupToRace: async ({ userId, raceId, powerupType }) => {
        assert.equal(userId, ME);
        assert.equal(raceId, "race-1");
        assert.equal(powerupType, "RAINSTORM");
        return { powerup: { id: "rpw-1", type: "RAINSTORM", status: "HELD" } };
      },
    })
  );
  try {
    const { status, body } = await postJson(
      server.baseUrl,
      "/races/race-1/powerups/redeem",
      { powerupType: "RAINSTORM" }
    );
    assert.equal(status, 200);
    assert.equal(body.result.powerup.type, "RAINSTORM");
    assert.equal(body.result.powerup.status, "HELD");
  } finally {
    await server.close();
  }
});

test("POST /races/:raceId/powerups/redeem maps RedeemPowerupError to its status", async () => {
  const server = await startServer(
    depsWithStubAuth({
      redeemPowerupToRace: async () => {
        const err = new Error("You don't own any Rainstorm");
        err.name = "RedeemPowerupError";
        err.statusCode = 400;
        throw err;
      },
    })
  );
  try {
    const { status, body } = await postJson(
      server.baseUrl,
      "/races/race-1/powerups/redeem",
      { powerupType: "RAINSTORM" }
    );
    assert.equal(status, 400);
    assert.match(body.error, /Rainstorm/i);
  } finally {
    await server.close();
  }
});
