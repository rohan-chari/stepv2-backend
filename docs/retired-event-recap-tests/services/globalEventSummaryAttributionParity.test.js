const assert = require("node:assert/strict");
const test = require("node:test");

const {
  scoreCaptureArtifact,
} = require("../../src/modules/steps/services/globalEventSummaryCapture");

const BEFORE = "2026-08-27T11:30:00.000Z";
const START = "2026-08-27T12:00:00.000Z";
const END = "2026-08-27T12:30:00.000Z";

function payload({ type = null, finishedAt = null } = {}) {
  const cutoffAt = finishedAt || END;
  return {
    schemaVersion: 1,
    userId: "user",
    race: {
      id: "race",
      startedAt: BEFORE,
      endsAt: "2026-08-27T13:00:00.000Z",
      timezone: "UTC",
      powerupsEnabled: true,
    },
    event: { id: "event", startsAt: START, endsAt: END, multiplier: 2 },
    participants: [{
      id: "participant",
      userId: "user",
      joinedAt: BEFORE,
      bonusSteps: 0,
      finishedAt,
      forfeitedAt: null,
      cutoffAt,
    }],
    samples: [
      { userId: "user", periodStart: BEFORE, periodEnd: START, steps: 300 },
      { userId: "user", periodStart: START, periodEnd: END, steps: 100 },
    ],
    dailySteps: [{
      userId: "user",
      date: "2026-08-27T00:00:00.000Z",
      steps: 400,
    }],
    effects: type ? [{
      id: `effect-${type}`,
      type,
      status: "ACTIVE",
      startsAt: START,
      expiresAt: END,
      targetParticipantId: "participant",
      targetUserId: "user",
      sourceUserId: "user",
      metadata: {},
    }] : [],
    dependencyInputGenerations: [{ userId: "user", generation: "1" }],
  };
}

test("boundary artifact uses the shared whole-race parity vectors", async () => {
  for (const [name, input, expected] of [
    ["plain 2x", {}, 100],
    ["multiplicative positive buff", { type: "RUNNERS_HIGH" }, 200],
    ["frozen overlap", { type: "LEG_CRAMP" }, 0],
    ["signed Wrong Turn overlap", { type: "WRONG_TURN" }, -100],
    ["finish during event replays to the cutoff", {
      finishedAt: "2026-08-27T12:15:00.000Z",
    }, 50],
  ]) {
    assert.equal(await scoreCaptureArtifact(payload(input)), expected, name);
  }
});
