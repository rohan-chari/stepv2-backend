const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cosmeticsPath = path.join(__dirname, "../../data/cosmetics.json");

function loadCosmetics() {
  return JSON.parse(fs.readFileSync(cosmeticsPath, "utf8"));
}

test("cosmetics catalog includes sunglasses as an active face accessory", () => {
  const catalog = loadCosmetics();
  const sunglasses = catalog.items.find((item) => item.sku === "sunglasses");

  assert.deepEqual(sunglasses, {
    sku: "sunglasses",
    name: "Sunglasses",
    description: "Shades for sunny step streaks.",
    slot: "FACE",
    priceCoins: 250,
    assetKey: "sunglasses",
    active: true,
    sortOrder: 30,
    renderMetadata: {
      offsetX: 0.025,
      offsetY: -0.04,
      rotation: -0.08,
      scale: 1.65,
    },
  });
});

test("cosmetics catalog includes shoes as an active feet accessory", () => {
  const catalog = loadCosmetics();
  const shoes = catalog.items.find((item) => item.sku === "shoes");

  assert.deepEqual(shoes, {
    sku: "shoes",
    name: "Trail Shoes",
    description: "High-top kicks for extra trail style.",
    slot: "FEET",
    priceCoins: 250,
    assetKey: "shoes",
    active: true,
    sortOrder: 40,
    renderMetadata: {
      offsetX: 0.03,
      offsetY: 0.02,
      rotation: -0.03,
      scale: 1.1,
    },
  });
});
