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
//
// ---------------------------------------------------------------------------
// PRE-APPLY CHECKLIST (added 2026-08-09 after the Option H code review). Run it
// on STAGING first, then prod, for every migration — the two items below are
// failure modes a green `validateConfig` does NOT catch.
//
//   (a) READ EVERY REMOVED `positionRules.*` PATH IN THE DRY-RUN mergedDiff.
//       A migration that assigns a down-weight table assigns it WHOLESALE —
//       `leadingDownweight` / `trailingDownweight` are replaced, not merged
//       key-by-key, once the migration writes them. Any key an admin tuned live
//       that is absent from the migration's table silently reverts to the code
//       default (and a key the migration merely OMITS is re-imposed by
//       mergeOverDefaults — the STEALTH_MODE trap: neutralise with an explicit
//       1.0, never by omission). Diff lines showing `+ (absent)` under
//       positionRules are the ones to read one by one and confirm intentional.
//
//   (b) FOR THE RAW-STEPS / OPTION H WORK, REQUIRE A GREEN NON-SKIPPED RUN OF
//       test/integration/box-raw-steps-worker-redis.test.js. It is the ONLY
//       coverage of the production writer path (`redisStandingsEnabled` ON, the
//       v2 worker's fenced replay), and it SKIPS SILENTLY when no local Redis
//       is available — a "green" suite with that file skipped proves nothing
//       about prod. Confirm the two cases printed ✔, not ﹣/skipped, before
//       applying Option H anywhere.
// ---------------------------------------------------------------------------

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
  // dailyBoxExcludedTypes is NOT written: the key was retired 2026-07-28 (the
  // daily-spin pool is the shop catalog now), so a stored copy is ignored and
  // writing to it would be a dead key in the row.
  return next;
}

// docs/economy.md §8 Option H + docs/box-raw-steps-position-and-option-h-
// requirements.md step 8 — "trailers catch up by SELF-BOOST, not griefing".
//
// ORDER IS MANDATORY: this row goes out only AFTER the raw-steps position fix
// is deployed. H roughly doubles the value of trailing odds (E[self]/box
// 635 -> 1,180), so applying it while the odds position still comes from the
// effect-sensitive `totalSteps` AMPLIFIES the hoarding exploit it depends on
// the code fix to remove.
//
// The enabling mechanic is that `validateConfig` requires a dropPool member to
// HAVE a rarity in rarityByType, not to MATCH it — so the three COMMON
// self-boosts can join the UNCOMMON tier while the upgrade ladder stays put.
// Without that the UNCOMMON tier in a solo race is 100% grief with nowhere for
// the freed mass to move.
//
// TRAP (verified, economy.md §8): never let a tier's total weight reach 0.
// `drawWeighted` falls back to a UNIFORM pick when the weights sum to zero,
// which inverts a down-weight into an up-weight. That is what the zero-weight
// sweep in test/services/optionHBalanceConfig.test.js pins.
//
// Idempotent: re-running it on an already-migrated config is a no-op diff.
function optionHPositionFairness(config) {
  const next = JSON.parse(JSON.stringify(config));

  next.dropPool = { ...(next.dropPool || {}) };
  for (const type of ["PROTEIN_SHAKE", "TRAIL_MIX", "RUNNERS_HIGH"]) {
    next.dropPool.UNCOMMON = withValue(next.dropPool.UNCOMMON, type);
  }

  next.positionOdds = {
    ...(next.positionOdds || {}),
    first: [0.52, 0.2, 0.28],
    last: [0.3, 0.36, 0.34],
  };

  next.positionRules = {
    ...(next.positionRules || {}),
    // Toward the FRONT: the leader's own self-boosts are damped so the freed
    // tier mass lands on the trailing end of the ramp.
    leadingDownweight: { RUNNERS_HIGH: 0.5, PROTEIN_SHAKE: 0.7, TRAIL_MIX: 0.7 },
    // Toward the BACK: offense moves to mid-pack and the front, where prod
    // already shows it being USED.
    //
    // STEALTH_MODE is restored to full strength — trailers are barely attacked
    // (0.19 Wrong Turns received per head), so weighting them away from defense
    // was correct but the freed mass is better spent on self-boost. It is
    // written as an EXPLICIT 1.0 and NOT omitted: `mergeOverDefaults` merges
    // plain objects RECURSIVELY (only arrays replace wholesale), so a stored
    // table that simply leaves the key out inherits the code default's
    // `STEALTH_MODE: 0.5` and the intended change silently does nothing. 1.0 is
    // the identity multiplier in positionMultiplierFor, so this is exactly
    // "no rule" — expressed in the one way the merge cannot undo.
    trailingDownweight: {
      WRONG_TURN: 0.2,
      LEG_CRAMP: 0.25,
      PINECONE_TOSS: 0.4,
      DETOUR_SIGN: 0.4,
      SNEAKY_SWAP: 0.5,
      CLEANSE: 0.5,
      MIRROR: 0.5,
      STEALTH_MODE: 1,
    },
  };
  // leaderExcluded / lastPlaceExcluded / the two ramp endpoints are carried
  // through unchanged by the spread above — H changes weights, not gates.

  // Drift reconcile, same row (approved by the owner 2026-08-09). The live prod
  // row says WRONG_TURN is RARE and SNEAKY_SWAP UNCOMMON, both of which
  // contradict the tier each type actually drops from. `upgradeCost` is
  // evaluated at PURCHASE time from rarityForType, so already-held rows are
  // unaffected; only the upgrade ladder moves (WRONG_TURN 195 -> 130,
  // player-favourable; SNEAKY_SWAP 130 -> 195).
  next.rarityByType = {
    ...(next.rarityByType || {}),
    WRONG_TURN: "UNCOMMON",
    SNEAKY_SWAP: "RARE",
  };

  return next;
}

