const assert = require("node:assert/strict");
const test = require("node:test");

const { buildUsePowerup } = require("../../src/commands/usePowerup");

function makeParticipant(id, userId, displayName, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 9000,
    bonusSteps: 0,
    powerupSlots: 3,
    finishedAt: null,
    user: { displayName },
    ...overrides,
  };
}

test("usePowerup resolves race state after applying an instant bonus", async () => {
  let resolved = null;

  const alice = makeParticipant("rp-1", "user-1", "Alice");
  const bob = makeParticipant("rp-2", "user-2", "Bob", { totalSteps: 4000 });

  const usePowerup = buildUsePowerup({
    RacePowerup: {
      async findById() {
        return {
          id: "pw-1",
          userId: "user-1",
          raceId: "race-1",
          type: "PROTEIN_SHAKE",
          status: "HELD",
          rarity: "COMMON",
        };
      },
      async update() {},
      async findUsedTypesByParticipant() {
        return [];
      },
    },
    Race: {
      async findById() {
        return {
          id: "race-1",
          status: "ACTIVE",
          participants: [alice, bob],
        };
      },
    },
    RaceParticipant: {
      async addBonusSteps() {},
      async subtractBonusSteps() {},
      async updatePowerupSlots() {},
    },
    RaceActiveEffect: {
      async findActiveByTypeForParticipant() {
        return null;
      },
      async create() {
        return null;
      },
      async update() {
        return null;
      },
    },
    RacePowerupEvent: {
      async create() {},
    },
    eventBus: {
      emit() {},
    },
    resolveRaceState: async (payload) => {
      resolved = payload;
    },
    now: () => new Date("2026-04-07T12:00:00Z"),
  });

  await usePowerup({
    userId: "user-1",
    raceId: "race-1",
    powerupId: "pw-1",
  });

  assert.deepEqual(resolved, { raceId: "race-1", timeZone: undefined });
});
