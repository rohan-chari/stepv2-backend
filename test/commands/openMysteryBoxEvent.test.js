const assert = require("node:assert/strict");
const test = require("node:test");
const { buildOpenMysteryBox } = require("../../src/commands/openMysteryBox");

// Item 9: opening an in-race mystery box on the NORMAL path must persist a
// MYSTERY_BOX_OPENED RacePowerupEvent (actorUserId + createdAt) so the admin
// "avg unique box openers / day" metric has data. The Fanny-Pack auto-activate
// path keeps writing only its own POWERUP_EARNED row (no double event).

function makeDeps(overrides = {}) {
  const feedEvents = [];
  const mysteryBoxPowerup = {
    id: "pw-1", raceId: "race-1", participantId: "rp-1", userId: "user-1",
    type: null, rarity: null, status: "MYSTERY_BOX", ...overrides.powerup,
  };
  return {
    feedEvents,
    deps: {
      RacePowerup: {
        async findById(id) { return id === mysteryBoxPowerup.id ? mysteryBoxPowerup : null; },
        async update() {},
        async countOccupiedSlots() { return overrides.heldCount !== undefined ? overrides.heldCount : 0; },
      },
      RaceParticipant: {
        async findByRaceAndUser() { return { id: "rp-1", userId: "user-1", totalSteps: 5000, powerupSlots: 3 }; },
        async findAcceptedByRace() { return [{ id: "rp-1", userId: "user-1", totalSteps: 5000 }, { id: "rp-2", userId: "user-2", totalSteps: 3000 }]; },
        async update() {},
      },
      Race: { async findById() { return { id: "race-1", status: "ACTIVE" }; } },
      RacePowerupEvent: { async create(data) { feedEvents.push(data); return { id: "fe", ...data }; } },
      eventBus: { emit() {} },
      rollPowerupOdds: overrides.rollPowerupOdds || (() => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" })),
    },
  };
}

test("normal open persists a MYSTERY_BOX_OPENED event with actor + rolled type", async () => {
  const ctx = makeDeps();
  const open = buildOpenMysteryBox(ctx.deps);
  await open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", displayName: "Alice" });

  const opened = ctx.feedEvents.find((e) => e.eventType === "MYSTERY_BOX_OPENED");
  assert.ok(opened, "writes a MYSTERY_BOX_OPENED row");
  assert.equal(opened.actorUserId, "user-1");
  assert.equal(opened.powerupType, "PROTEIN_SHAKE");
});

test("Fanny-Pack auto-activate open does NOT add a second MYSTERY_BOX_OPENED event", async () => {
  const ctx = makeDeps({ heldCount: 3, rollPowerupOdds: () => ({ type: "FANNY_PACK", rarity: "RARE" }) });
  const open = buildOpenMysteryBox(ctx.deps);
  await open({ userId: "user-1", raceId: "race-1", powerupId: "pw-1", displayName: "Alice" });

  assert.equal(ctx.feedEvents.filter((e) => e.eventType === "MYSTERY_BOX_OPENED").length, 0);
  // The auto-activate path still writes its single POWERUP_EARNED row.
  assert.equal(ctx.feedEvents.filter((e) => e.eventType === "POWERUP_EARNED").length, 1);
});
