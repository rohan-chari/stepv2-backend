const { Race } = require("../models/race");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");

async function getRaceFeed(userId, raceId, { cursor, limit = 50 } = {}) {
  const race = await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant) {
    const error = new Error("You are not a participant in this race");
    error.statusCode = 403;
    throw error;
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
  const events = rawEvents.filter((e) => e.eventType !== "MYSTERY_BOX_OPENED");

  return {
    events: events.map((e) => {
      let description = e.description;

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
        powerupType: e.powerupType,
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
