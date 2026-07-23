require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db");

const COSMETICS_FILE = path.join(__dirname, "..", "data", "cosmetics.json");

const RENDER_METADATA_NUMBER_KEYS = ["offsetX", "offsetY", "rotation", "scale"];
const RENDER_METADATA_RENDER_LAYERS = new Set(["front", "behind"]);

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
  if (raw.perFoot !== undefined && raw.perFoot !== null) {
    if (typeof raw.perFoot !== "boolean") {
      throw new Error("renderMetadata.perFoot must be a boolean");
    }
    out.perFoot = raw.perFoot;
  }
  // Per-animal placement overrides (see modules/admin/routes.js): only the four
  // numeric tuner keys are allowed inside each animal block.
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

async function applyCosmetics() {
  const items = loadFile();
  console.log(`Applying ${items.length} cosmetics from cosmetics.json...`);
  let created = 0;
  let updated = 0;
  for (const item of items) {
    if (!item.sku) throw new Error("each item must have a sku");
    const data = {
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
      // Whether the accessory rides the head-bob. cosmetics.json is the source of
      // truth, so be explicit per item (HEAD/FACE/NECK historically bobbed). An
      // item with no `bobble` key defaults to false to match the DB column default.
      bobble: item.bobble === true,
      sortOrder: Number(item.sortOrder ?? 0),
    };
    const existing = await prisma.shopItem.findUnique({
      where: { sku: item.sku },
    });
    if (existing) {
      await prisma.shopItem.update({ where: { sku: item.sku }, data });
      updated++;
    } else {
      await prisma.shopItem.create({ data });
      created++;
    }
  }
  console.log(`Cosmetics applied: ${created} created, ${updated} updated.`);
}

module.exports = { applyCosmetics };

if (require.main === module) {
  applyCosmetics()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("cosmetics:apply failed:", err);
      process.exit(1);
    });
}
