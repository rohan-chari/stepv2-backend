"use strict";

// Test-only dependency replacements for the three real race routes. The
// router and its handlers remain production code; only the injected query
// functions are prototype candidates.
const { isVisiblePowerupInventoryRow } = require("../../src/modules/powerups/powerupRetirement");
const { Race } = require("../../src/modules/races/models/race");
const { RacePowerup } = require("../../src/modules/powerups/models/racePowerup");
const { RacePowerupEvent } = require("../../src/modules/powerups/models/racePowerupEvent");
const { RaceActiveEffect } = require("../../src/modules/powerups/models/raceActiveEffect");
const { isTournamentParticipant } = require("../../src/modules/tournaments/services/tournamentAccess");
const { sanitizeDisplayNameSnapshots } = require("../../src/shared/lib/displayNameValidator");

const ACCESS_RACE_SELECT = {
  id: true,
  status: true,
  seededBucketId: true,
  tournamentId: true,
  powerupsEnabled: true,
};

const VIEWER_PARTICIPANT_SELECT = {
  id: true,
  userId: true,
  status: true,
};

const FEED_PARTICIPANT_SELECT = {
  userId: true,
  user: { select: { displayName: true } },
};

function accessError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function findAccess(prisma, raceId, userId) {
  return prisma.race.findUnique({
    where: { id: raceId },
    select: {
      ...ACCESS_RACE_SELECT,
      participants: {
        where: { userId },
        select: VIEWER_PARTICIPANT_SELECT,
        take: 1,
      },
    },
  });
}

function acceptedOrSeededDenied(race, participant) {
  return !participant || (race.seededBucketId && participant.status !== "ACCEPTED");
}

function buildAuthorizationCandidates({ prisma, broad = false } = {}) {
  async function getRaceInventory(userId, raceId, supportsPowerups4 = false) {
    const race = broad
      ? await Race.findById(raceId)
      : await findAccess(prisma, raceId, userId);
    if (!race) throw accessError("Race not found", 404);
    const [myParticipant] = race.participants;
    if (acceptedOrSeededDenied(race, myParticipant)) {
      throw accessError("You are not a participant in this race", 403);
    }
    const [held, mysteryBoxes] = await Promise.all([
      RacePowerup.findHeldByParticipant(myParticipant.id),
      RacePowerup.findMysteryBoxesByParticipant(myParticipant.id),
    ]);
    return {
      inventory: held
        .filter((p) => isVisiblePowerupInventoryRow(p) && (supportsPowerups4 || p.type !== "QUICKSAND"))
        .map((p) => ({ id: p.id, type: p.type, rarity: p.rarity, earnedAtSteps: p.earnedAtSteps, createdAt: p.createdAt })),
      mysteryBoxes: mysteryBoxes.map((p) => ({ id: p.id })),
    };
  }

  async function getRaceFeed(userId, raceId, { cursor, limit = 50, supportsPowerups4 = false } = {}) {
    const race = broad
      ? await Race.findById(raceId)
      : await findAccess(prisma, raceId, userId);
    if (!race) throw accessError("Race not found", 404);
    const [myParticipant] = race.participants;
    if (acceptedOrSeededDenied(race, myParticipant)) {
      const canSpectate = race.tournamentId != null && await isTournamentParticipant(race.tournamentId, userId);
      if (!canSpectate) throw accessError("You are not a participant in this race", 403);
    }

    const stealthedUserIds = new Set();
    if (race.powerupsEnabled) {
      const activeEffects = await RaceActiveEffect.findActiveForRace(raceId);
      for (const effect of activeEffects) {
        if (effect.type === "STEALTH_MODE" && effect.targetUserId !== userId) stealthedUserIds.add(effect.targetUserId);
      }
    }
    const rawEvents = await RacePowerupEvent.findByRace(raceId, {
      cursor,
      limit,
      excludeWelcomeMysteryBoxEvents: true,
      excludeHiddenFromFeedEvents: true,
    });
    const namedPrincipalIds = new Set();
    for (const event of rawEvents) {
      for (const id of [event.actorUserId, event.targetUserId, event.metadata?.attackerUserId, event.metadata?.decoyOwnerUserId, event.metadata?.redirectedUserId]) {
        if (id) namedPrincipalIds.add(id);
      }
    }
    namedPrincipalIds.add(userId);
    const names = broad
      ? race.participants
      : await prisma.raceParticipant.findMany({
          where: { raceId, userId: { in: [...namedPrincipalIds] } },
          select: FEED_PARTICIPANT_SELECT,
        });
    const participantNames = new Map(names.map((p) => [p.userId, p.user?.displayName]).filter(([, name]) => name));
    const hidden = new Set(["MYSTERY_BOX_OPENED", "POWERUP_REROLLED"]);
    const events = rawEvents.filter((event) =>
      !hidden.has(event.eventType) &&
      event.metadata?.hiddenFromFeed !== true &&
      !(event.eventType === "POWERUP_USED" && event.powerupType === "TRAIL_MINE" && event.metadata?.ownerParticipantId != null)
    );
    return {
      events: events.map((event) => {
        let description = event.description;
        if (event.powerupType === "QUICKSAND" && !supportsPowerups4) {
          description = event.eventType === "POWERUP_EXPIRED"
            ? "A freezing effect wore off."
            : "A freezing attack affected one or more runners.";
        }
        const ids = new Set([event.actorUserId, event.targetUserId, event.metadata?.attackerUserId, event.metadata?.decoyOwnerUserId, event.metadata?.redirectedUserId].filter(Boolean));
        description = sanitizeDisplayNameSnapshots(description, ids, participantNames, stealthedUserIds);
        return {
          id: event.id,
          eventType: event.eventType,
          powerupType: event.powerupType === "QUICKSAND" && !supportsPowerups4 ? "LEG_CRAMP" : event.powerupType,
          description,
          actorUserId: event.actorUserId,
          targetUserId: event.targetUserId,
          metadata: event.metadata,
          createdAt: event.createdAt,
        };
      }),
      nextCursor: rawEvents.length === limit ? rawEvents[rawEvents.length - 1].createdAt.toISOString() : null,
    };
  }

  return { getRaceFeed, getRaceInventory };
}

module.exports = { buildAuthorizationCandidates };
