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
    testOnly: false,
    earnOnly: false,
    bobble: true,
    sortOrder: 30,
    renderMetadata: {
      offsetX: -0.09463276836158163,
      offsetY: -0.02,
      rotation: -0.2800000000000001,
      scale: 1.3999999999999997,
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
    priceCoins: 500,
    assetKey: "shoes",
    active: true,
    testOnly: false,
    earnOnly: false,
    bobble: false,
    sortOrder: 40,
    renderMetadata: {
      offsetX: 0.019999999999999993,
      offsetY: 0.009999999999999998,
      rotation: -0.060000000000000005,
      scale: 1.5000000000000004,
    },
  });
});

test("cosmetics catalog includes beaver tail as a test-only back accessory", () => {
  const catalog = loadCosmetics();
  const beaverTail = catalog.items.find((item) => item.sku === "beaver_tail");

  assert.deepEqual(beaverTail, {
    sku: "beaver_tail",
    name: "Beaver Tail",
    description: "A paddle tail that sways with each step.",
    slot: "BACK",
    priceCoins: 1000,
    assetKey: "beaver_tail",
    active: true,
    testOnly: true,
    earnOnly: false,
    bobble: false,
    sortOrder: 95,
    renderMetadata: {
      offsetX: -0.18881355932203348,
      offsetY: -0.15536723163841776,
      rotation: -0.19999999999999998,
      scale: 0.9012711864406793,
      animationFrames: 6,
      renderLayer: "behind",
    },
  });
});
