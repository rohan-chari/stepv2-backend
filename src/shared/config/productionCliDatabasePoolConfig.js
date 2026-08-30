const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const AUTHORIZED_PRODUCTION_DATABASE_COMMANDS = Object.freeze({
  "balance:drift": "scripts/balance-drift-report.js",
  "powerups:copy:sync": "scripts/powerup-copy-sync.js",
  "referral-contest:catch-up": "scripts/referral-contest-ledger-catch-up.js",
});
const MAINTENANCE_DEFAULT = 2;
const CANONICAL_MAINTENANCE_MAX = /^[1-5]$/;

function resolveProductionCliDatabasePoolConfig(env = process.env, entryPath = process.argv[1]) {
  if (env.NODE_ENV !== "production" || env.STEPS_PROCESS_ROLE) return null;
  const command = env.npm_lifecycle_event;
  const relativeEntry = AUTHORIZED_PRODUCTION_DATABASE_COMMANDS[command];
  if (!relativeEntry || typeof entryPath !== "string" ||
      path.resolve(entryPath) !== path.join(REPO_ROOT, relativeEntry)) {
    return null;
  }
  if (!Object.hasOwn(env, "DATABASE_POOL_MAX_MAINTENANCE")) {
    return {
      role: "maintenance",
      max: MAINTENANCE_DEFAULT,
      source: "maintenance-default",
      command,
    };
  }
  const raw = env.DATABASE_POOL_MAX_MAINTENANCE;
  if (typeof raw !== "string" || !CANONICAL_MAINTENANCE_MAX.test(raw)) {
    throw new Error("DATABASE_POOL_MAX_MAINTENANCE must be a canonical base-10 integer from 1 through 5");
  }
  return {
    role: "maintenance",
    max: Number(raw),
    source: "DATABASE_POOL_MAX_MAINTENANCE",
    command,
  };
}

module.exports = {
  AUTHORIZED_PRODUCTION_DATABASE_COMMANDS,
  resolveProductionCliDatabasePoolConfig,
};
