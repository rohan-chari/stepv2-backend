const { prisma: defaultPrisma } = require("../../../db");
const { Race: defaultRace } = require("../models/race");
const { isTournamentParticipant } = require("../../tournaments/services/tournamentAccess");

const POWERUP_TITLES = Object.freeze({
  LEG_CRAMP: "Leg Cramp", QUICKSAND: "Quicksand", RUNNERS_HIGH: "Runner’s High",
  WRONG_TURN: "Wrong Turn", CAMPFIRE_REST: "Campfire Rest", RAINSTORM: "Rainstorm",
  LEECH: "Leech", UPRISING: "Uprising", RALLY_FLAG: "Rally Flag",
  COIN_FLIP: "Coin Flip", GHOST_PEPPER: "Ghost Pepper", HITCHHIKE: "Hitchhike",
  UMBRELLA: "Umbrella", DRILL_SERGEANT: "Drill Sergeant",
});

function impactTitle(powerupType) {
  return POWERUP_TITLES[powerupType] || String(powerupType || "Effect")
    .toLowerCase().split("_").map((part) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
}

async function resolveRaceImpactAccess({ userId, raceId, prisma = defaultPrisma, Race = defaultRace }) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found"); error.statusCode = 404; error.code = "RACE_NOT_FOUND"; throw error;
  }
  const participant = race.participants?.find((row) => row.userId === userId && row.status === "ACCEPTED");
  if (participant) return { race, spectator: false };
  if (race.tournamentId && await isTournamentParticipant(race.tournamentId, userId)) {
    return { race, spectator: true };
  }
  const error = new Error("You are not a participant in this race"); error.statusCode = 403; error.code = "NOT_RACE_PARTICIPANT"; throw error;
}

async function getImpactNotices({ userId, raceId, prisma = defaultPrisma, Race = defaultRace }) {
  const access = await resolveRaceImpactAccess({ userId, raceId, prisma, Race });
  if (access.spectator) return [];
  return prisma.raceEffectImpact.findMany({
    where: { raceId, userId, acknowledgedAt: null },
    select: { id: true, powerupType: true, deltaSteps: true, settledAt: true },
    orderBy: [{ settledAt: "asc" }, { id: "asc" }],
  });
}

async function acknowledgeImpactNotice({ userId, raceId, noticeId, prisma = defaultPrisma }) {
  const result = await prisma.raceEffectImpact.updateMany({
    where: { id: noticeId, raceId, userId }, data: { acknowledgedAt: new Date() },
  });
  return result.count === 1;
}

module.exports = { resolveRaceImpactAccess, getImpactNotices, acknowledgeImpactNotice, impactTitle };
