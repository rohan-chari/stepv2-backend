const ACTIVE_CONFLICTS = Object.freeze({
  LEG_CRAMP: new Set(["LEG_CRAMP", "WRONG_TURN"]),
  WRONG_TURN: new Set(["WRONG_TURN", "LEG_CRAMP"]),
  DETOUR_SIGN: new Set(["DETOUR_SIGN"]),
  SIGNAL_JAMMER: new Set(["SIGNAL_JAMMER"]),
  LEECH: new Set(["LEECH"]),
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
  now = new Date(),
}) {
  const me = (participants || []).find((p) => p.userId === viewerUserId);
  if (!me) return [];
  const teamRace = me.team != null && (participants || []).some(
    (p) => p.team != null && p.team !== me.team,
  );
  const active = liveEffectsByParticipant(effects, now);
  const conflicts = ACTIVE_CONFLICTS[powerupType] || null;

  return (participants || []).filter((participant) => {
    if (!participant || participant.userId === viewerUserId) return false;
    if (participant.status && participant.status !== "ACCEPTED") return false;
    if (participant.finishedAt || participant.forfeitedAt) return false;
    if (teamRace && participant.team != null && participant.team === me.team && powerupType !== "HITCHHIKE") return false;

    const targetEffects = active.get(participant.id) || new Set();
    if (targetEffects.has("STEALTH_MODE")) return false;
    if (conflicts && [...conflicts].some((type) => targetEffects.has(type))) return false;

    if (powerupType === "SNEAKY_SWAP" && !stealableParticipantIds.has(participant.id)) return false;

    return true;
  });
}

module.exports = { ACTIVE_CONFLICTS, eligiblePowerupTargets, liveEffectsByParticipant };
