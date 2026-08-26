#!/usr/bin/env node
require("dotenv").config();

const { prisma } = require("../src/db");
const {
  auditReferralRaceActivityCatchUp,
  catchUpReferralRaceActivities,
} = require("../src/modules/social/commands/recordReferralRaceActivity");
const {
  auditGiveawayPointReviewOwnership,
  catchUpGiveawayPointReviewOwnership,
} = require("../src/modules/giveaways/commands/catchUpGiveawayPointReviewOwnership");

function databaseIdentity(value = process.env.DATABASE_URL) {
  try {
    const parsed = new URL(value);
    return `${parsed.hostname}/${decodeURIComponent(parsed.pathname.slice(1))}`;
  } catch {
    return "unresolved";
  }
}

async function audit() {
  return {
    raceActivities: await auditReferralRaceActivityCatchUp({ tx: prisma }),
    reviewOwnership: await auditGiveawayPointReviewOwnership({ tx: prisma }),
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const before = await audit();
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    database: databaseIdentity(),
    before,
  }));
  if (!apply) return { before };

  const applied = await prisma.$transaction(async (tx) => ({
    raceActivities: await catchUpReferralRaceActivities({ tx }),
    reviewOwnership: await catchUpGiveawayPointReviewOwnership({ tx }),
  }), { timeout: 120_000 });
  const after = await audit();
  if (after.raceActivities !== 0 || after.reviewOwnership !== 0) {
    throw new Error(`Catch-up did not converge: ${JSON.stringify(after)}`);
  }
  console.log(JSON.stringify({ applied, after }));
  return { before, applied, after };
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error("referral contest ledger catch-up failed:", error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { audit, databaseIdentity, main };
