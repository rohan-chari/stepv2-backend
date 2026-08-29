const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildGetPowerupCopyCatalog,
} = require("../../src/modules/powerups/queries/getPowerupCopyCatalog");
test("guide catalog marks only active shop/roll powerups as available", async () => {
  const getCatalog = buildGetPowerupCopyCatalog({
    PowerupCopy: { findAll: async () => [
      { powerupType: "ACTIVE", name: "Active", description: "a", updatedAt: new Date() },
      { powerupType: "DISABLED", name: "Disabled", description: "d", updatedAt: new Date() },
    ] },
    PowerupShopItem: { findActive: async () => [{ powerupType: "ACTIVE" }] },
    powerupBalanceConfig: {
      getAvailabilitySnapshot: async () => ({ authoritative: true, config: {} }),
    },
    canonicalRollAvailabilityForClient: () => new Set(["ACTIVE"]),
    appSettings: { getFlag: async () => false },
  });
  const result = await getCatalog(new Set(["powerup_stacking_guide_v1"]));
  assert.deepEqual(result.powerups.map((row) => [row.type, row.availability]), [
    ["ACTIVE", { shop: true, roll: true }],
  ]);
  assert.equal(result.availabilityVersion, 2);
});
const {
  buildGetPowerupShopCatalog,
} = require("../../src/modules/powerups/queries/getPowerupShopCatalog");
const {
  POWERUP_COPY_SEED,
  POWERUP_COPY_TYPES,
} = require("../../src/modules/powerups/constants/powerupCopySeed");
const { UPGRADEABLE_TYPES } = require("../../src/modules/powerups/powerupUpgrades");

// ---------------------------------------------------------------------------
// GET /powerups/catalog (§9.5) — the single source of truth for powerup copy.
//
// Keyed by PowerupType rather than SKU, because only 6 of the usable types have
// a PowerupShopItem row while every type needs use-sheet and effect-rail copy.
// Unauthenticated-safe and client-feature-INDEPENDENT: copy is not a capability,
// and receiving copy for a type a client cannot obtain is harmless.
// ---------------------------------------------------------------------------

const NEWEST = new Date("2026-07-20T22:15:00.000Z");

function rowsFromSeed() {
  return POWERUP_COPY_SEED.map((row, index) => ({
    ...row,
    updatedAt:
      index === 0 ? NEWEST : new Date(NEWEST.getTime() - (index + 1) * 1000),
  }));
}

function makeDeps(rows = rowsFromSeed()) {
  return {
    PowerupCopy: {
      async findAll() {
        return rows;
      },
    },
  };
}

test("returns exactly the user-renderable types and EXCLUDES MYSTERY_BOX", async () => {
  const result = await buildGetPowerupCopyCatalog(makeDeps())();
  const types = result.powerups.map((p) => p.type);

  assert.equal(types.length, 39, "28 through wave 4 + the 11 powerups5-wave types");
  assert.equal(new Set(types).size, types.length, "no duplicate types");
  assert.ok(!types.includes("MYSTERY_BOX"), "MYSTERY_BOX is a container state");
  // Drop-only types (never purchasable, so never in PowerupShopItem) must be
  // present — this is precisely why the catalog is not keyed by SKU.
  for (const dropOnly of [
    "PROTEIN_SHAKE",
    "SECOND_WIND",
    "TRAIL_MIX",
    "POCKET_WATCH",
    "TRAIL_MINE",
    "SNEAKY_SWAP",
  ]) {
    assert.ok(types.includes(dropOnly), `${dropOnly} must have copy`);
  }
  for (const newType of ["HITCHHIKE", "QUICK_RINSE"]) {
    assert.ok(types.includes(newType));
  }
});

test("every PowerupType except MYSTERY_BOX has a seeded row", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "..", "prisma", "schema.prisma"),
    "utf8"
  );
  const block = schema.match(/enum PowerupType \{([\s\S]*?)\n\}/);
  assert.ok(block, "PowerupType enum found");
  const enumTypes = [...block[1].matchAll(/^\s{2}([A-Z_]+)\s+@map/gm)].map(
    (m) => m[1]
  );
  const renderable = enumTypes.filter((t) => t !== "MYSTERY_BOX");
  assert.deepEqual(
    [...POWERUP_COPY_TYPES].sort(),
    [...renderable].sort(),
    "the seed must cover every user-renderable enum value"
  );
});

test("the new enum values are ordered BEFORE mystery_box", () => {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "..", "prisma", "schema.prisma"),
    "utf8"
  );
  const block = schema.match(/enum PowerupType \{([\s\S]*?)\n\}/)[1];
  const order = [...block.matchAll(/^\s{2}([A-Z_]+)\s+@map/gm)].map((m) => m[1]);
  const mystery = order.indexOf("MYSTERY_BOX");
  assert.ok(order.indexOf("HITCHHIKE") < mystery);
  assert.ok(order.indexOf("QUICK_RINSE") < mystery);
  assert.equal(mystery, order.length - 1, "mystery_box stays last");

  const migration = fs.readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "prisma",
      "migrations",
      "20260720120000_add_hitchhike_quick_rinse_and_powerup_copy",
      "migration.sql"
    ),
    "utf8"
  );
  for (const value of ["hitchhike", "quick_rinse"]) {
    assert.match(
      migration,
      new RegExp(`ADD VALUE IF NOT EXISTS '${value}' BEFORE 'mystery_box'`),
      `${value} must be added BEFORE 'mystery_box' or the DB ordering diverges`
    );
  }
});

