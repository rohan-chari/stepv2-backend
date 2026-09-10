// The ordinary byType disclosure intentionally omits one-shot guaranteed
// rolls. This derived response fact authorizes decoration only when that same
// distribution is usable; it never changes the roll or normalizes missing mass.
function reelPreviewAvailable({ byType, effects, participantId } = {}) {
  if (typeof participantId !== "string" || !participantId || !Array.isArray(effects)) return false;
  for (const effect of effects) {
    if (!effect || typeof effect.type !== "string" ||
        typeof effect.targetParticipantId !== "string" ||
        !["ACTIVE", "EXPIRED", "BLOCKED"].includes(effect.status)) return false;
    // Match openMysteryBox's ACTIVE lookup exactly, including past expiresAt.
    if (effect.targetParticipantId === participantId &&
        effect.type === "LUCKY_HORSESHOE" && effect.status === "ACTIVE") return false;
  }
  if (!byType || typeof byType !== "object" || Array.isArray(byType)) return false;
  const values = Object.values(byType);
  if (!values.length || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return false;
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-6;
}

module.exports = { reelPreviewAvailable };
