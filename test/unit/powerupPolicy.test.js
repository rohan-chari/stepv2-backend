const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  getPowerupPolicy,
  shouldSkipRedirectedDuplicate,
  validatePowerupPolicy,
} = require("../../src/modules/powerups/constants/powerupPolicy");

describe("power-up runtime policy", () => {
  it("has valid policy entries for the redirected-duplicate candidates", () => {
    assert.doesNotThrow(() => validatePowerupPolicy());
    for (const type of ["RAINSTORM", "WRONG_TURN", "POWER_OUTAGE", "LEG_CRAMP", "SIGNAL_JAMMER", "LEECH", "DETOUR_SIGN"]) {
      assert.ok(getPowerupPolicy(type), type);
    }
  });

  it("skips only a live same-type effect after a redirected landing", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    const active = [{ type: "RAINSTORM", status: "ACTIVE", expiresAt: new Date("2026-09-17T13:00:00.000Z") }];
    assert.equal(shouldSkipRedirectedDuplicate({
      type: "RAINSTORM", wasRedirected: true, activeEffects: active, now,
    }), true);
    assert.equal(shouldSkipRedirectedDuplicate({
      type: "RAINSTORM", wasRedirected: false, activeEffects: active, now,
    }), false);
    assert.equal(shouldSkipRedirectedDuplicate({
      type: "RAINSTORM", wasRedirected: true,
      activeEffects: [{ ...active[0], expiresAt: new Date("2026-09-17T11:59:59.000Z") }], now,
    }), false);
  });

  it("preserves direct cross-caster Rainstorm overlap policy", () => {
    assert.equal(getPowerupPolicy("RAINSTORM").directDuplicatePolicy, "PER_CASTER");
    assert.equal(shouldSkipRedirectedDuplicate({
      type: "RAINSTORM", wasRedirected: false,
      activeEffects: [{ type: "RAINSTORM", status: "ACTIVE", expiresAt: new Date("2026-09-17T13:00:00.000Z") }],
      now: new Date("2026-09-17T12:00:00.000Z"),
    }), false);
  });

  it("has explicit redirected-duplicate coverage for every configured policy", () => {
    const now = new Date("2026-09-17T12:00:00.000Z");
    for (const type of ["RAINSTORM", "WRONG_TURN", "POWER_OUTAGE", "LEG_CRAMP", "SIGNAL_JAMMER", "LEECH", "DETOUR_SIGN"]) {
      assert.equal(shouldSkipRedirectedDuplicate({
        type,
        wasRedirected: true,
        activeEffects: [{ type, status: "ACTIVE", expiresAt: new Date("2026-09-17T13:00:00.000Z") }],
        now,
      }), true, type);
    }
  });
});
