#!/usr/bin/env node
// Toggle powerup-store visibility from the CLI.
//
// This is the scriptable twin of the in-app admin screen
// (frontend lib/screens/admin_powerup_shop_screen.dart) — it writes the same
// two `powerup_shop_items` booleans through the same semantics, so a bulk
// cleanup ("hide the nine SKUs nobody has ever bought") is one command instead
// of nine taps and nine PATCHes.
//
// WHAT THE TWO FLAGS MEAN
//   active=false  -> the item disappears from GET /shop/powerups and can no
//                    longer be purchased (404). It is a STORE flag only: drops,
//                    existing inventory, and in-race use are all untouched.
//                    Cleanse has been active=false for a while and still minted
//                    458 times in 60 days off the mystery-box drop pool.
//   testOnly=true -> TestFlight/staging-channel clients only; prod clients
//                    never see it. Layered on top of the client-feature gates
//                    in getPowerupShopCatalog, which this script does NOT touch.
//
// Hiding a powerup from the store therefore does NOT remove it from the game.
// If the type is still in the live balance-config drop pool, this script says
// so explicitly after a hide — removing it there is a separate, deliberate edit
// in the balance-config admin editor.
//
// Usage:
//   node scripts/powerup-store.js list [--db=local|staging|prod]
//   node scripts/powerup-store.js hide  <sku|type> [...] [--db=…] [--apply]
//   node scripts/powerup-store.js show  <sku|type> [...] [--db=…] [--apply]
//   node scripts/powerup-store.js flag  <sku|type> [...] --test-only=true|false [--db=…] [--apply]
//
// Dry run is the default: without --apply nothing is written, and the script
// prints the exact before -> after it would have applied.
//
//   npm run powerups:store -- list --db=prod
//   npm run powerups:store -- hide RALLY_FLAG COIN_FLIP UPRISING BOUNTY UMBRELLA --db=prod --apply

require("dotenv").config();

const DB_ALIASES = {
  local: "DATABASE_URL",
  staging: "STAGING_DATABASE_URL",
  prod: "PROD_DATABASE_URL",
};

function parseArgs(argv) {
  const command = argv[0];
  const targets = [];
  const opts = { db: "local", apply: false, testOnly: undefined };

  for (const arg of argv.slice(1)) {
    if (arg === "--apply") {
      opts.apply = true;
    } else if (arg.startsWith("--db=")) {
      opts.db = arg.slice(5);
    } else if (arg.startsWith("--test-only=")) {
      const value = arg.slice(12);
      if (value !== "true" && value !== "false") {
        throw new Error("--test-only must be true or false");
      }
      opts.testOnly = value === "true";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      targets.push(arg);
    }
  }

  return { command, targets, opts };
}

// Point Prisma at the requested database BEFORE src/db is required — it reads
// DATABASE_URL at module load and caches the pool.
function selectDatabase(alias) {
  const envKey = DB_ALIASES[alias];
  if (!envKey) {
    throw new Error(
      `Unknown --db target "${alias}". Expected one of: ${Object.keys(DB_ALIASES).join(", ")}`
    );
  }
  const url = process.env[envKey];
  if (!url) {
    throw new Error(`${envKey} is not set in .env — cannot target "${alias}"`);
  }
  process.env.DATABASE_URL = url;
  return url;
}

function describeTarget(alias, url) {
  const host = url.replace(/\/\/[^@]*@/, "//***@").split("@").pop().split("?")[0];
  return `${alias} (${host})`;
}

// Accepts a sku (POWERUP_LEECH), a powerup type (LEECH / leech), or a bare name
// (leech). Matching is case-insensitive so the values you copy out of a psql
// dump — which are lowercase, because the enum is @map'd — just work.
function matchItem(items, token) {
  const needle = token.trim().toUpperCase();
  return items.filter(
    (item) =>
      item.sku.toUpperCase() === needle ||
      item.powerupType.toUpperCase() === needle ||
      item.sku.toUpperCase() === `POWERUP_${needle}`
  );
}

function resolveTargets(items, tokens) {
  const resolved = [];
  const errors = [];

  for (const token of tokens) {
    const matches = matchItem(items, token);
    if (matches.length === 0) {
      errors.push(`No powerup shop item matches "${token}"`);
    } else if (matches.length > 1) {
      errors.push(
        `"${token}" is ambiguous: ${matches.map((m) => m.sku).join(", ")}`
      );
    } else if (resolved.some((item) => item.id === matches[0].id)) {
      // A duplicate token is a typo, not an error worth aborting on.
      continue;
    } else {
      resolved.push(matches[0]);
    }
  }

  return { resolved, errors };
}

