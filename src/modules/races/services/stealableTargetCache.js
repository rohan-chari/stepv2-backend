const { readFragment } = require("../../../shared/cache/cacheEfficiencyRead");
const { RacePowerup } = require("../../powerups/models/racePowerup");

const UNSTEALABLE_TYPES = new Set([
  "SNEAKY_SWAP",
  "MYSTERY_BOX",
  "UPRISING",
  "GHOST_PEPPER",
  "COIN_FLIP",
  "MYSTERY_POTION",
  "DECOY",
  "POWER_OUTAGE",
  "UMBRELLA",
  "RALLY_FLAG",
  "DRILL_SERGEANT",
  "PIGGY_BANK",
  "BOUNTY",
]);

function isStealable(powerup) {
  return Boolean(
    powerup &&
    powerup.status === "HELD" &&
    !UNSTEALABLE_TYPES.has(powerup.type)
  );
}

function valid(value) {
  return Array.isArray(value) &&
    value.length <= 10000 &&
    value.every((id) => typeof id === "string" && id.length > 0);
}

function buildStealableTargetCache(dependencies = {}) {
  const powerupModel = dependencies.RacePowerup || RacePowerup;
  return async function stealableParticipants(raceId, participantIds) {
    const ids = [...new Set(participantIds || [])].filter(Boolean).sort();
    if (!ids.length) return new Set();
    const markers = ids.map((id) => ({ domain: "slots", identity: `participant:${id}` }));
    const result = await readFragment({
      kind: "race-stealable-targets",
      key: `ce:v1:race-stealable-targets:${raceId}`,
      markers,
      ttlMs: 30000,
      validate: valid,
      load: async () => {
        const rows = await powerupModel.findInventoryForParticipants(ids, ["HELD"]);
        const targetIds = new Set();
        for (const row of rows || []) {
          if (isStealable(row) && row.participantId) targetIds.add(row.participantId);
        }
        return [...targetIds].sort();
      },
    });
    return new Set(result.value || []);
  };
}

const stealableParticipants = buildStealableTargetCache();

module.exports = { UNSTEALABLE_TYPES, isStealable, buildStealableTargetCache, stealableParticipants };