// docs/feature-batch-2026-08-09-requirements.md §Cross-cutting rollout order —
// the ONE consolidated data write for items 1, 6 and 8, applied only AFTER the
// batch's backend code (which carries the same values in defaults.js) is
// deployed: enforceStoreOnlyExclusion unions the stored storeOnlyTypes with the
// CODE defaults' list, so running this against an old backend would see the
// POWER_OUTAGE drop silently re-stripped (the defaults-veto trap this script
// refuses on).
//
// Deliberately NOT touched: rarityByType.WRONG_TURN. The live prod row says
// RARE where the code default says UNCOMMON — known drift; the byType reprice
// below makes the price agree either way, and reconciling the drift belongs to
// option-h-position-fairness, not this row.
//
// Idempotent: re-running it on an already-migrated config is a no-op diff.
function batch20260809(config) {
  const next = JSON.parse(JSON.stringify(config));

  // Item 1 — WT/LC upgrade ladder 1h/1h15/1h30/1h45, repriced per level.
  // Item 8b — Horseshoe stays upgradeable (frozen-client 400 trap) at cost 0.
  next.upgradeCosts = { ...(next.upgradeCosts || {}) };
  next.upgradeCosts.byType = {
    ...(next.upgradeCosts.byType || {}),
    LEG_CRAMP: [0, 10, 20, 30],
    WRONG_TURN: [0, 15, 30, 45],
    LUCKY_HORSESHOE: [0, 0, 0, 0],
  };

  // Item 8b — every Horseshoe level guarantees a rare.
  next.luckyHorseshoe = {
    ...(next.luckyHorseshoe || {}),
    rareChanceByLevel: [1, 1, 1, 1],
  };

  // Item 6 — POWER_OUTAGE out of the shop/daily roll, into box drops as RARE,
  // damped at the front (game-analyst REQUIRED). The down-weight is a single
  // key MERGED into the existing table — never assign the table wholesale, or
  // every other tuned key silently reverts (the STEALTH_MODE trap).
  next.rarityByType = { ...(next.rarityByType || {}), POWER_OUTAGE: "RARE" };
  next.positionRules = { ...(next.positionRules || {}) };
  next.positionRules.leadingDownweight = {
    ...(next.positionRules.leadingDownweight || {}),
    POWER_OUTAGE: 0.3,
  };
  next.storeOnlyTypes = withoutValue(next.storeOnlyTypes, "POWER_OUTAGE");
  next.dropPool = { ...(next.dropPool || {}) };
  next.dropPool.RARE = withValue(next.dropPool.RARE, "POWER_OUTAGE");

  // Item 8a — Fanny Pack out of generation. Held copies keep working; the
  // shop row is untouched here (it was already store-hidden).
  next.dropPool.RARE = withoutValue(next.dropPool.RARE, "FANNY_PACK");

  return next;
}

const MIGRATIONS = {
  "batch-2026-08-09": {
    apply: batch20260809,
    note: "batch 2026-08-09 items 1/6/8: WT-LC reprice, PO to RARE drops, Horseshoe all-rare at cost 0",
    description:
      "Consolidated data write for batch 2026-08-09 (items 1, 6, 8): WT/LC byType reprice, " +
      "LUCKY_HORSESHOE [0,0,0,0] + rareChanceByLevel [1,1,1,1], POWER_OUTAGE -> dropPool.RARE " +
      "with leadingDownweight 0.3 and out of storeOnlyTypes, FANNY_PACK out of dropPool.RARE. " +
      "APPLY ONLY AFTER the batch backend is deployed (defaults-veto trap).",
  },
  "option-h-position-fairness": {
    apply: optionHPositionFairness,
    note: "Option H: trailer catch-up via self-boost + rarityByType drift reconcile",
    description:
      "economy.md §8 Option H — add PROTEIN_SHAKE/TRAIL_MIX/RUNNERS_HIGH to dropPool.UNCOMMON, " +
      "retune positionOdds + both down-weight tables, reconcile WRONG_TURN/SNEAKY_SWAP rarity. " +
      "APPLY ONLY AFTER the raw-steps position fix is deployed.",
  },
  "team-only-rally-flag": {
    apply: teamOnlyRallyFlag,
    note: "team-only drop pool: RALLY_FLAG -> dropPool.UNCOMMON, teamOnlyTypes",
    description:
      "Move RALLY_FLAG out of storeOnlyTypes and into dropPool.UNCOMMON + teamOnlyTypes (§5.1).",
  },
};

