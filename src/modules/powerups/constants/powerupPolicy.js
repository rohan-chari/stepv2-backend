// Runtime policy for the small set of effect types whose final landing rules
// are being shared. This is deliberately narrower than the full stacking guide:
// specialized mechanics remain in usePowerup.js.
const REDIRECTED_DUPLICATE_POLICIES = Object.freeze({
  RAINSTORM: "SKIP_IF_FINAL_TARGET_ACTIVE",
  WRONG_TURN: "SKIP_IF_FINAL_TARGET_ACTIVE",
  POWER_OUTAGE: "SKIP_IF_FINAL_TARGET_ACTIVE",
  LEG_CRAMP: "SKIP_IF_FINAL_TARGET_ACTIVE",
  SIGNAL_JAMMER: "SKIP_IF_FINAL_TARGET_ACTIVE",
  LEECH: "SKIP_IF_FINAL_TARGET_ACTIVE",
  DETOUR_SIGN: "SKIP_IF_FINAL_TARGET_ACTIVE",
});

const POWERUP_POLICY = Object.freeze({
  RAINSTORM: Object.freeze({
    shop: true,
    targetMode: "AOE_ENEMY",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "PER_CASTER",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.RAINSTORM,
    effectWriteMode: "MULTI_TARGET",
  }),
  WRONG_TURN: Object.freeze({
    shop: false,
    targetMode: "SINGLE_TARGET",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "BLOCK",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.WRONG_TURN,
    effectWriteMode: "SINGLE_TARGET",
  }),
  POWER_OUTAGE: Object.freeze({
    shop: true,
    targetMode: "AOE_ENEMY",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "SKIP_RECIPIENT",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.POWER_OUTAGE,
    effectWriteMode: "MULTI_TARGET",
  }),
  LEG_CRAMP: Object.freeze({
    shop: false,
    targetMode: "SINGLE_TARGET",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "BLOCK",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.LEG_CRAMP,
    effectWriteMode: "SINGLE_TARGET",
  }),
  SIGNAL_JAMMER: Object.freeze({
    shop: true,
    targetMode: "SINGLE_TARGET",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "BLOCK",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.SIGNAL_JAMMER,
    effectWriteMode: "SINGLE_TARGET",
  }),
  LEECH: Object.freeze({
    shop: true,
    targetMode: "SINGLE_TARGET",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "TARGET_CAP",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.LEECH,
    effectWriteMode: "SINGLE_TARGET",
  }),
  DETOUR_SIGN: Object.freeze({
    shop: false,
    targetMode: "SINGLE_TARGET",
    persistence: "TIMED_EFFECT",
    directDuplicatePolicy: "BLOCK",
    redirectedDuplicate: REDIRECTED_DUPLICATE_POLICIES.DETOUR_SIGN,
    effectWriteMode: "SINGLE_TARGET",
  }),
});

function getPowerupPolicy(type) {
  return POWERUP_POLICY[type] || null;
}

function shouldSkipRedirectedDuplicate({ type, wasRedirected, activeEffects, now = new Date() }) {
  if (!wasRedirected) return false;
  const policy = getPowerupPolicy(type);
  if (!policy || policy.redirectedDuplicate !== "SKIP_IF_FINAL_TARGET_ACTIVE") return false;
  return (activeEffects || []).some((effect) => (
    effect.type === type &&
    effect.status === "ACTIVE" &&
    (!effect.expiresAt || new Date(effect.expiresAt) > now)
  ));
}

function validatePowerupPolicy() {
  for (const [type, policy] of Object.entries(POWERUP_POLICY)) {
    if (typeof policy.shop !== "boolean") throw new Error(`${type} policy shop must be boolean`);
    if (!policy.targetMode || !policy.persistence || !policy.directDuplicatePolicy) {
      throw new Error(`${type} policy is incomplete`);
    }
    if (!policy.redirectedDuplicate || !policy.effectWriteMode) {
      throw new Error(`${type} policy is incomplete`);
    }
  }
  return true;
}

module.exports = {
  POWERUP_POLICY,
  REDIRECTED_DUPLICATE_POLICIES,
  getPowerupPolicy,
  shouldSkipRedirectedDuplicate,
  validatePowerupPolicy,
};
