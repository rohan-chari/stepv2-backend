const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const raceSelect = {
  id: true,
  name: true,
  status: true,
  startedAt: true,
  endsAt: true,
  timezone: true,
  payoutPreset: true,
  potCoins: true,
  fundedPrize: true,
  payoutCurve: true,
  maxDurationDays: true,
  isTeamRace: true,
  teamAName: true,
  teamBName: true,
};

const participantSelect = {
  id: true,
  raceId: true,
  userId: true,
  status: true,
  totalSteps: true,
  placement: true,
  lastNotifiedPlacement: true,
  placementAlertsMuted: true,
  finishedAt: true,
  forfeitedAt: true,
  joinedAt: true,
  team: true,
};

function planningFingerprint(race, participants) {
  const participantFacts = [...participants]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => [
      row.id,
      row.userId,
      row.status,
      row.totalSteps,
      row.placement,
      row.placementAlertsMuted,
      row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      row.forfeitedAt ? new Date(row.forfeitedAt).toISOString() : null,
      row.joinedAt ? new Date(row.joinedAt).toISOString() : null,
      row.team,
    ]);
  const raceFacts = [
    race.id,
    race.name,
    race.status,
    race.startedAt ? new Date(race.startedAt).toISOString() : null,
    race.endsAt ? new Date(race.endsAt).toISOString() : null,
    race.timezone,
    race.payoutPreset,
    race.potCoins,
    race.fundedPrize,
    race.payoutCurve ?? null,
    race.maxDurationDays,
    race.isTeamRace,
    race.teamAName,
    race.teamBName,
  ];
  return crypto.createHash("sha256")
    .update(JSON.stringify([raceFacts, participantFacts]))
    .digest("hex");
}

// Retained for callers that only need the historical accepted-roster/scoring
// digest. Placement persistence uses planningFingerprint so mute and payload
// facts are fenced too.
function rosterFingerprint(participants) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([...participants]
      .sort((left, right) => left.id.localeCompare(right.id))))
    .digest("hex");
}

function validateRoster(raceId, participants) {
  if (!Array.isArray(participants) || participants.length === 0) return false;
  const ids = new Set();
  for (const row of participants) {
    if (!row.id || ids.has(row.id) || row.raceId !== raceId || row.status !== "ACCEPTED") {
      return false;
    }
    ids.add(row.id);
  }
  return true;
}

function buildRacePlacementBaselineModel(prisma = defaultPrisma) {
  return {
    async loadCanonicalContext(raceId, tx = prisma) {
      const [race, participants] = await Promise.all([
        tx.race.findUnique({ where: { id: raceId }, select: raceSelect }),
        tx.raceParticipant.findMany({
          where: { raceId, status: "ACCEPTED" },
          select: participantSelect,
          orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        }),
      ]);
      if (!race) {
        return null;
      }
      if (race.status === "COMPLETED" || race.status === "CANCELLED") {
        return { race, participants: [], fingerprint: null, terminal: true };
      }
      if (race.status !== "ACTIVE" || !validateRoster(raceId, participants)) return null;
      return { race, participants, fingerprint: planningFingerprint(race, participants) };
    },

    async lockResolutionGeneration(tx, { raceId, generation }) {
      const rows = await tx.$queryRawUnsafe(
        `SELECT race_id AS "raceId", generation,
                processing_generation AS "processingGeneration", state,
                last_completed_at AS "lastCompletedAt"
           FROM race_resolution_jobs_v2
          WHERE race_id=$1
          FOR UPDATE`,
        raceId,
      );
      const row = rows[0];
      return !!row && row.state === "succeeded" && row.generation === generation &&
        row.processingGeneration === generation && row.lastCompletedAt != null;
    },

    async compareAndSetPage(tx, changes) {
      if (!changes.length) return new Set();
      const rows = await tx.$queryRawUnsafe(
        `WITH proposed AS (
           SELECT p."participantId", p."expectedPlacement", p."nextPlacement"
             FROM jsonb_to_recordset($1::jsonb) AS p(
               "participantId" text,
               "expectedPlacement" integer,
               "nextPlacement" integer
             )
         )
         UPDATE race_participants participant
            SET last_notified_placement=proposed."nextPlacement"
           FROM proposed
          WHERE participant.id=proposed."participantId"
            AND participant.last_notified_placement IS NOT DISTINCT FROM proposed."expectedPlacement"
         RETURNING participant.id`,
        JSON.stringify(changes.map((change) => ({
          participantId: change.participantId,
          expectedPlacement: change.expectedPlacement,
          nextPlacement: change.nextPlacement,
        }))),
      );
      return new Set(rows.map((row) => row.id));
    },
  };
}

const RacePlacementBaseline = buildRacePlacementBaselineModel();

module.exports = {
  rosterFingerprint,
  planningFingerprint,
  validateRoster,
  buildRacePlacementBaselineModel,
  RacePlacementBaseline,
};
