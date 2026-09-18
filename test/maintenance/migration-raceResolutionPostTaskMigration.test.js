const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migrationPath = path.join(
  __dirname,
  "../../prisma/migrations/20260813120000_api_contract_payload_cleanup_resolution/migration.sql"
);

test("delivery intent identity and payload are DB-immutable after insert", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /race_resolution_delivery_intent_immutable/i);
  for (const column of [
    "task_id",
    "ordinal",
    "kind",
    "recipient_user_id",
    "payload",
    "payload_bytes",
    "delivery_key_hash",
    "cooldown_claim_id",
    "created_at",
  ]) {
    assert.match(sql, new RegExp(`OLD\\.${column}\\s+IS\\s+DISTINCT\\s+FROM\\s+NEW\\.${column}`, "i"));
  }
});
