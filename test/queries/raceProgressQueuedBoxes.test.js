const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetRaceProgress } = require("../../src/queries/getRaceProgress");

// ---------------------------------------------------------------------------
// Queued mystery boxes auto-fill open slots and unified inventory response
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-03-30T13:00:00.000Z");
const NOW = new Date("2026-03-31T15:00:00.000Z");
const TZ = "America/New_York";

const SAMPLES = [
  { userId: "user-1", periodStart: "2026-03-30T13:00:00.000Z", periodEnd: "2026-03-30T14:00:00.000Z", steps: 500 },
  { userId: "user-1", periodStart: "2026-03-31T12:00:00.000Z", periodEnd: "2026-03-31T13:00:00.000Z", steps: 1000 },
];

function createStepSampleStore(samples) {
  return {
    async sumStepsInWindow(userId, windowStart, windowEnd) {
      const ws = new Date(windowStart).getTime();
      const we = new Date(windowEnd).getTime();
      return samples
        .filter(
          (s) =>
            s.userId === userId &&
            new Date(s.periodEnd).getTime() > ws &&
            new Date(s.periodStart).getTime() < we
        )
        .reduce((sum, s) => sum + s.steps, 0);
    },
  };
}

function makeParticipant(overrides = {}) {
  return {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    joinedAt: RACE_START,
    baselineSteps: 0,
    finishedAt: null,
    bonusSteps: 0,
    nextBoxAtSteps: 0,
    powerupSlots: overrides.powerupSlots || 3,
    user: { displayName: "TestUser" },
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  const updates = [];
  const promotedBoxes = [];

  const slotPowerups = overrides.slotPowerups || [];
  const queuedPowerups = overrides.queuedPowerups || [];
  let queuedCount = queuedPowerups.length;

  const race = {
    id: "race-1",
    status: "ACTIVE",
    targetSteps: 100000,
    startedAt: RACE_START,
    endsAt: new Date("2026-04-06T13:00:00.000Z"),
    powerupsEnabled: true,
    powerupStepInterval: 5000,
    participants: [makeParticipant(overrides.participant || {})],
  };

  return {
    updates,
    promotedBoxes,
    deps: {
      Race: { async findById() { return race; } },
      StepSample: createStepSampleStore(SAMPLES),
      Steps: {
        async findByUserIdAndDate() { return null; },
        async findByUserIdAndDateRange() { return []; },
      },
      RaceParticipant: {
        async updateTotalSteps(id, totalSteps) { updates.push({ id, totalSteps }); },
        async markFinished() {},
        async setPlacement() {},
      },
      RaceActiveEffect: {
        async findEffectsForRaceByType() { return []; },
        async findActiveForParticipant() { return []; },
        async findActiveForRace() { return []; },
      },
      RacePowerup: {
        async findHeldByParticipant() { return slotPowerups.filter((p) => p.status === "HELD"); },
        async findMysteryBoxesByParticipant() { return slotPowerups.filter((p) => p.status === "MYSTERY_BOX"); },
        async countMysteryBoxesByParticipant() { return slotPowerups.filter((p) => p.status === "MYSTERY_BOX").length; },
        async findSlotPowerups() { return slotPowerups; },
        async countOccupiedSlots() { return slotPowerups.length; },
        async countQueuedByParticipant() { return queuedCount; },
        async findQueuedByParticipant() { return queuedPowerups.slice(0, queuedCount); },
        async findHeldByParticipant() { return slotPowerups.filter((p) => p.status === "HELD"); },
        async update(id, fields) {
          promotedBoxes.push({ id, fields });
          // Simulate promotion: move from queued to slot
          if (fields.status === "MYSTERY_BOX") {
            const box = queuedPowerups.find((p) => p.id === id);
            if (box) {
              box.status = "MYSTERY_BOX";
              slotPowerups.push(box);
              queuedCount--;
            }
          }
        },
      },
      expireEffects: async () => {},
      completeRace: async () => {},
      rollPowerup: async () => [],
      now: () => NOW,
    },
  };
}

test("unified inventory includes both HELD and MYSTERY_BOX items with status field", async () => {
  const { deps } = makeDeps({
    slotPowerups: [
      { id: "pw-1", type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
      { id: "pw-2", type: null, rarity: null, status: "MYSTERY_BOX" },
    ],
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);
  const inv = result.powerupData.inventory;

  assert.equal(inv.length, 2);
  assert.equal(inv[0].status, "HELD");
  assert.equal(inv[0].type, "PROTEIN_SHAKE");
  assert.equal(inv[1].status, "MYSTERY_BOX");
  assert.equal(inv[1].type, null);
});

test("queuedBoxCount reflects number of queued boxes", async () => {
  const { deps } = makeDeps({
    slotPowerups: [
      { id: "pw-1", type: "LEG_CRAMP", rarity: "UNCOMMON", status: "HELD" },
    ],
    queuedPowerups: [
      { id: "q-1", status: "QUEUED" },
      { id: "q-2", status: "QUEUED" },
    ],
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  // 2 queued boxes should auto-fill into open slots (3 slots, 1 occupied → 2 open)
  // After auto-fill, queuedBoxCount should be 0
  assert.equal(result.powerupData.queuedBoxCount, 0);
  // Inventory should now have 3 items (1 held + 2 promoted)
  assert.equal(result.powerupData.inventory.length, 3);
});

test("queued boxes auto-fill open slots on refresh (oldest first)", async () => {
  const { deps, promotedBoxes } = makeDeps({
    slotPowerups: [
      { id: "pw-1", type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
      { id: "pw-2", type: "LEG_CRAMP", rarity: "UNCOMMON", status: "HELD" },
    ],
    queuedPowerups: [
      { id: "q-1", status: "QUEUED" },
      { id: "q-2", status: "QUEUED" },
      { id: "q-3", status: "QUEUED" },
    ],
    participant: { powerupSlots: 3 },
  });

  await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  // Only 1 open slot (3 slots, 2 occupied) → only first queued box promoted
  assert.equal(promotedBoxes.length, 1);
  assert.equal(promotedBoxes[0].id, "q-1");
  assert.equal(promotedBoxes[0].fields.status, "MYSTERY_BOX");
});

test("no auto-fill when all slots are occupied", async () => {
  const { deps, promotedBoxes } = makeDeps({
    slotPowerups: [
      { id: "pw-1", type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
      { id: "pw-2", type: "LEG_CRAMP", rarity: "UNCOMMON", status: "HELD" },
      { id: "pw-3", type: null, rarity: null, status: "MYSTERY_BOX" },
    ],
    queuedPowerups: [
      { id: "q-1", status: "QUEUED" },
    ],
    participant: { powerupSlots: 3 },
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(promotedBoxes.length, 0);
  assert.equal(result.powerupData.queuedBoxCount, 1);
});

test("response does not include legacy mysteryBoxCount or mysteryBoxIds fields", async () => {
  const { deps } = makeDeps({
    slotPowerups: [
      { id: "pw-1", type: null, rarity: null, status: "MYSTERY_BOX" },
    ],
  });

  const result = await buildGetRaceProgress(deps)("user-1", "race-1", TZ);

  assert.equal(result.powerupData.mysteryBoxCount, undefined);
  assert.equal(result.powerupData.mysteryBoxIds, undefined);
});
