const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  isTournamentParticipant,
} = require("../../tournaments/services/tournamentAccess");

async function getRaceFeed(userId, raceId, { cursor, limit = 50, supportsPowerups4 = false } = {}) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    // 2026-07-25 §5 — tournament spectating, identical to the relaxation
    // getRaceDetails/getRaceProgress already apply: any ACCEPTED bracket player
    // (INCLUDING eliminated) may READ a matchup race they aren't in. READ ONLY —
    // sendRaceMessage/deleteRaceMessage are untouched and stay participant-only.
    // Non-tournament races and users with no bracket relation still 403.
    const canSpectate =
      race.tournamentId != null &&
      (await isTournamentParticipant(race.tournamentId, userId));
    if (!canSpectate) {
      const error = new Error("You are not a participant in this race");
      error.statusCode = 403;
      throw error;
    }
  }

  // Build set of stealthed user IDs (exclude self — you can see your own name)
  const stealthedUserIds = new Set();
  if (race.powerupsEnabled) {
    const activeEffects = await RaceActiveEffect.findActiveForRace(raceId);
    for (const e of activeEffects) {
      if (e.type === "STEALTH_MODE" && e.targetUserId !== userId) {
        stealthedUserIds.add(e.targetUserId);
      }
    }
  }

  // Build name lookup for stealthed users
  const stealthedNames = new Map();
  if (stealthedUserIds.size > 0) {
    for (const p of race.participants) {
      if (stealthedUserIds.has(p.userId) && p.user?.displayName) {
        stealthedNames.set(p.userId, p.user.displayName);
      }
    }
  }

  const rawEvents = await RacePowerupEvent.findByRace(raceId, { cursor, limit });

  // MYSTERY_BOX_OPENED rows are persisted only for the admin box-opener metric
  // (Item 9). They are audit-only — hide them from the visible feed so the
  // frequent box opens don't bury the powerup-use activity. Filtered post-query
  // so paging cursors (createdAt of the last raw row) stay stable.
  //
  // POWERUP_REROLLED (batch 2026-08-08 item 11) is hidden for the same reason
  // AND a stronger one: it names the rerolled result, which would leak box
  // contents the open path deliberately conceals. Keep this list in lockstep
  // with HIDDEN_SYSTEM_EVENT_TYPES in social/queries/getRaceMessages.js.
  const HIDDEN_FEED_EVENT_TYPES = new Set([
    "MYSTERY_BOX_OPENED",
    "POWERUP_REROLLED",
  ]);
  const events = rawEvents.filter((e) => !HIDDEN_FEED_EVENT_TYPES.has(e.eventType));

  return {
    events: events.map((e) => {
      let description = e.description;
      if (e.powerupType === "QUICKSAND" && !supportsPowerups4) {
        description = e.eventType === "POWERUP_EXPIRED"
          ? "A freezing effect wore off."
          : "A freezing attack affected one or more runners.";
      }

      // Replace stealthed actor's name with ???
      if (stealthedUserIds.has(e.actorUserId)) {
        const realName = stealthedNames.get(e.actorUserId);
        if (realName && description.includes(realName)) {
          description = description.replaceAll(realName, "???");
        }
      }

      // Replace stealthed target's name with ???
      if (e.targetUserId && stealthedUserIds.has(e.targetUserId)) {
        const realName = stealthedNames.get(e.targetUserId);
        if (realName && description.includes(realName)) {
          description = description.replaceAll(realName, "???");
        }
      }

      return {
        id: e.id,
        eventType: e.eventType,
        powerupType: e.powerupType === "QUICKSAND" && !supportsPowerups4 ? "LEG_CRAMP" : e.powerupType,
        description,
        actorUserId: e.actorUserId,
        targetUserId: e.targetUserId,
        metadata: e.metadata,
        createdAt: e.createdAt,
      };
    }),
    // Paging is driven by the RAW page size (before the audit-row filter) so a
    // page that was full at the DB still advances the cursor correctly.
    nextCursor:
      rawEvents.length === limit
        ? rawEvents[rawEvents.length - 1].createdAt.toISOString()
        : null,
  };
}

module.exports = { getRaceFeed };
