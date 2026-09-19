const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  eligiblePowerupTargets,
} = require("../../../src/modules/races/services/powerupTargetEligibility");

const participants = [
  { id: "me-p", userId: "me", status: "ACCEPTED", team: "TEAM_A", totalSteps: 100 },
  { id: "normal-p", userId: "normal", status: "ACCEPTED", team: "TEAM_B", totalSteps: 200 },
  { id: "cramped-p", userId: "cramped", status: "ACCEPTED", team: "TEAM_B", totalSteps: 300 },
  { id: "wrong-p", userId: "wrong", status: "ACCEPTED", team: "TEAM_B", totalSteps: 400 },
];
const effects = [
  { targetParticipantId: "cramped-p", type: "LEG_CRAMP", status: "ACTIVE", expiresAt: "2099-01-01T00:00:00.000Z" },
  { targetParticipantId: "wrong-p", type: "WRONG_TURN", status: "ACTIVE", expiresAt: "2099-01-01T00:00:00.000Z" },
];

test("Leg Cramp and Wrong Turn hide conflicting active targets", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const leg = eligiblePowerupTargets({
    powerupType: "LEG_CRAMP",
    participants,
    viewerUserId: "me",
    effects,
    now,
  });
  const wrong = eligiblePowerupTargets({
    powerupType: "WRONG_TURN",
    participants,
    viewerUserId: "me",
    effects,
    now,
  });

  assert.deepEqual(leg.map((p) => p.userId), ["normal"]);
  assert.deepEqual(wrong.map((p) => p.userId), ["normal"]);
});
