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
const {
  computeEffectModifiers,
  computeSnapshotEffectiveTotal,
  createIncrementalEffectScoreCapture,
} = require("../races/services/effectiveStepScoring");
const { eventsForUser } = require("../steps/services/globalStepEventEntitlement");
const {
  HitchhikeAttributionCapture,
} = require("./models/hitchhikeAttributionCapture");
const {
  getTimeZoneParts,
  zonedDateTimeToUtc,
} = require("../../shared/time/week");

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

function hitchhikeScoringWindow(effect, now, {raceEndsAt=null,targetFinishedAt=null,targetForfeitedAt=null}={}) {
  if (!effect?.targetUserId || !effect?.sourceUserId) return null;
  const nowMs=toMsOrNull(now);
  const windowStart=toMsOrNull(effect.startsAt);
  if (windowStart===null) return null;
  const scoringVersion=Number(effect.metadata?.scoringVersion) || 1;
  const rawEnd=Math.min(...[toMsOrNull(effect.expiresAt) ?? nowMs,toMsOrNull(raceEndsAt),
    toMsOrNull(targetFinishedAt),toMsOrNull(targetForfeitedAt)].filter((value)=>value!==null));
  const windowEnd=Math.min(rawEnd,scoringVersion>=3 ? nowMs : Math.floor(nowMs/HOUR_MS)*HOUR_MS);
  return {nowMs,windowStart,windowEnd,rawEnd,scoringVersion};
}

function hitchhikeExactContribution(effect, rawSteps, modifiers) {
  const effective=rawSteps-modifiers.frozenSteps+modifiers.buffedSteps-
    2*modifiers.reversedSteps+(modifiers.globalBoostedSteps || 0);
  return Math.floor(effective*hitchhikeCopyRatio(effect));
}

function hitchhikeFlooredBalance(preLeechTotal, copiedSteps) {
  return Math.max(0,(preLeechTotal || 0)+copiedSteps);
}

function localDayStart(instant, timeZone) {
  try {
    const parts = getTimeZoneParts(instant, timeZone);
    return zonedDateTimeToUtc({
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: 0,
      minute: 0,
      second: 0,
    }, timeZone);
  } catch {
    const date = new Date(instant);
    return new Date(Date.UTC(
      date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    ));
  }
}

