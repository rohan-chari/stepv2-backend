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

// earnedTransfer for ONE leech = floor(attackerWindowSteps / ratio), no cap.
//
// attackerWindowSteps = the leecher's (sourceUserId) eligible steps in
// [startsAt, min(expiresAt|now, topOfCurrentHour)] — the in-progress hour bucket
// is EXCLUDED until it closes, because that bucket's prorated contribution shifts
// on every re-upsert (its periodEnd is the live endTime, not the hour boundary).
// Excluding it makes the transferred total monotonic — the property that matters
// once steps are minted to a visible recipient. Consequence (accepted): up to an
// hour of lag before a burst of walking lands.
async function computeLeechEarnedTransfer(effect, stepSampleModel, now) {
  if (!effect || !effect.sourceUserId) return 0;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const windowStart = new Date(effect.startsAt).getTime();
  const rawEnd = effect.expiresAt ? new Date(effect.expiresAt).getTime() : nowMs;
  const windowEnd = Math.min(rawEnd, currentHourStart);
  if (!(windowEnd > windowStart)) return 0;

  const steps = await stepSampleModel.sumStepsInWindow(
    effect.sourceUserId,
    new Date(windowStart),
    new Date(windowEnd)
  );
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
// Returns Map(participantId -> finalTotal). For each leech, resolved in
// (startsAt, effectId) order: actualTransfer = min(earnedTransfer, victimRemaining),
// victimRemaining -= actualTransfer, attacker credit += actualTransfer. The
// victim never goes negative; the attacker is credited exactly what was drained
// (zero-sum). Attacker credit lands only on a participant present in `entries`
// (a finished/absent attacker's credit is dropped, matching the frozen-total rule);
// the victim is still drained either way.
function applyLeechTransfers(entries) {
  const remaining = new Map(); // participantId -> drainable balance (pre-leech)
  const credit = new Map(); // userId -> steps credited as attacker
  const participantIdByUser = new Map(); // userId -> participantId (first seen)

  for (const e of entries) {
    remaining.set(e.participantId, e.preLeechTotal);
    if (!participantIdByUser.has(e.userId)) {
      participantIdByUser.set(e.userId, e.participantId);
    }
  }

  const all = [];
  for (const e of entries) {
    for (const t of e.leechTransfers || []) {
      all.push({ victimParticipantId: e.participantId, ...t });
    }
  }
  // Deterministic order so live display and settlement always agree.
  all.sort((a, b) => {
    const sa = new Date(a.startsAt).getTime();
    const sb = new Date(b.startsAt).getTime();
    if (sa !== sb) return sa - sb;
    return String(a.effectId).localeCompare(String(b.effectId));
  });

  for (const t of all) {
    const victimRemaining = remaining.get(t.victimParticipantId) ?? 0;
    const actual = Math.max(0, Math.min(t.earnedTransfer || 0, victimRemaining));
    if (actual <= 0) continue;
    remaining.set(t.victimParticipantId, victimRemaining - actual);
    if (t.sourceUserId) {
      credit.set(t.sourceUserId, (credit.get(t.sourceUserId) || 0) + actual);
    }
  }

  const finals = new Map();
  for (const e of entries) finals.set(e.participantId, remaining.get(e.participantId));
  for (const [userId, amount] of credit) {
    const pid = participantIdByUser.get(userId);
    if (pid == null) continue; // attacker not among active participants — drop credit
    finals.set(pid, (finals.get(pid) || 0) + amount);
  }
  return finals;
}

module.exports = {
  LEECH_DEFAULT_RATIO,
  leechRatio,
  computeLeechEarnedTransfer,
  applyLeechTransfers,
};
