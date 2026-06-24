const { Race } = require("../models/race");

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

    return {
      id: race.id,
      name: race.name,
      status: race.status,
      powerupsEnabled: race.powerupsEnabled === true,
      buyInAmount: race.buyInAmount || 0,
      maxParticipants: race.maxParticipants ?? null,
      participantCount,
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
