require("dotenv").config();
const { prisma } = require("../src/db");
const { writeSnapshot, SNAPSHOT_FILE } = require("../src/modules/economy/balanceSnapshot");

// DB -> data/balance-config.json. Mirrors scripts/cosmetics-pull.js.
//
// Run this after tuning balance in the admin editor so the change lands in git
// history. The committed file is a RECORD, never the runtime source: the DB is
// authoritative (D1/D3), and this script exists so "who changed the Leech price
// and when" is answerable from `git log` instead of nowhere.
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