function visibility(item) {
  if (!item.active) return "HIDDEN";
  return item.testOnly ? "testflight" : "PROD";
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function printCatalog(items) {
  const skuWidth = Math.max(3, ...items.map((i) => i.sku.length));
  console.log(
    `${pad("SKU", skuWidth)}  ${pad("TYPE", 16)}  ${pad("PRICE", 6)}  ${pad("VISIBILITY", 10)}`
  );
  for (const item of items) {
    console.log(
      `${pad(item.sku, skuWidth)}  ${pad(item.powerupType, 16)}  ${pad(item.priceCoins, 6)}  ${pad(visibility(item), 10)}`
    );
  }
  const prod = items.filter((i) => i.active && !i.testOnly).length;
  const test = items.filter((i) => i.active && i.testOnly).length;
  const hidden = items.filter((i) => !i.active).length;
  console.log(
    `\n${items.length} items — ${prod} visible in prod, ${test} TestFlight-only, ${hidden} hidden.`
  );
  console.log(
    "Note: client-feature gates (jammer/powerups2-5) and the Imposter kill switch " +
      "can hide an item from a given build on top of these flags."
  );
}

// A hidden store row is not a removed powerup: the mystery-box drop pool is a
// separate authority. Surface that explicitly so "remove it" doesn't quietly
// mean "remove it from one of the two places it appears".
async function warnAboutDropPool(changedItems) {
  const stillDropping = [];
  try {
    const { balanceConfig } = require("../src/modules/economy/balanceConfig");
    const config = await balanceConfig.getConfig();
    const pool = config?.dropPool || {};
    for (const item of changedItems) {
      for (const [rarity, types] of Object.entries(pool)) {
        if (Array.isArray(types) && types.includes(item.powerupType)) {
          stillDropping.push(`${item.powerupType} (${rarity})`);
        }
      }
    }
  } catch (error) {
    console.warn(
      `\nCould not read the balance config to check the drop pool: ${error.message}`
    );
    return;
  }

  if (stillDropping.length === 0) return;
  console.log(
    `\nStill in the mystery-box drop pool — hidden from the store but NOT removed ` +
      `from the game:\n  ${stillDropping.join("\n  ")}\n` +
      `Remove them from dropPool in the balance-config editor to stop them dropping.`
  );
}

async function main() {
  const { command, targets, opts } = parseArgs(process.argv.slice(2));

  if (!command || !["list", "hide", "show", "flag"].includes(command)) {
    console.error(
      "Usage:\n" +
        "  node scripts/powerup-store.js list [--db=local|staging|prod]\n" +
        "  node scripts/powerup-store.js hide <sku|type> [...] [--db=…] [--apply]\n" +
        "  node scripts/powerup-store.js show <sku|type> [...] [--db=…] [--apply]\n" +
        "  node scripts/powerup-store.js flag <sku|type> [...] --test-only=true|false [--db=…] [--apply]"
    );
    process.exitCode = 1;
    return;
  }

  const url = selectDatabase(opts.db);
  const { prisma } = require("../src/db");

  try {
    const items = await prisma.powerupShopItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { sku: "asc" }],
    });

    console.log(`Target: ${describeTarget(opts.db, url)}\n`);

    if (command === "list") {
      printCatalog(items);
      return;
    }

    if (targets.length === 0) {
      throw new Error(`"${command}" needs at least one sku or powerup type`);
    }
    if (command === "flag" && opts.testOnly === undefined) {
      throw new Error("flag requires --test-only=true|false");
    }

    const { resolved, errors } = resolveTargets(items, targets);
    if (errors.length > 0) {
      // Abort the whole run rather than half-applying a bulk cleanup.
      for (const message of errors) console.error(`  ${message}`);
      throw new Error("Refusing to apply a partial change — fix the names above.");
    }

    const patch = {};
    if (command === "hide") patch.active = false;
    if (command === "show") patch.active = true;
    if (opts.testOnly !== undefined) patch.testOnly = opts.testOnly;

    const changes = resolved
      .map((item) => {
        const after = { ...item, ...patch };
        return { item, after, changed: visibility(item) !== visibility(after) };
      })
      .filter((row) => row.changed);

    if (changes.length === 0) {
      console.log("Nothing to do — every named item is already in that state.");
      return;
    }

    for (const { item, after } of changes) {
      console.log(
        `  ${pad(item.sku, 24)} ${visibility(item)} -> ${visibility(after)}`
      );
    }

    if (!opts.apply) {
      console.log(
        `\nDry run — nothing written. Re-run with --apply to write ${changes.length} change(s).`
      );
      return;
    }

    await prisma.$transaction(
      changes.map(({ item }) =>
        prisma.powerupShopItem.update({ where: { id: item.id }, data: patch })
      )
    );
    console.log(`\nApplied ${changes.length} change(s) to ${opts.db}.`);

    if (patch.active === false) {
      await warnAboutDropPool(changes.map((row) => row.item));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`powerups:store failed: ${error.message}`);
  process.exit(1);
});
