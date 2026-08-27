const cacheKeys = require("../../../shared/cache/cacheKeys");
const defaultRedisCache = require("../../../shared/cache/redisCache");
const defaultDerivedCache = require("../../../shared/cache/derivedCache");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");
const { RaceParticipant: defaultRaceParticipant } = require("../models/raceParticipant");

const CACHE_VERSION = 1;
const MAX_RACES = 128;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const TTL_SECONDS = Object.freeze({
  membership: 30,
  completed: 300,
  pending: 15,
});
const locallyStaleUsers = new Set();

const CHANNELS = new Set(["prod", "testflight"]);
// This is the field audit for the fragment boundary. Stable fields are copied
// into Redis; per-user and live fields are deliberately rebuilt by getRaces.
// Route-added fields (tournaments, nextRace, payoutDoubleOffer, and review
// prompts) are not part of any fragment and remain request-time reads.
const FIELD_CLASSIFICATION = Object.freeze({
  stable: Object.freeze([
    "id", "creatorId", "seedId", "name", "targetSteps", "status",
    "maxDurationDays", "buyInAmount", "payoutPreset", "potCoins",
    "fundedPrize", "prizePoolCoins", "prizeCoinUnit", "prizePoolMaxCoins",
    "prizeCalculationVersion", "payoutRoundingVersion", "payoutCurve",
    "creationSource", "startPolicy", "teamPoolMultBps", "teamPayoutVersion",
    "teamWinnerRewardCoins", "startedAt", "endsAt",
    "scheduledStartAt", "scheduledEndAt", "timezone", "completedAt",
    "winnerUserId", "powerupsEnabled", "powerupStepInterval", "isPublic",
    "maxParticipants", "timeBased", "isTeamRace", "teamSize", "teamAName",
    "teamBName", "winnerTeam", "tournamentId", "tournamentRound",
    "tournamentMatchIndex", "seededBucketId", "createdAt", "updatedAt",
    "creator", "winner",
  ]),
  perUser: Object.freeze([
    "myStatus", "myPlacement", "myPlacementHidden", "myBuyInStatus",
    "myPayoutCoins", "myResultsSeen", "queuedBoxCount", "mysteryBoxCount",
    "slotItems", "myActiveEffects", "isCreator", "myInviteExpiresAt", "myTeam",
    "myForfeited", "leaveAction",
  ]),
  live: Object.freeze([
    "participantCount", "leader", "teams", "teamATotalSteps", "teamBTotalSteps",
    "podium",
  ]),
});

function classifyRaceListFields() {
  return {
    stable: [...FIELD_CLASSIFICATION.stable],
    perUser: [...FIELD_CLASSIFICATION.perUser],
    live: [...FIELD_CLASSIFICATION.live],
  };
}

function bit(features, token) {
  return features?.has(token) === true ? "1" : "0";
}

