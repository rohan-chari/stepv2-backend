const { SETTLEMENT_EFFECT_TYPES } = require("../../races/services/raceScoringEffectTypes");

const LOCAL_TYPES = new Set(SETTLEMENT_EFFECT_TYPES);
// These are the exact target modifiers consumed by Hitchhike's canonical
// effective-copy calculation. Neither target Leech credit nor its own copies
// become copy inputs, so they must not create a transitive dependency graph.
const HITCHHIKE_TARGET_TYPES = new Set([
  "LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "WRONG_TURN", "CAMPFIRE_REST", "RAINSTORM",
]);

function buildDurableCaptureScoringPlan({ race, effects, uploaderUserId, eventEndsAt }) {
  const participants = race.participants || [];
  const byId = new Map(participants.map((row) => [row.id, row]));
  const byUserId = new Map(participants.map((row) => [row.userId, row]));
  const uploader = byUserId.get(uploaderUserId);
  if (!uploader) throw new Error("Cannot plan capture without its uploader participant");
  const boundary = new Date(eventEndsAt).getTime();
  const frozen = (participant) => [participant?.finishedAt, participant?.forfeitedAt]
    .filter(Boolean).some((value) => new Date(value).getTime() <= boundary);
  const retained = race.powerupsEnabled ? (effects || []).filter((row) =>
    (!row.raceId || row.raceId === race.id) && ["ACTIVE", "EXPIRED"].includes(row.status)) : [];
  const evaluated = new Set([uploader.id]);
  const factUsers = new Set([uploaderUserId]);
  const includedEffects = new Set();
  const copyModifiersByTarget = new Map();
  for (const row of retained) {
    if (!HITCHHIKE_TARGET_TYPES.has(row.type)) continue;
    if (!copyModifiersByTarget.has(row.targetParticipantId)) copyModifiersByTarget.set(row.targetParticipantId, []);
    copyModifiersByTarget.get(row.targetParticipantId).push(row);
  }
  const uploaderFrozen = frozen(uploader);

  // Uploader credit depends only on its victims' pre-Leech balances. Incoming
  // attacker credits are applied afterward and are never drainable themselves.
  if (!uploaderFrozen) {
    for (const row of retained) {
      if (row.type !== "LEECH" || row.sourceUserId !== uploaderUserId) continue;
      const victim = byId.get(row.targetParticipantId);
      if (victim && !frozen(victim)) evaluated.add(victim.id);
    }
  }
  const evaluatedUsers = new Set([...evaluated].map((id) => byId.get(id).userId));
  for (const userId of evaluatedUsers) factUsers.add(userId);
  for (const row of retained) {
    if (!evaluated.has(row.targetParticipantId) || !LOCAL_TYPES.has(row.type)) continue;
    if (row.type === "LEECH") {
      if (uploaderFrozen) continue;
      // Competing sources remain raw leaves, including sources whose racer is
      // frozen or absent: canonical Leech still drains their victim.
      if (row.sourceUserId) factUsers.add(row.sourceUserId);
    }
    includedEffects.add(row.id);
  }
  if (!uploaderFrozen) {
    for (const copy of retained) {
      if (copy.type !== "HITCHHIKE" || !evaluatedUsers.has(copy.sourceUserId)) continue;
      includedEffects.add(copy.id);
      if (copy.targetUserId) factUsers.add(copy.targetUserId);
      const target = byId.get(copy.targetParticipantId) || byUserId.get(copy.targetUserId);
      if (!target) continue;
      for (const modifier of copyModifiersByTarget.get(target.id) || []) includedEffects.add(modifier.id);
    }
  }
  return {
    version: 1,
    evaluatedParticipantIds: [...evaluated].sort(),
    factUserIds: [...factUsers].sort(),
    leafOnlyUserIds: [...factUsers].filter((id) => !evaluatedUsers.has(id)).sort(),
    effectIds: [...includedEffects].sort(),
  };
}

module.exports = { buildDurableCaptureScoringPlan };
