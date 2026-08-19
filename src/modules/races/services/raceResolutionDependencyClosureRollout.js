async function dependencyClosureRolloutPercent(settings, masterEnabled) {
  if (masterEnabled !== true) return 0;

  // Production settings expose presence separately from the resolved default.
  // That distinction preserves the legacy boolean-only rollout (absent row =>
  // 100%) while keeping the new catalog default/explicit zero dark. A settings
  // read failure is not absence and therefore fails closed to zero.
  if (typeof settings?.getRawFlagState === "function") {
    const state = await settings.getRawFlagState(
      "raceResolutionDependencyClosureV1Percent"
    );
    if (!state?.available) return 0;
    if (!state.present) return 100;
    const value = state.value;
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
  }

  // Backward-compatible dependency-injection seam for older settings fakes and
  // mixed internal callers that predate raw-presence support.
  if (typeof settings?.getRawFlag === "function") {
    const value = await settings.getRawFlag(
      "raceResolutionDependencyClosureV1Percent"
    );
    if (value === undefined) return 100;
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : 0;
  }
  return 100;
}

module.exports = { dependencyClosureRolloutPercent };
