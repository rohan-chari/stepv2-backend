const assert = require("node:assert/strict");
const { it } = require("node:test");
const { readFile } = require("node:fs/promises");
const { Client } = require("pg");

it("Decoy migrations restore only price/sale/copy, retain eligibility and old effects, and install the cooldown index", async () => {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, "localhost");
  assert.ok(url.pathname.endsWith("_test"));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Apply the actual migration files against isolated schema copies of the
    // real tables. Public fixture rows and other suites remain untouched.
    await client.query(`CREATE SCHEMA decoy_migration_test;
      SET search_path = decoy_migration_test, public;
      CREATE TABLE race_active_effects (LIKE public.race_active_effects INCLUDING DEFAULTS);
      ALTER TABLE race_active_effects DROP COLUMN decoy_consumed_at;
      CREATE TABLE powerup_shop_items (LIKE public.powerup_shop_items INCLUDING DEFAULTS);
      CREATE TABLE powerup_copy (LIKE public.powerup_copy INCLUDING DEFAULTS);
      INSERT INTO powerup_shop_items (id,sku,name,powerup_type,price_coins,active,test_only,daily_reward_eligible)
      VALUES ('decoy','POWERUP_DECOY','Decoy','decoy',75,false,false,false),
             ('other','POWERUP_LEECH','Leech','leech',333,true,false,true);
      INSERT INTO powerup_copy (powerup_type,name,description,upgrade_tier_labels,updated_at)
      VALUES ('decoy','Decoy','old copy','{}',NOW()), ('leech','Leech','untouched copy','{}',NOW());
      INSERT INTO race_active_effects (id,race_id,target_participant_id,target_user_id,source_user_id,powerup_id,type,status,starts_at,updated_at)
      VALUES ('historical','race','participant','user','user','item','decoy','expired_effect',NOW(),NOW());`);
    await client.query(await readFile(new URL("../../prisma/migrations/20260910120000_restore_decoy_shop_cooldown/migration.sql", `file://${__filename}`), "utf8"));
    await client.query(await readFile(new URL("../../prisma/migrations/20260910120100_decoy_cooldown_index/migration.sql", `file://${__filename}`), "utf8"));
    const rows = (await client.query("SELECT sku,price_coins,active,test_only,daily_reward_eligible FROM powerup_shop_items ORDER BY sku")).rows;
    assert.deepEqual(rows, [
      { sku: "POWERUP_DECOY", price_coins: 150, active: true, test_only: false, daily_reward_eligible: false },
      { sku: "POWERUP_LEECH", price_coins: 333, active: true, test_only: false, daily_reward_eligible: true },
    ]);
    const copies = (await client.query("SELECT powerup_type,description FROM powerup_copy ORDER BY name")).rows;
    assert.match(copies[0].description, /Wait 1 hour after it pops/);
    assert.equal(copies[1].description, "untouched copy");
    assert.equal((await client.query("SELECT decoy_consumed_at FROM race_active_effects WHERE id='historical'")).rows[0].decoy_consumed_at, null);
    const indexes = (await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname='decoy_migration_test' AND indexname='race_active_effects_decoy_cooldown_idx'")).rows;
    assert.equal(indexes.length, 1);
    assert.match(indexes[0].indexdef, /target_participant_id, type, decoy_consumed_at/);
  } finally {
    await client.query("ROLLBACK");
    await client.query("SET search_path=public; DROP SCHEMA IF EXISTS decoy_migration_test CASCADE");
    await client.end();
  }
});
