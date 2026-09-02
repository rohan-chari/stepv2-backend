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

test("selected attribution prepares Leech sample users introduced by the expanded prefix", async () => {
  const participants = ["a", "b", "c"].map((id) => ({
    id: `participant-${id}`,
    userId: `user-${id}`,
    bonusSteps: 0,
  }));
  const selected = {
    id: "due-a",
    raceId: "race",
    type: "RUNNERS_HIGH",
    targetParticipantId: "participant-a",
    targetUserId: "user-a",
    sourceUserId: "user-a",
    status: "ACTIVE",
    startsAt: new Date(currentTime.getTime() - 60 * 60 * 1000),
    expiresAt: new Date(currentTime.getTime() - 1000),
    metadata: { multiplier: 2 },
  };
  const aLeech = {
    id: "leech-a",
    raceId: "race",
    type: "LEECH",
    targetParticipantId: "participant-a",
    targetUserId: "user-a",
    sourceUserId: "user-b",
    status: "EXPIRED",
    startsAt: new Date(currentTime.getTime() - 80 * 60 * 1000),
    expiresAt: new Date(currentTime.getTime() - 10 * 60 * 1000),
    metadata: { ratio: 2 },
  };
  const bLeech = {
    id: "leech-b",
    raceId: "race",
    type: "LEECH",
    targetParticipantId: "participant-b",
    targetUserId: "user-b",
    sourceUserId: "user-c",
    status: "EXPIRED",
    startsAt: new Date(currentTime.getTime() - 70 * 60 * 1000),
    expiresAt: new Date(currentTime.getTime() - 5 * 60 * 1000),
    metadata: { ratio: 2 },
  };
  const prepared = new Set();
  const model = {
    async findActiveImpactPrefixEffects({ participantIds }) {
      if (participantIds.includes("participant-a")) return [selected, aLeech];
      if (participantIds.includes("participant-b")) return [bLeech];
      return [];
    },
  };
  const stepSampleModel = {
    async prepareUsers(userIds) {
      for (const userId of userIds) prepared.add(userId);
    },
    releaseUsers() {},
    async sumClosedStepsInWindows(userId, windows) {
      if (!prepared.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      return windows.map(() => 100);
    },
    async sumClosedStepsInWindow(userId) {
      if (!prepared.has(userId)) {
        throw new Error("sample user outside the prepared worker scoring chunk");
      }
      return 100;
    },
  };

  const capture = await computeActiveTimedImpactCapture({
    race: {
      id: "race",
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
    selectedEffects: [selected],
    prepareSampleUsers: stepSampleModel.prepareUsers,
    releaseSampleUsers: stepSampleModel.releaseUsers,
  });

  assert.equal(capture.resolved.length, 1);
  assert.ok(prepared.has("user-c"));
});
