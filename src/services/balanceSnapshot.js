const fs = require("node:fs");
const path = require("node:path");
const { defaultConfig } = require("./balanceConfig.defaults");

// The COMMITTED snapshot of the balance config: data/balance-config.json.
//
// This file is the git history the Leech price drift never had. The DB stays
// authoritative at runtime — this is a record, not a source. `npm run
// balance:pull` refreshes it from the DB after tuning, and the deploy-time
// drift report compares the two and WARNS.
//
// It deliberately does not block a deploy. The cosmetics equivalent currently
// aborts deploys on drift, which has repeatedly been worse than the drift it
// was guarding against.
const SNAPSHOT_FILE = path.join(__dirname, "..", "..", "data", "balance-config.json");

function readSnapshot() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Config to generate docs from: the committed snapshot when present, otherwise
// code defaults. Deliberately does NOT touch the DB — the docs check has to run
// in CI, which has no database.
function snapshotConfig() {
  const snapshot = readSnapshot();
  return snapshot?.config || defaultConfig();
}

function writeSnapshot({ version, config, note, createdAt }) {
  const payload = {
    _comment:
      "Committed record of the balance config. The DATABASE is authoritative at runtime; regenerate this with `npm run balance:pull` after tuning via the admin editor.",
    version: version ?? null,
    note: note ?? null,
    pulledAt: new Date().toISOString(),
    createdAt: createdAt ?? null,
    config,
  };
  fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

// Paths whose values differ between two configs. Used by the drift report.
function diffPaths(a, b, prefix = "") {
  const out = [];
  const keys = new Set([
    ...Object.keys(a || {}),
    ...Object.keys(b || {}),
  ]);
  for (const key of keys) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const av = a?.[key];
    const bv = b?.[key];
    const bothPlainObjects =
      av && bv && typeof av === "object" && typeof bv === "object" &&
      !Array.isArray(av) && !Array.isArray(bv);
    if (bothPlainObjects) {
      out.push(...diffPaths(av, bv, pathKey));
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ path: pathKey, snapshot: av, live: bv });
    }
  }
  return out;
}

module.exports = {
  SNAPSHOT_FILE,
  readSnapshot,
  snapshotConfig,
  writeSnapshot,
  diffPaths,
};
