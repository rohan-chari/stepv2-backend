#!/usr/bin/env node
//
// Wipe everything owned by App Review-affiliated users (the reviewer + every
// flagged supporting cast user) and re-run the canonical seed. Use between
// review cycles when the demo state has drifted.
//
// Usage:
//   node scripts/reset-app-review.js
//
// The reviewer's own user row is preserved so their email/apple_id login
// binding stays stable. Only their activity is wiped.

const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config();

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://rohan@localhost:5432/steps_tracker";

function runStep(label, command, args) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

runStep(
  "Wiping review-affiliated activity",
  "psql",
  [databaseUrl, "-v", "ON_ERROR_STOP=1", "-f", path.join(__dirname, "reset-app-review.sql")]
);

runStep(
  "Re-seeding canonical demo state",
  "node",
  [path.join(__dirname, "seed-app-review-demo.js")]
);

console.log("\nReview state reset complete.");
