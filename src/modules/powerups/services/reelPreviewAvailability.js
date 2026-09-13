// Ordinary byType odds supply decorative reel tiles, including while a
// one-shot guarantee is active. The stopping tile comes from the actual open
// result; enabling decoration never changes that roll or normalizes missing mass.
function reelPreviewAvailable({ byType, effects, participantId } = {}) {
  if (typeof participantId !== "string" || !participantId || !Array.isArray(effects)) return false;
  for (const effect of effects) {
    if (!effect || typeof effect.type !== "string" ||
        typeof effect.targetParticipantId !== "string" ||
        !["ACTIVE", "EXPIRED", "BLOCKED"].includes(effect.status)) return false;
  }
  if (!byType || typeof byType !== "object" || Array.isArray(byType)) return false;
  const values = Object.values(byType);
  if (!values.length || values.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) return false;
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-6;
}

module.exports = { reelPreviewAvailable };
