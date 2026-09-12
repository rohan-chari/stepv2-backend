// Leech 2:1 uncapped step-transfer scoring (Race Powerups spec §5).
//
// A LEECH effect on victim V, sourced by leecher S, TRANSFERS steps from V to S:
// every `ratio` (default 2) steps S walks during the leech window mints one step
// that is subtracted from V and added to S. There is NO per-use cap — the only
// ceiling is the victim's available balance (the target floor is zero).
//
// This module is deliberately split into two pieces so the SAME math drives live
// progress, settlement, and sync-v2 reconcile (they "move together"):
//   * computeLeechEarnedTransfer — async, per-leech: reads the leecher's in-window
//     steps and returns floor(steps / ratio). Excludes the in-progress hour bucket
//     so the number is monotonic across recomputes.
//   * applyLeechTransfers — pure/sync: resolves a race's leeches against victim
//     availability deterministically ((startsAt, effectId) order), draining each
//     victim (floored at zero) and crediting each attacker the SAME amount
//     (zero-sum).

function frozenLeechAmount(effect) {
  const stamp = effect?.metadata?.leechFinalV1;
  return stamp?.version === 1 && Number.isSafeInteger(stamp.amount) && stamp.amount >= 0
    ? stamp.amount : null;
}

function finalMetadata(effect, amount) {
  return { ...(effect.metadata || {}), leechFinalV1: {
    version: 1, amount, expiresAt: new Date(effect.leechFinalBoundaryAt || effect.expiresAt).toISOString(),
  } };
}

function leechExpiryBoundary(effect, stepSampleModel) {
  const context = stepSampleModel?.leechBoundaryContext;
  const race = context?.races?.find(row => row.id === effect.raceId);
  const people = (race?.participants || []).filter(row =>
    row.id === effect.targetParticipantId || row.userId === effect.sourceUserId);
  const values = [effect.expiresAt, race?.endsAt,
    ...people.flatMap(row => [row.finishedAt, row.forfeitedAt]),
    ...(context?.terminalEffectIds?.has(effect.id) ? [context.terminalAt] : [])]
    .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
  return values.length ? new Date(Math.min(...values)) : null;
}

const HOUR_MS = 60 * 60 * 1000;

// Default conversion ratio when an effect row carries no (or malformed)
// `metadata.ratio`. Old rows created under the retired 1:1/3:1 rules, and any row
// whose metadata predates the `ratio` field, adopt 2:1 immediately.
const LEECH_DEFAULT_RATIO = 2;

// Read the conversion ratio from effect metadata, defaulting to LEECH_DEFAULT_RATIO.
// A future ratio change is data-only (no code/migration): the scorer reads this.
function leechRatio(effect) {
  const raw = Number((effect && effect.metadata ? effect.metadata.ratio : undefined));
  return Number.isFinite(raw) && raw > 0 ? raw : LEECH_DEFAULT_RATIO;
}

function resolveLeechDrain(earnedTransfer, victimRemaining) {
  return Math.max(0, Math.min(earnedTransfer || 0, victimRemaining));
}

// Frozen amounts are immutable debit/credit entries. A later correction can
// exhaust the victim's displayed balance, but cannot claw back the credit or
// unlock unused potential. Keep zero distinct from an absent capture.
function hasFrozenTransfer(transfer) {
  return Number.isSafeInteger(transfer.frozenTransfer) && transfer.frozenTransfer >= 0;
}

function resolveTransferAmount(transfer, victimRemaining) {
  if (hasFrozenTransfer(transfer)) {
    return transfer.frozenTransfer;
  }
  return resolveLeechDrain(transfer.earnedTransfer, victimRemaining);
}

