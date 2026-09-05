// Closed event-boundary scoring consumes accepted checkpoint facts. It never
// advances a live checkpoint or claims new coarse daily ownership.
function capturedHitchhikeInputs(rows) {
  const checkpoints = new Map(rows.map((row) => [row.effectId, row]));
  return {
    async findByEffect(effectId) { return checkpoints.get(effectId) || null; },
    async findFrozen(effectId) {
      const row = checkpoints.get(effectId);
      return row?.frozenAt ? row : null;
    },
    selectBoundaryContribution({ effectId, exactSteps, exactCopiedSteps, rawEnd, nowMs }) {
      if (rawEnd > nowMs) throw new Error("Captured Hitchhike requires a closed scoring boundary");
      const row = checkpoints.get(effectId);
      // Coarse contribution already includes its signed modifiers and ratio.
      // Exact wins ties; do not multiply or floor an attributed coarse value.
      return Number(row?.coarseRawAttributed) > exactSteps
        ? Number(row.coarseEffectiveContribution) || 0
        : exactCopiedSteps;
    },
  };
}

module.exports = { capturedHitchhikeInputs };
