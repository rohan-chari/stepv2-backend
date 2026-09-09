// Permanent content mapping, never automatic species inference. Default mode
// validates/dry-runs; an operator separately authorizes an --apply invocation.
process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
async function main() {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "../data/character-wardrobe-fits.json"),
    ),
  );
  const apply = process.argv.includes("--apply");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query(apply ? "BEGIN" : "BEGIN READ ONLY");
    await db.query("SET LOCAL statement_timeout='15s'");
    const ids = [
      ...new Set(
        manifest.items.flatMap((i) => [
          i.id,
          ...i.approvedCharacterKeys.filter((k) => k !== "default"),
        ]),
      ),
    ];
    const found = (
      await db.query(
        `SELECT id,sku,slot FROM shop_items WHERE id=ANY($1::text[]) ORDER BY id ${apply ? "FOR SHARE" : ""}`,
        [ids],
      )
    ).rows;
    const byId = new Map(found.map((i) => [i.id, i]));
    const missing = [];
    const pairs = [];
    for (const i of manifest.items) {
      const row = byId.get(i.id);
      if (!row) {
        missing.push({ id: i.id, sku: i.sku });
        continue;
      }
      if (row.sku !== i.sku || row.slot === "CHARACTER")
        throw new Error(`Manifest identity/slot mismatch: ${i.id}`);
      for (const key of i.approvedCharacterKeys) {
        if (key !== "default" && byId.get(key)?.slot !== "CHARACTER")
          throw new Error(`Missing or wrong-slot character ${key}`);
        pairs.push({
          accessory: i.id,
          key,
          character: key === "default" ? null : key,
        });
      }
    }
    if (apply && missing.length)
      throw new Error(
        "Missing manifest items; resolve identity mapping before apply.",
      );
    if (apply && pairs.length)
      await db.query(
        `INSERT INTO shop_item_character_fits(accessory_shop_item_id,character_key,character_shop_item_id) SELECT accessory,key,character FROM jsonb_to_recordset($1::jsonb) AS x(accessory text,key text,character text) ON CONFLICT DO NOTHING`,
        [JSON.stringify(pairs)],
      );
    await db.query("COMMIT");
    console.log(
      JSON.stringify({ apply, approvedPairs: pairs.length, missing }, null, 2),
    );
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    await db.end();
  }
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
