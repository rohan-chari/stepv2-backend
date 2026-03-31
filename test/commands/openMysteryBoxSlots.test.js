const assert = require("node:assert/strict");
const test = require("node:test");
const { buildOpenMysteryBox } = require("../../src/commands/openMysteryBox");

function makeDeps(overrides = {}) {
  const events = [];
  const feedEvents = [];
  const updates = [];
  const participantUpdates = [];

  const mysteryBoxPowerup = {
    id: "pw-1",
    raceId: "race-1",
    participantId: "rp-1",
    userId: "user-1",
    type: null,
    rarity: null,
    status: "MYSTERY_BOX",
    ...overrides.powerup,
  };

  return {
    events,
    feedEvents,
    updates,
    participantUpdates,
    deps: {
      RacePowerup: {
        async findById(id) {
          if (id === mysteryBoxPowerup.id) return mysteryBoxPowerup;
          return null;
        },
        async update(id, fields) {
          updates.push({ id, fields });
          return { ...mysteryBoxPowerup, ...fields };
        },
        async countOccupiedSlots() {
          return overrides.occupiedSlots !== undefined ? overrides.occupiedSlots : 3;
        },
        ...overrides.RacePowerup,
      },
      RaceParticipant: {
        async findByRaceAndUser(raceId, userId) {
          if (raceId === "race-1" && userId === "user-1") {
            return { id: "rp-1", userId: "user-1", totalSteps: 5000, powerupSlots: overrides.powerupSlots || 3 };
          }
          return null;
        },
        async findAcceptedByRace() {
          return [
            { id: "rp-1", userId: "user-1", totalSteps: 5000 },
            { id: "rp-2", userId: "user-2", totalSteps: 3000 },
          ];
        },
        async update(id, fields) {
          participantUpdates.push({ id, fields });
          return { id, ...fields };
        },
      },
      RacePowerupEvent: {
        async create(data) {
          feedEvents.push(data);
          return { id: "fe-1", ...data };
        },
      },
      Race: {
        async findById() {
          return { id: "race-1", status: "ACTIVE" };
        },
      },
      eventBus: {
        emit(event, payload) {
          events.push({ event, payload });
        },
      },
      rollPowerupOdds: overrides.rollFn || (() => ({ type: "PROTEIN_SHAKE", rarity: "COMMON" })),
    },
  };
}

// ---------------------------------------------------------------------------
// Opening mystery box transforms in-place (no inventory-full rejection)
// ---------------------------------------------------------------------------

test("opening a mystery box succeeds even when all slots are occupied", async () => {
  // All 3 slots occupied (including the mystery box itself)
  const ctx = makeDeps({ occupiedSlots: 3 });
  const openBox = buildOpenMysteryBox(ctx.deps);

  const result = await openBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alex",
  });

  // Should succeed — box transforms in-place
  assert.equal(result.type, "PROTEIN_SHAKE");
  assert.equal(result.rarity, "COMMON");
  assert.equal(result.autoActivated, false);

  // Powerup updated to HELD with rolled type
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].fields.status, "HELD");
  assert.equal(ctx.updates[0].fields.type, "PROTEIN_SHAKE");
});

test("Fanny Pack auto-activates when all slots are occupied", async () => {
  const ctx = makeDeps({
    occupiedSlots: 3,
    rollFn: () => ({ type: "FANNY_PACK", rarity: "RARE" }),
  });
  const openBox = buildOpenMysteryBox(ctx.deps);

  const result = await openBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alex",
  });

  assert.equal(result.type, "FANNY_PACK");
  assert.equal(result.autoActivated, true);

  // Participant powerupSlots incremented
  assert.equal(ctx.participantUpdates.length, 1);
  assert.equal(ctx.participantUpdates[0].fields.powerupSlots, 4);

  // Powerup set to USED (auto-activated)
  assert.equal(ctx.updates[0].fields.status, "USED");
});

test("opening a mystery box emits MYSTERY_BOX_OPENED event", async () => {
  const ctx = makeDeps({ occupiedSlots: 2 });
  const openBox = buildOpenMysteryBox(ctx.deps);

  await openBox({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
    displayName: "Alex",
  });

  assert.equal(ctx.events.length, 1);
  assert.equal(ctx.events[0].event, "MYSTERY_BOX_OPENED");
  assert.equal(ctx.events[0].payload.type, "PROTEIN_SHAKE");
});
