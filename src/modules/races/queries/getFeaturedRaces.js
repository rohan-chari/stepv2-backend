const { Race } = require("../models/race");
const { buildRaceMoneyView } = require("../racePrizePool");
const { buildSeededRaceBuckets } = require("../services/seededRaceBuckets");

// Ordering for the featured strip: daily first, then weekly, then anything else.
const SEED_RANK = { DAILY_10K: 0, WEEKLY_50K: 1 };

function buildGetFeaturedRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const seededBuckets = dependencies.seededBuckets || buildSeededRaceBuckets(dependencies);
  const now = dependencies.now || (() => new Date());

  // Returns the current live seeded races (daily + weekly) for the Featured
  // section. Unlike getPublicRaces, this does NOT drop races the user already
  // joined or full races — a featured card stays pinned and flips to a VIEW /
  // FULL state instead. Each entry carries the viewer's join status so the
  // client can render JOIN vs VIEW without a failed join round-trip.
  return async function getFeaturedRaces({ userId, suggestionMode = false, supportsBuckets = false, hiddenSeedKinds = new Set() }) {
    const bucketCards = supportsBuckets && !suggestionMode
      ? await seededBuckets.featuredCards(userId)
      : [];
    if (suggestionMode) {
      const rows = await raceModel.findFeaturedSuggestions({
        userId,
        now: now(),
      });
      return rows.filter((raw) => !hiddenSeedKinds.has(raw.seedKind)).map((raw) => {
        const participants = raw.participants || [];
        const acceptedCount = Number(raw.acceptedCount || 0);
        const race = {
          ...raw,
          status: "ACTIVE",
          payoutPreset: raw.payoutPreset
            ? String(raw.payoutPreset).toUpperCase()
            : null,
          participants,
        };
        const money = buildRaceMoneyView({ race, participants, acceptedCount });
        const max = race.maxParticipants ?? null;
        return {
          raceId: race.id,
          seedKind: race.seedKind,
          name: race.name,
          endsAt: race.endsAt,
          participantCount: acceptedCount,
          maxParticipants: max ?? 100,
          isFull: max != null && acceptedCount >= max,
          powerupsEnabled: race.powerupsEnabled === true,
          payoutRoundingVersion: race.payoutRoundingVersion ?? 0,
          finishReward: money.finishReward,
          prizePool: money.prizePool,
          myStatus: null,
          upcoming: null,
        };
      });
    }

    const races = await raceModel.findLiveSeeded({ legacyOnly: true });
    const currentTime = now();

    // Partition the live seeded races by status:
    //   * ACTIVE  → the featured cards (the array shape old clients consume).
    //   * PENDING → the pre-created "next" race a user can opt into BEFORE it
    //     starts. It is surfaced ONLY via the additive `upcoming` field on the
    //     matching live card — never as its own array entry — so old app builds
    //     (which would mis-render a not-yet-started race with an "ends in"
    //     countdown and let users "join" before it begins) never see it.
    //
    // For ACTIVE races: renewal guarantees ~one per seed, but between a race's
    // endsAt passing and expiry completing it an expired-but-still-ACTIVE race
    // can linger — skip those, and defensively keep only the most recently
    // started race per seed so an old instance never shadows the fresh one.
    const activeBySeed = new Map();
    const upcomingBySeed = new Map();
    for (const race of races) {
      if (race.status === "ACTIVE") {
        const ended = race.endsAt && new Date(race.endsAt) <= currentTime;
        if (ended) continue;
        const existing = activeBySeed.get(race.seedId);
        if (
          !existing ||
          new Date(race.startedAt) > new Date(existing.startedAt)
        ) {
          activeBySeed.set(race.seedId, race);
        }
      } else if (race.status === "PENDING") {
        // Keep the soonest-starting upcoming race per seed.
        const existing = upcomingBySeed.get(race.seedId);
        const t = race.scheduledStartAt
          ? new Date(race.scheduledStartAt).getTime()
          : Infinity;
        const et =
          existing && existing.scheduledStartAt
            ? new Date(existing.scheduledStartAt).getTime()
            : Infinity;
        if (!existing || t < et) {
          upcomingBySeed.set(race.seedId, race);
        }
      }
    }

    // Compact summary of the pre-registerable next race (null when none exists).
    function summarizeUpcoming(race) {
      if (!race) return null;
      const participants = race.participants || [];
      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      const myParticipant = participants.find((p) => p.userId === userId);
      const max = race.maxParticipants ?? null; // null = unlimited
      return {
        raceId: race.id,
        scheduledStartAt: race.scheduledStartAt,
        scheduledEndAt: race.scheduledEndAt ?? null,
        endsAt: race.endsAt,
        participantCount: acceptedCount,
        maxParticipants: max,
        isFull: max != null && acceptedCount >= max,
        // null → render "Opt in"; "ACCEPTED" → render "You're in".
        myStatus: myParticipant ? myParticipant.status : null,
      };
    }

    const featured = [...activeBySeed.values()].map((race) => {
      const participants = race.participants || [];
      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      const myParticipant = participants.find((p) => p.userId === userId);
      const max = race.maxParticipants ?? null; // null = unlimited
      // Projected from the current field; the final pool/places are recomputed
      // from actual finishers at settlement (completeRace). A funded seeded race
      // carries the app-minted prizePool instead of the retired finishReward.
      const money = buildRaceMoneyView({ race, participants, acceptedCount });

      return {
        raceId: race.id,
        seedKind: race.seed ? race.seed.kind : null,
        name: race.name,
        endsAt: race.endsAt,
        participantCount: acceptedCount,
        // Legacy int field for old clients; unlimited surfaces as 100 (as before).
        maxParticipants: max ?? 100,
        isFull: max != null && acceptedCount >= max,
        powerupsEnabled: race.powerupsEnabled || false,
        payoutRoundingVersion: race.payoutRoundingVersion ?? 0,
        // Minted reward projection for seeded races. `paidPlaces` replaces the
        // old fixed `topFraction`: newer clients render "Top N split <pool>";
        // older clients read only `pool` (and show their hardcoded copy).
        finishReward: money.finishReward,
        // Additive app-funded pool block (null for a legacy seeded race).
        prizePool: money.prizePool,
        // null = not joined → render JOIN; otherwise the participant status
        // (ACCEPTED) → render VIEW.
        myStatus: myParticipant ? myParticipant.status : null,
        // Additive: the pre-registerable next race for this seed (null if none).
        // Old app builds ignore the unknown field; new builds render an opt-in
        // affordance with a starts-in countdown.
        upcoming: summarizeUpcoming(upcomingBySeed.get(race.seedId)),
      };
    });

    featured.sort((a, b) => {
      const aRank = SEED_RANK[a.seedKind] ?? 2;
      const bRank = SEED_RANK[b.seedKind] ?? 2;
      return aRank - bRank;
    });

    if (!bucketCards.length) return featured.filter((card) => !hiddenSeedKinds.has(card.seedKind));
    const bucketKinds = new Set(bucketCards.map((card) => card.seedKind));
    return [...featured.filter((card) => !bucketKinds.has(card.seedKind) && !hiddenSeedKinds.has(card.seedKind)), ...bucketCards]
      .sort((a, b) => (SEED_RANK[a.seedKind] ?? 2) - (SEED_RANK[b.seedKind] ?? 2));
  };
}

const getFeaturedRaces = buildGetFeaturedRaces();

module.exports = { buildGetFeaturedRaces, getFeaturedRaces };