test("version is the maximum row updatedAt, serialized as ISO-8601", async () => {
  const result = await buildGetPowerupCopyCatalog(makeDeps())();
  assert.equal(result.version, NEWEST.toISOString());
});

test("each entry carries name, description, shortDescription and upgradeTierLabels", async () => {
  const result = await buildGetPowerupCopyCatalog(makeDeps())();
  const byType = Object.fromEntries(result.powerups.map((p) => [p.type, p]));

  assert.equal(byType.LEECH.name, "Leech");
  assert.equal(byType.LEECH.shortDescription, "Steps being stolen");
  assert.deepEqual(byType.LEECH.upgradeTierLabels, []);
  assert.deepEqual(byType.POCKET_WATCH.upgradeTierLabels, [
    "Extend 1h",
    "Extend 2h",
    "Extend 3h",
    "Extend 4h",
  ]);
  assert.equal(
    byType.RED_CARD.shortDescription,
    null,
    "a type with no short form serializes null so the client omits the subtitle"
  );
  for (const entry of result.powerups) {
    assert.ok(entry.name && entry.name.length > 0, entry.type);
    assert.ok(entry.description && entry.description.length > 0, entry.type);
    assert.ok(Array.isArray(entry.upgradeTierLabels), entry.type);
  }
});

// RETIRED LADDERS: upgradeable for compatibility, but with no tier labels.
//
// LUCKY_HORSESHOE (batch 2026-08-09 item 8b) is the only member and the only
// place the two lists are allowed to disagree. It must STAY in
// `upgradeableTypes` or every frozen binary — which decides "is this
// upgradeable?" from its BUNDLED table — takes a permanent 400 on an upgrade it
// still offers; the cost ladder is zeroed to [0,0,0,0] instead, so those
// upgrades are free and inert. But it must ship NO labels, because the server
// snapshot wins over the bundled fallback and a NEW build hides the upgrade UI
// exactly when the label list is empty.
//
// This is an explicit, named exception rather than a loosened assertion: every
// other upgradeable type must still carry exactly 4 labels, every
// non-upgradeable type must still carry 0, and adding a type here requires
// stating why its ladder is retired.
const RETIRED_UPGRADE_LADDERS = new Set(["LUCKY_HORSESHOE"]);

test("upgradeTierLabels has 4 entries for every upgradeable type and is empty otherwise", () => {
  for (const row of POWERUP_COPY_SEED) {
    const expected =
      UPGRADEABLE_TYPES.has(row.powerupType) &&
      !RETIRED_UPGRADE_LADDERS.has(row.powerupType)
        ? 4
        : 0;
    assert.equal(
      row.upgradeTierLabels.length,
      expected,
      `${row.powerupType} should have ${expected} tier labels`
    );
  }
});

test("a retired ladder stays upgradeable but ships no labels and costs nothing", () => {
  const { upgradeCost } = require("../../src/modules/powerups/powerupUpgrades");
  for (const type of RETIRED_UPGRADE_LADDERS) {
    const row = POWERUP_COPY_SEED.find((r) => r.powerupType === type);
    assert.ok(row, `${type} must still have a copy row`);
    // The frozen-client contract: still upgradeable server-side...
    assert.ok(
      UPGRADEABLE_TYPES.has(type),
      `${type} must stay upgradeable or frozen clients 400`
    );
    // ...but free, so the inert upgrade an old build offers costs the user nothing.
    assert.deepEqual(
      [0, 1, 2, 3].map((lvl) => upgradeCost(type, lvl)),
      [0, 0, 0, 0],
      `${type} upgrades must be free`
    );
    // ...and invisible to any build that reads the server snapshot.
    assert.deepEqual(row.upgradeTierLabels, []);
  }
});

test("seeded copy matches the pre-migration frontend strings, except the intentional Leech duration update", () => {
  const byType = Object.fromEntries(
    POWERUP_COPY_SEED.map((r) => [r.powerupType, r])
  );
  // Spot-checks across all three former maps.
  assert.equal(byType.RUNNERS_HIGH.name, "Runner's High");
  assert.equal(byType.DEFENSE_SCAN.name, "X-Ray");
  assert.equal(byType.LEG_CRAMP.description, "Freeze a rival's steps for 1 hour");
  assert.equal(
    byType.CAMPFIRE_REST.description,
    "Freeze for 30 min, then multiply steps for up to 90 min"
  );
  assert.equal(byType.LEG_CRAMP.shortDescription, "Steps frozen");
  assert.equal(
    Object.values(byType).filter((r) => r.shortDescription != null).length,
    27,
    "17 through wave 4 + 10 of the 11 powerups5 types (Mystery Potion has none)"
  );
  // The one intentional change.
  assert.match(byType.LEECH.description, /^For 60 min, /);
  assert.ok(
    !byType.LEECH.description.includes("30 min"),
    "the authoritative Leech copy describes the 60-minute powerups3 product"
  );
});

