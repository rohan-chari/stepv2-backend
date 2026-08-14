const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const {
  isTournamentParticipant,
} = require("../../tournaments/services/tournamentAccess");
const raceMessagesCache = require("../services/raceMessagesCache");
const userPresentationCache = require("../services/userPresentationCache");
const { appSettings } = require("../../../shared/config/appSettings");

const CURSOR_VERSION = 1;
const KIND_RANK = { USER: 1, SYSTEM: 0 };

// SYSTEM powerup-event types that must never appear in the activity feed.
// Excluded at the DB-query level (Prisma notIn) so hidden rows don't consume
// page slots — the JS filter below is a belt-and-suspenders no-op.
//   * POWERUP_IMPOSTER — stealthy; never surfaced.
//   * MYSTERY_BOX_OPENED — box-content reveals + the fanny-pack auto-activate
//     audit rows (B1); audit-only, kept for the admin box-opener metric.
//   * POWERUP_REROLLED — batch 2026-08-08 item 11; the ad-funded reroll audit
//     row, which names the new result and so must stay as hidden as the open
//     it replaces. Mirrored in races/queries/getRaceFeed.js.
const HIDDEN_SYSTEM_EVENT_TYPES = [
  "POWERUP_IMPOSTER",
  "MYSTERY_BOX_OPENED",
  "POWERUP_REROLLED",
];

const WELCOME_MYSTERY_BOX_DESCRIPTIONS = new Set([
  "Welcome gift. A mystery box!",
  "Welcome gift — a mystery box!",
]);

// A previously populated Redis list can outlive this deployment briefly. Keep
// this defensive filter so those rows never render; the DB predicate below is
// still required to keep fresh pages full.
function isHiddenSystemEvent(event) {
  return HIDDEN_SYSTEM_EVENT_TYPES.includes(event.eventType) ||
    (event.eventType === "POWERUP_EARNED" &&
      event.powerupType === "MYSTERY_BOX" &&
      WELCOME_MYSTERY_BOX_DESCRIPTIONS.has(event.description));
}

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
    { cursor, limit = 50, kind, accessContext = null } = {}
  ) {
    // Flag read is defensive: a settings failure must degrade to "no cache",
    // never to a 500 on the busiest endpoint in the product.
    let cacheEnabled = false;
    if (!dependencies.RaceMessage && !dependencies.RacePowerupEvent) {
      // Injected models mean a unit test with fakes — the cache would read
      // straight past them, so it stays off in that configuration.
      try {
        cacheEnabled =
          (await appSettings.getFlag("redisCacheMessagesEnabled")) === true;
      } catch {
        cacheEnabled = false;
      }
    }

    const pageLimit = normalizeLimit(limit);
    const parsedCursor = parseCursor(cursor);
    // Backward compatible: omitted/invalid kind => merged feed (USER + SYSTEM).
    const normalizedKind =
      kind === "USER" || kind === "SYSTEM" ? kind : null;
    const includeUser = normalizedKind !== "SYSTEM";
    const includeSystem = normalizedKind !== "USER";
    const race = accessContext || (await raceModel.findById(raceId));
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }

    const myParticipant = race.participants.find((p) => p.userId === userId);
    if (!accessContext && (!myParticipant || (race.seededBucketId && myParticipant.status !== "ACCEPTED"))) {
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

    // C2 (spec §5 Phase C): only the exact default shape may be served from the
    // cache. A cursor, a non-50 limit, or the merged (no-`kind`) feed bypasses
    // entirely — caching unbounded query variants was explicitly rejected.
    const cacheable =
      cacheEnabled && raceMessagesCache.isCacheableShape({ cursor, limit, kind });

    const fetchLimit = pageLimit + 1;
    const [userMessages, powerupEvents] = await Promise.all([
      includeUser
        ? cacheable
          ? (
              await raceMessagesCache.getRows({
                raceId,
                kind: "USER",
                enabled: true,
              })
            ).rows
          : raceMessageModel.findByRace(raceId, {
              cursor: parsedCursor,
              limit: fetchLimit,
            })
        : Promise.resolve([]),
      includeSystem
        ? cacheable
          ? (
              await raceMessagesCache.getRows({
                raceId,
                kind: "SYSTEM",
                enabled: true,
                hiddenSystemEventTypes: HIDDEN_SYSTEM_EVENT_TYPES,
              })
            ).rows
          : racePowerupEventModel.findByRace(raceId, {
              cursor: parsedCursor,
              limit: fetchLimit,
              // Hidden SYSTEM event types are excluded at the DB level so they
              // never occupy a page slot (keeps pagination full — see model).
              // POWERUP_IMPOSTER: stealthy. MYSTERY_BOX_OPENED: box-reveal +
              // fanny-pack auto-activate audit rows (B1) — audit-only, must never
              // surface what a box contained.
              excludeEventTypes: HIDDEN_SYSTEM_EVENT_TYPES,
              // Welcome grants are onboarding gifts, not race activity. This is
              // query-level so they cannot consume a page slot.
              excludeWelcomeMysteryBoxEvents: true,
            })
        : Promise.resolve([]),
    ]);

    // Sender presentation is joined HERE, per request, from the per-user cache
    // (spec §3: "cosmetics are NOT embedded; they hydrate at read time"). The
    // cached rows carry `senderId` only, so a rename/equip/photo change
    // propagates into every race's chat without touching a single message list.
    //
    // The uncached path still carries a hydrated `sender` relation, so it is
    // used directly and this lookup is skipped — keeping the two paths
    // byte-identical rather than merely equivalent.
    let presentation = null;
    if (cacheable && includeUser && userMessages.length > 0) {
      presentation = await userPresentationCache.getMany(
        userMessages.map((m) => m.senderId),
        true
      );
    }

    const userItems = userMessages.map((m) => {
      // A sender whose account was deleted: `deleteUserAccount` nulls
      // `race_messages.sender_id`, so Postgres would report no sender at all.
      // A cached row still holds the old id, so a MISSING user row must produce
      // exactly the same null triple rather than a dangling id.
      let senderId = m.senderId;
      let senderName;
      let senderPhotoUrl;
      if (presentation) {
        const p = senderId ? presentation.get(senderId) : null;
        if (senderId && p === null) senderId = null;
        senderName = p?.displayName ?? null;
        senderPhotoUrl = p?.profilePhotoUrl ?? null;
      } else {
        senderName = m.sender?.displayName ?? null;
        senderPhotoUrl = m.sender?.profilePhotoUrl ?? null;
      }
      return {
        id: m.id,
        kind: "USER",
        body: m.body,
        senderId,
        senderName,
        senderPhotoUrl,
        createdAt: m.createdAt,
        _cursorKind: "USER",
        _cursorId: m.id,
      };
    });

    const systemItems = powerupEvents
      // Belt-and-suspenders: these are already excluded at the DB level
      // (excludeEventTypes -> notIn); the JS filter is a redundant no-op that
      // keeps the feed safe even if the model call is ever changed.
      .filter((e) => !isHiddenSystemEvent(e))
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
