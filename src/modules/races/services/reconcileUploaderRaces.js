const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../../steps/models/steps");
const { StepSample } = require("../../steps/models/stepSample");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { eventsForUser } = require("../../steps/services/globalStepEventEntitlement");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
} = require("./raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("./racePowerupStateSync");
const {
  withRaceResolutionLock: defaultWithRaceResolutionLock,
} = require("./withRaceResolutionLock");
const { computeBoxEffectiveSteps } = require("../../powerups/boxSteps");
const { nextRawSteps } = require("../../powerups/rawPosition");
const { raceTimeZone } = require("../raceTimeZone");
const { applyLeechTransfers } = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const {
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const { prisma: defaultPrisma } = require("../../../db");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const { isStrictFlagEnabled } = require("../../../shared/config/isStrictFlagEnabled");
const {
  materializeAndReadScoringInputVersion,
} = require("../../steps/services/scoringInputVersion");
const {
  prefetchUploaderScoringInputs: defaultPrefetchUploaderScoringInputs,
} = require("./uploaderScoringPrefetch");

// Narrowly-scoped uploader reconciliation for POST /steps/sync-v2 (§6.4 / Phase
// C2). For each of the uploader's ACTIVE races it computes and persists ONLY the
// uploader's own participant total (using the SAME primitives and timezone rules
// as resolveRaceState) and runs syncRacePowerupState for that uploader so newly
// earned mystery boxes / queued powerups are current in the same pull.
//
// It explicitly does NOT evaluate trail mines, overtakes, rival totals, rival
// writes, placement events, or any other cross-participant work — the durable
// full-field worker owns all of that. The historical lock wrapper is now a
// deliberate passthrough; the optional prefetch path instead fences the only
// participant write with the uploader's scoring-input generation. Stable race
// order remains for compatibility with other ordered multi-race paths.

function buildReconcileUploaderRaces(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const stepsModel = dependencies.Steps || Steps;
  const stepSampleModel = dependencies.StepSample || StepSample;
  const raceActiveEffectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const withRaceResolutionLock =
    dependencies.withRaceResolutionLock || defaultWithRaceResolutionLock;
  const now = dependencies.now || (() => new Date());
  const prisma = dependencies.prisma || defaultPrisma;
  const settings = dependencies.appSettings || defaultAppSettings;
  const prefetchUploaderScoringInputs =
    dependencies.prefetchUploaderScoringInputs ||
    defaultPrefetchUploaderScoringInputs;
  const participantEventQueryEnabled =
    !hasInjectedDeps || dependencies.GlobalStepEvent != null;

  async function loadEventsForUser(race, userId, at, fallback = null) {
    if (participantEventQueryEnabled &&
        typeof globalStepEventModel.findEligibleByRace === "function") {
      const map = await globalStepEventModel.findEligibleByRace({
        raceId: race.id,
        userIds: [userId],
        rangeStart: race.startedAt,
        rangeEnd: at,
      });
      return eventsForUser(map, userId);
    }
    if (fallback) return fallback();
    try {
      return (await globalStepEventModel.findActiveInRange(race.startedAt, at)) || [];
    } catch {
      return [];
    }
  }

  async function prefetchEnabled() {
    if (dependencies.legacyUploaderStepSamplePrefetchV1Enabled != null) {
      return dependencies.legacyUploaderStepSamplePrefetchV1Enabled === true;
    }
    if (hasInjectedDeps && !dependencies.appSettings) return false;
    return isStrictFlagEnabled(
      settings,
      "legacyUploaderStepSamplePrefetchV1Enabled"
    );
  }

  async function calculateUploaderRace({
    capacity,
    race,
    participant,
    currentTime,
    baseStepsModel,
    baseStepSampleModel,
    globalEvents,
    requestTimeZone,
  }) {
    const scoreTz = raceTimeZone(race, requestTimeZone);
    const { baseAdjusted, hasSampleData } = await capacity.measurePhase(
      "stepSampleScoring",
      () => calculateBaseAdjusted({
        participant,
        raceStartedAt: race.startedAt,
        timeZone: scoreTz,
        stepsModel: baseStepsModel,
        stepSampleModel: baseStepSampleModel,
        now: currentTime,
      })
    );
    const { total, leechTransfers } = await capacity.measurePhase(
      "effectScoring",
      () => calculateCurrentTotal({
        raceId: race.id,
        racePowerupsEnabled: race.powerupsEnabled,
        participant,
        baseAdjusted,
        hasSampleData,
        raceActiveEffectModel,
        stepSampleModel,
        globalEvents,
        now: currentTime,
      })
    );
    const hitchhikeCopies = race.powerupsEnabled
      ? await capacity.measurePhase("hitchhikeLoad", () =>
          collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: race.endsAt,
            participants: race.participants,
            raceActiveEffectModel,
            stepSampleModel,
            now: currentTime,
            raceTimezone: race.timezone || "UTC",
            globalEvents,
          })
        )
      : [];
    const leechFinals = applyLeechTransfers(
      applyHitchhikeCopies(
        [{
          participantId: participant.id,
          userId: participant.userId,
          preLeechTotal: total,
          leechTransfers,
        }],
        hitchhikeCopies
      )
    );
    const finalTotal = leechFinals.get(participant.id) ?? total;
    const boxTz = raceTimeZone(race, "UTC");
    let boxBaseAdjusted = baseAdjusted;
    if (scoreTz !== boxTz) {
      ({ baseAdjusted: boxBaseAdjusted } = await capacity.measurePhase(
        "boxStepSampleScoring",
        () => calculateBaseAdjusted({
          participant,
          raceStartedAt: race.startedAt,
          timeZone: boxTz,
          stepsModel: baseStepsModel,
          stepSampleModel: baseStepSampleModel,
          now: currentTime,
        })
      ));
    }
    const boxEffectiveSteps = computeBoxEffectiveSteps({
      baseAdjusted: boxBaseAdjusted,
      bonusSteps: participant.bonusSteps || 0,
      maxBonusSteps: participant.maxBonusSteps || 0,
    });
    return { baseAdjusted, finalTotal, boxEffectiveSteps };
  }

  return async function reconcileUploaderRaces({
    userId,
    timeZone = "UTC",
    includeReconciledRaces = false,
    includeActiveRaces = false,
  }) {
    const capacity = startCapacityPhase("uploader_reconciliation");
    let capacityOutcome = "error";
    let races = [];
    let resolvedRaceCount = 0;
    const reconciledRaces = [];
    try {
    races = await capacity.measurePhase(
      "activeRaceLoad",
      () => raceModel.findActiveForUser(userId),
    );
    const usePrefetch =
      (await prefetchEnabled()) &&
      typeof participantModel.updateUploaderTotalsIfScoringVersion === "function";
    let capturedGeneration = null;
    let prefetched = null;
    if (usePrefetch) {
      capturedGeneration = await materializeAndReadScoringInputVersion(
        prisma,
        userId
      );
      const asOf = now();
      prefetched = await capacity.measurePhase("stepSamplePrefetch", () =>
        prefetchUploaderScoringInputs({
          userId,
          races,
          requestTimeZone: timeZone,
          asOf,
          Steps: stepsModel,
          StepSample: stepSampleModel,
          GlobalStepEvent: globalStepEventModel,
        })
      );
    }
    // Stable sorted order to avoid advisory-lock deadlocks across paths.
    const ordered = [...races].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    for (const race of ordered) {
      if (race.status !== "ACTIVE" || !race.startedAt) continue;
      // Past endsAt: settlement owns it; do not live-resolve (mirrors resolver).
      if (race.endsAt && now() >= new Date(race.endsAt)) continue;

      const participant = race.participants.find(
        (p) => p.userId === userId && p.status === "ACCEPTED"
      );
      if (!participant) continue;
      // Forfeited members are frozen — never recomputed.
      if (participant.forfeitedAt) continue;
      // Finished racers keep their frozen total; nothing to recompute.
      if (participant.finishedAt) {
        resolvedRaceCount += 1;
        continue;
      }

      await capacity.measurePhase("perRaceReconciliation", () =>
        withRaceResolutionLock(race.id, async () => {
        let workingRace = race;
        let workingParticipant = participant;
        let expectedGeneration = capturedGeneration;
        let currentTime = prefetched?.asOf || now();
        let globalEvents = await capacity.measurePhase(
          "globalEventLoad",
          () => loadEventsForUser(workingRace, userId, currentTime,
            prefetched ? () => prefetched.globalEventsForRace(workingRace) : null)
        );
        let calculation = await calculateUploaderRace({
          capacity,
          race: workingRace,
          participant: workingParticipant,
          currentTime,
          baseStepsModel: prefetched?.stepsModel || stepsModel,
          baseStepSampleModel: prefetched?.stepSampleModel || stepSampleModel,
          globalEvents,
          requestTimeZone: timeZone,
        });

        let updatedParticipant;
        if (usePrefetch) {
          // An upload can commit after the shared prefetch. The version-row
          // lock makes the participant write conditional on the exact captured
          // generation. A mismatch reloads just in time and retries the same
          // atomic path; no stale calculation is ever written.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const rawSteps = nextRawSteps(
              workingParticipant.rawSteps,
              calculation.baseAdjusted
            );
            const committed = await capacity.measurePhase(
              "participantPersist",
              () => participantModel.updateUploaderTotalsIfScoringVersion({
                id: workingParticipant.id,
                raceId: workingRace.id,
                userId,
                expectedGeneration,
                totalSteps: calculation.finalTotal,
                rawSteps,
              })
            );
            if (committed.status === "COMMITTED") {
              updatedParticipant = committed.participant;
              break;
            }
            if (committed.status === "NOT_ELIGIBLE") return;
            if (attempt === 2) {
              throw new Error("Uploader scoring inputs changed during reconciliation");
            }
            expectedGeneration = await materializeAndReadScoringInputVersion(
              prisma,
              userId
            );
            const freshRaces = await raceModel.findActiveForUser(userId);
            workingRace = freshRaces.find((candidate) => candidate.id === race.id);
            workingParticipant = workingRace?.participants.find(
              (candidate) =>
                candidate.userId === userId && candidate.status === "ACCEPTED"
            );
            if (
              !workingRace ||
              !workingParticipant ||
              workingParticipant.finishedAt ||
              workingParticipant.forfeitedAt
            ) return;
            currentTime = now();
            globalEvents = await loadEventsForUser(
              workingRace, userId, currentTime
            );
            calculation = await calculateUploaderRace({
              capacity,
              race: workingRace,
              participant: workingParticipant,
              currentTime,
              baseStepsModel: stepsModel,
              baseStepSampleModel: stepSampleModel,
              globalEvents,
              requestTimeZone: timeZone,
            });
          }
        } else {
          updatedParticipant = await capacity.measurePhase(
            "participantPersist",
            () => participantModel.updateStepTotals(workingParticipant.id, {
              totalSteps: calculation.finalTotal,
              rawSteps: nextRawSteps(
                workingParticipant.rawSteps,
                calculation.baseAdjusted
              ),
            })
          );
        }

        // Sync ONLY the uploader's box/powerup state. Pass the lean race so no
        // duplicate findById round-trip; syncRacePowerupState self-refetches when
        // a roll mutates the field.
        await capacity.measurePhase(
          "boxPowerupSync",
          () => syncRacePowerupState({
            raceId: workingRace.id,
            userId,
            race: workingRace,
            boxEffectiveSteps: calculation.boxEffectiveSteps,
          }),
        );

        // Internal claimability token/result. It is produced only after the
        // participant update and box sync above have completed inside the same
        // race-serialization boundary; callers use presence to decide whether
        // STEP_SYNC is safely narrow or must become FULL.
        if (includeReconciledRaces) {
          reconciledRaces.push({
            raceId: workingRace.id,
            participantId: workingParticipant.id,
            totalsUpdatedAt:
              updatedParticipant?.totalsUpdatedAt ||
              workingParticipant.totalsUpdatedAt || null,
            totalSteps: calculation.finalTotal,
            rawSteps:
              updatedParticipant?.rawSteps ??
              nextRawSteps(
                workingParticipant.rawSteps,
                calculation.baseAdjusted
              ),
            boxEffectiveSteps: calculation.boxEffectiveSteps,
          });
        }
        })
      );

      resolvedRaceCount += 1;
    }

    capacityOutcome = "success";
    return {
      resolvedRaceCount,
      boxStateCurrent: true,
      ...(includeReconciledRaces ? { reconciledRaces } : {}),
      // Internal request-path reuse only. sync-v2 has to enqueue these same
      // races immediately after reconciliation; returning the already-loaded
      // snapshot avoids repeating the widest query on the endpoint. Keep this
      // opt-in so every existing caller retains its exact result shape.
      ...(includeActiveRaces ? { activeRaces: races } : {}),
    };
    } finally {
      capacity.setCounts({
        activeRaces: Array.isArray(races) ? races.length : 0,
        resolvedRaces: resolvedRaceCount,
      });
      capacity.finish(capacityOutcome);
    }
  };
}

const reconcileUploaderRaces = buildReconcileUploaderRaces();

module.exports = { buildReconcileUploaderRaces, reconcileUploaderRaces };
