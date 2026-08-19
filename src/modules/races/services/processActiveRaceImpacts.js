const {
  ACTIVE_IMPACT_EXPIRY_TYPES,
} = require("../../powerups/constants/expiryEffectTypes");
const {
  sourceResolvedUnderFence,
} = require("../../../shared/config/activeImpactRolloutFence");

const ELIGIBLE_TIMED_TYPES = new Set(ACTIVE_IMPACT_EXPIRY_TYPES);

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : 0;
}

function buildProcessActiveRaceImpacts() {
  return async function processActiveRaceImpacts({
    tx,
    raceId,
    generation,
    result,
    enabled,
    generationAsOf = null,
    rolloutFence = null,
  }) {
    if (!enabled || !tx || !raceId || !result) {
      return { created: 0, zero: 0, suppressed: 0, failures: 0 };
    }

    const race = await tx.race.findUnique({
      where: { id: raceId },
      select: { status: true },
    });
    if (!race || race.status !== "ACTIVE") {
      const suppressed = await tx.activeRaceImpactWork.updateMany({
        where: { raceId, status: "PENDING" },
        data: { status: "SUPPRESSED_TERMINAL" },
      });
      return { created: 0, zero: 0, suppressed: suppressed.count, failures: 0 };
    }

    const asOf = new Date(
      result.activeImpactCapture?.asOf ||
      result.displayCapture?.asOf ||
      generationAsOf,
    );
    if (!Number.isFinite(asOf.getTime())) {
      return { created: 0, zero: 0, suppressed: 0, failures: 1 };
    }
    const fence = rolloutFence || { enabled: true, enabledFrom: null };
    const [effects, participants, directEvents, existingWork] = await Promise.all([
      tx.raceActiveEffect.findMany({
        where: {
          raceId,
          type: { in: [...ELIGIBLE_TIMED_TYPES] },
          status: { in: ["ACTIVE", "EXPIRED"] },
          expiresAt: { not: null, lte: asOf },
        },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      }),
      tx.raceParticipant.findMany({
        where: { raceId, status: "ACCEPTED" },
        select: {
          id: true,
          userId: true,
          finishedAt: true,
          forfeitedAt: true,
        },
      }),
      tx.racePowerupEvent.findMany({
        where: { raceId, eventType: "POWERUP_USED" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      tx.activeRaceImpactWork.findMany({
        where: { raceId },
        select: {
          recipientUserId: true,
          sourceKind: true,
          sourceId: true,
          calculationVersion: true,
        },
      }),
    ]);
    const existingWorkKeys = new Set(existingWork.map((row) =>
      `${row.recipientUserId}:${row.sourceKind}:${row.sourceId}:${row.calculationVersion}`
    ));
    const hasWork = (recipientUserId, sourceKind, sourceId, version = 1) =>
      existingWorkKeys.has(`${recipientUserId}:${sourceKind}:${sourceId}:${version}`);
    const participantById = new Map(participants.map((row) => [row.id, row]));
    const activeParticipantByUser = new Map(
      participants
        .filter((row) => !row.finishedAt && !row.forfeitedAt)
        .map((row) => [row.userId, row])
    );
    const leechByEffect = new Map(
      (result.activeImpactCapture?.leechResolutions || []).map((row) => [row.effectId, row])
    );
    const hitchhikeByEffect = new Map(
      (result.activeImpactCapture?.hitchhikeCopies || []).map((row) => [row.effectId, row])
    );
    const timedImpactByEffectAndUser = new Map(
      (result.activeImpactCapture?.timedImpacts || []).map((row) => [
        `${row.effectId}:${row.userId}`,
        row,
      ])
    );
    const trailMineImpactByEffectAndUser = new Map(
      (result.activeImpactCapture?.trailMineImpacts || []).map((row) => [
        `${row.effectId}:${row.userId}`,
        row,
      ])
    );
    const defenseImpactBySourceAndUser = new Map(
      (result.activeImpactCapture?.defenseImpacts || []).map((row) => [
        `${row.sourceId}:${row.userId}`,
        row,
      ])
    );

    const eligibleEffects = effects.filter((effect) =>
      effect.metadata?.activeImpactResolutionSkippedVersion !== 1 ||
      existingWork.some((work) =>
        work.sourceKind === "ACTIVE_EFFECT" && work.sourceId === effect.id
      )
    );

    for (const effect of eligibleEffects) {
      const recipients = [];
      if (effect.type === "LEECH") {
        const victim = participantById.get(effect.targetParticipantId);
        if (victim) recipients.push(victim.userId);
        const beneficiary = activeParticipantByUser.get(effect.sourceUserId);
        if (beneficiary) recipients.push(beneficiary.userId);
      } else if (effect.type === "HITCHHIKE") {
        const beneficiary = activeParticipantByUser.get(effect.sourceUserId);
        if (beneficiary) recipients.push(beneficiary.userId);
      } else if (typeof effect.targetUserId === "string") {
        recipients.push(effect.targetUserId);
      }
      for (const recipientUserId of new Set(recipients)) {
        if (
          !hasWork(recipientUserId, "ACTIVE_EFFECT", effect.id) &&
          (
            effect.metadata?.activeImpactResolutionSkippedVersion === 1 ||
            !sourceResolvedUnderFence(fence, effect.expiresAt)
          )
        ) continue;
        await tx.activeRaceImpactWork.upsert({
          where: {
            raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
              raceId,
              recipientUserId,
              sourceKind: "ACTIVE_EFFECT",
              sourceId: effect.id,
              calculationVersion: 1,
            },
          },
          update: {},
          create: {
            raceId,
            recipientUserId,
            sourceKind: "ACTIVE_EFFECT",
            sourceId: effect.id,
            powerupType: effect.type,
            status: "PENDING",
            resolvedAt: effect.expiresAt,
            calculationVersion: 1,
          },
        });
      }
    }
    for (const impact of result.activeImpactCapture?.trailMineImpacts || []) {
      if (!impact?.effectId || !impact?.userId) continue;
      if (
        !hasWork(impact.userId, "ACTIVE_EFFECT", impact.effectId) &&
        !sourceResolvedUnderFence(
          fence,
          impact.resolvedAt || result.activeImpactCapture?.asOf,
        )
      ) continue;
      await tx.activeRaceImpactWork.upsert({
        where: {
          raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
            raceId,
            recipientUserId: impact.userId,
            sourceKind: "ACTIVE_EFFECT",
            sourceId: impact.effectId,
            calculationVersion: 1,
          },
        },
        update: {},
        create: {
          raceId,
          recipientUserId: impact.userId,
          sourceKind: "ACTIVE_EFFECT",
          sourceId: impact.effectId,
          powerupType: "TRAIL_MINE",
          status: "PENDING",
          resolvedAt: impact.resolvedAt || asOf,
          calculationVersion: 1,
        },
      });
    }

    const stampedEvents = directEvents.filter((event) => {
      const metadata = event?.metadata;
      const valid = metadata &&
        metadata.activeImpactCalculationVersion === 1 &&
        typeof metadata.activeImpactPowerupType === "string" &&
        Array.isArray(metadata.activeImpactDeltas);
      if (!valid) return false;
      const resolvedInCurrentEpoch = sourceResolvedUnderFence(fence, event.createdAt);
      return metadata.activeImpactDeltas.some((delta) =>
        delta && typeof delta.userId === "string" &&
        (resolvedInCurrentEpoch || hasWork(delta.userId, "POWERUP_EVENT", event.id))
      );
    });
    const defenseEvents = directEvents.filter((event) => {
      const metadata = event?.metadata;
      const end = new Date(metadata?.activeImpactDefenseWindowEnd);
      return metadata &&
        metadata.activeImpactDefenseCalculationVersion === 1 &&
        metadata.activeImpactDefenseType === "UMBRELLA" &&
        typeof metadata.activeImpactDefenseTargetUserId === "string" &&
        Number.isFinite(end.getTime()) &&
        end <= asOf;
    });
    for (const event of defenseEvents) {
      const metadata = event.metadata;
      if (
        !hasWork(
          metadata.activeImpactDefenseTargetUserId,
          "DEFENSE_RESOLUTION",
          event.id,
        ) &&
        !sourceResolvedUnderFence(fence, metadata.activeImpactDefenseWindowEnd)
      ) continue;
      await tx.activeRaceImpactWork.upsert({
        where: {
          raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
            raceId,
            recipientUserId: metadata.activeImpactDefenseTargetUserId,
            sourceKind: "DEFENSE_RESOLUTION",
            sourceId: event.id,
            calculationVersion: 1,
          },
        },
        update: {},
        create: {
          raceId,
          recipientUserId: metadata.activeImpactDefenseTargetUserId,
          sourceKind: "DEFENSE_RESOLUTION",
          sourceId: event.id,
          powerupType: "UMBRELLA",
          status: "PENDING",
          resolvedAt: new Date(metadata.activeImpactDefenseWindowEnd),
          calculationVersion: 1,
        },
      });
    }
    for (const event of stampedEvents) {
      const metadata = event.metadata;
      const resolvedInCurrentEpoch = sourceResolvedUnderFence(fence, event.createdAt);
      for (const delta of metadata.activeImpactDeltas) {
        if (!delta || typeof delta.userId !== "string") continue;
        if (
          !resolvedInCurrentEpoch &&
          !hasWork(delta.userId, "POWERUP_EVENT", event.id)
        ) continue;
        await tx.activeRaceImpactWork.upsert({
          where: {
            raceId_recipientUserId_sourceKind_sourceId_calculationVersion: {
              raceId,
              recipientUserId: delta.userId,
              sourceKind: "POWERUP_EVENT",
              sourceId: event.id,
              calculationVersion: 1,
            },
          },
          update: {},
          create: {
            raceId,
            recipientUserId: delta.userId,
            sourceKind: "POWERUP_EVENT",
            sourceId: event.id,
            powerupType: metadata.activeImpactPowerupType,
            status: "PENDING",
            resolvedAt: event.createdAt,
            calculationVersion: 1,
          },
        });
      }
    }

    const effectById = new Map(eligibleEffects.map((row) => [row.id, row]));
    const eventById = new Map(stampedEvents.map((row) => [row.id, row]));
    const defenseEventById = new Map(defenseEvents.map((row) => [row.id, row]));
    const pending = await tx.activeRaceImpactWork.findMany({
      where: { raceId, status: "PENDING" },
      orderBy: [{ resolvedAt: "asc" }, { id: "asc" }],
    });
    let created = 0;
    let zero = 0;
    let failures = 0;
    for (const work of pending) {
      let deltaSteps = work.capturedDeltaSteps == null
        ? 0
        : integer(work.capturedDeltaSteps);
      if (work.capturedDeltaSteps != null) {
        // Exact consequence/freeze snapshots are committed with their source
        // under C0 and must never be recomputed from a later generation.
      } else if (work.sourceKind === "POWERUP_EVENT") {
        const event = eventById.get(work.sourceId);
        const deltas = event?.metadata?.activeImpactDeltas?.filter(
          (entry) => entry?.userId === work.recipientUserId
        );
        if (!event || !deltas?.length) {
          failures += 1;
          continue;
        }
        deltaSteps = deltas.reduce(
          (sum, entry) => sum + integer(entry.deltaSteps),
          0
        );
      } else if (work.sourceKind === "DEFENSE_RESOLUTION") {
        const event = defenseEventById.get(work.sourceId);
        if (!event || event.metadata?.activeImpactDefenseTargetUserId !== work.recipientUserId) {
          failures += 1;
          continue;
        }
        const captured = defenseImpactBySourceAndUser.get(
          `${work.sourceId}:${work.recipientUserId}`
        );
        if (!captured) {
          failures += 1;
          continue;
        }
        deltaSteps = integer(captured.deltaSteps);
      } else if (work.sourceKind === "ACTIVE_EFFECT") {
        const trailMineImpact = trailMineImpactByEffectAndUser.get(
          `${work.sourceId}:${work.recipientUserId}`
        );
        if (trailMineImpact) {
          deltaSteps = integer(trailMineImpact.deltaSteps);
        } else {
        const effect = effectById.get(work.sourceId);
        if (!effect) {
          failures += 1;
          continue;
        }
        if (effect.type === "LEECH") {
        const resolution = leechByEffect.get(effect.id);
        if (!resolution) {
          failures += 1;
          continue;
        }
        const actual = integer(resolution.actualTransfer);
        const victim = participantById.get(effect.targetParticipantId);
        if (victim?.userId === work.recipientUserId) deltaSteps -= actual;
        if (effect.sourceUserId === work.recipientUserId) deltaSteps += actual;
        } else if (effect.type === "HITCHHIKE") {
          if (effect.sourceUserId !== work.recipientUserId) {
            failures += 1;
            continue;
          }
          deltaSteps = integer(hitchhikeByEffect.get(effect.id)?.copiedSteps);
        } else if (
          effect.type === "DRILL_SERGEANT" &&
          effect.metadata?.activeImpactCalculationVersion === 1
        ) {
          deltaSteps = integer(effect.metadata.activeImpactDeltaSteps);
        } else if (ELIGIBLE_TIMED_TYPES.has(effect.type)) {
          const captured = timedImpactByEffectAndUser.get(
            `${effect.id}:${work.recipientUserId}`
          );
          if (!captured) {
            failures += 1;
            continue;
          }
          deltaSteps = integer(captured.deltaSteps);
        } else {
          failures += 1;
          continue;
        }
        }
      } else {
        failures += 1;
        continue;
      }

      if (deltaSteps === 0) {
        const changed = await tx.activeRaceImpactWork.updateMany({
          where: { id: work.id, status: "PENDING" },
          data: { status: "ZERO", processedGeneration: generation },
        });
        zero += changed.count;
        continue;
      }
      await tx.activeRaceEffectImpact.upsert({
        where: {
          raceId_userId_sourceKind_sourceId_calculationVersion: {
            raceId,
            userId: work.recipientUserId,
            sourceKind: work.sourceKind,
            sourceId: work.sourceId,
            calculationVersion: work.calculationVersion,
          },
        },
        update: {},
        create: {
          raceId,
          userId: work.recipientUserId,
          workId: work.id,
          sourceKind: work.sourceKind,
          sourceId: work.sourceId,
          powerupType: work.powerupType,
          deltaSteps,
          valueStatus: "SYNCED_SNAPSHOT",
          calculationVersion: work.calculationVersion,
          sourceGeneration: generation,
          resolvedAt: work.resolvedAt,
          acknowledgedAt: work.inlineAcknowledgedAt,
        },
      });
      const changed = await tx.activeRaceImpactWork.updateMany({
        where: { id: work.id, status: "PENDING" },
        data: { status: "CREATED", processedGeneration: generation },
      });
      // Close the stale-read race with receipt acknowledgement. The status
      // update above serializes on the work row: if acknowledgement won while
      // the notice insert was blocked, it commits first and this statement
      // copies the current timestamp; if materialization won, the receipt
      // command subsequently updates the already-visible impact in its own
      // transaction. No ordering can leave work acknowledged and impact null.
      await tx.$executeRawUnsafe(
        `UPDATE active_race_effect_impacts impact
            SET acknowledged_at = work.inline_acknowledged_at,
                updated_at = CURRENT_TIMESTAMP
           FROM active_race_impact_work work
          WHERE impact.work_id = work.id
            AND work.id = $1
            AND work.inline_acknowledged_at IS NOT NULL
            AND impact.acknowledged_at IS NULL`,
        work.id,
      );
      created += changed.count;
    }
    return { created, zero, suppressed: 0, failures };
  };
}

const processActiveRaceImpacts = buildProcessActiveRaceImpacts();

module.exports = {
  ELIGIBLE_TIMED_TYPES,
  buildProcessActiveRaceImpacts,
  processActiveRaceImpacts,
};
