const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// Test #16 — THE guard that stops the nine duplicated tables from coming back.
//
// Balance values (rarity maps, upgrade cost ladders, odds tables) may be DEFINED
// in exactly two files: balanceConfig.js and balanceConfig.defaults.js. Every
// other module must read them from getConfig(). This is a structural assertion
// over source text because that is the only way to express "nobody anywhere
// re-declares this" — no integration test can prove a negative about the shape
// of the codebase.
//
// If this fails: you almost certainly want `balanceConfig.getConfigSync()`
// instead of the literal you just pasted.

const SRC = path.join(__dirname, "..", "..", "src");

const ALLOWED_FILES = new Set([
  path.join(SRC, "modules", "economy", "balanceConfig.js"),
  path.join(SRC, "modules", "economy", "balanceConfig.defaults.js"),
]);

// Mechanics that are deliberately NOT balance config in this build. Effect
// durations and magnitudes are per-type effect behaviour rather than the
// rarity/price/odds surface the admin editor exposes, and the copy seed is
// user-facing strings. Listed explicitly so the exemption is a decision on the
// record, not an accident.
const EXEMPT_FILES = new Set([
  path.join(SRC, "utils", "powerupUpgrades.js"), // DURATIONS_MS / MAGNITUDES only
  path.join(SRC, "constants", "powerupCopySeed.js"), // strings + tier labels
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// A rarity MAP: an object literal assigning rarities to several powerup types.
const RARITY_MAP = /(COMMON|UNCOMMON|RARE)"?\s*:\s*\[/;
const RARITY_ASSIGNMENT = /[A-Z_]{4,}\s*:\s*"(COMMON|UNCOMMON|RARE)"/g;
// A 4-entry cost ladder starting at 0, e.g. [0, 5, 15, 45].
const COST_LADDER = /\[\s*0\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\]/;
// A 3-entry probability row, e.g. [0.48, 0.25, 0.27].
const ODDS_ROW = /\[\s*0?\.\d+\s*,\s*0?\.\d+\s*,\s*0?\.\d+\s*\]/;

test("no rarity map, cost ladder, or odds table is defined outside balanceConfig", () => {
  const offenders = [];

  for (const file of walk(SRC)) {
    if (ALLOWED_FILES.has(file) || EXEMPT_FILES.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    const relative = path.relative(path.join(SRC, ".."), file);

    // Three or more "TYPE: "RARITY"" pairs is a rarity map, not a stray mention.
    const rarityAssignments = source.match(RARITY_ASSIGNMENT) || [];
    if (rarityAssignments.length >= 3) {
      offenders.push(`${relative}: rarity map (${rarityAssignments.length} entries)`);
    }
    if (RARITY_MAP.test(source)) {
      offenders.push(`${relative}: rarity tier table`);
    }
    if (COST_LADDER.test(source)) {
      offenders.push(`${relative}: upgrade cost ladder`);
    }
    if (ODDS_ROW.test(source)) {
      offenders.push(`${relative}: odds row`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Balance tables must live in balanceConfig.js / balanceConfig.defaults.js only.\n` +
      `Read them with balanceConfig.getConfigSync() instead.\nOffenders:\n  ${offenders.join(
        "\n  "
      )}`
  );
});
