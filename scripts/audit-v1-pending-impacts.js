#!/usr/bin/env node
process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });

const DB_ALIASES = {
  local: "DATABASE_URL",
  staging: "STAGING_DATABASE_URL",
  prod: "PROD_DATABASE_URL",
};

function parseTarget(argv) {
  const option = argv.find((value) => value.startsWith("--db="));
  const target = option ? option.slice("--db=".length) : "local";
  const unknown = argv.filter((value) => !value.startsWith("--db="));
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}`);
  if (!DB_ALIASES[target]) {
    throw new Error(`Unknown database target: ${target}`);
  }
  return target;
}

async function main() {
  const target = parseTarget(process.argv.slice(2));
  const envKey = DB_ALIASES[target];
  if (!process.env[envKey]) throw new Error(`${envKey} is required`);
  process.env.DATABASE_URL = process.env[envKey];
  const { prisma } = require("../src/db");
  const {
    auditPendingV1Impacts,
  } = require("../src/modules/steps/services/v1PendingImpactAudit");
  try {
    const report = await auditPendingV1Impacts(prisma);
    console.log(JSON.stringify({ target, ...report }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error?.stack || error);
    process.exit(1);
  },
);
