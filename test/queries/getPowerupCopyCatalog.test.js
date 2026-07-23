const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildGetPowerupCopyCatalog,
} = require("../../src/modules/powerups/queries/getPowerupCopyCatalog");
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
    "Extend 1.5h",
    "Extend 2h",
    "Extend 3h",
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

test("upgradeTierLabels has 4 entries for every upgradeable type and is empty otherwise", () => {
  for (const row of POWERUP_COPY_SEED) {
    const expected = UPGRADEABLE_TYPES.has(row.powerupType) ? 4 : 0;
    assert.equal(
      row.upgradeTierLabels.length,
      expected,
      `${row.powerupType} should have ${expected} tier labels`
    );
  }
});

test("seeded copy matches the pre-migration frontend strings, except the intentional Leech duration update", () => {
  const byType = Object.fromEntries(
    POWERUP_COPY_SEED.map((r) => [r.powerupType, r])
  );
  // Spot-checks across all three former maps.
  assert.equal(byType.RUNNERS_HIGH.name, "Runner's High");
  assert.equal(byType.DEFENSE_SCAN.name, "X-Ray");
  assert.equal(byType.LEG_CRAMP.description, "Freeze a rival's steps for 2 hours");
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
  assert.deepEqual(Object.keys(item).sort(), [
    "description",
    "name",
    "ownedQuantity",
    "powerupType",
    "priceCoins",
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
