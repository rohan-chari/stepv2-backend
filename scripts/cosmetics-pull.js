require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db");

const COSMETICS_FILE = path.join(__dirname, "..", "data", "cosmetics.json");
const RENDER_METADATA_KEYS = ["offsetX", "offsetY", "rotation", "scale"];

function normalizeRenderMetadata(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const key of RENDER_METADATA_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

async function pullCosmetics() {
  const rows = await prisma.shopItem.findMany({
    orderBy: [{ sortOrder: "asc" }, { sku: "asc" }],
  });

  const items = rows.map((row) => ({
    sku: row.sku,
    name: row.name,
    description: row.description ?? null,
    slot: row.slot,
    priceCoins: row.priceCoins,
    assetKey: row.assetKey,
    active: row.active,
    sortOrder: row.sortOrder,
    renderMetadata: normalizeRenderMetadata(row.renderMetadata),
  }));

  const payload = JSON.stringify({ items }, null, 2) + "\n";
  fs.writeFileSync(COSMETICS_FILE, payload, "utf8");
  console.log(`Wrote ${items.length} cosmetics to ${COSMETICS_FILE}`);
}

module.exports = { pullCosmetics };

if (require.main === module) {
  pullCosmetics()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("cosmetics:pull failed:", err);
      process.exit(1);
    });
}
