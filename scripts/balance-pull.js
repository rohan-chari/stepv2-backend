require("dotenv").config();
const { prisma } = require("../src/db");
const { writeSnapshot, SNAPSHOT_FILE } = require("../src/modules/economy/balanceSnapshot");

// DB -> data/balance-config.json. Mirrors scripts/cosmetics-pull.js.
//
// Run this after tuning balance in the admin editor so the change lands in git
// history. The committed file is a RECORD, never the runtime source: the DB is
// authoritative (D1/D3), and this script exists so "who changed the Leech price
// and when" is answerable from `git log` instead of nowhere.
//
// COROLLARY, and a standing source of confusion: a batch that changes
// balanceConfig.defaults.js leaves data/balance-config.json STALE until this
// script is re-run against the environment whose config was PUT. That staleness
// is drift-report NOISE ONLY — nothing reads the snapshot at runtime — and the
// file must NOT be hand-edited or regenerated from the code defaults to silence
// it, because that would record a config no database ever served.
//
// Concretely for batch 2026-08-09 (items 6 + 8): the snapshot still shows
// FANNY_PACK in dropPool.RARE and no POWER_OUTAGE. Correct until
// `PUT /admin/balance-config` lands; run this script AFTER that PUT, per
// environment, and commit the result.
async function pull() {
  const row = await prisma.balanceConfig.findFirst({
    where: { active: true },
    orderBy: { version: "desc" },
  });

  if (!row) {
    console.error(
      "No active balance_config row found. Nothing pulled — the snapshot was left untouched."
    );
    process.exitCode = 1;
    return;
  }

  writeSnapshot({
    version: row.version,
    config: row.config,
    note: row.note,
    createdAt: row.createdAt?.toISOString?.() ?? null,
  });
  console.log(`Pulled balance config v${row.version} -> ${SNAPSHOT_FILE}`);
}

pull()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("balance:pull failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
