const { readFragment } = require("../../../shared/cache/cacheEfficiencyRead");
const { RacePowerup } = require("../../powerups/models/racePowerup");

const { isStealablePowerup } = require("../../powerups/services/powerupStealability");

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
          if (isStealablePowerup(row) && row.participantId) targetIds.add(row.participantId);
        }
        return [...targetIds].sort();
      },
    });
    return new Set(result.value || []);
  };
}

const stealableParticipants = buildStealableTargetCache();

module.exports = { buildStealableTargetCache, stealableParticipants };
