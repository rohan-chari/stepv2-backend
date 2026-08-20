#!/usr/bin/env node
require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const { prisma } = require("../src/db");
const {
  assertCleanupEvidence,
  cleanupRetiredAppSettings,
} = require("../src/shared/config/retiredAppSettingCleanup");

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const apply = process.argv.includes("--apply");
  const evidencePath = arg("evidence");
  const exportPath = arg("export");
  const dryRun = await cleanupRetiredAppSettings({ prisma, apply: false });
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", retiredRows: dryRun.rows }, null, 2));
  if (!apply) return dryRun;
  if (!evidencePath || !path.isAbsolute(evidencePath)) {
    throw new Error("--apply requires an absolute --evidence JSON path");
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  assertCleanupEvidence(evidence);
  if (!exportPath || !path.isAbsolute(exportPath) || path.resolve(exportPath).startsWith(`${path.resolve(__dirname, "..")}${path.sep}`)) {
    throw new Error("--apply requires an absolute --export path outside the repository");
  }
  fs.writeFileSync(exportPath, `${JSON.stringify({ exportedAt: new Date().toISOString(), evidence, rows: dryRun.rows }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const result = await cleanupRetiredAppSettings({ prisma, apply: true, evidence });
  console.log(JSON.stringify({ exportedTo: exportPath, deleted: result.deleted }));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Retired AppSetting cleanup failed:", error);
    process.exitCode = 1;
  }).finally(() => prisma.$disconnect());
}

module.exports = { main };
