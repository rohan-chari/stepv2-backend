// Hitchhike 1:1 raw-step COPY scoring (§7.3).
//
// A HITCHHIKE effect on target T, sourced by caster C, COPIES T's recorded raw
// physical steps during the scoring window into C's race score. It is NOT
// zero-sum: T loses nothing, C gains a copy. So — unlike Leech — there is no
// victim-availability resolution; the copy is a plain additive term.
//
// Structure deliberately mirrors src/utils/leechTransfers.js so the same math
// drives live progress, background resolution, and settlement ("they move
// together"):
//   * computeHitchhikeCopiedSteps — async, per-effect: reads the TARGET's
//     in-window steps and returns floor(steps * copyRatio). Excludes the
//     in-progress hour bucket so the number is monotonic across recomputes.
//   * collectRaceHitchhikeCopies — async, per-race: ONE bulk query for every
//     HITCHHIKE row in the race (including rows on finished/forfeited targets,
//     whose already-accrued copy must survive their exit), clamping each
//     window per §7.2/§7.3.
//   * applyHitchhikeCopies — pure/sync: folds the per-caster credit into each
//     participant's preLeechTotal. It MUST run BEFORE applyLeechTransfers so
//     copied steps are ordinary, drainable steps for every downstream purpose
//     (§7.1 "copied steps ARE drainable by a Leech on the caster").
//
// CRITICAL (§7.1): the copy term is added at the preLeechTotal ASSEMBLY and is
// NEVER folded into `baseAdjusted`. computeBoxEffectiveSteps is
// max(0, baseAdjusted) (src/modules/powerups/boxSteps.js), so keeping the term out of
// baseAdjusted is what structurally prevents Hitchhike from advancing mystery
// box progress — no special case is needed or wanted.

const HOUR_MS = 60 * 60 * 1000;

// Default copy strength when an effect row carries no (or malformed)
// `metadata.copyRatio`. Mirrors leechRatio: reading it per-effect makes the copy
// strength a DATA-ONLY tuning lever (no code change, no migration).
const HITCHHIKE_DEFAULT_COPY_RATIO = 1;

function hitchhikeCopyRatio(effect) {
  const raw = Number(
    effect && effect.metadata ? effect.metadata.copyRatio : undefined
  );
  return Number.isFinite(raw) && raw > 0 ? raw : HITCHHIKE_DEFAULT_COPY_RATIO;
}

