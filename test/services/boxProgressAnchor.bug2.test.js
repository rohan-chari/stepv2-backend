const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSyncRacePowerupState,
} = require("../../src/services/racePowerupStateSync");

// Bug 2: mystery-box progress must never be pushed backward by a debuff.
// The bonusSteps high-water (maxBonusSteps) only protects against bonusSteps
// losses (Red Card/Shortcut/Pinecone/Trail Mine). It does NOT protect against
// frozenSteps (Leg Cramp) or reversedSteps (Wrong Turn), which reduce
// totalSteps directly. The maxBoxProgressSteps high-water anchor makes box
// progress monotonic against ANY debuff: once effectiveSteps peaks at N, box
// rolls keep gating on N even if totalSteps later drops below N.

function makeParticipant(overrides = {}) {
  return {
    id: "rp-1",
    userId: "user-1",
    status: "ACCEPTED",
    totalSteps: 9000,
    powerupSlots: 3,
    nextBoxAtSteps: 2000,
    bonusSteps: 0,
    maxBonusSteps: 0,
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
  const maxBoxProgressUpdates = [];
  // When true, the participant model omits updateMaxBoxProgressSteps so we can
  // assert the sync guards on `typeof === "function"` (older deploy compat).
  const omitUpdateMethod = overrides.omitUpdateMethod === true;

  const participantModel = {
    async updateMaxBoxProgressSteps(id, maxBoxProgressSteps) {
      maxBoxProgressUpdates.push({ id, maxBoxProgressSteps });
      participant = { ...participant, maxBoxProgressSteps };
      return { id, maxBoxProgressSteps };
    },
  };
  if (omitUpdateMethod) {
    delete participantModel.updateMaxBoxProgressSteps;
  }

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
    RaceParticipant: participantModel,
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
      effectiveSteps,
      nextBoxAtSteps,
      powerupStepInterval,
      powerupSlots,
    }) => {
      rollCalls.push({
        raceId,
        participantId,
        userId,
        currentSteps,
        effectiveSteps,
        nextBoxAtSteps,
        powerupStepInterval,
        powerupSlots,
      });

      // The roll must gate on effectiveSteps (the high-water), not currentSteps.
      const gateSteps = effectiveSteps != null ? effectiveSteps : currentSteps;
      const results = [];
      let threshold = nextBoxAtSteps;
      while (threshold > 0 && gateSteps >= threshold) {
        const queued = slotPowerups.length >= powerupSlots;
        const id = `pw-${slotPowerups.length + queuedPowerups.length + 1}`;
        const powerup = { id, participantId, status: queued ? "QUEUED" : "MYSTERY_BOX" };
        if (queued) {
          queuedPowerups.push(powerup);
        } else {
          slotPowerups.push(powerup);
        }
        results.push({ mysteryBox: { id }, threshold, queued });
        threshold += powerupStepInterval;
      }

      participant = { ...participant, nextBoxAtSteps: threshold };
      return results;
    },
  };

  return {
    rollCalls,
    promotedBoxes,
    slotPowerups,
    queuedPowerups,
    maxBoxProgressUpdates,
    syncRacePowerupState: buildSyncRacePowerupState(deps),
  };
}

test("box progress gates on the stored high-water even after a debuff drops totalSteps", async () => {
  // Player peaked at effectiveSteps 9000 (high-water already persisted), but a
  // Leg Cramp/Wrong Turn later dropped totalSteps to 5000. With no bonus, the
  // recomputed effectiveSteps would be only 5000 — yet box rolls must still
  // gate on 9000 so already-earned boxes are kept and there is NO re-walk.
  const ctx = makeContext({
    participant: {
      totalSteps: 5000,
      bonusSteps: 0,
      maxBonusSteps: 0,
      nextBoxAtSteps: 2000,
      maxBoxProgressSteps: 9000,
    },
  });

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1, "should roll using the high-water");
  assert.equal(
    ctx.rollCalls[0].effectiveSteps,
    9000,
    "roll must gate on the 9000 high-water, not the dropped 5000 totalSteps"
  );
  // 9000 / 2000 = boxes at 2000,4000,6000,8000 -> 4 boxes (3 in slots, 1 queued)
  assert.equal(ctx.slotPowerups.length, 3);
  assert.equal(ctx.queuedPowerups.length, 1);
  // No new high-water to persist (5000 effective < 9000 stored).
  assert.equal(ctx.maxBoxProgressUpdates.length, 0);
});

test("a fresh high-water is persisted when effectiveSteps exceeds the stored mark", async () => {
  // totalSteps 9000, no debuff, stored high-water lower at 4000. The new mark
  // 9000 must be persisted via updateMaxBoxProgressSteps and the roll gated on it.
  const ctx = makeContext({
    participant: {
      totalSteps: 9000,
      bonusSteps: 0,
      maxBonusSteps: 0,
      nextBoxAtSteps: 2000,
      maxBoxProgressSteps: 4000,
    },
  });

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.maxBoxProgressUpdates.length, 1, "should persist the new high-water");
  assert.equal(ctx.maxBoxProgressUpdates[0].id, "rp-1");
  assert.equal(ctx.maxBoxProgressUpdates[0].maxBoxProgressSteps, 9000);
  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(ctx.rollCalls[0].effectiveSteps, 9000);
});

test("NULL/absent maxBoxProgressSteps reproduces current behavior (regression guard)", async () => {
  // Existing rows have maxBoxProgressSteps = NULL -> treated as 0 ->
  // Math.max(effectiveSteps, 0) = effectiveSteps. Box rolls behave exactly as
  // before, and the new high-water (= effectiveSteps) gets seeded on this sync.
  const ctx = makeContext({
    participant: {
      totalSteps: 9000,
      bonusSteps: 0,
      maxBonusSteps: 0,
      nextBoxAtSteps: 2000,
      // maxBoxProgressSteps intentionally absent (undefined -> NULL row)
    },
  });

  await ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" });

  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(
    ctx.rollCalls[0].effectiveSteps,
    9000,
    "effectiveSteps == totalSteps when there is no debuff and no stored mark"
  );
  // High-water is seeded from the effective steps on first sync.
  assert.equal(ctx.maxBoxProgressUpdates.length, 1);
  assert.equal(ctx.maxBoxProgressUpdates[0].maxBoxProgressSteps, 9000);
  assert.equal(ctx.slotPowerups.length, 3);
  assert.equal(ctx.queuedPowerups.length, 1);
});

test("guards when participant model lacks updateMaxBoxProgressSteps (older deploy)", async () => {
  // If the model method does not exist yet, the sync must not throw; it still
  // gates the roll on the in-memory high-water without persisting.
  const ctx = makeContext({
    omitUpdateMethod: true,
    participant: {
      totalSteps: 9000,
      bonusSteps: 0,
      maxBonusSteps: 0,
      nextBoxAtSteps: 2000,
      maxBoxProgressSteps: 4000,
    },
  });

  await assert.doesNotReject(() =>
    ctx.syncRacePowerupState({ raceId: "race-1", userId: "user-1" })
  );

  assert.equal(ctx.maxBoxProgressUpdates.length, 0, "no persist without the method");
  assert.equal(ctx.rollCalls.length, 1);
  assert.equal(ctx.rollCalls[0].effectiveSteps, 9000);
});
