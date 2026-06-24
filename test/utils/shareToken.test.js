const assert = require("node:assert/strict");
const test = require("node:test");

const { generateShareToken } = require("../../src/utils/shareToken");

test("generateShareToken returns a 32-char lowercase hex string", () => {
  const token = generateShareToken();
  assert.match(token, /^[0-9a-f]{32}$/);
});

test("generateShareToken is URL-safe (no characters needing escaping)", () => {
  const token = generateShareToken();
  assert.equal(encodeURIComponent(token), token);
});

test("generateShareToken produces distinct values across calls", () => {
  const tokens = new Set();
  for (let i = 0; i < 100; i++) {
    tokens.add(generateShareToken());
  }
  // 16 random bytes => collisions across 100 draws are astronomically unlikely.
  assert.equal(tokens.size, 100);
});
