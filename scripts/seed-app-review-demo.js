#!/usr/bin/env node
//
// Seed the App Review demo state: provision the dedicated reviewer user
// (unflagged, real user) + supporting cast (Alex/Maya/Jordan, flagged with
// is_review_account = true so they're hidden from real users in search,
// leaderboards, public race browsing). Idempotent — safe to re-run.
//
// Usage:
//   node scripts/seed-app-review-demo.js
//
// Reads from .env:
//   DATABASE_URL          — target database
//   APP_REVIEW_EMAIL      — reviewer's email (must be set)

const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config();

// Reuse the configured Prisma client from src/db.js so we get the same
// pg-pool + adapter setup the app uses (Prisma 7 requires the adapter,
// and constructing a bare PrismaClient here would skip that).
const { prisma } = require("../src/db");

const REVIEWER_APPLE_ID = "review-account-v1";
const REVIEWER_DISPLAY_NAME = "App Reviewer";

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://rohan@localhost:5432/steps_tracker";
const reviewerEmail = process.env.APP_REVIEW_EMAIL;

if (!reviewerEmail) {
  console.error(
    "APP_REVIEW_EMAIL is required in .env so the reviewer account has a stable email to log in with."
  );
  process.exit(1);
}

async function provisionReviewerUser() {
  const existing = await prisma.user.findUnique({
    where: { appleId: REVIEWER_APPLE_ID },
  });
  if (existing) {
    await prisma.user.update({
      where: { appleId: REVIEWER_APPLE_ID },
      data: { email: reviewerEmail, isReviewAccount: false },
    });
    console.log(`Reviewer user already exists (id=${existing.id}); email refreshed.`);
    return;
  }
  const created = await prisma.user.create({
    data: {
      appleId: REVIEWER_APPLE_ID,
      email: reviewerEmail,
      name: REVIEWER_DISPLAY_NAME,
      displayName: REVIEWER_DISPLAY_NAME,
      isReviewAccount: false,
    },
  });
  console.log(`Provisioned reviewer user (id=${created.id}).`);
}

async function main() {
  try {
    await provisionReviewerUser();
  } finally {
    await prisma.$disconnect();
  }

  const sqlPath = path.join(__dirname, "seed-app-review-demo.sql");
  const result = spawnSync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", sqlPath],
    { stdio: "inherit" }
  );

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
