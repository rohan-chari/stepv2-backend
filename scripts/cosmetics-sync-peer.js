require("dotenv").config();
const { prisma } = require("../src/db");
const { getPeerPrisma } = require("../src/peerDb");

// Reconcile the cosmetic catalog between this environment's DB (DATABASE_URL)
// and its peer (PEER_DATABASE_URL). The DB is the single source of truth for
// cosmetics; the admin editor mirrors every save to the peer, and this script
// is the safety net for mirrors that failed or edits made while the peer was
// unreachable.
//
//   node scripts/cosmetics-sync-peer.js            # report drift (read-only)
//   node scripts/cosmetics-sync-peer.js --repair   # push primary -> peer
//
// Direction is always primary -> peer: run it FROM the environment whose
// catalog you trust. Items that exist only in the peer are reported but never
// deleted or overwritten by anything here.

const COMPARED_FIELDS = [
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
];

function stable(value) {
  if (value === undefined) return null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])])
    );
  }
  if (Array.isArray(value)) return value.map(stable);
  return value;
}

function fieldEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function mirrorFields(item) {
  const out = {};
  for (const key of COMPARED_FIELDS) {
    out[key] = key === "renderMetadata" ? item[key] ?? null : item[key];
  }
  return out;
}

async function syncPeerCosmetics({ repair = false } = {}) {
  const peer = getPeerPrisma();
  if (!peer) {
    throw new Error("PEER_DATABASE_URL is not set — nothing to reconcile against.");
  }

  const [primaryRows, peerRows] = await Promise.all([
    prisma.shopItem.findMany({ orderBy: { sku: "asc" } }),
    peer.shopItem.findMany({ orderBy: { sku: "asc" } }),
  ]);
  const peerBySku = new Map(peerRows.map((r) => [r.sku, r]));
  const primarySkus = new Set(primaryRows.map((r) => r.sku));

  const missingInPeer = [];
  const differing = [];
  for (const row of primaryRows) {
    const peerRow = peerBySku.get(row.sku);
    if (!peerRow) {
      missingInPeer.push(row);
      continue;
    }
    const diffs = COMPARED_FIELDS.filter(
      (key) => !fieldEqual(row[key], peerRow[key])
    );
    if (diffs.length > 0) differing.push({ row, peerRow, diffs });
  }
  const onlyInPeer = peerRows.filter((r) => !primarySkus.has(r.sku));

  console.log(
    `Primary: ${primaryRows.length} items, peer: ${peerRows.length} items.`
  );
  for (const row of missingInPeer) {
    console.log(`  MISSING in peer: ${row.sku}`);
  }
  for (const { row, peerRow, diffs } of differing) {
    console.log(`  DIFFERS: ${row.sku} → ${diffs.join(", ")}`);
    for (const key of diffs) {
      console.log(
        `      primary ${key}=${JSON.stringify(row[key])} peer ${key}=${JSON.stringify(peerRow[key])}`
      );
    }
  }
  for (const row of onlyInPeer) {
    console.log(`  ONLY in peer (left untouched): ${row.sku}`);
  }
  if (missingInPeer.length === 0 && differing.length === 0 && onlyInPeer.length === 0) {
    console.log("Catalogs are in sync.");
    return { created: 0, updated: 0, onlyInPeer: 0 };
  }

  if (!repair) {
    console.log("\nDry run — re-run with --repair to push primary -> peer.");
    return {
      created: 0,
      updated: 0,
      wouldCreate: missingInPeer.length,
      wouldUpdate: differing.length,
      onlyInPeer: onlyInPeer.length,
    };
  }

  let created = 0;
  let updated = 0;
  for (const row of missingInPeer) {
    await peer.shopItem.create({ data: { sku: row.sku, ...mirrorFields(row) } });
    console.log(`  created ${row.sku} in peer`);
    created++;
  }
  for (const { row } of differing) {
    await peer.shopItem.update({
      where: { sku: row.sku },
      data: mirrorFields(row),
    });
    console.log(`  updated ${row.sku} in peer`);
    updated++;
  }
  console.log(`Repair done: ${created} created, ${updated} updated in peer.`);
  return { created, updated, onlyInPeer: onlyInPeer.length };
}

module.exports = { syncPeerCosmetics };

if (require.main === module) {
  syncPeerCosmetics({ repair: process.argv.includes("--repair") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("cosmetics:sync-peer failed:", err);
      process.exit(1);
    });
}
