const PREMIUM_POWERUP_TYPES = new Set();

function powerupRequiresGold(powerupType) {
  return PREMIUM_POWERUP_TYPES.has(powerupType);
}

function powerupAcquisitionState(item, isGoldMember) {
  const requiresGold = powerupRequiresGold(item?.powerupType);
  const goldEligible = !requiresGold || isGoldMember === true;
  return {
    requiresGold,
    goldEligible,
    purchaseEligibility: goldEligible ? "AVAILABLE" : "GOLD_REQUIRED",
  };
}

module.exports = {
  PREMIUM_POWERUP_TYPES,
  powerupRequiresGold,
  powerupAcquisitionState,
};
