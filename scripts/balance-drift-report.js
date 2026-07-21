require("dotenv").config();
const { prisma } = require("../src/db");
const { readSnapshot, diffPaths } = require("../src/services/balanceSnapshot");

// Deploy-time drift report: compares the ACTIVE DB config against the committed
// data/balance-config.json and logs a warning for each differing path.
//
// It REPORTS, it never blocks. Exit code is always 0. The cosmetics drift guard
// currently aborts the deploy, which has caused more outages than the drift it
// was protecting against — a balance value being tuned in the admin editor and
// not yet pulled back to git is normal and must not stop a deploy.
async function report() {
  const snapshot = readSnapshot();
  if (!snapshot) {
    console.warn("[balance-drift] no committed snapshot (data/balance-config.json); skipping");
    return;
  }

  let row;
  try {
    row = await prisma.balanceConfig.findFirst({
      where: { active: true },
      orderBy: { version: "desc" },
    });
  } catch (error) {
    console.warn(`[balance-drift] could not read balance_config: ${error.message}`);
    return;
  }

  if (!row) {
    console.warn("[balance-drift] no active balance_config row in the database");
    return;
  }

  const drift = diffPaths(snapshot.config, row.config);
  if (drift.length === 0) {
    console.log(
      `[balance-drift] OK — committed snapshot matches live config v${row.version}`
    );
    return;
  }

  console.warn(
    `[balance-drift] ${drift.length} path(s) differ between the committed snapshot ` +
      `(v${snapshot.version}) and the live config (v${row.version}). ` +
      `Run \`npm run balance:pull\` to record the live values in git.`
  );
  for (const { path, snapshot: was, live } of drift) {
    console.warn(
      `[balance-drift]   ${path}: snapshot=${JSON.stringify(was)} live=${JSON.stringify(live)}`
    );
  }
}

report()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    // Never fail a deploy over a report.
    console.warn("[balance-drift] report failed:", err.message);
    await prisma.$disconnect();
  });
