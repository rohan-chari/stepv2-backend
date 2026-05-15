require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db");

const COSMETICS_FILE = path.join(__dirname, "..", "data", "cosmetics.json");

const RENDER_METADATA_KEYS = ["offsetX", "offsetY", "rotation", "scale"];

function sanitizeRenderMetadata(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("renderMetadata must be an object");
  }
  const out = {};
  for (const key of RENDER_METADATA_KEYS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`renderMetadata.${key} must be a finite number`);
    }
    out[key] = num;
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
