#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("dotenv").config();

const databaseUrl =
  process.env.DATABASE_URL || "postgresql://rohan@localhost:5432/steps_tracker";
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
