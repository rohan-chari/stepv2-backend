require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const pg = require("pg");
const { prisma } = require("../src/db");

// Bootstrap a fresh/local database's cosmetic catalog by cloning it from a
// live environment (normally staging). Replaces the old data/cosmetics.json
// seed path — the DB is the single source of truth for cosmetics.
//
//   SOURCE_DATABASE_URL=<staging url> node scripts/cosmetics-clone.js
//   SOURCE_DATABASE_URL=<staging url> node scripts/cosmetics-clone.js --dry-run
//
// Create-missing semantics: it only creates rows whose sku is absent from the
// target (DATABASE_URL) and never touches existing rows, so re-running is
// always safe. NEVER point DATABASE_URL at prod for this — prod is written to
// only by the admin editor's peer mirror and cosmetics:sync-peer.

// KEEP IN SYNC with MIRRORED_SHOP_ITEM_FIELDS (src/modules/cosmetics/
// mirrorShopItem.js) and COMPARED_FIELDS (scripts/cosmetics-sync-peer.js).
const CLONED_FIELDS = [
  "name",
  "description",
  "slot",
  "priceCoins",
  "assetKey",
  "renderMetadata",
  "active",
  "testOnly",
  "earnOnly",
  "bobble",
  "sortOrder",
  "assetVersion",
];

function openSource(url) {
  const isLocalhost = url.includes("localhost") || url.includes("127.0.0.1");
  const pool = new pg.Pool({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, ""),
    max: 2,
    ...(isLocalhost ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

async function cloneCosmetics({ dryRun = false } = {}) {
  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  if (!sourceUrl) {
    throw new Error("Set SOURCE_DATABASE_URL to the DB to clone the catalog from.");
  }
  const source = openSource(sourceUrl);

  const rows = await source.shopItem.findMany({
    orderBy: [{ sortOrder: "asc" }, { sku: "asc" }],
  });
  const existing = new Set(
    (await prisma.shopItem.findMany({ select: { sku: true } })).map((r) => r.sku)
  );
  const missing = rows.filter((r) => !existing.has(r.sku));

  console.log(
    `Source has ${rows.length} items; target already has ${existing.size}; ${missing.length} missing.`
  );
  if (missing.length === 0) {
    console.log("Nothing to clone.");
    return { created: 0 };
  }
  if (dryRun) {
    for (const r of missing) console.log(`  would create ${r.sku} (${r.slot})`);
    return { created: 0, wouldCreate: missing.length };
  }

  let created = 0;
  for (const r of missing) {
    const data = { sku: r.sku };
    for (const key of CLONED_FIELDS) {
      data[key] =
        key === "renderMetadata" || key === "assetVersion" ? r[key] ?? null : r[key];
    }
    await prisma.shopItem.create({ data });
    console.log(`  created ${r.sku}`);
    created++;
  }
  console.log(`Done: ${created} created.`);
  return { created };
}

module.exports = { cloneCosmetics, CLONED_FIELDS };

if (require.main === module) {
  cloneCosmetics({ dryRun: process.argv.includes("--dry-run") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("cosmetics:clone failed:", err);
      process.exit(1);
    });
}