// earnedTransfer for ONE leech = floor(attackerWindowSteps / ratio), no cap.
//
// attackerWindowSteps = the leecher's (sourceUserId) eligible steps in
// [startsAt, min(expiresAt|now, now)], counting ONLY CLOSED buckets — samples
// whose periodEnd <= now (§3.4, Five-Minute Step Samples). A not-yet-closed
// bucket is excluded until it closes, because its prorated contribution shifts on
// every re-upload (its periodEnd is the live endTime). Excluding it makes the
// transferred total monotonic — the property that matters once steps are minted
// to a visible recipient. With 5-min buckets the lag drops from up to 60 min to
// up to one bucket; identical for hour-aligned closed data.
//
// Capability-detected: the real StepSample model exposes sumClosedStepsInWindow
// and takes the generalized (bucket-size-agnostic) path. Injected unit-test fakes
// that only implement sumStepsInWindow fall back to the legacy top-of-current-hour
// clamp so their assertions (and the "in-progress hour bucket is excluded" test)
// stay valid.
async function computeLeechEarnedTransfer(effect, stepSampleModel, now, { resolveExpiry = true } = {}) {
  if (!effect || !effect.sourceUserId) return 0;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const windowStart = new Date(effect.startsAt).getTime();
  const alreadyFrozen = frozenLeechAmount(effect);
  if (alreadyFrozen != null) return alreadyFrozen;
  const cutoff = leechExpiryBoundary(effect, stepSampleModel);
  const rawEnd = cutoff ? cutoff.getTime() : nowMs;
  if (rawEnd <= nowMs && effect.expiresAt) {
    const frozen = frozenLeechAmount(effect);
    if (frozen != null) return frozen;
    if (resolveExpiry && typeof stepSampleModel.resolveLeechExpiry === "function") {
      const finalized = await stepSampleModel.resolveLeechExpiry(effect, now, stepSampleModel);
      if (finalized != null) return finalized;
    }
  }

  let steps;
  if (typeof stepSampleModel.sumClosedStepsInWindow === "function") {
    const windowEnd = Math.min(rawEnd, nowMs);
    if (!(windowEnd > windowStart)) return 0;
    steps = await stepSampleModel.sumClosedStepsInWindow(
      effect.sourceUserId,
      new Date(windowStart),
      new Date(windowEnd),
      new Date(nowMs)
    );
  } else {
    const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
    const windowEnd = Math.min(rawEnd, currentHourStart);
    if (!(windowEnd > windowStart)) return 0;
    steps = await stepSampleModel.sumStepsInWindow(
      effect.sourceUserId,
      new Date(windowStart),
      new Date(windowEnd)
    );
  }
  if (!(steps > 0)) return 0;
  return Math.floor(steps / leechRatio(effect));
}

