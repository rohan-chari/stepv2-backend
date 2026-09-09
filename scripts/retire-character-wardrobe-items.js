// Preparation/dry-run by default. Production --apply is a separately reviewed
// operation and never part of migrate deploy or application startup.
process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const { fingerprint } = require("./audit-character-wardrobes");
const manifest = require("../data/character-wardrobe-retirements.json");
async function main() {
  const apply = process.argv.includes("--apply"),
    items = manifest.items.filter((i) => i.retired === true);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout='15s'");
    if (items.length > 200)
      throw new Error("Retire at most 200 reviewed items per manifest batch.");
    const ids = items.map((i) => i.id);
    const rows = (
      await db.query(
        `SELECT * FROM shop_items WHERE id=ANY($1::text[]) ORDER BY id ${apply ? "FOR UPDATE" : ""}`,
        [ids],
      )
    ).rows;
    for (const expected of items) {
      const row = rows.find((r) => r.id === expected.id);
      if (
        !row ||
        row.sku !== expected.sku ||
        expected.historicallyUnreleased !== true ||
        !expected.releaseEvidence ||
        fingerprint(row) !== expected.expectedFingerprint ||
        !row.test_only ||
        row.slot === "CHARACTER" ||
        row.earn_only
      )
        throw new Error(`Candidate no longer proven safe: ${expected.id}`);
    }
    const tables = [
      "user_shop_items",
      "user_equipped_accessories",
      "character_wardrobe_items",
      "shop_purchase_requests",
      "ad_reward_grants",
      "daily_reward_claims",
      "billing_cosmetic_releases",
      "billing_cosmetic_grants",
    ];
    const referenceKeys = [...new Set(items.flatMap((i) => [i.id, i.sku]))];
    for (const table of tables) {
      const refs = (
        await db.query(
          `SELECT 1 FROM ${table} WHERE shop_item_id=ANY($1::text[]) LIMIT 1`,
          [referenceKeys],
        )
      ).rows;
      if (refs.length)
        throw new Error(
          `New retained reference in ${table}; abort retirement.`,
        );
    }
    let after = null;
    for (;;) {
      const rows = (
        await db.query(
          "SELECT id,result_json FROM shop_purchase_requests WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 200",
          [after],
        )
      ).rows;
      if (!rows.length) break;
      for (const row of rows)
        if (
          referenceKeys.some((id) =>
            JSON.stringify(row.result_json).includes(JSON.stringify(id)),
          )
        )
          throw new Error(
            "Purchase replay references candidate; abort retirement.",
          );
      after = rows.at(-1).id;
    }
    if (apply && ids.length)
      await db.query(
        "UPDATE shop_items SET active=false WHERE id=ANY($1::text[])",
        [ids],
      );
    await db.query("COMMIT");
    if (apply && ids.length) {
      const derivedCache = require("../src/shared/cache/derivedCache");
      const cacheKeys = require("../src/shared/cache/cacheKeys");
      await derivedCache.invalidate({
        keys: cacheKeys.shopCatalogVariants(),
        prefix: cacheKeys.PREFIX.SHOP_CATALOG,
      });
      await derivedCache.invalidate({
        keys: cacheKeys.assetsManifestVariants(),
        prefix: cacheKeys.PREFIX.ASSETS_MANIFEST,
      });
      await require("../src/shared/cache/redisCache").close();
    }
    console.log(
      JSON.stringify({ apply, items: ids, retired: apply ? ids.length : 0 }),
    );
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
