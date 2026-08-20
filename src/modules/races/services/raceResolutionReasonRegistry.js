// Closed dirty-reason/dependency registry for the race-keyed resolver. Unknown
// input is deliberately represented as FULL: narrowing is an optimization and
// must never become a correctness requirement during a mixed-version rollout.

const DIRTY_REASONS = Object.freeze(new Set([
  "DISPLAY_REFRESH",
  "STEP_SYNC",
  "POWERUP_MUTATION",
  "BOX_OPEN",
  "JOIN_LEAVE_KICK",
  "FORFEIT_TEAM",
  "RACE_START",
  "EFFECT_BOUNDARY",
  "GLOBAL_EVENT_BOUNDARY",
  "RECOVERY",
  "DAILY_MOVER",
]));

const PRIORITIES = Object.freeze(new Set(["COALESCE", "IMMEDIATE"]));
const USER_CAP = 1000;
const PARTICIPANT_CAP = 1000;
const POWERUP_TYPE_CAP = 64;

// Every currently named catalog/effect type is explicit. A new type is unsafe
// until deliberately classified; callers must escalate an absent entry to FULL.
const POWERUP_SCOPE_BY_TYPE = Object.freeze({
  BOUNTY: "TARGET",
  CAMPFIRE_REST: "SELF",
  CLEANSE: "SELF",
  COIN_FLIP: "RACE_WIDE",
  COMPRESSION_SOCKS: "SELF",
  DECOY: "SELF",
  DEFENSE_SCAN: "RACE_WIDE",
  DETOUR_SIGN: "TARGET",
  DRILL_SERGEANT: "RACE_WIDE",
  FANNY_PACK: "SELF",
  GHOST_PEPPER: "TARGET",
  HITCHHIKE: "DEPENDENCY_CLOSURE",
  IMPOSTER: "TARGET",
  LEECH: "DEPENDENCY_CLOSURE",
  LEG_CRAMP: "TARGET",
  LUCKY_HORSESHOE: "SELF",
  MIRROR: "SELF",
  MYSTERY_POTION: "RACE_WIDE",
  PIGGY_BANK: "RACE_WIDE",
  PINECONE_TOSS: "TARGET",
  POCKET_WATCH: "DEPENDENCY_CLOSURE",
  POWER_OUTAGE: "RACE_WIDE",
  PROTEIN_SHAKE: "SELF",
  QUICK_RINSE: "SELF",
  QUICKSAND: "TARGET",
  RAINSTORM: "RACE_WIDE",
  RALLY_FLAG: "TEAM",
  RED_CARD: "RACE_WIDE",
  RUNNERS_HIGH: "SELF",
  SECOND_WIND: "SELF",
  SHORTCUT: "TARGET",
  SIGNAL_JAMMER: "RACE_WIDE",
  SNEAKY_SWAP: "DEPENDENCY_CLOSURE",
  STEALTH_MODE: "SELF",
  TRAIL_MAGNET: "SELF",
  TRAIL_MINE: "RACE_WIDE",
  TRAIL_MIX: "SELF",
  UMBRELLA: "SELF",
  UPRISING: "TEAM",
  WRONG_TURN: "TARGET",
});

const FULL_ENVELOPE = Object.freeze({
  reasons: Object.freeze(["FULL"]),
  dirtyUserIds: Object.freeze([]),
  dirtyParticipantIds: Object.freeze([]),
  powerupTypes: Object.freeze([]),
  priority: "IMMEDIATE",
});

function fullEnvelope() {
  return {
    reasons: ["FULL"],
    dirtyUserIds: [],
    dirtyParticipantIds: [],
    powerupTypes: [],
    priority: "IMMEDIATE",
  };
}

function stableStrings(value, cap) {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return null;
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
      if (result.length > cap) return null;
    }
  }
  return result;
}

function normalizeDirtyEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fullEnvelope();
  }
  const reason = value.reason;
  const priority = value.priority;
  if (!DIRTY_REASONS.has(reason) || !PRIORITIES.has(priority)) {
    return fullEnvelope();
  }
  const dirtyUserIds = stableStrings(value.dirtyUserIds, USER_CAP);
  const dirtyParticipantIds = stableStrings(
    value.dirtyParticipantIds,
    PARTICIPANT_CAP
  );
  const powerupTypes = stableStrings(value.powerupTypes, POWERUP_TYPE_CAP);
  if (!dirtyUserIds || !dirtyParticipantIds || !powerupTypes) {
    return fullEnvelope();
  }
  if (
    reason === "POWERUP_MUTATION" &&
    powerupTypes.some((type) => !POWERUP_SCOPE_BY_TYPE[type])
  ) {
    return fullEnvelope();
  }
  return {
    reasons: [reason],
    dirtyUserIds,
    dirtyParticipantIds,
    powerupTypes,
    priority,
  };
}

function mergeStable(left, right, cap) {
  return stableStrings([...(left || []), ...(right || [])], cap);
}

function isNormalized(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray(value.reasons) &&
      Array.isArray(value.dirtyUserIds) &&
      Array.isArray(value.dirtyParticipantIds) &&
      Array.isArray(value.powerupTypes) &&
      PRIORITIES.has(value.priority)
  );
}

function mergeDirtyEnvelopes(left, right) {
  if (!isNormalized(left) || !isNormalized(right)) return fullEnvelope();
  if (left.reasons.includes("FULL") || right.reasons.includes("FULL")) {
    const merged = [...left.reasons, ...right.reasons];
    if (!merged.includes("EFFECT_BOUNDARY")) return fullEnvelope();
    return {
      ...fullEnvelope(),
      // FULL owns scoring scope; EFFECT_BOUNDARY and its Umbrella discriminator
      // are orthogonal durable source-consumption signals.
      reasons: ["FULL", "EFFECT_BOUNDARY"],
      powerupTypes:
        left.powerupTypes.includes("UMBRELLA") || right.powerupTypes.includes("UMBRELLA")
          ? ["UMBRELLA"]
          : [],
    };
  }
  const reasons = mergeStable(left.reasons, right.reasons, DIRTY_REASONS.size);
  const dirtyUserIds = mergeStable(left.dirtyUserIds, right.dirtyUserIds, USER_CAP);
  const dirtyParticipantIds = mergeStable(
    left.dirtyParticipantIds,
    right.dirtyParticipantIds,
    PARTICIPANT_CAP
  );
  const powerupTypes = mergeStable(
    left.powerupTypes,
    right.powerupTypes,
    POWERUP_TYPE_CAP
  );
  if (
    !reasons ||
    reasons.some((reason) => !DIRTY_REASONS.has(reason)) ||
    !dirtyUserIds ||
    !dirtyParticipantIds ||
    !powerupTypes ||
    powerupTypes.some((type) => !POWERUP_SCOPE_BY_TYPE[type])
  ) {
    return fullEnvelope();
  }
  return {
    reasons,
    dirtyUserIds,
    dirtyParticipantIds,
    powerupTypes,
    priority:
      left.priority === "IMMEDIATE" || right.priority === "IMMEDIATE"
        ? "IMMEDIATE"
        : "COALESCE",
  };
}

module.exports = {
  DIRTY_REASONS,
  PRIORITIES,
  POWERUP_SCOPE_BY_TYPE,
  FULL_ENVELOPE,
  USER_CAP,
  PARTICIPANT_CAP,
  POWERUP_TYPE_CAP,
  normalizeDirtyEnvelope,
  mergeDirtyEnvelopes,
};
