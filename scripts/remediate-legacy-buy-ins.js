#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const { prisma } = require("../src/db");
const {
  remediateLegacyBuyIns,
  validateLegacyBuyInPlan,
} = require("../src/modules/races/services/legacyBuyInRemediation");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const planPath = arg("plan");
  if (!planPath) throw new Error("Usage: --plan <audited-json> [--apply]");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const validated = validateLegacyBuyInPlan(plan);
  const apply = process.argv.includes("--apply");
  const participantIds = [...validated.completedParticipants, ...validated.pendingParticipants].map((row) => row.participantId);
  const [races, participants] = await Promise.all([
    prisma.race.findMany({ where: { id: { in: [...validated.completedRaceIds, validated.pendingRaceId] } }, select: { id: true, status: true } }),
    prisma.raceParticipant.findMany({ where: { id: { in: participantIds } }, select: { id: true, userId: true, raceId: true, buyInAmount: true, buyInStatus: true } }),
  ]);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", races, participants }, null, 2));
  if (!apply) return;
  const result = await prisma.$transaction(
    (tx) => remediateLegacyBuyIns({ tx, plan }),
    { timeout: 60_000 },
  );
  console.log(JSON.stringify({ result }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Legacy buy-in remediation failed:", error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}

module.exports = { main };
