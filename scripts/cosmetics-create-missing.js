require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db");

// Create cosmetic shop items from data/cosmetics.json that DON'T already exist
// in the target DB, and never touch rows that do.
//
// Why this exists alongside cosmetics:apply:
//   cosmetics:apply UPSERTS every item, so it overwrites renderMetadata that was
//   tuned in-app (Accessory Tuner) but not yet pulled back into cosmetics.json —
//   see prisma/seed.js and scripts/cosmetics-pull.js. When you only want to add
//   NEW accessories to an environment (staging or prod) without disturbing the
//   existing tuned catalog, use THIS script: it matches on sku, creates the ones
//   that are missing, and leaves every existing row exactly as-is.
//
// It targets whatever DATABASE_URL the checkout's .env points at, so run it from
// the staging checkout for staging and the prod checkout for prod. It is
// idempotent: re-running only ever creates rows still missing.
//
//   node scripts/cosmetics-create-missing.js            # create missing
//   node scripts/cosmetics-create-missing.js --dry-run  # list what WOULD be created

// Defaults to the repo's data/cosmetics.json; override with COSMETICS_FILE to
// point at another catalog (e.g. running against a server whose tracked
// cosmetics.json carries local tuner drift you don't want to disturb).
const COSMETICS_FILE =
  process.env.COSMETICS_FILE || path.join(__dirname, "..", "data", "cosmetics.json");

const RENDER_METADATA_NUMBER_KEYS = ["offsetX", "offsetY", "rotation", "scale"];
const RENDER_METADATA_RENDER_LAYERS = new Set(["front", "behind"]);

// Identical to cosmetics-apply.js so created rows match what apply would produce.
function sanitizeRenderMetadata(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("renderMetadata must be an object");
  }
  const out = {};
  for (const key of RENDER_METADATA_NUMBER_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`renderMetadata.${key} must be a finite number`);
    }
    out[key] = num;
  }
  if (raw.animationFrames !== undefined && raw.animationFrames !== null) {
    const frames = Number(raw.animationFrames);
    if (!Number.isInteger(frames) || frames < 1) {
      throw new Error("renderMetadata.animationFrames must be a positive integer");
    }
    out.animationFrames = frames;
  }
  if (raw.renderLayer !== undefined && raw.renderLayer !== null) {
    const layer = String(raw.renderLayer);
    if (!RENDER_METADATA_RENDER_LAYERS.has(layer)) {
      throw new Error("renderMetadata.renderLayer must be 'front' or 'behind'");
    }
    out.renderLayer = layer;
  }
  if (raw.perAnimal !== undefined && raw.perAnimal !== null) {
    if (typeof raw.perAnimal !== "object" || Array.isArray(raw.perAnimal)) {
      throw new Error("renderMetadata.perAnimal must be an object");
    }
    const perAnimal = {};
    for (const [animal, override] of Object.entries(raw.perAnimal)) {
      if (override == null) continue;
      if (typeof override !== "object" || Array.isArray(override)) {
        throw new Error(`renderMetadata.perAnimal.${animal} must be an object`);
      }
      const block = {};
      for (const key of RENDER_METADATA_NUMBER_KEYS) {
        if (override[key] === undefined || override[key] === null) continue;
        const num = Number(override[key]);
        if (!Number.isFinite(num)) {
          throw new Error(
            `renderMetadata.perAnimal.${animal}.${key} must be a finite number`
          );
        }
        block[key] = num;
      }
      if (Object.keys(block).length > 0) perAnimal[animal] = block;
    }
    if (Object.keys(perAnimal).length > 0) out.perAnimal = perAnimal;
  }
  return out;
}

function loadFile() {
  const raw = fs.readFileSync(COSMETICS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error("cosmetics.json must contain an { items: [...] } array");
  }
  return parsed.items;
}

function itemToData(item) {
  if (!item.sku) throw new Error("each item must have a sku");
  return {
    sku: item.sku,
    name: item.name,
    description: item.description ?? null,
    slot: item.slot,
    priceCoins: Number(item.priceCoins ?? 0),
    assetKey: item.assetKey,
    renderMetadata: sanitizeRenderMetadata(item.renderMetadata),
    active: item.active !== false,
    testOnly: item.testOnly === true,
    earnOnly: item.earnOnly === true,
    bobble: item.bobble === true,
    sortOrder: Number(item.sortOrder ?? 0),
  };
}

async function createMissingCosmetics({ dryRun = false } = {}) {
  const items = loadFile();
  const existing = new Set(
    (await prisma.shopItem.findMany({ select: { sku: true } })).map((r) => r.sku)
  );
  const missing = items.filter((it) => it.sku && !existing.has(it.sku));

  const dbName = (process.env.DATABASE_URL || "").match(/\/([^/?]+)(\?|$)/)?.[1] || "(unknown)";
  console.log(
    `Target DB: ${dbName} — ${items.length} in cosmetics.json, ${existing.size} already present, ${missing.length} missing.`
  );

  if (missing.length === 0) {
    console.log("Nothing to create; DB already has every catalog item.");
    return { created: 0 };
  }

  if (dryRun) {
    console.log("Would create (dry run):");
    for (const it of missing) console.log(`  + ${it.sku} (${it.slot})`);
    return { created: 0, wouldCreate: missing.length };
  }

  let created = 0;
  for (const it of missing) {
    await prisma.shopItem.create({ data: itemToData(it) });
    console.log(`  created ${it.sku}`);
    created++;
  }
  console.log(`Done: ${created} created, ${existing.size} left untouched.`);
  return { created };
}

module.exports = { createMissingCosmetics };

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  createMissingCosmetics({ dryRun })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("cosmetics:create-missing failed:", err);
      process.exit(1);
    });
}
