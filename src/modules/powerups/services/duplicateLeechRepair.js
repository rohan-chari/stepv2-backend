const crypto = require("node:crypto");
const {
  prisma: defaultPrisma,
  runInPrismaTransaction: defaultRunInPrismaTransaction,
} = require("../../../db");
const {
  computeRaceState: defaultComputeRaceState,
} = require("../../races/services/computeRaceState");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");
const {
  invalidateRaceProgress: defaultInvalidateRaceProgress,
} = require("../../races/services/raceProgressSnapshot");
const {
  impactDescription,
  normalizeAttackerDisplayName,
} = require("../../races/models/raceImpactEvent");

const APPLY_CONFIRMATION = "EXPIRE_DUPLICATE_LIVE_LEECHES_V1";

function stableDigest({ groups, deferredRaces }) {
  const digestInput = {
    groups: groups.map((group) => ({
      raceId: group.raceId,
      targetParticipantId: group.targetParticipantId,
      keepEffectId: group.keepEffectId,
      expireEffectIds: group.expireEffectIds,
    })),
    deferredRaces,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(digestInput))
    .digest("hex");
}

function isSettlementRisk(race, cutoff) {
  return (
    !race ||
    race.status !== "ACTIVE" ||
    !race.startedAt ||
    (race.endsAt && new Date(race.endsAt).getTime() <= cutoff.getTime())
  );
}

function groupLiveLeeches(rows, cutoff) {
  const byVictim = new Map();
  for (const effect of rows || []) {
    if (
      effect.type !== "LEECH" ||
      effect.status !== "ACTIVE" ||
      !effect.expiresAt ||
      new Date(effect.expiresAt).getTime() <= cutoff.getTime()
    ) {
      continue;
    }
    const key = `${effect.raceId}:${effect.targetParticipantId}`;
    if (!byVictim.has(key)) byVictim.set(key, []);
    byVictim.get(key).push(effect);
  }

  const groups = [];
  for (const effects of byVictim.values()) {
    effects.sort((left, right) => {
      const starts = new Date(left.startsAt) - new Date(right.startsAt);
      return starts || String(left.id).localeCompare(String(right.id));
    });
    if (effects.length < 2) continue;
    groups.push({
      raceId: effects[0].raceId,
      targetParticipantId: effects[0].targetParticipantId,
      targetUserId: effects[0].targetUserId,
      keepEffectId: effects[0].id,
      expireEffectIds: effects.slice(1).map((effect) => effect.id),
    });
  }
  groups.sort((left, right) =>
    String(left.raceId).localeCompare(String(right.raceId)) ||
    String(left.targetParticipantId).localeCompare(
      String(right.targetParticipantId)
    )
  );
  return groups;
}

