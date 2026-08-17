const { Race } = require("../models/race");
const { buildRaceMoneyView } = require("../racePrizePool");

// Public, UNAUTHENTICATED preview of a shared race, used by both the web
// landing page (GET /r/:token) and the app's pre-join screen
// (GET /races/share/:token). Returns ONLY display-safe fields — never the
// creatorId, the shareToken itself, buy-in internals, or the raw participant
// rows (which carry user ids). Returns null when the token resolves to nothing,
// so the caller renders a 404.
function buildGetSharedRacePreview(dependencies = {}) {
  const raceModel = dependencies.Race || Race;

  return async function getSharedRacePreview({ token }) {
    const race = await raceModel.findByShareToken(token);
    if (!race) {
      return null;
    }

    const participants = Array.isArray(race.participants)
      ? race.participants
      : [];
    const participantCount = participants.filter(
      (p) => p.status === "ACCEPTED"
    ).length;

    const isOpen = race.status === "PENDING" || race.status === "ACTIVE";
    // null maxParticipants => unlimited; only a finite cap can fill a race.
    const isFull =
      race.maxParticipants != null && participantCount >= race.maxParticipants;

    // Legacy buy-in pot OR app-funded prize pool (race.fundedPrize decides). A
    // funded race reports buyInAmount 0, so a frozen build's pre-join sheet shows
    // no charge, and carries the pool in the additive prizePool block.
    const money = buildRaceMoneyView({
      race,
      participants,
      acceptedCount: participantCount,
    });

    return {
      id: race.id,
      name: race.name,
      status: race.status,
      powerupsEnabled: race.powerupsEnabled === true,
      buyInAmount: money.buyInAmount,
      prizePool: money.prizePool,
      maxParticipants: race.maxParticipants ?? null,
      participantCount,
      // Timing (spec §5.7). Four additive, display-only fields so a link pasted
      // in a group chat can say when the race runs. On a PENDING race `endsAt`
      // is null by design and the end lives in `scheduledEndAt`, so any renderer
      // must read `endsAt ?? scheduledEndAt`, never `endsAt` alone. A frozen
      // client that ignores all four is unaffected.
      scheduledStartAt: race.scheduledStartAt ?? null,
      scheduledEndAt: race.scheduledEndAt ?? null,
      endsAt: race.endsAt ?? null,
      maxDurationDays: race.maxDurationDays ?? null,
      host: race.creator
        ? {
            displayName: race.creator.displayName ?? null,
            profilePhotoUrl: race.creator.profilePhotoUrl ?? null,
          }
        : null,
      isJoinable: isOpen && !isFull,
    };
  };
}

const getSharedRacePreview = buildGetSharedRacePreview();

module.exports = { buildGetSharedRacePreview, getSharedRacePreview };
