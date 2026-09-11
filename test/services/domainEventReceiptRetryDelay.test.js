const assert = require("node:assert/strict");
const { test } = require("node:test");
const { retryDelayMs } = require("../../src/modules/domainEvents/models/domainEventReceiptRecovery");

test("receipt retry delays grow to the six-hour cap with bounded jitter", () => {
  const bases = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000, 21_600_000];
  bases.forEach((base, index) => {
    assert.equal(retryDelayMs(index + 1, () => 0.5), base);
    assert.equal(retryDelayMs(index + 1, () => 0), base * 0.9);
    assert.equal(retryDelayMs(index + 1, () => 1), Math.min(Math.round(base * 1.1), 21_600_000));
  });
});
