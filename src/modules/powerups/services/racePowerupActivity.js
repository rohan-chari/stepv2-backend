const ACTIVITY_VERSION = 1;

function buildDecoyActivityMetadata({
  metadata = null,
  attackerUserId,
  originalTargetUserId,
  finalTargetUserId = null,
  decoyOwnerUserId = null,
  redirectedUserId = null,
  outcome,
}) {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : {};
  return {
    ...base,
    activityV1: {
      action: "POWERUP_USE",
      version: ACTIVITY_VERSION,
      originalAttackerUserId: attackerUserId,
      originalTargetUserId,
      finalTargetUserId,
      redirect: redirectedUserId
        ? {
            type: "DECOY",
            ownerUserId: decoyOwnerUserId,
            recipientUserId: redirectedUserId,
          }
        : null,
      outcome,
    },
  };
}

module.exports = { ACTIVITY_VERSION, buildDecoyActivityMetadata };
