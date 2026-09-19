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


test("Shortcut hides zero-step targets using cached participant totals", () => {
  const shortcutParticipants = [
    { id: "me-p", userId: "me", status: "ACCEPTED", totalSteps: 100 },
    { id: "zero-p", userId: "zero", status: "ACCEPTED", totalSteps: 0 },
    { id: "steps-p", userId: "steps", status: "ACCEPTED", totalSteps: 25 },
  ];
  const targets = eligiblePowerupTargets({
    powerupType: "SHORTCUT",
    participants: shortcutParticipants,
    viewerUserId: "me",
    effects: [],
  });
  assert.deepEqual(targets.map((p) => p.userId), ["steps"]);
});

test("Hitchhike hides occupied targets and returns none when caster already has a live link", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const hitchParticipants = [
    { id: "me-p", userId: "me", status: "ACCEPTED" },
    { id: "free-p", userId: "free", status: "ACCEPTED" },
    { id: "occupied-p", userId: "occupied", status: "ACCEPTED" },
  ];
  const occupiedOnly = eligiblePowerupTargets({
    powerupType: "HITCHHIKE",
    participants: hitchParticipants,
    viewerUserId: "me",
    effects: [
      {
        type: "HITCHHIKE",
        status: "ACTIVE",
        targetParticipantId: "occupied-p",
        targetUserId: "occupied",
        sourceUserId: "other",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    now,
  });
  assert.deepEqual(occupiedOnly.map((p) => p.userId), ["free"]);

  const casterAlreadyLinked = eligiblePowerupTargets({
    powerupType: "HITCHHIKE",
    participants: hitchParticipants,
    viewerUserId: "me",
    effects: [
      {
        type: "HITCHHIKE",
        status: "ACTIVE",
        targetParticipantId: "free-p",
        targetUserId: "free",
        sourceUserId: "me",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    now,
  });
  assert.deepEqual(casterAlreadyLinked, []);
});

test("Quicksand hides rivals already frozen by Leg Cramp or Quicksand", () => {
  const now = new Date("2026-09-19T00:00:00.000Z");
  const quicksandParticipants = [
    { id: "me-p", userId: "me", status: "ACCEPTED" },
    { id: "free-p", userId: "free", status: "ACCEPTED" },
    { id: "cramped-p", userId: "cramped", status: "ACCEPTED" },
    { id: "quicksand-p", userId: "quicksand", status: "ACCEPTED" },
  ];
  const targets = eligiblePowerupTargets({
    powerupType: "QUICKSAND",
    participants: quicksandParticipants,
    viewerUserId: "me",
    effects: [
      {
        type: "LEG_CRAMP",
        status: "ACTIVE",
        targetParticipantId: "cramped-p",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      {
        type: "QUICKSAND",
        status: "ACTIVE",
        targetParticipantId: "quicksand-p",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ],
    now,
  });
  assert.deepEqual(targets.map((p) => p.userId), ["free"]);
});
