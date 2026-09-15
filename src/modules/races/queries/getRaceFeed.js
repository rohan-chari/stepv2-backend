const { Race } = require("../models/race");
const { prisma } = require("../../../db");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  isTournamentParticipant,
} = require("../../tournaments/services/tournamentAccess");
const {
  sanitizeDisplayNameSnapshots,
} = require("../../../shared/lib/displayNameValidator");

async function getRaceFeed(userId, raceId, { cursor, limit = 50, supportsPowerups4 = false } = {}) {
  const race = typeof Race.findFeedAccess === "function"
    ? await Race.findFeedAccess(raceId, userId)
    : await Race.findById(raceId);
  if (!race) {
    const error = new Error("Race not found");
    error.statusCode = 404;
    throw error;
  }

  const myParticipant = race.participants.find((p) => p.userId === userId);
  if (!myParticipant || (race.seededBucketId && myParticipant.status !== "ACCEPTED")) {
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

  // Event descriptions snapshot names in prose, so keep the raw lookup long
  // enough to replace both stealthed and legacy-profane principals safely.
  const rawEvents = await RacePowerupEvent.findByRace(raceId, {
    cursor,
    limit,
    excludeWelcomeMysteryBoxEvents: true,
    excludeHiddenFromFeedEvents: true,
  });

  // Durable descriptions can name principals who are not the viewer. Fetch
  // only those race members, rather than hydrating the complete roster and
  // cosmetic graph before the event page is known.
  const namedPrincipalIds = new Set();
  for (const event of rawEvents) {
    for (const id of [
      event.actorUserId,
      event.targetUserId,
      event.metadata?.attackerUserId,
      event.metadata?.decoyOwnerUserId,
      event.metadata?.redirectedUserId,
    ].filter(Boolean)) {
      namedPrincipalIds.add(id);
    }
  }
  const participantNames = new Map();
  if (namedPrincipalIds.size > 0) {
    const namedParticipants = await prisma.raceParticipant.findMany({
      where: { raceId, userId: { in: [...namedPrincipalIds] } },
      select: { userId: true, user: { select: { displayName: true } } },
    });
    for (const participant of namedParticipants) {
      if (participant.user?.displayName) {
        participantNames.set(participant.userId, participant.user.displayName);
      }
    }
  }

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
  const events = rawEvents.filter(
    (e) =>
      !HIDDEN_FEED_EVENT_TYPES.has(e.eventType) &&
      e.metadata?.hiddenFromFeed !== true &&
      // Compatibility for plant rows written before hiddenFromFeed. A
      // detonation has mineId/penalty metadata and remains visible.
      !(
        e.eventType === "POWERUP_USED" &&
        e.powerupType === "TRAIL_MINE" &&
        e.metadata?.ownerParticipantId != null
      )
  );

  return {
    events: events.map((e) => {
      let description = e.description;
      if (e.powerupType === "QUICKSAND" && !supportsPowerups4) {
        description = e.eventType === "POWERUP_EXPIRED"
          ? "A freezing effect wore off."
          : "A freezing attack affected one or more runners.";
      }

      // Redact every principal named by the durable event, including additive
      // Decoy metadata whose attacker is neither the top-level actor nor target.
      const namedPrincipalIds = new Set([
        e.actorUserId,
        e.targetUserId,
        e.metadata?.attackerUserId,
        e.metadata?.decoyOwnerUserId,
        e.metadata?.redirectedUserId,
      ].filter(Boolean));
      description = sanitizeDisplayNameSnapshots(
        description,
        namedPrincipalIds,
        participantNames,
        stealthedUserIds,
      );

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
