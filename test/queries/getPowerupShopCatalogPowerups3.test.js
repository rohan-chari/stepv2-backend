const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetPowerupShopCatalog,
} = require("../../src/modules/powerups/queries/getPowerupShopCatalog");
const { getEligiblePowerupPool } = require("../../src/modules/powerups/queries/getEligiblePowerupPool");
const {
  POWERUPS2_GATED_TYPES,
  POWERUPS3_GATED_TYPES,
} = require("../../src/modules/powerups/constants/powerupGating");

// ---------------------------------------------------------------------------
// `powerups3` gating (§9.2). Two INDEPENDENT, layered gates keep the new store
// items away from users until the carrying build has rolled out:
//
//   * `powerups3` is a PER-BUILD signal (X-Client-Features). The TestFlight build
//     and the shipped App Store build advertise the same token, so it cannot on
//     its own distinguish the author from a real user.
//   * `testOnly` is a release-CHANNEL gate (applied inside
//     PowerupShopItem.findActive) — TestFlight-channel requests see test-only
//     rows, prod-channel requests do not. It is NOT an account allowlist.
//
// LEECH moves from the powerups2 group to the powerups3 group (§7.5).
// ---------------------------------------------------------------------------

const ROWS = [
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", description: "d", priceCoins: 75, powerupType: "RAINSTORM" },
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", description: "d", priceCoins: 75, powerupType: "SIGNAL_JAMMER" },
  { sku: "POWERUP_LEECH", name: "Leech", description: "d", priceCoins: 150, powerupType: "LEECH" },
  { sku: "POWERUP_XRAY", name: "X-Ray", description: "d", priceCoins: 150, powerupType: "DEFENSE_SCAN" },
  { sku: "POWERUP_HITCHHIKE", name: "Hitchhike", description: "d", priceCoins: 150, powerupType: "HITCHHIKE", testOnly: true },
  { sku: "POWERUP_QUICK_RINSE", name: "Quick Rinse", description: "d", priceCoins: 75, powerupType: "QUICK_RINSE", testOnly: true },
];

function build(rowsForChannel) {
  return buildGetPowerupShopCatalog({
    User: { async findCoins() { return 1000; } },
    PowerupShopItem: {
      // Mirrors the real findActive, which applies the release-CHANNEL testOnly
      // filter before any client-feature gating happens.
      async findActive({ channel }) {
        return rowsForChannel(channel);
      },
    },
    UserPowerupItem: { async findManyByUser() { return []; } },
    PowerupCopy: { async findAll() { return []; } },
  });
}

const allRows = () => ROWS;
const channelRows = (channel) =>
  channel === "prod" ? ROWS.filter((r) => !r.testOnly) : ROWS;

test("LEECH moved from the powerups2 group to the powerups3 group", () => {
  assert.ok(!POWERUPS2_GATED_TYPES.includes("LEECH"));
  assert.deepEqual(POWERUPS3_GATED_TYPES, ["LEECH", "HITCHHIKE", "QUICK_RINSE"]);
});

test("a client WITHOUT powerups3 never sees Leech, Hitchhike or Quick Rinse", async () => {
  const catalog = await build(allRows)("u-1", {
    channel: "testflight",
    supportsJammer: true,
    supportsPowerups2: true,
    supportsPowerups3: false,
  });
  const types = catalog.items.map((i) => i.powerupType);
  assert.ok(!types.includes("LEECH"));
  assert.ok(!types.includes("HITCHHIKE"));
  assert.ok(!types.includes("QUICK_RINSE"));
  assert.ok(types.includes("DEFENSE_SCAN"), "X-Ray stays a powerups2 item");
});

test("a powerups3 client on the TestFlight channel sees all three", async () => {
  const catalog = await build(channelRows)("u-1", {
    channel: "testflight",
    supportsJammer: true,
    supportsPowerups2: true,
    supportsPowerups3: true,
  });
  const types = catalog.items.map((i) => i.powerupType);
  for (const t of ["LEECH", "HITCHHIKE", "QUICK_RINSE"]) {
    assert.ok(types.includes(t), t);
  }
});

test("testOnly is a CHANNEL gate: a powerups3 client on the prod channel still sees no new items", async () => {
  const catalog = await build(channelRows)("u-1", {
    channel: "prod",
    supportsJammer: true,
    supportsPowerups2: true,
    supportsPowerups3: true,
  });
  const types = catalog.items.map((i) => i.powerupType);
  assert.ok(!types.includes("HITCHHIKE"), "testOnly row filtered by channel");
  assert.ok(!types.includes("QUICK_RINSE"));
  assert.ok(
    types.includes("LEECH"),
    "Leech's own testOnly flip is an owner-executed production change, not a code gate"
  );
});

test("a frozen client (no tokens at all, prod channel) sees neither gate's items", async () => {
  const catalog = await build(channelRows)("u-1", { channel: "prod" });
  const types = catalog.items.map((i) => i.powerupType);
  assert.deepEqual(types, ["RAINSTORM"]);
});

test("neither new type can ever be rolled from a box or the daily reward", async () => {
  const pool = await getEligiblePowerupPool({
    channel: "testflight",
    supportsJammer: true,
    powerupShopItemModel: { async findActive() { return ROWS; } },
  });
  const types = pool.map((i) => i.powerupType);
  for (const t of ["LEECH", "HITCHHIKE", "QUICK_RINSE", "DEFENSE_SCAN"]) {
    assert.ok(!types.includes(t), `${t} must stay out of the roll pool`);
  }
  assert.ok(types.includes("RAINSTORM"));
});
