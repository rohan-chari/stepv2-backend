const { Race } = require("../models/race");
const { withRaceJoinLock } = require("../services/raceJoinLock");
const { buildJoinRaceCore } = require("./joinRaceCore");
const {
  buildMaybeAutoStartPrivateRace,
} = require("../jobs/privateRaceAutoStart");
const {
  withQuickMembershipLock,
  countLiveQuickMemberships,
  MAX_LIVE_QUICK_MEMBERSHIPS,
  QUICK_MEMBERSHIP_LIMIT_MESSAGE,
} = require("../services/nextRacePolicy");
const { RaceJoinError } = require("./joinRaceCore");
const { prisma: defaultPrisma } = require("../../../db");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  buildApplyAutomaticFriendship,
} = require("../../social/services/automaticFriendship");

// Thrown only for the share-token-specific failure: the token resolves to no
// race (unknown/revoked link). All other join failures (full, already joined,
// closed, can't afford) surface as RaceJoinError from the shared core.
class RaceShareJoinError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceShareJoinError";
    if (statusCode) this.statusCode = statusCode;
  }
}

// Link-join: a user joins via a shareable race link (https://<host>/r/<token>).
// Possession of the unguessable token IS the invitation, so this path
// deliberately does NOT enforce `isPublic` — private/friends races are joinable
// by anyone holding the link. Everything else (status/capacity/buy-in/boxes) is
// the exact same logic as browse-join, via the shared core.
function buildJoinRaceByShareToken(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const withLock = dependencies.withRaceJoinLock || withRaceJoinLock;
  const joinRaceCore = buildJoinRaceCore(dependencies);
  const db = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || defaultAppSettings;
  const applyAutomaticFriendship =
    dependencies.applyAutomaticFriendship ||
    buildApplyAutomaticFriendship(dependencies);
  // Batch 2026-08-08 item 2 — private-race auto-start hook (see
  // jobs/privateRaceAutoStart.js). Link-join is the one join path that can land
  // on a PRIVATE race, so this is where it really fires.
  const maybeAutoStartPrivateRace =
    dependencies.maybeAutoStartPrivateRace ||
    buildMaybeAutoStartPrivateRace(dependencies);

  // `team` + `clientFeatures` thread through to the shared core for team races
  // (TR-201/202/204/703); both are ignored on individual races.
  return async function joinRaceByShareToken({
    userId,
    token,
    onboarding,
    team = null,
    clientFeatures = null,
  }) {
    // Resolve the token -> race OUTSIDE the lock (the lock is keyed by race id,
    // which we don't have until the token is resolved). An unknown token never
    // acquires a lock.
    const resolved = await raceModel.findByShareToken(token);
    if (!resolved) {
      throw new RaceShareJoinError("Race not found", 404);
    }

    const joinUnderRaceLock = () => withLock(resolved.id, async (lockTx) => {
      // Re-read inside the lock for a fresh participant set, so concurrent joins
      // can't both slip past the capacity check (mirrors joinPublicRace).
      const race = await raceModel.findById(resolved.id);
      if (!race) {
        throw new RaceShareJoinError("Race not found", 404);
      }
      // A bucket race never receives a share token, but retain this defensive
      // authorization check for rows minted before the feature or by an
      // operational script. Possession of an old token must not make a private
      // bucket discoverable or joinable.
      if (race.seededBucketId) {
        throw new RaceJoinError("This seeded race is private", 403, "RACE_PRIVATE");
      }

      const autoFriendEnabled =
        race.creationSource === "QUICK_CREATE" &&
        (await settings.getFlag("quickRaceShareAutoFriendEnabled")) === true;

      if (!autoFriendEnabled) {
        return {
          ...(await joinRaceCore({
            race,
            userId,
            onboarding,
            team,
            clientFeatures,
            deferPostCommit: true,
          })),
          invalidateFriendshipPair: false,
        };
      }

      const commitDurableJoin = async (tx) => {
        const joined = await joinRaceCore({
          race,
          userId,
          onboarding,
          team,
          clientFeatures,
          transactionClient: tx,
          deferPostCommit: true,
        });
        await applyAutomaticFriendship({
          userAId: race.creatorId,
          userBId: userId,
          transactionClient: tx,
        });
        return { ...joined, invalidateFriendshipPair: true };
      };
      // Production's race join lock supplies its transaction client, so the
      // advisory lock and both durable writes share one transaction/connection.
      // Minimal injected locks used by unit tests may omit it; retain an
      // explicit transaction fallback for those callers.
      return lockTx
        ? await commitDurableJoin(lockTx)
        : await db.$transaction(commitDurableJoin);
    });
    // Both advisory helpers own transactions. Bubble the deferred callbacks
    // all the way out of BOTH callbacks so events, cache invalidation, boxes,
    // and queue/cache work can only run after both commits have resolved.
    const deferred =
      resolved.creationSource === "QUICK_CREATE"
      ? await withQuickMembershipLock(userId, async () => {
          if (
            (await countLiveQuickMemberships(userId)) >=
            MAX_LIVE_QUICK_MEMBERSHIPS
          ) {
            throw new RaceJoinError(
              QUICK_MEMBERSHIP_LIMIT_MESSAGE,
              409,
              "QUICK_RACE_MEMBERSHIP_LIMIT"
            );
          }
          return joinUnderRaceLock();
        })
      : await joinUnderRaceLock();

    if (deferred.invalidateFriendshipPair) {
      await require("../../users/services/authMeCache").invalidatePairSafe(
        resolved.creatorId,
        userId
      );
      await require("../../social/services/friendsTopologyCache").invalidatePairSafe(
        resolved.creatorId,
        userId
      );
    }
    await deferred.runPostCommit();

    // OUTSIDE the advisory lock, after the participant row has committed —
    // startRace must never run while the join lock is held (3e6c827).
    await maybeAutoStartPrivateRace({ raceId: resolved.id });

    return deferred.participant;
  };
}

const joinRaceByShareToken = buildJoinRaceByShareToken();

module.exports = {
  buildJoinRaceByShareToken,
  joinRaceByShareToken,
  RaceShareJoinError,
};
