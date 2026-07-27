#!/usr/bin/env node
// Apply a reviewed, code-defined EDIT to the stored balance config.
//
// WHY THIS EXISTS (docs/team-only-drop-pool-requirements.md §3.2/§3.3)
//
// A stored `dropPool` array REPLACES the code defaults wholesale — mergeOverDefaults
// merges objects recursively but treats arrays as values. So editing
// balanceConfig.defaults.js does NOT reach an environment that already has a
// stored config carrying its own dropPool. Enabling a drop-pool change needs a
// deploy (defaults, so a fresh env is right) AND a data write (this script).
//
// And there is no other write path for it: the in-app balance editor is a typed
// form over scalars and renders dropPool as read-only chips — deliberately, its
// header comment says it is "never a raw JSON editor". Drop-pool membership is
// a list of enums with cross-field invariants, which is exactly the thing a
// reviewed, dry-runnable script should own rather than a form.
//
// WHAT IT DOES
//   Reads the active config, applies the named migration's pure transform,
//   prints a field-level diff, and — only with --apply — saves it as a NEW
//   version through balanceConfig.saveConfig, so validateConfig, the version
//   append and rollbackTo all apply exactly as they do for an admin edit.
//   It never bypasses validation.
//
// Usage:
//   node scripts/balance-apply.js list
//   node scripts/balance-apply.js <migration> [--db=local|staging|prod] [--apply] [--note="…"]
//
//   npm run balance:apply -- team-only-rally-flag --db=local
//   npm run balance:apply -- team-only-rally-flag --db=prod --apply
//
// DRY RUN IS THE DEFAULT. Without --apply nothing is written.
//
// SAFETY: --db=prod is a production data write. Per CLAUDE.md it requires
// explicit in-the-moment confirmation; the script additionally refuses to run
// against prod unless --apply is paired with --i-know-this-is-prod.

require("dotenv").config();

const DB_ALIASES = {
  local: "DATABASE_URL",
  staging: "STAGING_DATABASE_URL",
  prod: "PROD_DATABASE_URL",
};

// ---------------------------------------------------------------------------
// Migrations. Each is a PURE function config -> config (it must not mutate its
// input), so it is unit-testable without a database.
// ---------------------------------------------------------------------------

function withoutValue(list, value) {
  return (Array.isArray(list) ? list : []).filter((entry) => entry !== value);
}

function withValue(list, value) {
  const next = Array.isArray(list) ? [...list] : [];
  if (!next.includes(value)) next.push(value);
  return next;
}

// docs/team-only-drop-pool-requirements.md §5.1 — the exact three edits.
// Idempotent: re-running it on an already-migrated config is a no-op diff.
function teamOnlyRallyFlag(config) {
  const next = JSON.parse(JSON.stringify(config));
  next.teamOnlyTypes = withValue(next.teamOnlyTypes, "RALLY_FLAG");
  next.storeOnlyTypes = withoutValue(next.storeOnlyTypes, "RALLY_FLAG");
  next.dropPool = { ...(next.dropPool || {}) };
  next.dropPool.UNCOMMON = withValue(next.dropPool.UNCOMMON, "RALLY_FLAG");
  // dailyBoxExcludedTypes is deliberately UNCHANGED — the daily box has no race
  // context and must still never award it (§5.2's relaxed rule permits this).
  next.dailyBoxExcludedTypes = withValue(next.dailyBoxExcludedTypes, "RALLY_FLAG");
  return next;
}

const MIGRATIONS = {
  "team-only-rally-flag": {
    apply: teamOnlyRallyFlag,
    note: "team-only drop pool: RALLY_FLAG -> dropPool.UNCOMMON, teamOnlyTypes",
    description:
      "Move RALLY_FLAG out of storeOnlyTypes and into dropPool.UNCOMMON + teamOnlyTypes (§5.1).",
  },
};

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function flatten(value, prefix = "", out = {}) {
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out[prefix] = JSON.stringify(value);
  return out;
}

function diff(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return paths
    .filter((path) => a[path] !== b[path])
    .map((path) => ({ path, before: a[path], after: b[path] }));
}