function localDayDate(instant, timeZone) {
  try {
    const parts = getTimeZoneParts(instant, timeZone);
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  } catch {
    const date = new Date(instant);
    return new Date(Date.UTC(
      date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
    ));
  }
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
  { raceEndsAt = null, targetFinishedAt = null, targetForfeitedAt = null,
    targetParticipantId = null, raceId = null, raceActiveEffectModel = null,
    globalEvents = [], raceTimezone = "UTC",
    attributionCaptureModel = HitchhikeAttributionCapture } = {}
) {
  const window=hitchhikeScoringWindow(effect,now,{raceEndsAt,targetFinishedAt,targetForfeitedAt});
  if (!window) return 0;
  const {nowMs,windowStart,windowEnd,rawEnd,scoringVersion}=window;

  let existingCapture = null;
  if (scoringVersion === 3 &&
      typeof attributionCaptureModel?.findFrozen === "function") {
    const frozen = await attributionCaptureModel.findFrozen(effect.id);
    if (frozen) return Number(frozen.effectiveContribution) || 0;
    if (typeof attributionCaptureModel.findByEffect === "function") {
      existingCapture = await attributionCaptureModel.findByEffect(effect.id);
    }
  }

  // v1/v2 are frozen compatibility contracts: both intentionally wait for the
  // current hour to close. V3 consumes the target's canonical, timestamped
  // contribution through the current scoring instant so a sparse open sample
  // can raise the target and the 1:1 copy together.
  if (!(windowEnd > windowStart)) return 0;

  const exactSampleSteps = await stepSampleModel.sumStepsInWindow(
    effect.targetUserId,
    new Date(windowStart),
    new Date(windowEnd)
  );
  const exactSteps = Math.max(0, Number(exactSampleSteps) || 0);
  let currentDailySteps = null;

  // V3's fallback is an alternative source, never additive. It is available
  // only when a cast-time checkpoint already exists; a legacy/imported v3 row
  // without one cannot safely distinguish pre-cast walking from post-cast
  // walking and therefore remains sample-only until its first checkpoint.
  if (scoringVersion === 3 &&
      typeof attributionCaptureModel?.readDailySteps === "function") {
    try {
      currentDailySteps = await attributionCaptureModel.readDailySteps(
        effect.targetUserId,
        localDayDate(new Date(windowStart), raceTimezone || "UTC"),
      );
    } catch {
      // Exact timestamped samples remain authoritative when the daily fallback
      // cannot be read.
    }
  }
  if (!(exactSteps > 0) && scoringVersion < 3) return 0;

  if (scoringVersion < 2 || !targetParticipantId || !raceId ||
      typeof raceActiveEffectModel?.findEffectsForRaceByTypes !== "function") {
    return Math.floor(exactSteps * hitchhikeCopyRatio(effect));
  }

  // Run the exact shared leaderboard scorer through an adapter that clips
  // every interval read to this Hitchhike window.
  const types = ["LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "WRONG_TURN", "CAMPFIRE_REST", "RAINSTORM"];
  const byType = await raceActiveEffectModel.findEffectsForRaceByTypes(raceId, targetParticipantId, types);
  const targetEffects = types.flatMap((type) => byType[type] || []);
  const clippedSamples = {
    async sumStepsInWindow(userId, start, end) {
      const clippedStart = new Date(Math.max(new Date(start).getTime(), windowStart));
      const clippedEnd = new Date(Math.min(new Date(end).getTime(), windowEnd));
      if (!(clippedEnd > clippedStart)) return 0;
      return stepSampleModel.sumStepsInWindow(userId, clippedStart, clippedEnd);
    },
  };
  const modifiers = await computeEffectModifiers(
    targetEffects, exactSteps, effect.targetUserId, clippedSamples, true,
    globalEvents.length ? { globalEvents, now: new Date(windowEnd) } : null,
    new Date(windowEnd)
  );
  const exactCopiedSteps = hitchhikeExactContribution(effect,exactSteps,modifiers);
  if (scoringVersion === 3 && typeof attributionCaptureModel?.selectBoundaryContribution === "function") {
    return attributionCaptureModel.selectBoundaryContribution({
      effectId: effect.id, exactSteps, exactCopiedSteps, rawEnd, nowMs,
    });
  }
  if (scoringVersion !== 3 ||
      typeof attributionCaptureModel?.replaceV3 !== "function") {
    return exactCopiedSteps;
  }

  const scoringInput =
    typeof attributionCaptureModel.readScoringInput === "function"
      ? await attributionCaptureModel.readScoringInput(effect.targetUserId)
      : { generation: 0n, fingerprint: null };
  const frozenAt = rawEnd <= nowMs ? new Date(rawEnd) : null;
  const castDailySteps = existingCapture
    ? Math.max(0, Number(existingCapture.castDailySteps) || 0)
    : Math.max(0, Number(currentDailySteps) || 0);

  // Establish the immutable cast checkpoint before reserving any coarse
  // source. A v3 row first encountered after cast cannot distinguish pre-cast
  // walking, so that first observation is a baseline only.
  const checkpointCapture = await attributionCaptureModel.replaceV3({
    effect,
    raceTimezone: raceTimezone || "UTC",
    castDayStart: localDayStart(new Date(windowStart), raceTimezone || "UTC"),
    scoringInputGeneration: scoringInput.generation,
    scoringInputFingerprint: scoringInput.fingerprint,
    castDailySteps,
    rawSourceKind: "EXACT_SAMPLES",
    rawSourceHighWater: Math.max(0, Math.floor(exactSteps)),
    effectiveContribution: exactCopiedSteps,
    captureThrough: new Date(windowEnd),
    frozenAt,
  });

  let coarseRaw = Math.max(
    0,
    Number(checkpointCapture?.coarseRawAttributed ??
      existingCapture?.coarseRawAttributed) || 0,
  );
  let coarseEffective = Number(
    checkpointCapture?.coarseEffectiveContribution ??
      existingCapture?.coarseEffectiveContribution,
  ) || 0;
  const canAdvanceCoarse = existingCapture && rawEnd > nowMs &&
    currentDailySteps != null &&
    typeof attributionCaptureModel.claimAndCreditCoarseDelta === "function";
  if (canAdvanceCoarse) {
    const claim = await attributionCaptureModel.claimAndCreditCoarseDelta({
      effect,
      currentDailySteps,
      copyRatio: hitchhikeCopyRatio(effect),
      captureThrough: new Date(windowEnd),
      effectiveContributionAtRaw: (rawTotal) =>
        computeSnapshotEffectiveTotal(targetEffects, rawTotal),
    });
    const claimedRaw = Math.max(0, Number(claim?.claimedRaw) || 0);
    if (claimedRaw > 0) {
      coarseRaw = Math.max(0, Number(claim.row?.coarseRawAttributed) || 0);
      coarseEffective = Number(claim.row?.coarseEffectiveContribution) || 0;
    } else if (claim?.row) {
      coarseRaw = Math.max(0, Number(claim.row.coarseRawAttributed) || 0);
      coarseEffective = Number(claim.row.coarseEffectiveContribution) || 0;
    }
  }

  const useCoarse = coarseRaw > exactSteps;
  const selectedRaw = useCoarse ? coarseRaw : exactSteps;
  const selectedEffective = useCoarse ? coarseEffective : exactCopiedSteps;
  const capture = await attributionCaptureModel.replaceV3({
    effect,
    raceTimezone: raceTimezone || "UTC",
    castDayStart: localDayStart(new Date(windowStart), raceTimezone || "UTC"),
    scoringInputGeneration: scoringInput.generation,
    scoringInputFingerprint: scoringInput.fingerprint,
    castDailySteps,
    rawSourceKind: useCoarse ? "COARSE_DAILY_DELTA" : "EXACT_SAMPLES",
    rawSourceHighWater: Math.max(0, Math.floor(selectedRaw)),
    effectiveContribution: selectedEffective,
    captureThrough: new Date(windowEnd),
    frozenAt,
  });
  return Number(capture?.effectiveContribution ?? selectedEffective) || 0;
}

// Instrumented form used by active-boundary attribution. It reads the target's
// Hitchhike window once, then accepts target effects in canonical chronological
// order and updates the copied artifact without invoking the full scorer for
// every prefix.
async function createIncrementalHitchhikeCopyCapture({
  effect,
  targetEffects = [],
  stepSampleModel,
  now,
  raceEndsAt = null,
  targetFinishedAt = null,
  targetForfeitedAt = null,
  targetParticipantId = null,
  raceId = null,
  globalEvents = [],
}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const currentHourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const scoringVersion = Number(effect?.metadata?.scoringVersion) || 1;
  const windowStart = toMsOrNull(effect?.startsAt);
  const ends = [
    toMsOrNull(effect?.expiresAt) ?? nowMs,
    toMsOrNull(raceEndsAt),
    toMsOrNull(targetFinishedAt),
    toMsOrNull(targetForfeitedAt),
    scoringVersion >= 3 ? nowMs : currentHourStart,
  ].filter((ms) => ms != null);
  const windowEnd = ends.length ? Math.min(...ends) : currentHourStart;
  if (!effect?.targetUserId || !effect?.sourceUserId || windowStart == null ||
      !(windowEnd > windowStart)) {
    return { applyEffect() {}, getCopiedSteps() { return 0; } };
  }

  const steps = await stepSampleModel.sumStepsInWindow(
    effect.targetUserId,
    new Date(windowStart),
    new Date(windowEnd),
  );
  if (!(steps > 0)) {
    return { applyEffect() {}, getCopiedSteps() { return 0; } };
  }
  const ratio = hitchhikeCopyRatio(effect);
  if (scoringVersion < 2 || !targetParticipantId || !raceId) {
    const copiedSteps = Math.floor(steps * ratio);
    return { applyEffect() {}, getCopiedSteps() { return copiedSteps; } };
  }

  const supported = new Set([
    "LEG_CRAMP", "QUICKSAND", "RUNNERS_HIGH", "WRONG_TURN",
    "CAMPFIRE_REST", "RAINSTORM",
  ]);
  const scoringEffects = targetEffects.filter((row) => supported.has(row.type));
  const clippedSamples = {
    async sumStepsInWindows(userId, windows) {
      const clipped = windows.map((window) => ({
        start: new Date(Math.max(new Date(window.start).getTime(), windowStart)),
        end: new Date(Math.min(new Date(window.end).getTime(), windowEnd)),
      }));
      if (typeof stepSampleModel.sumStepsInWindows === "function") {
        return stepSampleModel.sumStepsInWindows(userId, clipped);
      }
      return Promise.all(clipped.map((window) =>
        window.end > window.start
          ? stepSampleModel.sumStepsInWindow(userId, window.start, window.end)
          : 0));
    },
  };
  const modifierCapture = await createIncrementalEffectScoreCapture({
    effects: scoringEffects,
    rawTotal: steps,
    userId: effect.targetUserId,
    stepSampleModel: clippedSamples,
    hasSampleData: true,
    now: new Date(windowEnd),
    windowStart: new Date(windowStart),
    windowEnd: new Date(windowEnd),
    globalEvents,
  });
  return {
    applyEffect(row) {
      if (supported.has(row.type)) modifierCapture.applyEffect(row);
    },
    getCopiedSteps() {
      return Math.floor(modifierCapture.getRawTotal() * ratio);
    },
  };
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
  globalEvents = [],
  eventsByUserId = null,
  raceTimezone = "UTC",
  attributionCaptureModel = HitchhikeAttributionCapture,
  prepareSampleUsers = null,
  releaseSampleUsers = null,
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
    if (prepareSampleUsers) await prepareSampleUsers([effect.targetUserId]);
    let copiedSteps;
    try {
      copiedSteps = await computeHitchhikeCopiedSteps(
        effect,
        stepSampleModel,
        now,
        {
          raceEndsAt,
          targetFinishedAt: target ? target.finishedAt : null,
          targetForfeitedAt: target ? target.forfeitedAt : null,
          targetParticipantId: target ? target.id : effect.targetParticipantId,
          raceId,
          raceActiveEffectModel,
          globalEvents,
          raceTimezone,
          attributionCaptureModel,
          ...(eventsByUserId
            ? { globalEvents: eventsForUser(eventsByUserId, effect.targetUserId) }
            : {}),
        }
      );
    } finally {
      if (releaseSampleUsers) releaseSampleUsers([effect.targetUserId]);
    }
    // v2 contributions may be negative (Wrong Turn). Legacy computation above
    // remains non-negative; retain either sign and drop only exact zero.
    if (copiedSteps === 0) continue;
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
    if (amount === 0) continue;
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
    if (add === 0) return e;
    return { ...e, preLeechTotal: hitchhikeFlooredBalance(e.preLeechTotal,add) };
  });
}

module.exports = {
  HITCHHIKE_DEFAULT_COPY_RATIO,
  hitchhikeCopyRatio,
  hitchhikeScoringWindow,
  hitchhikeExactContribution,
  hitchhikeFlooredBalance,
  computeHitchhikeCopiedSteps,
  createIncrementalHitchhikeCopyCapture,
  collectRaceHitchhikeCopies,
  hitchhikeCreditBySourceUser,
  applyHitchhikeCopies,
};
