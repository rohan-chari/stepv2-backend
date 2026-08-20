#!/usr/bin/env node
require("dotenv").config();

const { prisma } = require("../src/db");
const {
  auditLiveFundedExposure,
  backfillLiveFundedExposure,
} = require("../src/modules/races/services/fundedExposure");

async function main() {
  const apply = process.argv.includes("--apply");
  const before = await auditLiveFundedExposure(prisma);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", before }));
  if (!apply) return before;
  const result = await prisma.$transaction(
    (tx) => backfillLiveFundedExposure(tx),
    { timeout: 120_000 },
  );
  const after = await auditLiveFundedExposure(prisma);
  if (after.totalNulls !== 0) {
    throw new Error(`Activation audit failed: ${after.totalNulls} live null stamp(s)`);
  }
  console.log(JSON.stringify({ applied: result, after }));
  return { before, result, after };
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("funded exposure catch-up failed:", error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { main };
