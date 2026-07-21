// Shared guards for competition (race/tournament) lifecycle commands — the
// common prelude identified by the Phase 6 investigation (AUDIT.md): not-found,
// accepted-participant permission, and the reuse-or-mint share-token step.
// Errors are supplied by each call site as lazy factories so every domain keeps
// its exact error class / message / status / code; these helpers own only the
// checks, never the wire shape.

// Not-found prelude: returns the entity or throws the caller's 404.
function assertFound(entity, makeError) {
  if (!entity) throw makeError();
  return entity;
}

// Any-ACCEPTED-participant permission gate (deliberately not creator-only —
// both share-link commands document this). Tolerates a missing participants
// array (treated as "not a member").
function assertAcceptedParticipant(entity, userId, makeError) {
  const participants = Array.isArray(entity.participants)
    ? entity.participants
    : [];
  const isMember = participants.some(
    (p) => p.userId === userId && p.status === "ACCEPTED"
  );
  if (!isMember) throw makeError();
}

// Creator-only permission gate (kick/cancel). Note this also encodes the
// featured-competition quirk for free: a null creatorId matches no caller.
function assertCreator(entity, userId, makeError) {
  if (entity.creatorId !== userId) throw makeError();
}

// Parameterized state-window gate. The windows intentionally differ per
// domain/action (race kick: PENDING+ACTIVE; tournament kick/leave/cancel:
// PENDING-only) — callers pass their own allowed list and error. A caller
// needing distinct errors per bad status calls this more than once, excluding
// one status at a time.
function assertStatusIn(entity, allowedStatuses, makeError) {
  if (!allowedStatuses.includes(entity.status)) throw makeError();
}

// The shared "if charged → refund → domain follow-up" step for leave/kick/
// cancel. `refundFn` performs the domain refund (reason string + refId
// template, e.g. refundRaceBuyIn / refundTournamentBuyIn) and receives
// { awardCoinsFn, userId, amount, participant }; `onRefunded` is the
// domain-specific post-refund hook (race cancel: flag REFUNDED; tournament
// cancel: flag + buyInVersion bump; race leave/kick: nothing — the row is
// deleted right after). `refundableStatuses` defaults to HELD-only; race
// cancel widens it to HELD+COMMITTED because ACTIVE races are cancellable.
// Returns true when a refund happened.
async function refundHeldBuyIn({
  participant,
  awardCoinsFn,
  refundFn,
  onRefunded,
  refundableStatuses = ["HELD"],
}) {
  const refundable =
    (participant.buyInAmount || 0) > 0 &&
    refundableStatuses.includes(participant.buyInStatus);
  if (!refundable) return false;

  await refundFn({
    awardCoinsFn,
    userId: participant.userId,
    amount: participant.buyInAmount,
    participant,
  });
  if (onRefunded) await onRefunded(participant);
  return true;
}

// Idempotent share-token step: a competition has at most one share token for
// its lifetime — reuse it if present, else mint once and hand it to the
// caller's persistence function (model method or raw prisma; the caller owns
// how the write happens).
async function reuseOrMintShareToken({ entity, mintToken, persist }) {
  if (entity.shareToken) {
    return { shareToken: entity.shareToken };
  }
  const shareToken = mintToken();
  await persist(shareToken);
  return { shareToken };
}

module.exports = {
  assertAcceptedParticipant,
  assertCreator,
  assertFound,
  assertStatusIn,
  refundHeldBuyIn,
  reuseOrMintShareToken,
};
