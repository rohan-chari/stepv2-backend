const assert = require("node:assert/strict");
const test = require("node:test");

const { ACCESSORY_SLOTS } = require("../../src/utils/shopCosmetics");

test("ACCESSORY_SLOTS includes feet accessories", () => {
  assert.ok(ACCESSORY_SLOTS.includes("FEET"));
});