test("catalog is NOT filtered by client features (copy is not a capability)", async () => {
  const build = buildGetPowerupCopyCatalog(makeDeps());
  const plain = await build();
  const gated = await build({ supportsPowerups3: false, channel: "prod" });
  assert.deepEqual(gated, plain);
  assert.ok(gated.powerups.some((p) => p.type === "HITCHHIKE"));
});

test("an empty table degrades to an empty catalog rather than throwing", async () => {
  const result = await buildGetPowerupCopyCatalog(makeDeps([]))();
  assert.deepEqual(result.powerups, []);
  assert.equal(result.version, null);
});

test("guide-capable catalog rows carry complete bounded two-axis stacking metadata", async () => {
  const features = new Set([
    "jammer",
    "powerups2",
    "powerups3",
    "powerups4",
    "powerups5",
    "hitchhike_effective_steps",
    "powerup_stacking_guide_v1",
  ]);
  const result = await buildGetPowerupCopyCatalog(makeDeps())(features);

  assert.equal(result.stackingVersion, 2);
  assert.ok(!result.powerups.some((row) => row.type === "IMPOSTER"));
  const same = new Set(["NOT_APPLICABLE", "BLOCKED", "EXTENDS", "ALLOWED", "LIMITED"]);
  const other = new Set(["NOT_APPLICABLE", "ALLOWED", "CONDITIONAL", "CONFLICTS"]);
  for (const row of result.powerups) {
    assert.ok(row.stacking, `${row.type} stacking row`);
    assert.ok(same.has(row.stacking.samePowerup), row.type);
    assert.ok(other.has(row.stacking.otherEffects), row.type);
    assert.ok(row.stacking.summary.trim().length > 0, row.type);
    assert.ok([...row.stacking.summary].length <= 240, row.type);
  }
});

test("guide catalog applies the complete request capability visibility rule", async () => {
  const build = buildGetPowerupCopyCatalog(makeDeps());
  const legacyCapabilitySet = await build(new Set(["powerup_stacking_guide_v1"]));
  const types = new Set(legacyCapabilitySet.powerups.map((row) => row.type));
  for (const hidden of [
    "IMPOSTER", "DEFENSE_SCAN", "LEECH", "HITCHHIKE", "QUICK_RINSE",
    "QUICKSAND", "UPRISING", "GHOST_PEPPER", "COIN_FLIP", "MYSTERY_POTION",
    "DECOY", "POWER_OUTAGE", "UMBRELLA", "RALLY_FLAG", "DRILL_SERGEANT",
    "PIGGY_BANK", "BOUNTY",
  ]) {
    assert.equal(types.has(hidden), false, hidden);
  }
});

// ── The shop endpoint now SOURCES its strings from the copy catalog ─────────

test("getPowerupShopCatalog serves copy-catalog strings while keeping its response SHAPE unchanged", async () => {
  const catalog = await buildGetPowerupShopCatalog({
    User: { async findCoins() { return 500; } },
    PowerupShopItem: {
      async findActive() {
        return [
          {
            sku: "POWERUP_LEECH",
            // Stale strings on the deprecated columns — they must NOT be served.
            name: "STALE NAME",
            description: "STALE DESCRIPTION",
            priceCoins: 150,
            powerupType: "LEECH",
          },
        ];
      },
    },
    UserPowerupItem: { async findManyByUser() { return []; } },
    PowerupCopy: {
      async findAll() {
        return rowsFromSeed();
      },
    },
  })("u-1", { supportsPowerups2: true, supportsPowerups3: true });

  assert.deepEqual(Object.keys(catalog).sort(), ["coins", "items"]);
  const [item] = catalog.items;
  // Item 9 (2026-07-24): `category` + `rarity` are additive shop-catalog fields.
  assert.deepEqual(Object.keys(item).sort(), [
    "category",
    "description",
    "name",
    "ownedQuantity",
    "powerupType",
    "priceCoins",
    "rarity",
    "sku",
  ]);
  assert.equal(item.name, "Leech", "sourced from PowerupCopy, not PowerupShopItem");
  assert.match(item.description, /^For 60 min, /);
});

test("getPowerupShopCatalog falls back to the shop row when a type has no copy row", async () => {
  const catalog = await buildGetPowerupShopCatalog({
    User: { async findCoins() { return 0; } },
    PowerupShopItem: {
      async findActive() {
        return [
          {
            sku: "POWERUP_MYSTERY",
            name: "Legacy Name",
            description: "Legacy description",
            priceCoins: 10,
            powerupType: "RAINSTORM",
          },
        ];
      },
    },
    UserPowerupItem: { async findManyByUser() { return []; } },
    PowerupCopy: {
      async findAll() {
        return [];
      },
    },
  })("u-1", {});

  assert.equal(catalog.items[0].name, "Legacy Name");
  assert.equal(catalog.items[0].description, "Legacy description");
});