function canonicalRaceListVariant({
  clientFeatures = null,
  compact = false,
  releaseChannel = "prod",
} = {}) {
  const features = clientFeatures instanceof Set
    ? clientFeatures
    : new Set(Array.isArray(clientFeatures) ? clientFeatures : []);
  const channel = CHANNELS.has(releaseChannel) ? releaseChannel : "prod";
  return [
    `tm${bit(features, "team_races")}`,
    `to${bit(features, "tournaments")}`,
    `sb${bit(features, "seeded_race_buckets")}`,
    `pu${bit(features, "powerups3")}${bit(features, "powerups4")}${bit(features, "powerups5")}`,
    `lv${bit(features, "race_leave")}`,
    `ch${bit(features, "characters")}`,
    `ra${bit(features, "remote_assets")}`,
    `pd${bit(features, "race_payout_double")}`,
    `rv${bit(features, "review_prompt")}`,
    `co${compact === true ? "1" : "0"}`,
    `rc${channel}`,
  ].join(":");
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function projectPerson(value) {
  if (value == null) return value ?? null;
  if (!isPlainObject(value)) return null;
  return {
    id: value.id ?? null,
    displayName: value.displayName ?? null,
    profilePhotoUrl: value.profilePhotoUrl ?? null,
  };
}

function projectStableRace(race) {
  if (!isPlainObject(race)) return null;
  const out = {};
  for (const field of FIELD_CLASSIFICATION.stable) {
    if (field === "creator" || field === "winner") {
      out[field] = projectPerson(race[field]);
    } else if (Object.prototype.hasOwnProperty.call(race, field)) {
      out[field] = race[field];
    }
  }
  return out;
}

function projectStableRaces(races) {
  if (!Array.isArray(races)) return [];
  return races.map(projectStableRace).filter(Boolean);
}

function validRace(race) {
  return isPlainObject(race) &&
    typeof race.id === "string" && race.id.length > 0 &&
    typeof race.status === "string";
}

function validFragment(value) {
  if (!isPlainObject(value) || value.version !== CACHE_VERSION || !Array.isArray(value.races)) {
    return false;
  }
  if (value.races.length > MAX_RACES || value.races.some((race) => !validRace(race))) {
    return false;
  }
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PAYLOAD_BYTES;
}

function normalizeGeneration(value) {
  if (value == null) return 0;
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

function metric(logger, fields) {
  const payload = {
    event: "race_list_cache_v1",
    surface: "races",
    ...fields,
  };
  try {
    logger?.log?.(logger === console ? JSON.stringify(payload) : payload);
  } catch {}
}

function buildRaceListCache({
  redisCache = defaultRedisCache,
  derivedCache = defaultDerivedCache,
  logger = console,
} = {}) {
  async function getStableMembership({ userId, variant, load }) {
    const fallback = async (source = "postgres") => {
      const races = projectStableRaces(await load());
      metric(logger, {
        fragment: "all",
        source,
        outcome: source === "postgres" ? "miss" : source,
        variant: typeof variant === "string" ? variant : "legacy",
        raceCount: races.length,
      });
      return { races, source };
    };

    if (!userId || typeof load !== "function" || !redisCache.isEnabled?.()) {
      return fallback("bypass");
    }
    const prefix = cacheKeys.PREFIX.RACE_LIST;
    derivedCache.ensureSubscribed?.();
    if (locallyStaleUsers.has(userId) && !derivedCache.isBypassed?.(prefix)) {
      // derivedCache closes its background retry breaker when Redis becomes
      // healthy again; reconcile the per-user fast-path marker on the next
      // read so a transient failure cannot permanently disable this worker.
      locallyStaleUsers.delete(userId);
    }
    if (locallyStaleUsers.has(userId)) return fallback("pending_invalidation");
    if (derivedCache.isBypassed?.(prefix)) return fallback("bypass");

    const generationKey = cacheKeys.raceListGeneration(userId);
    const membershipKey = cacheKeys.raceListMembership(userId);
    let generationResult;
    try {
      generationResult = await redisCache.getManyJSON([generationKey]);
    } catch {
      return fallback("redis_error");
    }
    const generation = normalizeGeneration(generationResult?.values?.[0]);
    if (generation == null) return fallback("malformed");
    const safeVariant = typeof variant === "string" && variant.length <= 128
      ? variant
      : "legacy";
    const completedKey = cacheKeys.raceListFragment("completed", userId, generation, safeVariant);
    const pendingKey = cacheKeys.raceListFragment("pending", userId, generation, safeVariant);
    let read;
    try {
      read = await redisCache.getManyJSON([membershipKey, completedKey, pendingKey]);
    } catch {
      return fallback("redis_error");
    }
    const [membership, completed, pending] = read?.values || [];
    if (
      read?.ok === true &&
      validFragment(membership) &&
      validFragment(completed) &&
      validFragment(pending)
    ) {
      let currentGenerationResult;
      try {
        currentGenerationResult = await redisCache.getManyJSON([generationKey]);
      } catch {
        return fallback("redis_error");
      }
      const currentGeneration = normalizeGeneration(currentGenerationResult?.values?.[0]);
      if (currentGeneration === generation) {
        const races = [
          ...membership.races,
          ...completed.races,
          ...pending.races,
        ];
        if (races.length > MAX_RACES ||
          Buffer.byteLength(JSON.stringify({ version: CACHE_VERSION, races }), "utf8") > MAX_PAYLOAD_BYTES) {
          return fallback("malformed");
        }
        for (const fragment of ["membership", "completed", "pending"]) {
          metric(logger, {
            fragment,
            source: "redis",
            outcome: "hit",
            variant: safeVariant,
            raceCount: races.length,
          });
        }
        return { races, source: "redis" };
      }
      return fallback("generation_changed");
    }

    const races = projectStableRaces(await load());
    if (
      races.length <= MAX_RACES &&
      Buffer.byteLength(JSON.stringify({ version: CACHE_VERSION, races }), "utf8") <= MAX_PAYLOAD_BYTES
    ) {
      let writeResult;
      try {
        writeResult = await redisCache.setManyJSON([
        {
          key: membershipKey,
          value: {
            version: CACHE_VERSION,
            races: races.filter((race) => race.status !== "COMPLETED" && race.status !== "PENDING"),
          },
          ttlSeconds: TTL_SECONDS.membership,
        },
        {
          key: completedKey,
          value: {
            version: CACHE_VERSION,
            races: races.filter((race) => race.status === "COMPLETED"),
          },
          ttlSeconds: TTL_SECONDS.completed,
        },
        {
          key: pendingKey,
          value: {
            version: CACHE_VERSION,
            races: races.filter((race) => race.status === "PENDING"),
          },
          ttlSeconds: TTL_SECONDS.pending,
        },
        ]);
      } catch {
        metric(logger, { fragment: "all", source: "redis", outcome: "write_error", variant: safeVariant });
      }
      for (const fragment of ["membership", "completed", "pending"]) {
        metric(logger, {
          fragment,
          source: "redis",
          outcome: writeResult?.ok === true ? "write" : "write_error",
          variant: safeVariant,
          raceCount: races.length,
        });
      }
    }
    metric(logger, {
      fragment: "all",
      source: "postgres",
      outcome: read?.disabled === true ? "disabled" : "miss",
      variant: safeVariant,
      raceCount: races.length,
    });
    return { races, source: "postgres" };
  }

  return { getStableMembership };
}

function buildRaceListInvalidator({
  redisCache = defaultRedisCache,
  derivedCache = defaultDerivedCache,
  logger = console,
} = {}) {
  async function invalidateUser(userId) {
    if (!userId || !redisCache.isEnabled?.()) return true;
    locallyStaleUsers.add(userId);
    const generationKey = cacheKeys.raceListGeneration(userId);
    const membershipKey = cacheKeys.raceListMembership(userId);
    const result = await derivedCache.invalidate({
      keys: [membershipKey],
      prefix: cacheKeys.PREFIX.RACE_LIST,
      run: async () => {
        const outcome = await redisCache.evalLua(
          "return redis.call('incr', KEYS[1]) + redis.call('del', KEYS[2])",
          [generationKey, membershipKey],
        );
        return { ok: outcome?.ok === true, disabled: outcome?.disabled === true };
      },
    });
    if (result) locallyStaleUsers.delete(userId);
    for (const fragment of ["membership", "completed", "pending"]) {
      metric(logger, {
        fragment,
        source: "redis",
        outcome: result ? "invalidated" : "invalidate_error",
        affectedUsers: 1,
      });
    }
    return result;
  }

  return { invalidateUser };
}

const registeredEventBuses = new WeakSet();
const RACE_LIST_INVALIDATION_EVENTS = Object.freeze([
  "RACE_CREATED",
  "RACE_INVITE_SENT",
  "RACE_INVITE_ACCEPTED",
  "RACE_INVITE_DECLINED",
  "RACE_PUBLIC_JOINED",
  "RACE_PARTICIPANT_LEFT",
  "RACE_PARTICIPANT_KICKED",
  "RACE_PARTICIPANT_FORFEITED",
  "RACE_TEAM_SWITCHED",
  "RACE_EDITED",
  "RACE_BUYIN_CHANGED",
  "RACE_STARTED",
  "RACE_COMPLETED",
  "RACE_CANCELLED",
  "RACE_RESULTS_SEEN",
]);

function directEventUserIds(data) {
  const ids = new Set();
  for (const key of [
    "userId", "creatorUserId", "inviteeUserId", "kickedUserId", "winnerUserId",
  ]) {
    if (typeof data?.[key] === "string" && data[key]) ids.add(data[key]);
  }
  for (const id of data?.participantUserIds || []) {
    if (typeof id === "string" && id) ids.add(id);
  }
  for (const id of Object.keys(data?.memberTeams || {})) {
    if (id) ids.add(id);
  }
  return ids;
}

function registerRaceListCacheInvalidation({
  eventBus = defaultEventBus,
  RaceParticipant = defaultRaceParticipant,
  invalidator = defaultInvalidator,
  logger = console,
} = {}) {
  if (!eventBus || registeredEventBuses.has(eventBus)) return;
  registeredEventBuses.add(eventBus);

  for (const eventName of RACE_LIST_INVALIDATION_EVENTS) {
    eventBus.on(eventName, (data = {}) => {
      const directIds = directEventUserIds(data);
      const shouldLoadParticipants =
        Boolean(data.raceId) &&
        [
          "RACE_EDITED", "RACE_BUYIN_CHANGED", "RACE_STARTED", "RACE_COMPLETED",
          "RACE_CANCELLED", "RACE_RESULTS_SEEN",
        ].includes(eventName);
      const invalidate = (userId) => invalidator.invalidateUser(userId).catch((error) => {
        try {
          logger.error?.("Race list cache invalidation failed", {
            eventName,
            outcome: "error",
            error: error?.message || String(error),
          });
        } catch {}
      });
      for (const userId of directIds) invalidate(userId);
      if (shouldLoadParticipants) {
        Promise.resolve(RaceParticipant.findUserIdsByRace?.(data.raceId) || [])
          .then((userIds) => {
            for (const userId of userIds || []) {
              if (!directIds.has(userId)) invalidate(userId);
            }
          })
          .catch((error) => {
            try {
              logger.error?.("Race list cache participant fanout failed", {
                eventName,
                outcome: "fanout_error",
                error: error?.message || String(error),
              });
            } catch {}
          });
      }
    });
  }
}

const defaultCache = buildRaceListCache();
const defaultInvalidator = buildRaceListInvalidator();

module.exports = {
  CACHE_VERSION,
  MAX_RACES,
  MAX_PAYLOAD_BYTES,
  TTL_SECONDS,
  FIELD_CLASSIFICATION,
  canonicalRaceListVariant,
  classifyRaceListFields,
  projectStableRace,
  projectStableRaces,
  buildRaceListCache,
  buildRaceListInvalidator,
  registerRaceListCacheInvalidation,
  isEnabled: () => defaultRedisCache.isEnabled(),
  getStableMembership: defaultCache.getStableMembership,
  invalidateUser: defaultInvalidator.invalidateUser,
};
