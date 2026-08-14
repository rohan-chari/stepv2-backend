const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DIRTY_REASONS,
  PRIORITIES,
  POWERUP_SCOPE_BY_TYPE,
  normalizeDirtyEnvelope,
  mergeDirtyEnvelopes,
} = require("../../src/modules/races/services/raceResolutionReasonRegistry");

test("the resolution reason registry is closed and defaults unsafe input to FULL", () => {
  assert.deepEqual([...DIRTY_REASONS].sort(), [
    "BOX_OPEN",
    "DAILY_MOVER",
    "DISPLAY_REFRESH",
    "EFFECT_BOUNDARY",
    "FORFEIT_TEAM",
    "GLOBAL_EVENT_BOUNDARY",
    "JOIN_LEAVE_KICK",
    "POWERUP_MUTATION",
    "RACE_START",
    "RECOVERY",
    "STEP_SYNC",
  ]);
  assert.deepEqual([...PRIORITIES].sort(), ["COALESCE", "IMMEDIATE"]);

  for (const value of [null, {}, { reason: "NEW_UNKNOWN_REASON" }]) {
    assert.deepEqual(normalizeDirtyEnvelope(value), {
      reasons: ["FULL"],
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "IMMEDIATE",
    });
  }
});

test("scope sets merge append-distinct in stable order and IMMEDIATE wins", () => {
  const merged = mergeDirtyEnvelopes(
    normalizeDirtyEnvelope({
      reason: "STEP_SYNC",
      dirtyUserIds: ["u2", "u1"],
      dirtyParticipantIds: ["p2"],
      priority: "COALESCE",
    }),
    normalizeDirtyEnvelope({
      reason: "POWERUP_MUTATION",
      dirtyUserIds: ["u1", "u3"],
      dirtyParticipantIds: ["p1", "p2"],
      powerupTypes: ["LEECH"],
      priority: "IMMEDIATE",
    })
  );

  assert.deepEqual(merged, {
    reasons: ["STEP_SYNC", "POWERUP_MUTATION"],
    dirtyUserIds: ["u2", "u1", "u3"],
    dirtyParticipantIds: ["p2", "p1"],
    powerupTypes: ["LEECH"],
    priority: "IMMEDIATE",
  });
});

test("malformed or over-cap scope atomically becomes FULL without truncation", () => {
  assert.equal(
    normalizeDirtyEnvelope({
      reason: "STEP_SYNC",
      dirtyUserIds: Array.from({ length: 1001 }, (_, i) => `u${i}`),
      priority: "COALESCE",
    }).reasons[0],
    "FULL"
  );

  assert.deepEqual(
    mergeDirtyEnvelopes(
      normalizeDirtyEnvelope({ reason: "STEP_SYNC", priority: "COALESCE" }),
      { reasons: ["POWERUP_MUTATION"], dirtyUserIds: [17] }
    ),
    {
      reasons: ["FULL"],
      dirtyUserIds: [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "IMMEDIATE",
    }
  );
});

test("every currently named powerup has an explicit dependency scope", () => {
  const expected = [
    "BOUNTY", "CAMPFIRE_REST", "CLEANSE", "COIN_FLIP", "COMPRESSION_SOCKS",
    "DECOY", "DEFENSE_SCAN", "DETOUR_SIGN", "DRILL_SERGEANT", "FANNY_PACK",
    "GHOST_PEPPER", "HITCHHIKE", "IMPOSTER", "LEECH", "LEG_CRAMP",
    "LUCKY_HORSESHOE", "MIRROR", "MYSTERY_POTION", "PIGGY_BANK",
    "PINECONE_TOSS", "POCKET_WATCH", "POWER_OUTAGE", "PROTEIN_SHAKE",
    "QUICK_RINSE", "QUICKSAND", "RAINSTORM", "RALLY_FLAG", "RED_CARD",
    "RUNNERS_HIGH", "SECOND_WIND", "SHORTCUT", "SIGNAL_JAMMER",
    "SNEAKY_SWAP", "STEALTH_MODE", "TRAIL_MAGNET", "TRAIL_MINE",
    "TRAIL_MIX", "UMBRELLA", "UPRISING", "WRONG_TURN",
  ];
  assert.deepEqual(Object.keys(POWERUP_SCOPE_BY_TYPE).sort(), expected.sort());
  assert.equal(POWERUP_SCOPE_BY_TYPE.LEECH, "DEPENDENCY_CLOSURE");
  assert.equal(POWERUP_SCOPE_BY_TYPE.HITCHHIKE, "DEPENDENCY_CLOSURE");
  assert.equal(POWERUP_SCOPE_BY_TYPE.TRAIL_MINE, "RACE_WIDE");
});