// Pure resolution of every leech in a race against victim availability.
//
// entries: [{ participantId, userId, preLeechTotal, leechTransfers }]
//   * preLeechTotal — the participant's total after ALL other modifiers
//     (freeze/buff/reverse/boost/bonus), already floored at zero.
//   * leechTransfers — the leeches TARGETING this participant (victim):
//       [{ effectId, startsAt, sourceUserId, earnedTransfer }]
//
// Only NON-frozen participants (active racers) should be passed in; finished /
// forfeited participants keep their frozen totals and neither drain nor credit.
//
// Returns Map(participantId -> finalTotal). Frozen debit/credit amounts are
// reserved first. Live claims resolve in (startsAt, effectId) order:
// actualTransfer = min(earnedTransfer, victimRemaining),
// victimRemaining -= actualTransfer, attacker credit += actualTransfer. The
// displayed victim total never goes negative. A frozen debit may exceed a later
// corrected balance without clawing back its attacker credit. Incoming credits
// remain non-drainable, preserving the existing credit-after-floor rule.
// Attacker credit lands only on a participant present in `entries`
// (a finished/absent attacker's credit is dropped, matching the frozen-total rule);
// the victim is still drained either way.
function applyLeechTransfers(entries, { onTransfer = null, frozenVictimTransfers = [] } = {}) {
  const remaining = new Map(); // participantId -> drainable balance (pre-leech)
  const credit = new Map(); // userId -> steps credited as attacker
  const participantIdByUser = new Map(); // userId -> participantId (first seen)

  for (const e of entries) {
    remaining.set(e.participantId, e.preLeechTotal);
    if (!participantIdByUser.has(e.userId)) {
      participantIdByUser.set(e.userId, e.participantId);
    }
  }

  const all = frozenVictimTransfers.filter(hasFrozenTransfer).map(row => ({ ...row }));
  for (const e of entries) {
    for (const t of e.leechTransfers || []) {
      all.push({ victimParticipantId: e.participantId, ...t });
    }
  }
  // Reserve immutable debits first; live claims cannot spend already committed
  // balance. Each group retains the canonical chronological order.
  all.sort((a, b) => {
    const frozenOrder = Number(hasFrozenTransfer(b)) - Number(hasFrozenTransfer(a));
    if (frozenOrder !== 0) return frozenOrder;
    const sa = new Date(a.startsAt).getTime();
    const sb = new Date(b.startsAt).getTime();
    if (sa !== sb) return sa - sb;
    return String(a.effectId).localeCompare(String(b.effectId));
  });

  for (const t of all) {
    const victimRemaining = remaining.get(t.victimParticipantId) ?? 0;
    const actual = resolveTransferAmount(t, victimRemaining);
    if (typeof onTransfer === "function") {
      onTransfer({
        effectId: t.effectId,
        startsAt: t.startsAt,
        sourceUserId: t.sourceUserId,
        victimParticipantId: t.victimParticipantId,
        actualTransfer: actual,
      });
    }
    if (actual <= 0) continue;
    remaining.set(t.victimParticipantId, victimRemaining - actual);
    if (t.sourceUserId) {
      credit.set(t.sourceUserId, (credit.get(t.sourceUserId) || 0) + actual);
    }
  }

  const finals = new Map();
  for (const e of entries) finals.set(e.participantId, Math.max(0, remaining.get(e.participantId)));
  for (const [userId, amount] of credit) {
    const pid = participantIdByUser.get(userId);
    if (pid == null) continue; // attacker not among active participants — drop credit
    finals.set(pid, (finals.get(pid) || 0) + amount);
  }
  return finals;
}

// Metadata writes follow the caller's existing ownership: captured by the
// queue, discarded by read-only scoring, or persisted by fenced settlement.
async function applyLeechTransfersAndFinalize(entries, { effectModel, persist = false, onTransfer = null, race = null } = {}) {
  let frozenVictimTransfers = [];
  const frozenIds = new Set((race?.participants || []).filter(row => row.finishedAt || row.forfeitedAt).map(row => row.id));
  if (frozenIds.size && typeof effectModel?.findRaceEffectsByType === "function") {
    const rows = await effectModel.findRaceEffectsByType(race.id, "LEECH");
    frozenVictimTransfers = rows.filter(row => frozenIds.has(row.targetParticipantId) && frozenLeechAmount(row) != null)
      .map(row => ({ effectId: row.id, startsAt: row.startsAt, sourceUserId: row.sourceUserId,
        victimParticipantId: row.targetParticipantId, frozenTransfer: frozenLeechAmount(row),
        earnedTransfer: frozenLeechAmount(row) }));
  }
  const pending = new Map();
  const collect = (effect, transfer = null) => {
    if (transfer && frozenLeechAmount(effect) != null) transfer.frozenTransfer = frozenLeechAmount(effect);
    if (pending.has(effect.id)) { if (transfer) pending.set(effect.id, transfer); return; }
    for (const previous of effect.leechAdditionalFinalizations || []) collect(previous);
    const row = transfer || { effectId: effect.id, expiryFinalization: effect };
    const amount = frozenLeechAmount(effect);
    if (amount != null) row.frozenTransfer = amount;
    pending.set(effect.id, row);
  };
  for (const entry of entries) for (const transfer of entry.leechTransfers || []) {
    if (transfer.expiryFinalization) collect(transfer.expiryFinalization, transfer);
  }
  if (!persist || !pending.size) return applyLeechTransfers(entries, { onTransfer, frozenVictimTransfers });
  const amounts = new Map();
  applyLeechTransfers(entries, { frozenVictimTransfers, onTransfer: row => amounts.set(row.effectId, row.actualTransfer) });
  if (persist && pending.size) {
    for (const [id, transfer] of pending) {
      const metadata = finalMetadata(transfer.expiryFinalization, frozenLeechAmount(transfer.expiryFinalization) ?? amounts.get(id) ?? 0);
      const saved = await effectModel.update(id, { metadata });
      // The database preserves an existing immutable stamp if a concurrent
      // legacy reader already finalized it. Score from that winning value.
      transfer.frozenTransfer = frozenLeechAmount(saved) ?? metadata.leechFinalV1.amount;
      transfer.expiryFinalization.leechFinalizationPending = false;
    }
  }
  return applyLeechTransfers(entries, { onTransfer, frozenVictimTransfers });
}

