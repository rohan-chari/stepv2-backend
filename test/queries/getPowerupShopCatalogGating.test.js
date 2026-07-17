const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetPowerupShopCatalog,
} = require("../../src/queries/getPowerupShopCatalog");

// ---------------------------------------------------------------------------
// GET /shop/powerups gating (Items 2 + 3):
//   * IMPOSTER is filtered out when the kill switch is on (IMPOSTER_ENABLED=
//     "false") — no app version is offered it (Item 3).
//   * Leech + X-Ray (DEFENSE_SCAN) are hidden unless the client advertises the
//     `powerups2` feature (Item 2).
//   * Signal Jammer stays behind the `jammer` feature (unchanged).
// The Imposter kill switch is env-driven, so this test sets + restores
// IMPOSTER_ENABLED around each assertion.
// ---------------------------------------------------------------------------

const CATALOG = [
  { sku: "POWERUP_IMPOSTER", name: "Imposter", description: "", priceCoins: 75, powerupType: "IMPOSTER" },
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", description: "", priceCoins: 75, powerupType: "RAINSTORM" },
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", description: "", priceCoins: 75, powerupType: "SIGNAL_JAMMER" },
  { sku: "POWERUP_LEECH", name: "Leech", description: "", priceCoins: 300, powerupType: "LEECH" },
  { sku: "POWERUP_XRAY", name: "X-Ray", description: "", priceCoins: 150, powerupType: "DEFENSE_SCAN" },
];

function buildCatalog() {
  return buildGetPowerupShopCatalog({
    User: { async findCoins() { return 1000; } },
    PowerupShopItem: { async findActive() { return CATALOG; } },
    UserPowerupItem: { async findManyByUser() { return []; } },
  });
}

async function typesFor(opts, { imposterEnabledEnv } = {}) {
  const prev = process.env.IMPOSTER_ENABLED;
  if (imposterEnabledEnv === false) process.env.IMPOSTER_ENABLED = "false";
  else delete process.env.IMPOSTER_ENABLED;
  try {
    const result = await buildCatalog()("user-1", opts);
    return result.items.map((i) => i.powerupType);
  } finally {
    if (prev === undefined) delete process.env.IMPOSTER_ENABLED;
    else process.env.IMPOSTER_ENABLED = prev;
  }
}

test("Leech + X-Ray are hidden without the powerups2 feature", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: false });
  assert.ok(!types.includes("LEECH"));
  assert.ok(!types.includes("DEFENSE_SCAN"));
  assert.ok(types.includes("RAINSTORM"));
});

test("Leech + X-Ray are visible with the powerups2 feature", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  assert.ok(types.includes("LEECH"));
  assert.ok(types.includes("DEFENSE_SCAN"));
});

test("Signal Jammer stays gated behind the jammer feature", async () => {
  const withJammer = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  const withoutJammer = await typesFor({ supportsJammer: false, supportsPowerups2: true });
  assert.ok(withJammer.includes("SIGNAL_JAMMER"));
  assert.ok(!withoutJammer.includes("SIGNAL_JAMMER"));
});

test("IMPOSTER stays in the catalog by default (kill switch off)", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  assert.ok(types.includes("IMPOSTER"), "default (env unset) keeps Imposter visible");
});

test("IMPOSTER is filtered out when IMPOSTER_ENABLED=false (Item 3)", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true }, { imposterEnabledEnv: false });
  assert.ok(!types.includes("IMPOSTER"), "kill switch removes Imposter for every client version");
  // The rest of the catalog is unaffected.
  assert.ok(types.includes("RAINSTORM"));
});
