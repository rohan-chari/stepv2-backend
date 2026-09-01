const assert = require("node:assert/strict");
const test = require("node:test");

const {
  claimDisplayRefreshAdmission,
  normalizeResolutionPriority,
} = require("../../src/modules/races/services/enqueueRaceResolution");

test("display refresh work is always coalesced behind the interactive burst", () => {
  assert.deepEqual(
    normalizeResolutionPriority({ reason: "DISPLAY_REFRESH", priority: "IMMEDIATE" }),
    { priority: "COALESCE", queuePriority: "MAINTENANCE" },
  );
  assert.deepEqual(
    normalizeResolutionPriority({ reason: "POWERUP_MUTATION", priority: "IMMEDIATE" }),
    { priority: "IMMEDIATE", queuePriority: null },
  );
});

test("display refresh admission coalesces a race across workers and fails open", async () => {
  const calls = [];
  const cache = {
    async evalLua(script, keys, args) {
      calls.push({ script, keys, args });
      return { ok: true, disabled: false, result: calls.length === 1 ? "OK" : null };
    },
  };

  assert.equal(await claimDisplayRefreshAdmission("race-1", cache), true);
  assert.equal(await claimDisplayRefreshAdmission("race-1", cache), false);
  assert.deepEqual(calls[0].keys, ["v1:race:resolution-display-enqueue:race-1"]);
  assert.deepEqual(calls[0].args, [1000]);

  const unavailable = {
    async evalLua() { return { ok: false, disabled: false, result: null }; },
  };
  assert.equal(await claimDisplayRefreshAdmission("race-1", unavailable), true);
});
