const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../../../shared/events/eventBus");
const { isTeamSideFull } = require("../teamRaces");
const {
  prisma: defaultPrisma,
  runInPrismaTransaction,
  deferUntilAfterCommit,
} = require("../../../db");
const { acquireRaceWriteFence } = require("../services/raceWriteFence");
const raceMessagesCache = require("../../social/services/raceMessagesCache");

// TR-203: free side switching while a team race is PENDING, subject to the
// per-side cap; locked once ACTIVE. Exposed as PUT /races/:raceId/team.
class RaceTeamSwitchError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = "RaceTeamSwitchError";
    if (statusCode) this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildSwitchRaceTeam(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const events = dependencies.eventBus || eventBus;
  const db = dependencies.prisma || defaultPrisma;
  const usesDefaultPersistence = !dependencies.Race && !dependencies.RaceParticipant;

  return async function switchRaceTeam({ userId, raceId, team }) {
    const mutate = async (tx = db) => {
    if (usesDefaultPersistence) await acquireRaceWriteFence(tx, raceId);
    const race = usesDefaultPersistence
      ? await tx.race.findUnique({ where: { id: raceId }, include: { participants: true } })
      : await raceModel.findById(raceId);
    if (!race) {
      throw new RaceTeamSwitchError("Race not found", 404);
    }
    if (!race.isTeamRace) {
      throw new RaceTeamSwitchError("This is not a team race", 400);
    }
    if (race.status !== "PENDING") {
      throw new RaceTeamSwitchError(
        "Sides are locked once the race starts",
        409,
        "RACE_ALREADY_STARTED"
      );
    }
    if (team !== "TEAM_A" && team !== "TEAM_B") {
      throw new RaceTeamSwitchError("Team must be TEAM_A or TEAM_B", 400);
    }

    const participant = usesDefaultPersistence
      ? race.participants.find((row) => row.userId === userId)
      : await participantModel.findByRaceAndUser(raceId, userId);
    if (!participant || participant.status !== "ACCEPTED") {
      throw new RaceTeamSwitchError("You are not in this race", 403);
    }
    if (participant.team === team) {
      return participant; // no-op: already on that side
    }
    // Cap check excludes the mover's own current slot (they vacate it).
    if (isTeamSideFull(race, team, { excludeUserId: userId })) {
      throw new RaceTeamSwitchError("That team is full", 409, "TEAM_FULL");
    }

    const updated = usesDefaultPersistence
      ? await tx.raceParticipant.update({ where: { id: participant.id }, data: { team } })
      : await participantModel.update(participant.id, { team });

    await deferUntilAfterCommit(() => events.emit("RACE_TEAM_SWITCHED", {
      raceId,
      userId,
      team,
    }));

    return updated;
    };
    const updated = usesDefaultPersistence
      ? await runInPrismaTransaction(mutate)
      : await mutate();
    await raceMessagesCache.invalidateRace(raceId);
    return updated;
  };
}

const switchRaceTeam = buildSwitchRaceTeam();

module.exports = { buildSwitchRaceTeam, switchRaceTeam, RaceTeamSwitchError };
