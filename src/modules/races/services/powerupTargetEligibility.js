const ACTIVE_CONFLICTS = Object.freeze({
  LEG_CRAMP: new Set(["LEG_CRAMP", "WRONG_TURN"]),
  WRONG_TURN: new Set(["WRONG_TURN", "LEG_CRAMP"]),
  DETOUR_SIGN: new Set(["DETOUR_SIGN"]),
  SIGNAL_JAMMER: new Set(["SIGNAL_JAMMER"]),
  LEECH: new Set(["LEECH"]),
  QUICKSAND: new Set(["LEG_CRAMP", "QUICKSAND"]),
});

function liveEffectsByParticipant(effects, now = new Date()) {
  const byParticipant = new Map();
  const nowMs = now.getTime();
  for (const effect of effects || []) {
    if (!effect || effect.status && effect.status !== "ACTIVE") continue;
    if (effect.expiresAt && new Date(effect.expiresAt).getTime() <= nowMs) continue;
    const id = effect.targetParticipantId;
    if (!id) continue;
    const set = byParticipant.get(id) || new Set();
    set.add(effect.type);
    byParticipant.set(id, set);
  }
  return byParticipant;
}

function eligiblePowerupTargets({
  powerupType,
  participants,
  viewerUserId,
  effects = [],
  stealableParticipantIds = new Set(),
  isTeamRace = false,
  now = new Date(),
}) {
  const me = (participants || []).find((p) => p.userId === viewerUserId);
  if (!me) return [];
  const teamRace = isTeamRace === true;
  const active = liveEffectsByParticipant(effects, now);
  const conflicts = ACTIVE_CONFLICTS[powerupType] || null;
  const viewerHasActiveHitchhike =
    powerupType === "HITCHHIKE" &&
    (effects || []).some(
      (effect) =>
        effect &&
        effect.type === "HITCHHIKE" &&
        effect.sourceUserId === viewerUserId &&
        (!effect.status || effect.status === "ACTIVE") &&
        (!effect.expiresAt || new Date(effect.expiresAt).getTime() > now.getTime())
    );
  if (viewerHasActiveHitchhike) return [];

  return (participants || []).filter((participant) => {
    if (!participant || participant.userId === viewerUserId) return false;
    if (participant.status && participant.status !== "ACCEPTED") return false;
    if (participant.finishedAt || participant.forfeitedAt) return false;
    if (teamRace && participant.team != null && participant.team === me.team && powerupType !== "HITCHHIKE") return false;

    const targetEffects = active.get(participant.id) || new Set();
    if (targetEffects.has("STEALTH_MODE")) return false;
    if (conflicts && [...conflicts].some((type) => targetEffects.has(type))) return false;
    if (powerupType === "SHORTCUT" && Math.max(0, Number(participant.totalSteps) || 0) === 0) return false;
    if (powerupType === "HITCHHIKE" && targetEffects.has("HITCHHIKE")) return false;

    if (powerupType === "SNEAKY_SWAP" && !stealableParticipantIds.has(participant.id)) return false;
    if (powerupType === "BOUNTY") {
      const mineSteps = Math.max(0, Number(me.totalSteps) || 0);
      const targetSteps = Math.max(0, Number(participant.totalSteps) || 0);
      if (targetSteps <= mineSteps) return false;
    }

    return true;
  });
}

module.exports = { ACTIVE_CONFLICTS, eligiblePowerupTargets, liveEffectsByParticipant };
