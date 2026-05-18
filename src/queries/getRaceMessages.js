const { Race } = require("../models/race");
const { RaceMessage } = require("../models/raceMessage");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { RacePowerupEvent } = require("../models/racePowerupEvent");

async function getRaceMessages(userId, raceId, { cursor, limit = 50 } = {}) {
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

  // Stealth: same redaction logic as feed
  const stealthedUserIds = new Set();
  if (race.powerupsEnabled) {
    const activeEffects = await RaceActiveEffect.findActiveForRace(raceId);
    for (const e of activeEffects) {
      if (e.type === "STEALTH_MODE" && e.targetUserId !== userId) {
        stealthedUserIds.add(e.targetUserId);
      }
    }
  }

  const stealthedNames = new Map();
  if (stealthedUserIds.size > 0) {
    for (const p of race.participants) {
      if (stealthedUserIds.has(p.userId) && p.user?.displayName) {
        stealthedNames.set(p.userId, p.user.displayName);
      }
    }
  }

  const fetchLimit = Math.max(limit, 50);
  const [userMessages, powerupEvents] = await Promise.all([
    RaceMessage.findByRace(raceId, { cursor, limit: fetchLimit }),
    RacePowerupEvent.findByRace(raceId, { cursor, limit: fetchLimit }),
  ]);

  const userItems = userMessages.map((m) => ({
    id: m.id,
    kind: "USER",
    body: m.body,
    senderId: m.senderId,
    senderName: m.sender?.displayName ?? null,
    senderPhotoUrl: m.sender?.profilePhotoUrl ?? null,
    createdAt: m.createdAt,
  }));

  const systemItems = powerupEvents.map((e) => {
    let description = e.description;
    if (stealthedUserIds.has(e.actorUserId)) {
      const realName = stealthedNames.get(e.actorUserId);
      if (realName && description.includes(realName)) {
        description = description.replaceAll(realName, "???");
      }
    }
    if (e.targetUserId && stealthedUserIds.has(e.targetUserId)) {
      const realName = stealthedNames.get(e.targetUserId);
      if (realName && description.includes(realName)) {
        description = description.replaceAll(realName, "???");
      }
    }
    return {
      id: `evt_${e.id}`,
      kind: "SYSTEM",
      body: description,
      eventType: e.eventType,
      powerupType: e.powerupType,
      actorUserId: e.actorUserId,
      targetUserId: e.targetUserId,
      createdAt: e.createdAt,
    };
  });

  const merged = [...userItems, ...systemItems].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const trimmed = merged.slice(0, limit);
  const nextCursor =
    trimmed.length === limit
      ? new Date(trimmed[trimmed.length - 1].createdAt).toISOString()
      : null;

  return { messages: trimmed, nextCursor };
}

module.exports = { getRaceMessages };
