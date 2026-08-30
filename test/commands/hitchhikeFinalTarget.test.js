const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertHitchhikeAvailableForFinalTarget,
  isLiveHitchhikeAt,
} = require("../../src/modules/powerups/commands/usePowerup");

const checkTime = new Date("2026-08-29T12:00:00.000Z");

function effect(overrides = {}) {
  return {
    type: "HITCHHIKE",
    status: "ACTIVE",
    startsAt: new Date(checkTime.getTime() - 1),
    expiresAt: new Date(checkTime.getTime() + 1),
    targetUserId: "target",
    ...overrides,
  };
}

test("Hitchhike liveness is half-open at the captured command instant", () => {
  assert.equal(isLiveHitchhikeAt(effect({ startsAt: checkTime }), checkTime), true);
  assert.equal(isLiveHitchhikeAt(effect({ expiresAt: checkTime }), checkTime), false);
  assert.equal(
    isLiveHitchhikeAt(
      effect({ startsAt: new Date(checkTime.getTime() + 1) }),
      checkTime,
    ),
    false,
  );
  assert.equal(isLiveHitchhikeAt(effect({ status: "EXPIRED" }), checkTime), false);
  assert.equal(isLiveHitchhikeAt(effect({ startsAt: undefined }), checkTime), true);
});

test("final-target Hitchhike guard uses the authoritative target-full error", () => {
  assert.throws(
    () => assertHitchhikeAvailableForFinalTarget({
      liveLinks: [effect()],
      targetUserId: "target",
    }),
    (error) => error.statusCode === 409 &&
      error.code === "HITCHHIKE_TARGET_FULL" &&
      error.message === "Someone is already hitching a ride on that racer",
  );
  assert.doesNotThrow(() => assertHitchhikeAvailableForFinalTarget({
    liveLinks: [effect()],
    targetUserId: "someone-else",
  }));
});
