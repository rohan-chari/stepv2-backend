// Read-only finalization calculation. The caller persists the returned metadata
// through its existing race write fence; this module never writes source rows.
const { prisma } = require("../../db");

const { frozenLeechAmount, finalMetadata, leechExpiryBoundary } = require("./leechTransfers");

const camelRow = (row) => Object.fromEntries(Object.entries(row || {}).map(([key, value]) =>
  [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));

async function calculateLeechExpiry(effect, stepSampleModel, observedAt) {
  const frozen = frozenLeechAmount(effect);
  if (frozen != null) return frozen;
  const checkpointRows = effect.leechCheckpoint
    ? Object.values(effect.leechCheckpoint)
    : await prisma.$queryRawUnsafe(
      `SELECT * FROM leech_expiry_checkpoints WHERE effect_id=$1 ORDER BY kind`, effect.id);
  // Pre-change effects intentionally retain their current allocation for their
  // one-time legacy freeze. Never invent historical checkpoints for them.
  if (!checkpointRows.length) return null;
  const checkpoints = Object.fromEntries(checkpointRows.map(row => [row.kind, row]));
  if (!checkpoints.daily || !checkpoints.bonus || !checkpoints.hitchhike) {
    throw new Error("LEECH_EXPIRY_CHECKPOINT_INCOMPLETE");
  }
  const { RaceActiveEffect } = require("./models/raceActiveEffect");
  const { GlobalStepEvent } = require("../steps/models/globalStepEvent");
  const { eventsForUser } = require("../steps/services/globalStepEventEntitlement");
  const { calculateBaseAdjusted, calculateCurrentTotal } = require("../races/services/raceStateResolution");
  const { collectRaceHitchhikeCopies, applyHitchhikeCopies } = require("./hitchhikeCopies");
  const context = stepSampleModel.leechBoundaryContext;
  const race = context?.races?.find(row => row.id === effect.raceId) ||
    await prisma.race.findUnique({ where: { id: effect.raceId }, include: { participants: true } });
  if (!race) throw new Error("LEECH_EXPIRY_RACE_MISSING");
  const participant = race.participants.find(row => row.id === effect.targetParticipantId);
  if (!participant) throw new Error("LEECH_EXPIRY_VICTIM_MISSING");
  const boundary = leechExpiryBoundary(effect, {
    leechBoundaryContext: { ...context, races: [race] },
  });
  effect.leechFinalBoundaryAt = boundary;
  // The shared live scorer may read the entire start day. Every source sample
  // read here is clipped independently, while daily rows remain checkpointed.
  const clip = (start, end) => ({ start, end: new Date(Math.min(new Date(end).getTime(), boundary.getTime())) });
  const boundarySamples = {
    ...stepSampleModel,
    resolveLeechExpiry: undefined,
    async sumStepsInWindow(userId, start, end) {
      const window = clip(start, end);
      return new Date(window.end) <= new Date(window.start) ? 0 :
        stepSampleModel.sumStepsInWindow(userId, window.start, window.end);
    },
    async sumStepsInWindows(userId, windows) {
      const clipped = windows.map(window => {
        const result = clip(window.start, window.end);
        if (new Date(result.end) < new Date(result.start)) result.end = result.start;
        return result;
      });
      return typeof stepSampleModel.sumStepsInWindows === "function"
        ? stepSampleModel.sumStepsInWindows(userId, clipped)
        : Promise.all(clipped.map(window => this.sumStepsInWindow(userId, window.start, window.end)));
    },
    async hasAnyInWindow(userId, start, end) {
      const window = clip(start, end);
      return new Date(window.end) <= new Date(window.start) ? false :
        stepSampleModel.hasAnyInWindow(userId, window.start, window.end);
    },
  };
  const baseEffectModel = context?.raceActiveEffectModel || RaceActiveEffect;
  const effectModel = {
    ...baseEffectModel,
    async findEffectsForRaceByTypes(raceId, participantId, types) {
      const byType = await baseEffectModel.findEffectsForRaceByTypes(raceId, participantId, types);
      // Leech is allocated after the complete pre-Leech balance, never inside
      // the victim's modifier or Hitchhike calculation.
      return { ...byType, LEECH: [] };
    },
    async findRaceEffectsByType(raceId, type) {
      const rows = await baseEffectModel.findRaceEffectsByType(raceId, type);
      return type === "HITCHHIKE" ? rows.filter(row => row.sourceUserId === participant.userId) : rows;
    },
  };
  const daily = checkpoints.daily.daily_totals;
  const dayKey = value => new Date(value).toISOString().slice(0, 10);
  const stepsModel = {
    async findByUserIdAndDate(_userId, date) {
      const key = dayKey(date);
      return Object.hasOwn(daily, key) ? { date: key, steps: daily[key] } : null;
    },
    async findByUserIdAndDateRange(_userId, start, end) {
      return Object.entries(daily).filter(([key]) => key >= dayKey(start) && key <= dayKey(end))
        .map(([date, steps]) => ({ date, steps }));
    },
  };
  const hitchhikes = await effectModel.findRaceEffectsByType(race.id, "HITCHHIKE");
  const users = [...new Set([participant.userId, effect.sourceUserId,
    ...hitchhikes.map(row => row.targetUserId)].filter(Boolean))];
  const release = await stepSampleModel.acquireAdditionalUsers?.(users);
  try {
    const eventsByUserId = await GlobalStepEvent.findEligibleByRace({
      raceId: race.id, userIds: users, rangeStart: race.startedAt, rangeEnd: boundary,
    });
    // Daily counters come exclusively from the pre-expiry checkpoint, so the
    // usual live partial-day fallback is safe even during delayed finalization.
    const base = await calculateBaseAdjusted({
      participant, raceStartedAt: race.startedAt, timeZone: race.timezone || "UTC",
      stepsModel, stepSampleModel: boundarySamples, now: boundary,
    });
    const current = await calculateCurrentTotal({
      raceId: race.id, racePowerupsEnabled: race.powerupsEnabled,
      participant: { ...participant, bonusSteps: checkpoints.bonus.bonus_steps },
      baseAdjusted: base.baseAdjusted, hasSampleData: base.hasSampleData,
      raceActiveEffectModel: effectModel, stepSampleModel: boundarySamples,
      globalEvents: eventsForUser(eventsByUserId, participant.userId), now: boundary,
    });
    const savedCopies = checkpoints.hitchhike.hitchhike_captures;
    const attributionCaptureModel = {
      async findFrozen(id) {
        const row = camelRow(savedCopies[id]);
        return row.frozenAt && new Date(row.captureThrough) <= boundary ? row : null;
      },
      async findByEffect(id) { return camelRow(savedCopies[id]); },
      selectBoundaryContribution({ effectId, exactSteps, exactCopiedSteps }) {
        const row = camelRow(savedCopies[effectId]);
        return (Number(row.coarseRawAttributed) || 0) > exactSteps
          ? Number(row.coarseEffectiveContribution) || 0 : exactCopiedSteps;
      },
    };
    const copies = await collectRaceHitchhikeCopies({
      raceId: race.id, raceEndsAt: boundary, participants: race.participants,
      raceActiveEffectModel: effectModel, stepSampleModel: boundarySamples, now: boundary,
      raceTimezone: race.timezone || "UTC", eventsByUserId,
      globalEvents: eventsForUser(eventsByUserId, participant.userId), attributionCaptureModel,
    });
    let available = applyHitchhikeCopies([{
      participantId: participant.id, userId: participant.userId, preLeechTotal: current.total,
    }], copies)[0].preLeechTotal;
    const outgoing = await baseEffectModel.findEffectsForRaceByType(race.id, participant.id, "LEECH");
    const priorBoundary = previous => previous.metadata?.leechFinalV1?.expiresAt
      ? new Date(previous.metadata.leechFinalV1.expiresAt)
      : leechExpiryBoundary(previous, { leechBoundaryContext: { ...context, races: [race] } });
    const unresolvedEarlier = outgoing.filter(previous => previous.id !== effect.id &&
      priorBoundary(previous) <= boundary && frozenLeechAmount(previous) == null);
    if (unresolvedEarlier.length) {
      const checkpointIds = new Set((await prisma.$queryRawUnsafe(
        `SELECT DISTINCT effect_id FROM leech_expiry_checkpoints WHERE effect_id=ANY($1::text[])`,
        unresolvedEarlier.map(row => row.id))).map(row => row.effect_id));
      const legacy = unresolvedEarlier.filter(row => !checkpointIds.has(row.id));
      if (legacy.length) {
        // The user approved preserving current legacy allocations. Resolve
        // that cohort first, so a new Leech cannot claim its reserved balance.
        const { Steps } = require("../steps/models/steps");
        const { computeLeechEarnedTransfer, applyLeechTransfers } = require("./leechTransfers");
        const observedEvents = await GlobalStepEvent.findEligibleByRace({
          raceId: race.id, userIds: users, rangeStart: race.startedAt, rangeEnd: observedAt,
        });
        const observedBase = await calculateBaseAdjusted({
          participant, raceStartedAt: race.startedAt, raceEndsAt: race.endsAt,
          timeZone: race.timezone || "UTC", stepsModel: context?.stepsModel || Steps,
          stepSampleModel, now: observedAt,
        });
        const observedScore = await calculateCurrentTotal({
          raceId: race.id, racePowerupsEnabled: race.powerupsEnabled, participant,
          baseAdjusted: observedBase.baseAdjusted, hasSampleData: observedBase.hasSampleData,
          raceActiveEffectModel: effectModel, stepSampleModel,
          globalEvents: eventsForUser(observedEvents, participant.userId), now: observedAt,
        });
        const currentCaptures = new Map((await prisma.hitchhikeAttributionCapture.findMany({
          where: { effectId: { in: hitchhikes.map(row => row.id) } },
        })).map(row => [row.effectId, row]));
        const observedCopies = await collectRaceHitchhikeCopies({
          raceId: race.id, raceEndsAt: race.endsAt, participants: race.participants,
          raceActiveEffectModel: effectModel, stepSampleModel, now: observedAt,
          raceTimezone: race.timezone || "UTC", eventsByUserId: observedEvents,
          attributionCaptureModel: {
            async findFrozen(id) { const row = currentCaptures.get(id); return row?.frozenAt ? row : null; },
            async findByEffect(id) { return currentCaptures.get(id) || null; },
            selectBoundaryContribution({ effectId, exactSteps, exactCopiedSteps }) {
              const row = currentCaptures.get(effectId);
              return (row?.coarseRawAttributed || 0) > exactSteps ? row.coarseEffectiveContribution : exactCopiedSteps;
            },
          },
        });
        const transfers = [];
        for (const row of outgoing) transfers.push({
          effectId: row.id, startsAt: row.startsAt, sourceUserId: row.sourceUserId,
          frozenTransfer: frozenLeechAmount(row),
          earnedTransfer: await computeLeechEarnedTransfer(row, stepSampleModel, observedAt, { resolveExpiry: false }),
        });
        const legacyById = new Map(legacy.map(row => [row.id, row]));
        applyLeechTransfers(applyHitchhikeCopies([{
          participantId: participant.id, userId: participant.userId,
          preLeechTotal: observedScore.total, leechTransfers: transfers,
        }], observedCopies), { onTransfer({ effectId, actualTransfer }) {
          const row = legacyById.get(effectId);
          if (!row) return;
          row.metadata = finalMetadata(row, actualTransfer);
          row.leechFinalizationPending = true;
        } });
      }
    }
    for (const previous of outgoing) {
      if (previous.id === effect.id || priorBoundary(previous) > boundary) continue;
      // Earlier finalized debits reserve their balance. Equal deadlines retain
      // stable effect ordering rather than recursively resolving each other.
      if (priorBoundary(previous).getTime() === boundary.getTime() &&
          String(previous.id) >= String(effect.id)) continue;
      let amount = frozenLeechAmount(previous);
      if (amount == null) amount = await calculateLeechExpiry(previous, stepSampleModel, observedAt);
      if (amount == null) throw new Error("LEECH_LEGACY_INITIALIZATION_REQUIRED");
      if (previous.leechFinalizationPending) {
        (effect.leechAdditionalFinalizations ||= []).push(previous);
      }
      available -= amount;
    }
    // Finalization includes the clipped contribution of an accepted sample
    // overlapping expiry. The live closed-bucket gate must not decide whether
    // that same final contribution exists based on worker delay.
    const { leechRatio } = require("./leechTransfers");
    const earned = Math.floor(await boundarySamples.sumStepsInWindow(
      effect.sourceUserId, effect.startsAt, boundary) / leechRatio(effect));
    const amount = Math.min(earned, Math.max(0, available));
    effect.metadata = finalMetadata(effect, amount);
    effect.leechFinalizationPending = true;
    return amount;
  } finally {
    release?.();
  }
}

module.exports = { frozenLeechAmount, finalMetadata, calculateLeechExpiry };
