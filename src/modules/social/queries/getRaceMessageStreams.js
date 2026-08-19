const { prisma: defaultPrisma } = require("../../../db");
const { getRaceMessages: defaultGetRaceMessages } = require("./getRaceMessages");
const raceMessagesCache = require("../services/raceMessagesCache");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  isStrictFlagEnabled,
} = require("../../../shared/config/isStrictFlagEnabled");
const { Race: defaultRaceModel } = require("../../races/models/race");

function normalizeTopSnapshotLimit(raw) {
  if (raw == null || raw === "") return 50;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed === Number.NEGATIVE_INFINITY || parsed === 0) {
    return 50;
  }
  if (parsed === Number.POSITIVE_INFINITY) return 100;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

function buildGetRaceMessageStreams(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const getRaceMessages = dependencies.getRaceMessages || defaultGetRaceMessages;
  const logger = dependencies.logger || console;
  const cache = dependencies.raceMessagesCache || raceMessagesCache;
  const settings = dependencies.appSettings || defaultAppSettings;
  const raceModel = dependencies.Race || defaultRaceModel;

  async function getAccessContext(userId, raceId, leanAccessEnabled) {
    const race = leanAccessEnabled &&
        typeof raceModel.findMessageAccessContext === "function"
      ? await raceModel.findMessageAccessContext(raceId, userId)
      : await prisma.race.findUnique({
      where: { id: raceId },
      select: {
        id: true,
        seededBucketId: true,
        tournamentId: true,
        powerupsEnabled: true,
        participants: {
          select: {
            userId: true,
            status: true,
            user: { select: { displayName: true } },
          },
        },
        tournament: {
          select: {
            participants: {
              where: { userId, status: "ACCEPTED" },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!race) {
      const error = new Error("Race not found");
      error.statusCode = 404;
      throw error;
    }
    const mine = race.participants.find((participant) => participant.userId === userId);
    const directAccess =
      mine && (!race.seededBucketId || mine.status === "ACCEPTED");
    const tournamentAccess =
      race.tournamentId != null &&
      (race.tournament?.participants?.length || 0) > 0;
    if (!directAccess && !tournamentAccess) {
      const error = new Error("You are not a participant in this race");
      error.statusCode = 403;
      throw error;
    }
    return race;
  }

  async function getWatermark(raceId) {
    const enabled = await isStrictFlagEnabled(
      settings,
      "apiRaceChatWatermarkCacheV1Enabled"
    );
    return cache.getWatermark({ raceId, enabled });
  }

  return async function getRaceMessageStreams({
    userId,
    raceId,
    includeUser,
    limit,
  }) {
    const leanAccessEnabled = await isStrictFlagEnabled(
      settings,
      "raceMessageLeanAccessV1Enabled"
    );
    const accessContext = await getAccessContext(
      userId,
      raceId,
      leanAccessEnabled
    );
    const requested = { USER: includeUser, SYSTEM: true };
    const pageLimit = normalizeTopSnapshotLimit(limit);
    const userPromise = includeUser
      ? getRaceMessages(userId, raceId, {
          kind: "USER",
          limit: pageLimit,
          accessContext,
        })
      : getWatermark(raceId);
    const systemPromise = getRaceMessages(userId, raceId, {
      kind: "SYSTEM",
      limit: pageLimit,
      accessContext,
    });
    const [userResult, systemResult] = await Promise.allSettled([
      userPromise,
      systemPromise,
    ]);

    const userResolved = includeUser && userResult.status === "fulfilled";
    const systemResolved = systemResult.status === "fulfilled";
    let chatWatermark = null;
    let watermarkError = null;
    if (includeUser && userResolved) {
      const rows = userResult.value.messages;
      chatWatermark = {
        latestId: rows[0]?.id ?? null,
        latestAt: rows[0]?.createdAt ?? null,
        recentIds: rows.map((message) => message.id),
      };
    } else if (!includeUser && userResult.status === "fulfilled") {
      chatWatermark = userResult.value;
    } else {
      watermarkError = { code: "STREAM_UNAVAILABLE" };
    }

    if (userResult.status === "rejected") {
      logger.error?.("Race message USER stream unavailable", {
        error: userResult.reason?.message || "unknown",
      });
    }
    if (systemResult.status === "rejected") {
      logger.error?.("Race message SYSTEM stream unavailable", {
        error: systemResult.reason?.message || "unknown",
      });
    }

    const anyResolved =
      systemResolved || userResolved || (!includeUser && chatWatermark != null);
    if (!anyResolved) throw new Error("Race message streams unavailable");

    return {
      contract: "race-message-streams-v1",
      requested,
      resolved: { USER: userResolved, SYSTEM: systemResolved },
      streams: {
        USER: userResolved ? userResult.value : null,
        SYSTEM: systemResolved ? systemResult.value : null,
      },
      chatWatermark,
      watermarkError,
      errors: {
        USER:
          includeUser && !userResolved ? { code: "STREAM_UNAVAILABLE" } : null,
        SYSTEM: systemResolved ? null : { code: "STREAM_UNAVAILABLE" },
      },
    };
  };
}

const getRaceMessageStreams = buildGetRaceMessageStreams();

module.exports = {
  buildGetRaceMessageStreams,
  getRaceMessageStreams,
  normalizeTopSnapshotLimit,
};
