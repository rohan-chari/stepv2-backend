const { prisma } = require("../db");

class SetRacePlacementMuteError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "SetRacePlacementMuteError";
    this.statusCode = statusCode;
  }
}

// Per-race opt-out for live placement-change pushes. Mirrors setRaceChatMute:
// flips the calling participant's placementAlertsMuted flag for this race only.
// The placementRecompute job reads the flag and skips the PLACEMENT_CHANGED emit
// (keeping the baseline in sync) so a muted participant gets no further alerts.
async function setRacePlacementMute({ userId, raceId, muted }) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  if (!participant) {
    throw new SetRacePlacementMuteError("Not a participant in this race", 403);
  }
  return prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { placementAlertsMuted: !!muted },
  });
}

module.exports = { setRacePlacementMute, SetRacePlacementMuteError };
