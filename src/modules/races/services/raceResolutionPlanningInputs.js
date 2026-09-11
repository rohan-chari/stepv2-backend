const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { normalizedEntitlementEvent } = require("../../steps/services/globalStepEventEntitlement");

// These adapters are only installed by a worker attempt whose matching planning
// digest is protected by a NEW transaction-time fingerprint. They never replace
// the fence and are never retained in the process cache or a subsequent attempt.
function planningInputModels({ fingerprint, validUntil, scoringInputVersionModel, raceActiveEffectModel, raceModel }) {
  const provenance = fingerprint?.scoringReadSnapshot;
  const deadline = validUntil ? new Date(validUntil).getTime() : NaN;
  if (provenance?.schema !== 1 || !Number.isFinite(deadline) ||
      !Array.isArray(fingerprint.globalEvents) || !Array.isArray(fingerprint.inputs) ||
      !Array.isArray(fingerprint.participants) || !fingerprint.race?.id) return {};
  const members = new Map(fingerprint.participants.map(row => [row.userId, row]));
  const versions = new Map(fingerprint.inputs.map(row => [row.userId, row]));
  return {
    ...(provenance.raceComplete === true && raceModel
      ? { Race: {
          ...raceModel,
          async findForResolution(raceId) {
            if (raceId !== provenance.raceId) return raceModel.findForResolution(raceId);
            const race = structuredClone(fingerprint.race);
            for (const key of ["startedAt", "scheduledStartAt", "endsAt"]) {
              race[key] = race[key] == null ? null : new Date(Number(race[key]));
            }
            race.participants = structuredClone(fingerprint.participants).map(row => {
              for (const key of ["joinedAt", "finishedAt", "forfeitedAt", "highMultiplierNotifiedAt", "totalsUpdatedAt"]) {
                row[key] = row[key] == null ? null : new Date(Number(row[key]));
              }
              return row;
            }).sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
            return race;
          },
        } }
      : {}),
    ...(provenance.effectsComplete === true && Array.isArray(fingerprint.scoringEffects) && raceActiveEffectModel
      ? { RaceActiveEffect: {
          // Keep the worker's write-capture model: spreading the database model
          // here would allow scoring to persist effects outside the commit fence.
          ...raceActiveEffectModel,
          async findResolutionEffectsForRaces(raceIds, historyTypes) {
            if (raceIds.length !== 1 || raceIds[0] !== provenance.raceId) {
              return raceActiveEffectModel.findResolutionEffectsForRaces(raceIds, historyTypes);
            }
            return fingerprint.scoringEffects
              .filter(row => row.status === "ACTIVE" ||
                (row.status === "EXPIRED" && historyTypes.includes(row.type)))
              .map(row => ({ ...row, metadata: row.metadata == null ? row.metadata : structuredClone(row.metadata),
                startsAt: row.startsAt == null ? null : new Date(row.startsAt),
                expiresAt: row.expiresAt == null ? null : new Date(row.expiresAt),
                createdAt: new Date(row.createdAt), updatedAt: new Date(row.updatedAt) }))
              .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
          },
        } }
      : {}),
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
            }, { id: event.impactId });
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
