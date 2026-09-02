const assert = require("node:assert/strict");
const test = require("node:test");

const {
  evaluateHighMultiplierAlert,
} = require("../../src/modules/races/services/highMultiplierAlert");

test("deferred re-arm preparation is read-only and returns a fenced claim", async () => {
  let updates = 0;
  const outcome = await evaluateHighMultiplierAlert({
    participant: {
      id: "participant-1",
      userId: "user-1",
      highMultiplierNotifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
    currentMultiplier: 1,
    deferClaim: true,
    deferRearm: true,
    prisma: {
      raceParticipant: {
        async updateMany() { updates += 1; return { count: 1 }; },
      },
    },
  });
  assert.equal(updates, 0);
  assert.deepEqual(outcome, {
    emitted: false,
    reason: "re_armed_deferred",
    rearmClaim: {
      participantId: "participant-1",
      expectedNotifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  });
});
