const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRedeemPowerupToRace,
  RedeemPowerupError,
} = require("../../src/commands/redeemPowerupToRace");

// ---------------------------------------------------------------------------
// Redeem step: the user spends ONE powerup from their GLOBAL inventory
// (UserPowerupItem) into an ACTIVE race they're in, which creates a
// RacePowerup(raceId, userId, type, status=HELD) so it shows up in the normal
// in-race tray. The normal usePowerup flow then applies it.
//
//   - decrements UserPowerupItem.quantity by 1 (atomic, only if quantity >= 1)
//   - creates a HELD RacePowerup of that type for the user's participant
//   - rejects if the user owns 0 of that type (no RacePowerup created)
//   - rejects if the race is not ACTIVE or the user isn't an accepted racer
//
// Written from the schema + spec, NOT by mirroring implementation.
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const state = {
    quantity: overrides.quantity ?? 1,
    raceStatus: overrides.raceStatus ?? "ACTIVE",
    participants: overrides.participants || [
      { id: "rp-1", userId: "user-1", status: "ACCEPTED" },
    ],
  };
  const calls = { decrements: [], created: [] };

  const deps = {
    state,
    calls,
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: state.raceStatus,
          participants: state.participants,
        };
      },
    },
    UserPowerupItem: {
      // Atomic conditional decrement: returns count 1 if it had >= 1, else 0.
      async decrementIfAvailable(userId, powerupType) {
        calls.decrements.push({ userId, powerupType });
        if (state.quantity >= 1) {
          state.quantity -= 1;
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    RacePowerup: {
      async create(data) {
        const row = { id: `rpw-${calls.created.length + 1}`, ...data };
        calls.created.push(row);
        return row;
      },
    },
  };

  return deps;
}

test("redeem decrements global inventory and creates a HELD RacePowerup", async () => {
  const deps = makeDeps({ quantity: 2 });
  const redeem = buildRedeemPowerupToRace(deps);

  const result = await redeem({
    userId: "user-1",
    raceId: "race-1",
    powerupType: "IMPOSTER",
  });

  assert.equal(deps.state.quantity, 1, "quantity 2 -> 1");
  assert.equal(deps.calls.created.length, 1);
  const created = deps.calls.created[0];
  assert.equal(created.type, "IMPOSTER");
  assert.equal(created.status, "HELD");
  assert.equal(created.userId, "user-1");
  assert.equal(created.participantId, "rp-1");
  assert.equal(result.powerup.type, "IMPOSTER");
  assert.equal(result.powerup.status, "HELD");
});

test("redeem rejects when the user owns 0 and does NOT create a RacePowerup", async () => {
  const deps = makeDeps({ quantity: 0 });
  const redeem = buildRedeemPowerupToRace(deps);

  await assert.rejects(
    () =>
      redeem({ userId: "user-1", raceId: "race-1", powerupType: "IMPOSTER" }),
    (err) => err instanceof RedeemPowerupError
  );

  assert.equal(deps.calls.created.length, 0, "no powerup minted");
});

test("redeem rejects when the race is not ACTIVE", async () => {
  const deps = makeDeps({ quantity: 1, raceStatus: "COMPLETED" });
  const redeem = buildRedeemPowerupToRace(deps);

  await assert.rejects(
    () =>
      redeem({ userId: "user-1", raceId: "race-1", powerupType: "IMPOSTER" }),
    (err) => err instanceof RedeemPowerupError
  );
  assert.equal(deps.state.quantity, 1, "inventory not spent on a closed race");
});

test("redeem rejects when the user is not an accepted participant", async () => {
  const deps = makeDeps({
    quantity: 1,
    participants: [{ id: "rp-2", userId: "user-2", status: "ACCEPTED" }],
  });
  const redeem = buildRedeemPowerupToRace(deps);

  await assert.rejects(
    () =>
      redeem({ userId: "user-1", raceId: "race-1", powerupType: "IMPOSTER" }),
    (err) => err instanceof RedeemPowerupError
  );
  assert.equal(deps.calls.created.length, 0);
});