// Incremental form of applyLeechTransfers for chronological attribution. A
// local/Hitchhike score change can alter the floor allocation of earlier
// leeches, so only that victim's ordered transfer list is replayed; credits do
// not recursively become drainable and therefore no graph-wide recompute is
// required. getFinalTotals is exactly equivalent to applyLeechTransfers over
// the current state.
function createIncrementalLeechTransferState(entries = []) {
  const preLeech = new Map();
  const participantIdByUser = new Map();
  const userIdByParticipant = new Map();
  const transfersByVictim = new Map();
  const actualByEffect = new Map();
  const creditByUser = new Map();
  const drainedByVictim = new Map();

  for (const entry of entries) {
    preLeech.set(entry.participantId, Number(entry.preLeechTotal) || 0);
    userIdByParticipant.set(entry.participantId, entry.userId);
    if (!participantIdByUser.has(entry.userId)) {
      participantIdByUser.set(entry.userId, entry.participantId);
    }
  }

  const addCredit = (userId, delta) => {
    if (!userId || delta === 0) return;
    const next = (creditByUser.get(userId) || 0) + delta;
    if (next === 0) creditByUser.delete(userId);
    else creditByUser.set(userId, next);
  };

  const recomputeVictim = (participantId) => {
    const rows = transfersByVictim.get(participantId) || [];
    for (const row of rows) {
      addCredit(row.sourceUserId, -(actualByEffect.get(row.effectId) || 0));
      actualByEffect.delete(row.effectId);
    }
    rows.sort((a, b) => {
      const frozenOrder = Number(hasFrozenTransfer(b)) - Number(hasFrozenTransfer(a));
      if (frozenOrder !== 0) return frozenOrder;
      const at = new Date(a.startsAt).getTime();
      const bt = new Date(b.startsAt).getTime();
      if (at !== bt) return at - bt;
      return String(a.effectId).localeCompare(String(b.effectId));
    });
    let remaining = preLeech.get(participantId) || 0;
    let drained = 0;
    for (const row of rows) {
      const actual = resolveTransferAmount(row, remaining);
      actualByEffect.set(row.effectId, actual);
      addCredit(row.sourceUserId, actual);
      remaining -= actual;
      drained += actual;
    }
    drainedByVictim.set(participantId, drained);
  };

  return {
    addTransfer(transfer) {
      const victim = transfer.victimParticipantId;
      if (!transfersByVictim.has(victim)) transfersByVictim.set(victim, []);
      transfersByVictim.get(victim).push({ ...transfer });
      recomputeVictim(victim);
    },
    setPreLeechTotal(participantId, total) {
      preLeech.set(participantId, Number(total) || 0);
      recomputeVictim(participantId);
    },
    getPreLeechTotal(participantId) {
      return preLeech.get(participantId) || 0;
    },
    getFinalTotals() {
      const totals = new Map();
      for (const [participantId, total] of preLeech) {
        const userId = userIdByParticipant.get(participantId);
        totals.set(
          participantId,
          Math.max(0, total - (drainedByVictim.get(participantId) || 0)) +
            (creditByUser.get(userId) || 0),
        );
      }
      return totals;
    },
  };
}

module.exports = {
  leechExpiryBoundary,
  frozenLeechAmount,
  finalMetadata,
  applyLeechTransfersAndFinalize,
  LEECH_DEFAULT_RATIO,
  leechRatio,
  resolveLeechDrain,
  computeLeechEarnedTransfer,
  applyLeechTransfers,
  createIncrementalLeechTransferState,
};
