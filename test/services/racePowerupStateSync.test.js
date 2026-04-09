const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/services/racePowerupStateSync");

function makeParticipant(overrides = {}) {
  return {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    totalSteps: 9000,
    powerupSlots: 3,
    nextBoxAtSteps: 2000,
    finishedAt: null,
    finishTotalSteps: null,
    user: { id: "user-1", displayName: "AliceSync" },
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  let participant = makeParticipant(overrides.participant);
  const race = {
    id: "race-1",
    status: "ACTIVE",
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    participants: [participant],
    ...overrides.race,
  };

  const slotPowerups = [...(overrides.slotPowerups || [])];
  const queuedPowerups = [...(overrides.queuedPowerups || [])];
  const rollCalls = [];
  const promotedBoxes = [];

  const deps = {
    Race: {
      async findById(id) {
        assert.equal(id, race.id);
        return {
          ...race,
          participants: [{ ...participant, user: { ...participant.user } }],
        };
      },
    },
    RacePowerup: {
      async countOccupiedSlots(participantId) {
        assert.equal(participantId, participant.id);
        return slotPowerups.length;
      },
      async findQueuedByParticipant(participantId) {
        assert.equal(participantId, participant.id);
        return queuedPowerups.map((box) => ({ ...box }));
      },
      async update(id, fields) {
        promotedBoxes.push({ id, fields });
        if (fields.status === "MYSTERY_BOX") {
          const queuedIndex = queuedPowerups.findIndex((box) => box.id === id);
          if (queuedIndex >= 0) {
            const [box] = queuedPowerups.splice(queuedIndex, 1);
            slotPowerups.push({ ...box, status: "MYSTERY_BOX" });
          }
        }
        return { id, ...fields };
      },
      async countQueuedByParticipant(participantId) {
        assert.equal(participantId, participant.id);
        return queuedPowerups.length;
      },
    },
    rollPowerup: async ({
      raceId,
      participantId,
      userId,
      currentSteps,
      nextBoxAtSteps,
      powerupStepInterval,
      powerupSlots,
    }) => {
      rollCalls.push({
        raceId,
        participantId,
        userId,
        currentSteps,
        nextBoxAtSteps,
        powerupStepInterval,
        powerupSlots,
      });

      const results = [];
      let threshold = nextBoxAtSteps;
      while (threshold > 0 && currentSteps >= threshold) {
        const queued = slotPowerups.length >= powerupSlots;
        const id = `pw-${slotPowerups.length + queuedPowerups.length + 1}`;
        const powerup = { id, participantId, status: queued ? "QUEUED" : "MYSTERY_BOX" };
        if (queued) {
          queuedPowerups.push(powerup);
        } else {
          slotPowerups.push(powerup);
        }
        results.push({
          mysteryBox: { id },
          threshold,
          queued,
        });
        threshold += powerupStepInterval;
      }

      participant = {
        ...participant,
        nextBoxAtSteps: threshold,
      };

      return results;
    },
  };

  return {
    rollCalls,
    promotedBoxes,
    slotPowerups,
    queuedPowerups,
    syncRacePowerupState: buildSyncRacePowerupState(deps),
  };
}

test("syncRacePowerupState earns mystery boxes from stored total steps", async () => {
  const ctx = makeContext();

  const result = await ctx.syncRacePowerupState({
    raceId: "race-1",
    userId: "user-1",
  });

  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(ctx.rollCalls[0].currentSteps, 9000);
  assert.equal(ctx.rollCalls[0].nextBoxAtSteps, 2000);
  assert.equal(ctx.slotPowerups.length, 3);
  assert.equal(ctx.queuedPowerups.length, 1);
  assert.deepEqual(
    result.newMysteryBoxes.map((box) => box.id),
    ["pw-1", "pw-2", "pw-3"]
  );
  assert.equal(result.newQueuedBoxes, 1);
  assert.equal(result.queuedBoxCount, 1);
});

test("syncRacePowerupState promotes the oldest queued boxes into open slots", async () => {
  const ctx = makeContext({
    participant: {
      totalSteps: 5000,
      nextBoxAtSteps: 8000,
    },
    slotPowerups: [
      { id: "held-1", participantId: "rp-1", status: "HELD" },
      { id: "held-2", participantId: "rp-1", status: "HELD" },
    ],
    queuedPowerups: [
      { id: "queued-1", participantId: "rp-1", status: "QUEUED" },
      { id: "queued-2", participantId: "rp-1", status: "QUEUED" },
    ],
  });

  const result = await ctx.syncRacePowerupState({
    raceId: "race-1",
    userId: "user-1",
  });

  assert.equal(ctx.rollCalls.length, 0);
  assert.deepEqual(ctx.promotedBoxes, [
    { id: "queued-1", fields: { status: "MYSTERY_BOX" } },
  ]);
  assert.equal(ctx.slotPowerups.length, 3);
  assert.equal(ctx.queuedPowerups.length, 1);
  assert.equal(result.queuedBoxCount, 1);
});
