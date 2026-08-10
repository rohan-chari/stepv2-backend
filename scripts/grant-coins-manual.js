#!/usr/bin/env node
/**
 * Manual admin coin grant, through the real awardCoins seam (ledgered,
 * idempotent). Never raw SQL — see memory/remediation policy.
 *
 * Runs against whatever DATABASE_URL Prisma sees. To hit prod:
 *   DATABASE_URL="$PROD_DATABASE_URL" node scripts/grant-coins-manual.js \
 *     --user <userId> --amount <n> --ref <dedupKey> [--apply]
 *
 * Without --apply it only prints the target user and planned grant.
 * reason is always "admin_grant"; (userId, reason, refId) is the dedup key,
 * so re-running with the same --ref is a no-op.
 */
require("dotenv").config();

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const userId = arg("user");
const amount = Number(arg("amount"));
const refId = arg("ref");
const APPLY = process.argv.includes("--apply");

if (!userId || !Number.isInteger(amount) || amount === 0 || !refId) {
  console.error("Usage: --user <userId> --amount <int> --ref <dedupKey> [--apply]");
  process.exit(1);
}

async function main() {
  const { prisma } = require("../src/db");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    console.error(`User ${userId} not found. Aborting.`);
    process.exit(1);
  }
  console.log(`Target: ${user.displayName} (${user.id}), current coins: ${user.coins}`);
  console.log(`Grant:  ${amount} coins, reason "admin_grant", refId "${refId}"`);

  if (!APPLY) {
    console.log("DRY RUN — no write. Re-run with --apply to commit.");
    return;
  }

  const { awardCoins } = require("../src/shared/economy/awardCoins");
  const result = await awardCoins({ userId, amount, reason: "admin_grant", refId });
  console.log(
    result.awarded
      ? `APPLIED: new balance ${result.coins}`
      : `SKIPPED (already granted for this refId): balance ${result.coins}`
  );
}

main()
  .catch((e) => {
    console.error("Error:", e.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
