const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { normalizedEntitlementEvent } = require("../../steps/services/globalStepEventEntitlement");

// These adapters are only installed by a worker attempt whose matching planning
// digest is protected by a NEW transaction-time fingerprint. They never replace
// the fence and are never retained in the process cache or a subsequent attempt.
function planningInputModels({ fingerprint, validUntil, scoringInputVersionModel }) {
  const provenance = fingerprint?.scoringReadSnapshot;
  const deadline = validUntil ? new Date(validUntil).getTime() : NaN;
  if (provenance?.schema !== 1 || !Number.isFinite(deadline) ||
      !Array.isArray(fingerprint.globalEvents) || !Array.isArray(fingerprint.inputs) ||
      !Array.isArray(fingerprint.participants) || !fingerprint.race?.id) return {};
  const members = new Map(fingerprint.participants.map(row => [row.userId, row]));
  const versions = new Map(fingerprint.inputs.map(row => [row.userId, row]));
  return {
    GlobalStepEvent: {
      ...GlobalStepEvent,
      async findEligibleByRace(options) {
        const start = new Date(options.rangeStart).getTime();
        const end = new Date(options.rangeEnd).getTime();
        const ids = [...new Set(options.userIds || [])];
        if (options.raceId !== provenance.raceId || options.allowMissingImpactEventUserKeys ||
            !(start >= Number(fingerprint.race.startedAt)) ||
            !(end >= provenance.asOf && end < deadline && end <= provenance.through) ||
            !ids.every(id => members.has(id))) return GlobalStepEvent.findEligibleByRace(options);
        const map = new Map(ids.map(id => [id, []]));
        for (const event of fingerprint.globalEvents) {
          if (!(new Date(event.startsAt).getTime() < end && new Date(event.endsAt).getTime() > start)) continue;
          if (event.scheduleMode === "LEGACY_GLOBAL") {
            for (const id of ids) map.get(id).push({ ...event });
          } else if (event.scheduleMode === "LOCAL_ENTITLEMENTS" && map.has(event.userId)) {
            const normalized = normalizedEntitlementEvent(event, {
              id: event.entitlementId, startsAt: event.startsAt, endsAt: event.endsAt,
            }, { id: event.impactId, status: event.impactStatus });
            normalized.startsAt = new Date(Math.max(new Date(event.startsAt).getTime(), start,
              members.get(event.userId).joinedAt == null ? start : Number(members.get(event.userId).joinedAt)));
            if (normalized.startsAt < new Date(normalized.endsAt)) map.get(event.userId).push(normalized);
          }
        }
        return map;
      },
    },
    scoringInputVersionModel: {
      async findMany(options) {
        const ids = options?.where?.userId?.in;
        if (!Array.isArray(ids) || !ids.every(id => versions.has(id))) {
          return scoringInputVersionModel.findMany(options);
        }
        return ids.map(id => ({ userId: id, generation: BigInt(versions.get(id).generation) }));
      },
    },
  };
}

module.exports = { planningInputModels };
