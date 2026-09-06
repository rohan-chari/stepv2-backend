const { Tournament } = require("../models/tournament");
const { safePublicDisplayName } = require("../../../shared/lib/displayNameValidator");

// Public, UNAUTHENTICATED preview of a shared tournament (web landing page
// GET /t/:token and the app's GET /tournaments/share/:token). Display-safe
// fields only. Returns null for an unknown token so the caller renders a 404.
function buildGetSharedTournamentPreview(dependencies = {}) {
  const tournamentModel = dependencies.Tournament || Tournament;

  return async function getSharedTournamentPreview({ token }) {
    const t = await tournamentModel.findByShareToken(token);
    if (!t) return null;

    const acceptedCount = (t.participants || []).filter(
      (p) => p.status === "ACCEPTED"
    ).length;
    const isOpen = t.status === "PENDING";
    const isFull = acceptedCount >= t.bracketSize;

    return {
      id: t.id,
      name: t.name,
      status: t.status,
      bracketSize: t.bracketSize,
      matchupDurationDays: t.matchupDurationDays,
      buyInAmount: t.buyInAmount || 0,
      participantCount: acceptedCount,
      seedKind: t.seed ? t.seed.kind : null,
      championPrizeCoins:
        t.championPrizeCoinsSnapshot ??
        (t.seed ? t.seed.championPrizeCoins ?? null : null),
      host: t.creator
        ? {
            displayName: safePublicDisplayName(t.creator.displayName),
            profilePhotoUrl: t.creator.profilePhotoUrl ?? null,
          }
        : null,
      isJoinable: isOpen && !isFull,
    };
  };
}

const getSharedTournamentPreview = buildGetSharedTournamentPreview();

module.exports = { buildGetSharedTournamentPreview, getSharedTournamentPreview };
