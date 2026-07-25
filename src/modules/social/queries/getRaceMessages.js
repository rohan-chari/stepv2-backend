const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  isTournamentParticipant,
} = require("../../tournaments/services/tournamentAccess");

const CURSOR_VERSION = 1;
const KIND_RANK = { USER: 1, SYSTEM: 0 };

// SYSTEM powerup-event types that must never appear in the activity feed.
// Excluded at the DB-query level (Prisma notIn) so hidden rows don't consume
// page slots — the JS filter below is a belt-and-suspenders no-op.
//   * POWERUP_IMPOSTER — stealthy; never surfaced.
//   * MYSTERY_BOX_OPENED — box-content reveals + the fanny-pack auto-activate
//     audit rows (B1); audit-only, kept for the admin box-opener metric.
const HIDDEN_SYSTEM_EVENT_TYPES = ["POWERUP_IMPOSTER", "MYSTERY_BOX_OPENED"];

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function parseCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;

  try {
    const decoded = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    );
    if (
      decoded &&
      decoded.v === CURSOR_VERSION &&
      decoded.at &&
      decoded.kind &&
      decoded.id
    ) {
      return {
        createdAt: decoded.at,
        kind: decoded.kind,
        id: decoded.id,
      };
    }
  } catch {}

  const legacyDate = new Date(cursor);
  if (Number.isNaN(legacyDate.getTime())) return null;
  return { createdAt: legacyDate.toISOString(), kind: null, id: null };
}

function formatCursor(item) {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      at: new Date(item.createdAt).toISOString(),
      kind: item._cursorKind,
      id: item._cursorId,
    })
  ).toString("base64url");
}

function compareMessages(a, b) {
  const timeDiff = new Date(b.createdAt) - new Date(a.createdAt);
  if (timeDiff !== 0) return timeDiff;

  const rankDiff =
    (KIND_RANK[b._cursorKind] ?? 0) - (KIND_RANK[a._cursorKind] ?? 0);
  if (rankDiff !== 0) return rankDiff;

  return String(b._cursorId).localeCompare(String(a._cursorId));
}

function stripCursorFields(item) {
  const { _cursorKind, _cursorId, ...message } = item;
  return message;
}

function buildGetRaceMessages(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const raceMessageModel = dependencies.RaceMessage || RaceMessage;
  const raceActiveEffectModel =
    dependencies.RaceActiveEffect || RaceActiveEffect;
  const racePowerupEventModel =
    dependencies.RacePowerupEvent || RacePowerupEvent;

  return async function getRaceMessages(
    userId,
    raceId,
    { cursor, limit = 50, kind } = {}
  ) {
    const pageLimit = normalizeLimit(limit);
    const parsedCursor = parseCursor(cursor);
    // Backward compatible: omitted/invalid kind => merged feed (USER + SYSTEM).
    const normalizedKind =
      kind === "USER" || kind === "SYSTEM" ? kind : null;
    const includeUser = normalizedKind !== "SYSTEM";
    const includeSystem = normalizedKind !== "USER";
    const race = await raceModel.findById(raceId);
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }

    const myParticipant = race.participants.find((p) => p.userId === userId);
    if (!myParticipant) {
      // 2026-07-25 §5 — tournament spectating, identical to the relaxation
      // getRaceDetails/getRaceProgress already apply: any ACCEPTED bracket
      // player (INCLUDING eliminated) may READ a sibling matchup's chat.
      // READ ONLY — sendRaceMessage/deleteRaceMessage are untouched. The stealth
      // redaction below is keyed on `targetUserId !== userId`, so a spectator
      // (never the stealthed user) is redacted exactly like any other viewer.
      const canSpectate =
        race.tournamentId != null &&
        (await isTournamentParticipant(race.tournamentId, userId));
      if (!canSpectate) {
        const error = new Error("You are not a participant in this race");
        error.statusCode = 403;
        throw error;
      }
    }

    // Stealth: same redaction logic as feed (only relevant when SYSTEM items
    // are included, since redaction is applied to event descriptions).
    const stealthedUserIds = new Set();
    if (includeSystem && race.powerupsEnabled) {
      const activeEffects = await raceActiveEffectModel.findActiveForRace(
        raceId
      );
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

    const fetchLimit = pageLimit + 1;
    const [userMessages, powerupEvents] = await Promise.all([
      includeUser
        ? raceMessageModel.findByRace(raceId, {
            cursor: parsedCursor,
            limit: fetchLimit,
          })
        : Promise.resolve([]),
      includeSystem
        ? racePowerupEventModel.findByRace(raceId, {
            cursor: parsedCursor,
            limit: fetchLimit,
            // Hidden SYSTEM event types are excluded at the DB level so they
            // never occupy a page slot (keeps pagination full — see model).
            // POWERUP_IMPOSTER: stealthy. MYSTERY_BOX_OPENED: box-reveal +
            // fanny-pack auto-activate audit rows (B1) — audit-only, must never
            // surface what a box contained.
            excludeEventTypes: HIDDEN_SYSTEM_EVENT_TYPES,
          })
        : Promise.resolve([]),
    ]);

    const userItems = userMessages.map((m) => ({
      id: m.id,
      kind: "USER",
      body: m.body,
      senderId: m.senderId,
      senderName: m.sender?.displayName ?? null,
      senderPhotoUrl: m.sender?.profilePhotoUrl ?? null,
      createdAt: m.createdAt,
      _cursorKind: "USER",
      _cursorId: m.id,
    }));

    const systemItems = powerupEvents
      // Belt-and-suspenders: these are already excluded at the DB level
      // (excludeEventTypes -> notIn); the JS filter is a redundant no-op that
      // keeps the feed safe even if the model call is ever changed.
      .filter((e) => !HIDDEN_SYSTEM_EVENT_TYPES.includes(e.eventType))
      .map((e) => {
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
        _cursorKind: "SYSTEM",
        _cursorId: e.id,
      };
    });

    const merged = [...userItems, ...systemItems].sort(compareMessages);
    const trimmed = merged.slice(0, pageLimit);
    const nextCursor =
      merged.length > pageLimit
        ? formatCursor(trimmed[trimmed.length - 1])
        : null;

    return { messages: trimmed.map(stripCursorFields), nextCursor };
  };
}

const getRaceMessages = buildGetRaceMessages();

module.exports = { buildGetRaceMessages, getRaceMessages };
