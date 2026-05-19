const assert = require("node:assert/strict");
const test = require("node:test");

const {
  validateRaceBuyInConfig,
} = require("../../src/services/raceBuyIns");

class TestError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

test("validateRaceBuyInConfig accepts buy-in of exactly 200 (max boundary)", () => {
  const result = validateRaceBuyInConfig({
    buyInAmount: 200,
    payoutPreset: "WINNER_TAKES_ALL",
    ErrorClass: TestError,
  });
  assert.equal(result.buyInAmount, 200);
});

test("validateRaceBuyInConfig rejects buy-in of 201 (one over max)", () => {
  assert.throws(
    () =>
      validateRaceBuyInConfig({
        buyInAmount: 201,
        payoutPreset: "WINNER_TAKES_ALL",
        ErrorClass: TestError,
      }),
    (err) => {
      assert.ok(err instanceof TestError);
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /at most 200|maximum 200|cannot exceed 200/i);
      return true;
    }
  );
});

test("validateRaceBuyInConfig rejects very large buy-in amount", () => {
  assert.throws(
    () =>
      validateRaceBuyInConfig({
        buyInAmount: 100000,
        payoutPreset: "WINNER_TAKES_ALL",
        ErrorClass: TestError,
      }),
    (err) => err instanceof TestError && err.statusCode === 400
  );
});
