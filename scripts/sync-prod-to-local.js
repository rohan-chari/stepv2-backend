#!/usr/bin/env node
const { execSync } = require("child_process");
const readline = require("readline");
require("dotenv").config();

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : "local";

if (!["local", "staging"].includes(target)) {
  console.error(`Invalid --target=${target}. Use --target=local or --target=staging.`);
  process.exit(1);
}

const prodUrl = process.env.PROD_DATABASE_URL;
const destUrl =
  target === "staging" ? process.env.STAGING_DATABASE_URL : process.env.DATABASE_URL;

if (!prodUrl) {
  console.error("Missing PROD_DATABASE_URL in .env");
  process.exit(1);
}
if (!destUrl) {
  console.error(
    `Missing ${target === "staging" ? "STAGING_DATABASE_URL" : "DATABASE_URL"} in .env`
  );
  process.exit(1);
}
if (destUrl === prodUrl) {
  console.error("Refusing to run: destination URL matches PROD_DATABASE_URL.");
  process.exit(1);
}

const destParsed = new URL(destUrl);
const destDb = destParsed.pathname.slice(1);
const destHost = destParsed.hostname;

async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  console.log(`Target: ${target}`);
  console.log(`Destination database: ${destDb} on ${destHost}`);

  if (target === "staging") {
    const answer = await confirm(
      `This will WIPE all data in ${destDb} on ${destHost} and replace it with prod. Type "yes" to continue: `
    );
    if (answer !== "yes") {
      console.log("Aborted.");
      process.exit(1);
    }
  }

  if (target === "local") {
    console.log(`Dropping local database: ${destDb}`);
    try {
      execSync(`dropdb --if-exists ${destDb}`, { stdio: "inherit" });
    } catch {
      console.error("Failed to drop local db. Make sure no connections are open.");
      process.exit(1);
    }
    console.log(`Creating fresh database: ${destDb}`);
    execSync(`createdb ${destDb}`, { stdio: "inherit" });
  } else {
    console.log(`Resetting public schema on remote ${destDb}...`);
    execSync(
      `psql "${destUrl}" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"`,
      { stdio: "inherit" }
    );
  }

  console.log("Dumping prod and restoring to destination...");
  execSync(`pg_dump "${prodUrl}" --no-owner --no-acl | psql "${destUrl}"`, {
    stdio: "inherit",
    maxBuffer: 100 * 1024 * 1024,
  });

  console.log("Clearing device tokens so dev doesn't push to real devices...");
  execSync(`psql "${destUrl}" -c "TRUNCATE device_tokens;"`, { stdio: "inherit" });

  console.log("Applying any pending Prisma migrations to destination...");
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: destUrl },
  });

  console.log(`Done! ${target} database synced from prod.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
