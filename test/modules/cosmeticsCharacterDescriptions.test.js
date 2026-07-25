// Feature batch 2026-07-25 — §10, spec §9 test 11.
//
// STRUCTURAL SOURCE GUARD (the sanctioned unit-test case in CLAUDE.md): every
// CHARACTER-slot entry in data/cosmetics.json must NAME its power in its
// description. Characters are the only cosmetics that change gameplay, so a
// description that omits the power sells an invisible mechanic — which is
// exactly what happened to the corgi (its prod row predated the Zoomies copy
// and was never re-applied).
//
// This cannot be an integration test: it guards the SOURCE file that seeds the
// catalog, not a response. The prod row is fixed by re-applying this file (see
// the deploy notes); this guard is what stops the source from drifting again.
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");

const CATALOG_PATH = path.join(__dirname, "../../data/cosmetics.json");

// assetKey prefix -> the power that character has (see
// src/modules/races/services/characterPowers.js). Every CHARACTER item must
// match one of these, so adding a new animal without registering its power
// fails here rather than shipping a silent mechanic.
const POWER_BY_ANIMAL = [
  { prefix: "capybara", power: "Herd Bonus", keywords: [/herd/i] },
  { prefix: "corgi", power: "Zoomies", keywords: [/zoomies/i] },
  { prefix: "turtle", power: "Shell", keywords: [/shell/i] },
];

function loadCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const items = Array.isArray(parsed) ? parsed : parsed.items;
  assert.ok(Array.isArray(items), "data/cosmetics.json must expose an items array");
  return items;
}

describe("data/cosmetics.json — CHARACTER descriptions name their power", () => {
  it("has at least one CHARACTER item (the guard would be vacuous otherwise)", () => {
    const characters = loadCatalog().filter((i) => i.slot === "CHARACTER");
    assert.ok(characters.length > 0, "no CHARACTER items found");
  });

  it("every CHARACTER item maps to a known animal power", () => {
    for (const item of loadCatalog().filter((i) => i.slot === "CHARACTER")) {
      const key = String(item.assetKey || item.sku || "").toLowerCase();
      const match = POWER_BY_ANIMAL.find((p) => key.startsWith(p.prefix));
      assert.ok(
        match,
        `CHARACTER "${item.sku}" (assetKey ${item.assetKey}) has no registered power — ` +
          `add it to characterPowers.js and to POWER_BY_ANIMAL in this guard`
      );
    }
  });

  it("every CHARACTER description names its power", () => {
    for (const item of loadCatalog().filter((i) => i.slot === "CHARACTER")) {
      const key = String(item.assetKey || item.sku || "").toLowerCase();
      const match = POWER_BY_ANIMAL.find((p) => key.startsWith(p.prefix));
      if (!match) continue; // reported by the test above
      const description = item.description || "";
      assert.ok(
        description.trim().length > 0,
        `CHARACTER "${item.sku}" has an empty description`
      );
      assert.ok(
        match.keywords.some((re) => re.test(description)),
        `CHARACTER "${item.sku}" must name its power (${match.power}) in its ` +
          `description; got: ${JSON.stringify(description)}`
      );
    }
  });

  it("the corgi specifically names Zoomies (the regression that shipped stale to prod)", () => {
    const corgi = loadCatalog().find((i) => i.sku === "corgi_puppy");
    assert.ok(corgi, "corgi_puppy is missing from the catalog");
    assert.match(corgi.description || "", /zoomies/i);
  });
});
