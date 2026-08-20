const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeActiveTimedImpactCapture,
} = require("../../src/modules/races/services/raceStateResolution");

const currentTime = new Date("2026-08-20T12:00:00.000Z");

test("eight due sources in a 1,000-participant race bulk-load one selected closure and score once", async () => {
  const participants = Array.from({ length: 1000 }, (_, index) => ({
    id: `participant-${index}`,
    userId: `user-${index}`,
    bonusSteps: 0,
  }));
  const selectedEffects = participants.slice(0, 8).map((participant, index) => ({
    id: `due-${index}`,
    raceId: "large-race",
    type: "RUNNERS_HIGH",
    targetParticipantId: participant.id,
    targetUserId: participant.userId,
    sourceUserId: participant.userId,
    status: "ACTIVE",
    startsAt: new Date(currentTime.getTime() - 60 * 60 * 1000 - index),
    expiresAt: new Date(currentTime.getTime() - 1000),
    metadata: { multiplier: 2 },
  }));
  let prefixReads = 0;
  const model = {
    async findActiveImpactPrefixEffects({ participantIds }) {
      prefixReads += 1;
      const selected = new Set(participantIds);
      return selectedEffects.filter((effect) =>
        selected.has(effect.targetParticipantId)
      );
    },
  };
  const stepSampleModel = {
    async sumClosedStepsInWindows(_userId, windows) {
      return windows.map(() => 100);
    },
    async sumClosedStepsInWindow() { return 100; },
    async sumStepsInWindow() { return 100; },
  };
  const startedAt = process.hrtime.bigint();
  const capture = await computeActiveTimedImpactCapture({
    race: {
      id: "large-race",
      powerupsEnabled: true,
      endsAt: new Date(currentTime.getTime() + 60 * 60 * 1000),
    },
    participants,
    preLeech: participants.map((participant) => ({
      participant,
      baseAdjusted: 100,
      hasSampleData: true,
      frozen: false,
    })),
    currentTime,
    raceActiveEffectModel: model,
    stepSampleModel,
    selectedEffects,
  });
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.equal(prefixReads, 1);
  assert.equal(capture.scorerCalls, 1);
  assert.equal(capture.resolved.length, 8);
  assert.ok(durationMs < 250, `selected closure took ${durationMs.toFixed(1)}ms`);
});
