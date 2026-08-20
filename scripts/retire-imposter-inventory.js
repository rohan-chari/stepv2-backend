#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const { prisma } = require("../src/db");
const {
  remediateImposterInventory,
  validateImposterRetirementPlan,
} = require("../src/modules/powerups/services/imposterRetirementRemediation");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const planPath = arg("plan");
  if (!planPath) throw new Error("Usage: --plan <audited-json> [--apply]");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validated = validateImposterRetirementPlan(plan);
  const apply = process.argv.includes("--apply");
  const [inventory, held, liveEffects, ledger] = await Promise.all([
    prisma.userPowerupItem.findMany({ where: { powerupType: "IMPOSTER", quantity: { gt: 0 } }, select: { userId: true, quantity: true } }),
    prisma.racePowerup.count({ where: { type: "IMPOSTER", status: "HELD" } }),
    prisma.raceActiveEffect.count({ where: { type: "IMPOSTER", status: "ACTIVE" } }),
    prisma.coinTransaction.findMany({ where: { reason: "imposter_retirement" }, select: { userId: true, amount: true, refId: true } }),
  ]);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", plan: validated, audit: { inventory, held, liveEffects, ledger } }, null, 2));
  if (!apply) return;
  const result = await prisma.$transaction(
    (tx) => remediateImposterInventory({ tx, plan }),
    { timeout: 60_000 },
  );
  console.log(JSON.stringify({ result }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Imposter retirement failed:", error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}

module.exports = { main };
