const { Race } = require("../../races/models/race");
const { RaceMessage } = require("../models/raceMessage");
const { censor } = require("../../../shared/lib/profanity");
const { prisma: defaultPrisma, runInPrismaTransaction } = require("../../../db");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const { acquireRaceWriteFence } = require("../../races/services/raceWriteFence");

const MAX_BODY_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 5;

const raceMessagesCache = require("../services/raceMessagesCache");

class RaceMessageError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.name = "RaceMessageError";
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

function buildSendRaceMessage(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const raceMessageModel = dependencies.RaceMessage || RaceMessage;
  const censorFn = dependencies.censor || censor;
  const compatibilityEvents = dependencies.eventBus || null;
  const db = dependencies.prisma || defaultPrisma;
  const appendDomainEvent = dependencies.appendDomainEvent ||
    (Object.keys(dependencies).length > 0 ? async () => null : defaultAppendDomainEvent);
  const usesDefaultPersistence = !dependencies.RaceMessage;
  const now = dependencies.now || Date.now;

  return async function sendRaceMessage({
    userId,
    raceId,
    body,
    audience = "ALL",
    teamChatCapable = false,
  }) {
    if (typeof body !== "string") {
      throw new RaceMessageError("Message body is required");
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new RaceMessageError("Message cannot be empty");
    }
    if (trimmed.length > MAX_BODY_LENGTH) {
      throw new RaceMessageError(`Message too long (max ${MAX_BODY_LENGTH})`);
    }

    if (audience !== "ALL" && audience !== "TEAM") {
      throw new RaceMessageError("Audience must be ALL or TEAM", 400, "INVALID_REQUEST");
    }
    if (audience === "TEAM" && teamChatCapable !== true) {
      throw new RaceMessageError(
        "Update the app to use team chat.",
        400,
        "UPDATE_REQUIRED",
      );
    }

    const race = await raceModel.findById(raceId);
    if (!race) throw new RaceMessageError("Race not found", 404);

    if (race.status === "COMPLETED" || race.status === "CANCELLED") {
      throw new RaceMessageError("Chat is closed for this race", 403);
    }

    const participant = race.participants.find((p) => p.userId === userId);
    if (!participant) {
      throw new RaceMessageError("You are not a participant in this race", 403);
    }
    if (participant.status !== "ACCEPTED") {
      throw new RaceMessageError("Only accepted participants can post", 403);
    }
    if (
      audience === "TEAM" &&
      (!race.isTeamRace || race.status !== "ACTIVE" || participant.forfeitedAt ||
        (participant.team !== "TEAM_A" && participant.team !== "TEAM_B"))
    ) {
      throw new RaceMessageError(
        "Team chat is unavailable.",
        403,
        "TEAM_CHAT_UNAVAILABLE",
      );
    }

    const since = new Date(now() - RATE_LIMIT_WINDOW_MS);
    const recentCount = await raceMessageModel.countSentBySenderSince(
      userId,
      raceId,
      since
    );
    if (recentCount >= RATE_LIMIT_MAX) {
      throw new RaceMessageError("Slow down. Too many messages", 429);
    }

    const cleaned = censorFn(trimmed);

    const current = new Date(now());
    const createMessage = async (tx) => {
      let lockedRace = race;
      let lockedParticipant = participant;
      if (usesDefaultPersistence && audience === "TEAM") {
        await acquireRaceWriteFence(tx, raceId);
        lockedRace = await tx.race.findUnique({
          where: { id: raceId },
          include: { participants: true },
        });
        lockedParticipant = lockedRace?.participants.find((p) => p.userId === userId);
        if (
          !lockedRace?.isTeamRace || lockedRace.status !== "ACTIVE" ||
          lockedParticipant?.status !== "ACCEPTED" || lockedParticipant.forfeitedAt ||
          !["TEAM_A", "TEAM_B"].includes(lockedParticipant.team)
        ) {
          throw new RaceMessageError(
            "Team chat is unavailable.",
            403,
            "TEAM_CHAT_UNAVAILABLE",
          );
        }
      }
      const message = usesDefaultPersistence
        ? await tx.raceMessage.create({
            data: {
              raceId,
              senderId: userId,
              body: cleaned,
              kind: "USER",
              audience,
              team: audience === "TEAM" ? lockedParticipant.team : null,
            },
            include: {
              sender: { select: { id: true, displayName: true, profilePhotoUrl: true } },
            },
          })
        : await raceMessageModel.create({
            raceId,
            senderId: userId,
            body: cleaned,
            kind: "USER",
            ...(audience === "TEAM"
              ? { audience: "TEAM", team: lockedParticipant.team }
              : {}),
          });
      if (usesDefaultPersistence) {
        const recipients = await tx.raceParticipant.findMany({
          where: {
            raceId,
            status: "ACCEPTED",
            userId: { not: userId },
            chatMuted: false,
            forfeitedAt: null,
            ...(audience === "TEAM" ? { team: lockedParticipant.team } : {}),
          },
          select: { userId: true },
          orderBy: { userId: "asc" },
        });
        await appendDomainEvent(tx, {
          eventKey: `RACE_MESSAGE_SENT_V1:${message.id}`,
          eventType: "RACE_MESSAGE_SENT_V1", schemaVersion: 1,
          aggregateType: "RACE_MESSAGE", aggregateId: message.id,
          occurredAt: message.createdAt || current,
          payload: {
            raceId, messageId: message.id, senderId: userId,
            senderName: message.sender?.displayName ?? null,
            body: cleaned,
            raceName: lockedRace.name,
            audience,
            team: audience === "TEAM" ? lockedParticipant.team : null,
          },
          audience: recipients.map((row) => ({
            recipientId: row.userId,
            facts: {
              audience,
              ...(audience === "TEAM" ? { team: lockedParticipant.team } : {}),
            },
          })),
        });
      }
      return message;
    };
    const message = usesDefaultPersistence
      ? await runInPrismaTransaction(createMessage)
      : await createMessage(db);

    // C2 invalidation (spec §5 Phase C): AFTER the Postgres commit, one atomic
    // Lua `SET msgver <durable marker>` + `DEL list`. The command never writes
    // the new message INTO the cache — a DEL+push race would leave a list
    // containing only the new entry (§3 "Write paths never write caches").
    await raceMessagesCache.invalidateKind(
      raceId,
      "USER",
      message,
      audience,
      audience === "TEAM" ? message.team : null,
    );

    if (!usesDefaultPersistence) compatibilityEvents?.emit("RACE_MESSAGE_SENT", {
      raceId,
      messageId: message.id,
      senderId: userId,
      body: cleaned,
      senderName: message.sender?.displayName ?? null,
      raceName: race.name,
    });

    return message;
  };
}

const sendRaceMessage = buildSendRaceMessage();

module.exports = { buildSendRaceMessage, sendRaceMessage, RaceMessageError };
