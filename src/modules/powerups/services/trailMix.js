function uniqueTypesIfTrailMixUsed(usedTypes) {
  const types = new Set(
    Array.isArray(usedTypes) ? usedTypes.filter((type) => typeof type === "string") : [],
  );
  types.add("TRAIL_MIX");
  return types.size;
}

module.exports = { uniqueTypesIfTrailMixUsed };
