#!/usr/bin/env node
const { execSync } = require("child_process");
require("dotenv").config();

const prodUrl = process.env.PROD_DATABASE_URL;
const localUrl = process.env.DATABASE_URL;

if (!prodUrl || !localUrl) {
  console.error("Missing PROD_DATABASE_URL or DATABASE_URL in .env");
  process.exit(1);
}

// Extract local db name from URL
const localDb = new URL(localUrl).pathname.slice(1);

console.log(`Dropping local database: ${localDb}`);
try {
  execSync(`dropdb --if-exists ${localDb}`, { stdio: "inherit" });
} catch {
  console.error("Failed to drop local db. Make sure no connections are open.");
  process.exit(1);
}

console.log(`Creating fresh database: ${localDb}`);
execSync(`createdb ${localDb}`, { stdio: "inherit" });

console.log("Dumping prod and restoring to local...");
execSync(
  `pg_dump "${prodUrl}" --no-owner --no-acl | psql "${localUrl}"`,
  { stdio: "inherit", maxBuffer: 100 * 1024 * 1024 }
);

console.log("Done! Local database synced from prod.");
