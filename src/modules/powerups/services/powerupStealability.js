const UNSTEALABLE_TYPES = new Set([
  "SNEAKY_SWAP",
  "MYSTERY_BOX",
  "UPRISING",
  "GHOST_PEPPER",
  "COIN_FLIP",
  "MYSTERY_POTION",
  "DECOY",
  "POWER_OUTAGE",
  "UMBRELLA",
  "RALLY_FLAG",
  "DRILL_SERGEANT",
  "PIGGY_BANK",
  "BOUNTY",
]);

function isStealablePowerup(powerup) {
  return Boolean(
    powerup &&
    (!powerup.status || powerup.status === "HELD") &&
    !UNSTEALABLE_TYPES.has(powerup.type)
  );
}

module.exports = { UNSTEALABLE_TYPES, isStealablePowerup };