function printDiff(changes) {
  if (changes.length === 0) {
    console.log("No changes — the stored config already matches this migration.");
    return;
  }
  for (const change of changes) {
    console.log(`  ${change.path}`);
    console.log(`    - ${change.before === undefined ? "(absent)" : change.before}`);
    console.log(`    + ${change.after === undefined ? "(absent)" : change.after}`);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { db: "local", apply: false, note: null, confirmProd: false };
  const positional = [];
  for (const arg of argv) {
    if (arg === "--apply") opts.apply = true;
    else if (arg === "--i-know-this-is-prod") opts.confirmProd = true;
    else if (arg.startsWith("--db=")) opts.db = arg.slice(5);
    else if (arg.startsWith("--note=")) opts.note = arg.slice(7);
    else if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  return { migration: positional[0], opts };
}

function selectDatabase(alias) {
  const envKey = DB_ALIASES[alias];
  if (!envKey) {
    throw new Error(
      `Unknown --db target "${alias}". Expected one of: ${Object.keys(DB_ALIASES).join(", ")}`
    );
  }
  const url = process.env[envKey];
  if (!url) throw new Error(`${envKey} is not set in .env — cannot target "${alias}"`);
  // Point Prisma at the requested database BEFORE src/db is required.
  process.env.DATABASE_URL = url;
  return url;
}

function describeTarget(alias, url) {
  const host = url.replace(/\/\/[^@]*@/, "//***@").split("@").pop().split("?")[0];
  return `${alias} (${host})`;
}

function printUsage() {
  console.log("Usage: node scripts/balance-apply.js <migration> [--db=…] [--apply]");
  console.log("       node scripts/balance-apply.js list\n");
  console.log("Migrations:");
  for (const [name, m] of Object.entries(MIGRATIONS)) {
    console.log(`  ${name}\n    ${m.description}`);
  }
}

async function main() {
  const { migration, opts } = parseArgs(process.argv.slice(2));

  if (!migration || migration === "list" || migration === "help") {
    printUsage();
    return;
  }

  const chosen = MIGRATIONS[migration];
  if (!chosen) {
    printUsage();
    throw new Error(`Unknown migration "${migration}"`);
  }

  if (opts.db === "prod" && opts.apply && !opts.confirmProd) {
    throw new Error(
      "Refusing to write to PROD without --i-know-this-is-prod. " +
        "Per CLAUDE.md a prod data write needs explicit in-the-moment confirmation."
    );
  }

  const url = selectDatabase(opts.db);
  console.log(`Target: ${describeTarget(opts.db, url)}`);
  console.log(`Migration: ${migration}\n`);

  // Required AFTER selectDatabase — src/db reads DATABASE_URL at module load.
  const { prisma } = require("../src/db");
  const {
    buildBalanceConfig,
    validateConfig,
  } = require("../src/modules/economy/balanceConfig");
  const service = buildBalanceConfig({ prisma });

  try {
    const row = await service.getActiveRow();
    if (!row) {
      throw new Error(
        "No active balance_config row. Seed one first (the server does this on boot)."
      );
    }
    // Migrate the STORED config, not the merged one: writing a merged config back
    // would silently freeze today's code defaults into the row forever.
    const before = row.config;
    const after = chosen.apply(before);

    console.log(`Active version: v${row.version}`);
    console.log("Diff:");
    printDiff(diff(before, after));

    const errors = validateConfig(after);
    if (errors.length > 0) {
      console.error("\nRESULT IS INVALID — refusing to write:");
      for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nvalidateConfig: OK");

    if (!opts.apply) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to save a new version.");
      return;
    }

    const saved = await service.saveConfig({
      config: after,
      note: opts.note || chosen.note,
      createdBy: "scripts/balance-apply.js",
      expectedVersion: row.version,
      // A pre-existing soft-bound warning must not block an unrelated,
      // reviewed edit; the diff above is what is under review here.
      acknowledgeBoundWarnings: true,
    });
    console.log(`\nSaved v${saved.version}. Rollback: balanceConfig.rollbackTo(${row.version}).`);
    console.log("Record it in git with `npm run balance:pull`.");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`balance:apply failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { MIGRATIONS, teamOnlyRallyFlag, diff, flatten };
