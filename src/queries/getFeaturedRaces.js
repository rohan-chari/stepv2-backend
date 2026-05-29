const { Race } = require("../models/race");
const {
  getFinishRewardPool,
  FINISH_REWARD_TOP_FRACTION,
} = require("../constants/raceFinishReward");

// Ordering for the featured strip: daily first, then weekly, then anything else.
const SEED_RANK = { DAILY_10K: 0, WEEKLY_50K: 1 };

function buildGetFeaturedRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const now = dependencies.now || (() => new Date());

  // Returns the current live seeded races (daily + weekly) for the Featured
  // section. Unlike getPublicRaces, this does NOT drop races the user already
  // joined or full races — a featured card stays pinned and flips to a VIEW /
  // FULL state instead. Each entry carries the viewer's join status so the
  // client can render JOIN vs VIEW without a failed join round-trip.
  return async function getFeaturedRaces({ userId }) {
    const races = await raceModel.findLiveSeeded();
    const currentTime = now();

    // Renewal guarantees ~one live race per seed, but during the window between
    // a race's endsAt passing and the hourly/periodic expiry completing it, an
    // expired-but-still-ACTIVE race can linger. Skip those (not meaningfully
    // joinable) and, defensively, keep only the most recently started race per
    // seed so an old instance never shadows the fresh one.
    const bySeed = new Map();
    for (const race of races) {
      const ended = race.endsAt && new Date(race.endsAt) <= currentTime;
      if (ended) continue;
      const existing = bySeed.get(race.seedId);
      if (
        !existing ||
        new Date(race.startedAt) > new Date(existing.startedAt)
      ) {
        bySeed.set(race.seedId, race);
      }
    }

    const featured = [...bySeed.values()].map((race) => {
      const participants = race.participants || [];
      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      const myParticipant = participants.find((p) => p.userId === userId);
      const maxParticipants = race.maxParticipants || 100;
      const finishRewardPool = getFinishRewardPool(race.seedId);

      return {
        raceId: race.id,
        seedKind: race.seed ? race.seed.kind : null,
        name: race.name,
        endsAt: race.endsAt,
        participantCount: acceptedCount,
        maxParticipants,
        isFull: acceptedCount >= maxParticipants,
        powerupsEnabled: race.powerupsEnabled || false,
        finishReward:
          finishRewardPool > 0
            ? { pool: finishRewardPool, topFraction: FINISH_REWARD_TOP_FRACTION }
            : null,
        // null = not joined → render JOIN; otherwise the participant status
        // (ACCEPTED) → render VIEW.
        myStatus: myParticipant ? myParticipant.status : null,
      };
    });

    featured.sort((a, b) => {
      const aRank = SEED_RANK[a.seedKind] ?? 2;
      const bRank = SEED_RANK[b.seedKind] ?? 2;
      return aRank - bRank;
    });

    return featured;
  };
}

const getFeaturedRaces = buildGetFeaturedRaces();

module.exports = { buildGetFeaturedRaces, getFeaturedRaces };