function buildDuplicateLeechRepair(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const runInPrismaTransaction =
    dependencies.runInPrismaTransaction || defaultRunInPrismaTransaction;
  const computeRaceState = dependencies.computeRaceState || defaultComputeRaceState;
  const enqueueRaceResolution =
    dependencies.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const invalidateRaceProgress =
    dependencies.invalidateRaceProgress || defaultInvalidateRaceProgress;
  const now = dependencies.now || (() => new Date());

  async function audit(cutoff = now()) {
    const at = new Date(cutoff);
    const rows = await prisma.raceActiveEffect.findMany({
      where: {
        type: "LEECH",
        status: "ACTIVE",
        expiresAt: { gt: at },
      },
      include: {
        race: {
          select: {
            id: true,
            status: true,
            startedAt: true,
            endsAt: true,
            timezone: true,
          },
        },
      },
      orderBy: [
        { raceId: "asc" },
        { targetParticipantId: "asc" },
        { startsAt: "asc" },
        { id: "asc" },
      ],
    });
    const candidates = groupLiveLeeches(rows, at);
    const candidateRaceIds = new Set(
      candidates.map((group) => group.raceId)
    );
    const deferredRaceIds = new Set();
    for (const row of rows) {
      if (
        candidateRaceIds.has(row.raceId) &&
        isSettlementRisk(row.race, at)
      ) {
        deferredRaceIds.add(row.raceId);
      }
    }
    const deferredRaces = [...deferredRaceIds]
      .sort((left, right) => String(left).localeCompare(String(right)))
      .map((raceId) => ({ raceId, reason: "SETTLEMENT_RISK" }));
    const groups = candidates.filter(
      (group) => !deferredRaceIds.has(group.raceId)
    );
    const reportDigest = stableDigest({ groups, deferredRaces });
    return {
      mode: "dry-run",
      cutoff: at.toISOString(),
      duplicateGroupCount: groups.length,
      affectedEffectCount: groups.reduce(
        (sum, group) => sum + group.expireEffectIds.length,
        0
      ),
      deferredRaceCount: deferredRaces.length,
      deferredRaces,
      groups,
      reportDigest,
    };
  }

  async function persistRepairBoundaries({
    tx,
    race,
    effects,
    cutoff,
  }) {
    const effectIds = effects.map((effect) => effect.id);
    await tx.raceActiveEffect.updateMany({
      where: { id: { in: effectIds }, status: "ACTIVE" },
      data: { expiresAt: cutoff },
    });

    const computed = await computeRaceState({
      raceId: race.id,
      timeZone: race.timezone || "UTC",
      dependencies: {
        activeImpactEnabled: true,
        activeImpactSelectedSourceIds: effectIds,
        now: () => cutoff,
      },
    });
    const capture = computed?.result?.activeImpactCapture;
    if (!capture) {
      throw new Error(
        `Duplicate Leech repair could not capture boundaries for race ${race.id}`
      );
    }
    const selected = new Set(effectIds);
    const impacts = (capture.timedImpacts || []).filter(
      (impact) =>
        selected.has(impact.effectId) &&
        typeof impact.userId === "string" &&
        Number.isInteger(impact.deltaSteps) &&
        impact.deltaSteps !== 0
    );
    if (impacts.length > 0) {
      const byId = new Map(effects.map((effect) => [effect.id, effect]));
      await tx.raceImpactEvent.createMany({
        data: impacts.map((impact) => {
          const effect = byId.get(impact.effectId);
          return {
            raceId: race.id,
            recipientUserId: impact.userId,
            sourceKind: "ACTIVE_EFFECT",
            sourceId: impact.effectId,
            // The scorer capture may carry the id of a feed event it only
            // recorded in its discarded write set. Repair boundaries stand on
            // the ACTIVE_EFFECT source itself, so never persist that phantom FK.
            sourceFeedEventId: null,
            powerupType: "LEECH",
            deltaSteps: impact.deltaSteps,
            description: impactDescription("LEECH", impact.deltaSteps),
            attackerDisplayName:
              effect.sourceUserId !== impact.userId
                ? normalizeAttackerDisplayName(
                    effect.metadata?.impactBoundaryV1?.attackerDisplayName
                  )
                : null,
            valueStatus: "SYNCED_SNAPSHOT",
            calculationVersion: 2,
            resolvedAt: cutoff,
          };
        }),
        skipDuplicates: true,
      });
    }

    const capturedMetadataById = new Map(
      (computed.writes || [])
        .filter((write) => write.kind === "effectUpdate" && selected.has(write.id))
        .map((write) => [write.id, write.fields?.metadata])
    );
    for (const effect of effects) {
      const originalMetadata =
        effect.metadata && typeof effect.metadata === "object"
          ? effect.metadata
          : {};
      const capturedMetadata = capturedMetadataById.get(effect.id);
      const capturedBoundary =
        capturedMetadata?.impactBoundaryV1 &&
        typeof capturedMetadata.impactBoundaryV1 === "object"
          ? capturedMetadata.impactBoundaryV1
          : {};
      const priorBoundary =
        originalMetadata.impactBoundaryV1 &&
        typeof originalMetadata.impactBoundaryV1 === "object"
          ? originalMetadata.impactBoundaryV1
          : {};
      await tx.raceActiveEffect.update({
        where: { id: effect.id },
        data: {
          status: "EXPIRED",
          expiresAt: cutoff,
          metadata: {
            ...originalMetadata,
            ...(capturedMetadata && typeof capturedMetadata === "object"
              ? capturedMetadata
              : {}),
            impactBoundaryV1: {
              ...capturedBoundary,
              ...priorBoundary,
              endReason: "DUPLICATE_LEECH_REPAIR",
              endedAt: cutoff.toISOString(),
            },
          },
        },
      });
    }
  }

  async function apply({ confirmation, reportDigest }) {
    if (
      confirmation !== APPLY_CONFIRMATION ||
      !/^[a-f0-9]{64}$/.test(reportDigest || "")
    ) {
      throw new Error(
        `Apply refused: --confirm=${APPLY_CONFIRMATION} and a reviewed --report-digest are required.`
      );
    }
    const cutoff = now();
    const report = await audit(cutoff);
    if (report.reportDigest !== reportDigest) {
      throw new Error(
        `Apply refused: candidate report changed since dry-run. Current digest ${report.reportDigest}.`
      );
    }

    const groupsByRace = new Map();
    for (const group of report.groups) {
      if (!groupsByRace.has(group.raceId)) groupsByRace.set(group.raceId, []);
      groupsByRace.get(group.raceId).push(group);
    }
    let affectedEffectCount = 0;
    const runtimeDeferredRaces = [];
    for (const [raceId, groups] of groupsByRace) {
      const transactionResult = await runInPrismaTransaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM races WHERE id = ${raceId} FOR UPDATE
          `;
          const lockedRace = await tx.race.findUnique({
            where: { id: raceId },
            select: {
              id: true,
              status: true,
              startedAt: true,
              endsAt: true,
              timezone: true,
            },
          });
          if (isSettlementRisk(lockedRace, cutoff)) {
            return { deferred: true, count: 0, race: lockedRace };
          }
          const expectedIds = groups.flatMap((group) => [
            group.keepEffectId,
            ...group.expireEffectIds,
          ]);
          const targetParticipantIds = groups.map(
            (group) => group.targetParticipantId
          );
          const current = await tx.raceActiveEffect.findMany({
            where: {
              raceId,
              targetParticipantId: { in: targetParticipantIds },
              type: "LEECH",
              status: "ACTIVE",
              expiresAt: { gt: cutoff },
            },
            orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          });
          const currentIds = current.map((effect) => effect.id).sort();
          const sortedExpectedIds = [...expectedIds].sort();
          if (
            currentIds.length !== sortedExpectedIds.length ||
            currentIds.some((id, index) => id !== sortedExpectedIds[index])
          ) {
            throw new Error(
              `Apply refused: duplicate Leech rows changed while locking race ${raceId}.`
            );
          }
          const currentById = new Map(current.map((effect) => [effect.id, effect]));
          const expireEffects = groups.flatMap((group) =>
            group.expireEffectIds.map((id) => currentById.get(id))
          );
          await persistRepairBoundaries({
            tx,
            race: lockedRace,
            effects: expireEffects,
            cutoff,
          });
          return {
            deferred: false,
            count: expireEffects.length,
            race: lockedRace,
          };
        },
        { maxWait: 5_000, timeout: 60_000 }
      );
      if (transactionResult.deferred) {
        runtimeDeferredRaces.push({ raceId, reason: "SETTLEMENT_RISK" });
        continue;
      }
      affectedEffectCount += transactionResult.count;
      await invalidateRaceProgress(raceId);
      await enqueueRaceResolution({
        raceId,
        timeZone: transactionResult.race.timezone || "UTC",
        now: cutoff,
        reason: "EFFECT_BOUNDARY",
        powerupTypes: ["LEECH"],
        priority: "IMMEDIATE",
      });
    }

    const postAudit = await audit(now());
    const deferredByRace = new Map(
      [...report.deferredRaces, ...runtimeDeferredRaces].map((entry) => [
        entry.raceId,
        entry,
      ])
    );
    const deferredRaces = [...deferredByRace.values()].sort((left, right) =>
      String(left.raceId).localeCompare(String(right.raceId))
    );
    return {
      ...report,
      mode: "apply",
      affectedEffectCount,
      deferredRaceCount: deferredRaces.length,
      deferredRaces,
      postAuditDuplicateGroupCount: postAudit.duplicateGroupCount,
      postAuditDeferredRaceCount: postAudit.deferredRaceCount,
    };
  }

  return { audit, apply };
}

module.exports = {
  APPLY_CONFIRMATION,
  buildDuplicateLeechRepair,
  groupLiveLeeches,
  stableDigest,
};