function toMsOrNull(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// copiedSteps for ONE hitchhike = floor(targetWindowSteps * copyRatio).
//
// targetWindowSteps = the TARGET's (targetUserId) eligible steps in
// [startsAt, min(expiresAt|now, raceEndsAt, targetFinishedAt|targetForfeitedAt,
// topOfCurrentHour)].
//
// The in-progress hour bucket is EXCLUDED until it closes, because that bucket's
// prorated contribution shifts on every re-upsert (its periodEnd is the live
// endTime, not the hour boundary). Excluding it makes the copied total monotonic
// — the property that matters once steps are minted to a visible recipient. This
// is exactly why Hitchhike is a 60-minute powerup and not a 30-minute one (§7.1).
//
// The finish/forfeit clamp exists because StepSample rows keep accruing from
// real-world walking after a participant leaves a race; without it a caster
// would copy steps the target took once they were out (§7.2).
async function computeHitchhikeCopiedSteps(
  effect,
  stepSampleModel,
  now,
  { raceEndsAt = null, targetFinishedAt = null, targetForfeitedAt = null } = {}
) {
  if (!effect || !effect.targetUserId || !effect.sourceUserId) return 0;
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;

  const windowStart = toMsOrNull(effect.startsAt);
  if (windowStart == null) return 0;

  const ends = [
    toMsOrNull(effect.expiresAt) ?? nowMs,
    toMsOrNull(raceEndsAt),
    toMsOrNull(targetFinishedAt),
    toMsOrNull(targetForfeitedAt),
  ].filter((ms) => ms != null);
  const rawEnd = Math.min(...ends);
  const windowEnd = Math.min(rawEnd, currentHourStart);
  if (!(windowEnd > windowStart)) return 0;

  const steps = await stepSampleModel.sumStepsInWindow(
    effect.targetUserId,
    new Date(windowStart),
    new Date(windowEnd)
  );
  if (!(steps > 0)) return 0;
  return Math.floor(steps * hitchhikeCopyRatio(effect));
}

// Every hitchhike copy in a race, in ONE bulk query.
//
// Frozen (finished/forfeited) participants are deliberately INCLUDED as targets:
// their link's window is clamped to their exit instant, but the copy accrued
// BEFORE they left still belongs to the caster (§7.2 — "the link row is left in
// place and expires normally; only the window is clamped"). This differs from
// Leech, where a frozen participant neither drains nor credits.
//
// Capability-detected: a model without the bulk method (injected minimal test
// fakes) yields no copies, so every pre-existing scoring fixture is unchanged.
async function collectRaceHitchhikeCopies({
  raceId,
  raceEndsAt = null,
  participants = [],
  raceActiveEffectModel,
  stepSampleModel,
  now,
}) {
  if (
    !raceActiveEffectModel ||
    typeof raceActiveEffectModel.findRaceEffectsByType !== "function"
  ) {
    return [];
  }

  const rows = await raceActiveEffectModel.findRaceEffectsByType(
    raceId,
    "HITCHHIKE"
  );
  if (!rows || rows.length === 0) return [];

  const byParticipantId = new Map();
  const byUserId = new Map();
  for (const p of participants || []) {
    byParticipantId.set(p.id, p);
    if (!byUserId.has(p.userId)) byUserId.set(p.userId, p);
  }

  const copies = [];
  for (const effect of rows) {
    const target =
      byParticipantId.get(effect.targetParticipantId) ||
      byUserId.get(effect.targetUserId) ||
      null;
    const copiedSteps = await computeHitchhikeCopiedSteps(
      effect,
      stepSampleModel,
      now,
      {
        raceEndsAt,
        targetFinishedAt: target ? target.finishedAt : null,
        targetForfeitedAt: target ? target.forfeitedAt : null,
      }
    );
    if (copiedSteps <= 0) continue;
    copies.push({
      effectId: effect.id,
      startsAt: effect.startsAt,
      sourceUserId: effect.sourceUserId,
      targetUserId: effect.targetUserId,
      copiedSteps,
    });
  }
  // Deterministic order so live display and settlement always agree.
  copies.sort((a, b) => {
    const sa = new Date(a.startsAt).getTime();
    const sb = new Date(b.startsAt).getTime();
    if (sa !== sb) return sa - sb;
    return String(a.effectId).localeCompare(String(b.effectId));
  });
  return copies;
}

function hitchhikeCreditBySourceUser(copies) {
  const credit = new Map();
  for (const c of copies || []) {
    if (!c || !c.sourceUserId) continue;
    const amount = Number(c.copiedSteps) || 0;
    if (amount <= 0) continue;
    credit.set(c.sourceUserId, (credit.get(c.sourceUserId) || 0) + amount);
  }
  return credit;
}

// The SHARED insertion point. Both duplicated assembly sites (getRaceProgress and
// raceStateResolution / raceExpiry) call this on the SAME entry shape they hand
// to applyLeechTransfers, immediately before that call. Adding it in one site and
// not the other is the live-vs-settlement divergence §7.3 warns about; the parity
// test in test/queries/hitchhikeScoring.test.js fails if that happens.
//
// Returns a NEW entry array (inputs are never mutated). A caster who is not among
// the entries (finished, forfeited, or absent) simply drops their credit, which
// matches the frozen-total rule used everywhere else.
function applyHitchhikeCopies(entries, copies) {
  const credit = hitchhikeCreditBySourceUser(copies);
  if (credit.size === 0) return entries;
  return entries.map((e) => {
    const add = credit.get(e.userId) || 0;
    if (add <= 0) return e;
    return { ...e, preLeechTotal: (e.preLeechTotal || 0) + add };
  });
}

module.exports = {
  HITCHHIKE_DEFAULT_COPY_RATIO,
  hitchhikeCopyRatio,
  computeHitchhikeCopiedSteps,
  collectRaceHitchhikeCopies,
  hitchhikeCreditBySourceUser,
  applyHitchhikeCopies,
};