// ---------------------------------------------------------------------------
// Evaluation — what to validate, and what to persist (they are NOT the same)
// ---------------------------------------------------------------------------

// A stored row may legitimately be a PARTIAL: prod's is schema-v1, written
// before eleven powerup types existed, and mergeOverDefaults fills the gaps on
// every read. validateConfig, however, demands a WHOLE config (rarityByType
// must cover every type), so validating the stored row standalone rejects a row
// the runtime is perfectly happy with. That is what blocked this script in prod
// and staging on 2026-07-27 with 11 × "rarityByType is missing <TYPE>".
//
// So: validate the MERGED config — the thing the game actually runs on — and
// persist the PARTIAL, keeping the original design property that today's code
// defaults are never frozen into the row.
function evaluateMigration({ storedConfig, migration }) {
  const {
    validateConfig,
    mergeOverDefaults,
  } = require("../src/modules/economy/balanceConfig");

  const after = migration.apply(storedConfig);
  const mergedAfter = mergeOverDefaults(after);

  return {
    after,
    mergedAfter,
    storedDiff: diff(storedConfig, after),
    mergedDiff: diff(mergeOverDefaults(storedConfig), mergedAfter),
    errors: validateConfig(mergedAfter),
    lostAdditions: lostDropPoolAdditions(storedConfig, after, mergedAfter),
  };
}

// The defaults-veto trap (docs/team-only-drop-pool-requirements.md §3.2):
// enforceStoreOnlyExclusion filters the drop pool by the UNION of the stored
// storeOnlyTypes and the CODE DEFAULTS' list. A migration can therefore add a
// type to dropPool, validate clean, write a new version — and change nothing at
// runtime, because the defaults strip it straight back out. Silent no-ops are
// exactly what this script exists to prevent, so report them and refuse.
function lostDropPoolAdditions(before, after, mergedAfter) {
  const beforePool = (before && before.dropPool) || {};
  const afterPool = (after && after.dropPool) || {};
  const mergedPool = (mergedAfter && mergedAfter.dropPool) || {};
  const lost = [];

  for (const [tier, list] of Object.entries(afterPool)) {
    if (!Array.isArray(list)) continue;
    const had = new Set(Array.isArray(beforePool[tier]) ? beforePool[tier] : []);
    const survived = new Set(Array.isArray(mergedPool[tier]) ? mergedPool[tier] : []);
    for (const type of list) {
      if (!had.has(type) && !survived.has(type)) lost.push({ tier, type });
    }
  }
  return lost;
}

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
  const { buildBalanceConfig } = require("../src/modules/economy/balanceConfig");
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
    const { after, mergedDiff, errors, lostAdditions } = evaluateMigration({
      storedConfig: before,
      migration: chosen,
    });

    console.log(`Active version: v${row.version}`);
    console.log("Diff (what is written to the stored row):");
    printDiff(diff(before, after));
    // The stored row is a partial, so the stored diff is not the whole story —
    // this is what the running game will actually see change.
    console.log("\nDiff (what the runtime resolves, stored merged over defaults):");
    printDiff(mergedDiff);

    if (errors.length > 0) {
      console.error("\nRESULT IS INVALID — refusing to write:");
      for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    if (lostAdditions.length > 0) {
      console.error(
        "\nWOULD BE A SILENT NO-OP — refusing to write. These drop-pool additions are"
      );
      console.error("vetoed by the code defaults' storeOnlyTypes (§3.2):");
      for (const l of lostAdditions) console.error(`  dropPool.${l.tier}: ${l.type}`);
      console.error("Remove the type from defaultConfig().storeOnlyTypes and deploy first.");
      process.exitCode = 1;
      return;
    }
    console.log("\nvalidateConfig (on the merged config): OK");

    if (!opts.apply) {
      console.log("\nDRY RUN — nothing written. Re-run with --apply to save a new version.");
      return;
    }

    const saved = await service.saveConfig({
      config: after,
      note: opts.note || chosen.note,
      createdBy: "scripts/balance-apply.js",
      expectedVersion: row.version,
      // Validation already ran above, on the MERGED config — the one the game
      // resolves. saveConfig would re-run it on the partial being persisted and
      // reject a row the runtime reads happily (11 × "rarityByType is missing").
      // This skips the duplicate standalone check, not the check itself.
      skipValidation: true,
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

module.exports = {
  MIGRATIONS,
  optionHPositionFairness,
  teamOnlyRallyFlag,
  evaluateMigration,
  lostDropPoolAdditions,
  diff,
  flatten,
};
