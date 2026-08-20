const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetPowerupShopCatalog,
} = require("../../src/modules/powerups/queries/getPowerupShopCatalog");

// ---------------------------------------------------------------------------
// GET /shop/powerups gating (Items 2 + 3):
//   * IMPOSTER is permanently filtered out — no app version is offered it.
//   * Leech + X-Ray (DEFENSE_SCAN) are hidden unless the client advertises the
//     `powerups2` feature (Item 2).
//   * Signal Jammer stays behind the `jammer` feature (unchanged).
// A stale IMPOSTER_ENABLED value must not reactivate the retired item.
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

// LEECH MOVED from the powerups2 gate to the powerups3 gate (§7.5/§9.2): its
// duration is now capability-versioned (30 min for a legacy request, 60 min for
// a powerups3 one), so only a build that advertises powerups3 should be able to
// BUY one. Catalog visibility only — an existing owner of a banked Leech can
// still use it, and an old build's use still creates the 30-minute effect its own
// bundled copy describes.
test("X-Ray is still visible with the powerups2 feature", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  assert.ok(types.includes("DEFENSE_SCAN"), "X-Ray remains a powerups2 item");
});

test("Leech is NOT visible with powerups2 alone (it moved to the powerups3 gate)", async () => {
  const types = await typesFor({
    supportsJammer: true,
    supportsPowerups2: true,
    supportsPowerups3: false,
  });
  assert.ok(!types.includes("LEECH"));
});

test("Leech IS visible with the powerups3 feature", async () => {
  const types = await typesFor({
    supportsJammer: true,
    supportsPowerups2: true,
    supportsPowerups3: true,
  });
  assert.ok(types.includes("LEECH"));
  assert.ok(types.includes("DEFENSE_SCAN"), "the powerups2 item is unaffected");
});

test("Signal Jammer stays gated behind the jammer feature", async () => {
  const withJammer = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  const withoutJammer = await typesFor({ supportsJammer: false, supportsPowerups2: true });
  assert.ok(withJammer.includes("SIGNAL_JAMMER"));
  assert.ok(!withoutJammer.includes("SIGNAL_JAMMER"));
});

test("IMPOSTER stays retired when the legacy environment switch is absent", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true });
  assert.ok(!types.includes("IMPOSTER"));
});

test("IMPOSTER stays retired when the legacy environment switch is false", async () => {
  const types = await typesFor({ supportsJammer: true, supportsPowerups2: true }, { imposterEnabledEnv: false });
  assert.ok(!types.includes("IMPOSTER"), "kill switch removes Imposter for every client version");
  // The rest of the catalog is unaffected.
  assert.ok(types.includes("RAINSTORM"));
});
