const { Steps } = require("../models/steps");
const { User } = require("../../users");
const { RaceParticipant } = require("../../races/models/raceParticipant");
const { eventBus } = require("../../../shared/events/eventBus");
const { resolveRaceState: defaultResolveRaceState } = require("../../races/services/raceStateResolution");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const {
  enqueueRaceResolutionForUser: defaultEnqueueRaceResolutionForUser,
} = require("../../races/services/enqueueRaceResolution");
const {
  reconcileUploaderRaces: defaultReconcileUploaderRaces,
} = require("../../races/services/reconcileUploaderRaces");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");

// When a sync moves the syncing user ahead of rival(s) on an ACTIVE race's live
// leaderboard, those rivals' displayed counts are now stale (the standings just
// changed against them). Nudge their devices to upload fresh steps so the board
// self-corrects. Detection reuses the freshly-persisted participant rows that
// resolveRaceState just wrote (one extra read per active race, mirroring
// placementRecompute): AFTER rank = index in totalSteps-desc order, BEFORE rank =
// each row's lastNotifiedPlacement (the last live rank persisted by the placement
// cron). A rival is "passed" when it now sits below the user AND its before-rank
// was ahead of the user's before-rank. requestStepSyncForUsers self-throttles
// (skips anyone synced/pushed within the last hour), which also prevents two
// rivals trading places from ping-ponging pushes. Excludes the user, finished
// participants, and rows with no known before-rank. Best-effort: any missing/null
// field just yields no nudge for that race.
async function nudgeOvertakenRivals({
  raceResults,
  userId,
  userIds = null,
  participantWrites = null,
  preferHydratedRoster = false,
  participantModel,
  requestStepSyncForUsers,
  recordPhaseTiming = null,
}) {
  if (!Array.isArray(raceResults) || raceResults.length === 0) return;

  async function measure(name, operation) {
    if (typeof recordPhaseTiming !== "function") return operation();
    const startedAt = process.hrtime.bigint();
    try {
      return await operation();
    } finally {
      try {
        recordPhaseTiming(
          name,
          Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)
        );
      } catch {}
    }
  }

  function measureSync(name, operation) {
    if (typeof recordPhaseTiming !== "function") return operation();
    const startedAt = process.hrtime.bigint();
    try {
      return operation();
    } finally {
      try {
        recordPhaseTiming(
          name,
          Math.max(0, Number(process.hrtime.bigint() - startedAt) / 1e6)
        );
      } catch {}
    }
  }

  const rivalIds = new Set();
  const triggerUserIds = [...new Set(
    (Array.isArray(userIds) ? userIds : [userId]).filter(Boolean)
  )].sort();

  for (const result of raceResults) {
    if (!result || !result.raceId) continue;

    let participants = null;
    if (preferHydratedRoster) {
      const hydrated = result?.race?.participants;
      const projectionComplete = Array.isArray(hydrated) && hydrated.every((row) =>
        row && row.id && row.userId && row.status && row.joinedAt != null &&
        Object.prototype.hasOwnProperty.call(row, "totalSteps") &&
        Object.prototype.hasOwnProperty.call(row, "bonusSteps") &&
        Object.prototype.hasOwnProperty.call(row, "lastNotifiedPlacement")
      );
      if (projectionComplete) {
        participants = hydrated
          .filter((row) => row.status === "ACCEPTED")
          .map((row) => ({ ...row }));
        const byId = new Map(participants.map((row) => [row.id, row]));
        let replayUnambiguous = Array.isArray(participantWrites);
        if (replayUnambiguous) {
          for (const write of participantWrites) {
            const row = byId.get(write?.participantId);
            if (!row || !["participantTotal", "participantBonus"].includes(write.kind)) {
              replayUnambiguous = false;
              break;
            }
            if (write.kind === "participantTotal" && Number.isFinite(write.totalSteps)) {
              row.totalSteps = write.totalSteps;
            } else if (write.kind === "participantBonus" && Number.isFinite(write.amount)) {
              row.bonusSteps = Math.max(0, Number(row.bonusSteps || 0) - write.amount);
            } else {
              replayUnambiguous = false;
              break;
            }
          }
        }
        if (!replayUnambiguous) participants = null;
      }
    }
    // Fail closed to exactly one current accepted-roster read. A partial old
    // artifact/projection is never used to guess recipients.
    if (!participants) {
      participants = await measure(
        "participantLoad",
        () => participantModel.findAcceptedByRace(result.raceId)
      );
    }
    if (!participants || participants.length === 0) continue;

    measureSync("ranking", () => {
      const ranked = [...participants].sort(
        (a, b) =>
          (b.totalSteps ?? 0) - (a.totalSteps ?? 0) ||
          new Date(a.joinedAt || 0).getTime() - new Date(b.joinedAt || 0).getTime()
      );
      const indexByUserId = new Map(
        ranked.map((participant, index) => [participant.userId, index])
      );
      for (const triggerUserId of triggerUserIds) {
        const userIndex = indexByUserId.get(triggerUserId);
        if (userIndex == null) continue;
        const beforeRank = ranked[userIndex].lastNotifiedPlacement;
        const afterRank = userIndex + 1;
        if (beforeRank == null || afterRank >= beforeRank) continue;
        for (let i = userIndex + 1; i < ranked.length; i++) {
          const rival = ranked[i];
          if (rival.userId === triggerUserId || rival.finishedAt) continue;
          if (rival.lastNotifiedPlacement == null) continue;
          if (rival.lastNotifiedPlacement < beforeRank) rivalIds.add(rival.userId);
        }
      }
    });
  }

  if (rivalIds.size > 0) {
    await measure(
      "intentHandoff",
      () => requestStepSyncForUsers([...rivalIds].sort())
    );
  }
}

function buildRecordSteps(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const inlineResolutionInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  const resolveRaceState = inlineResolutionInjected
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const syncRacePowerupState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "syncRacePowerupState"
  )
    ? dependencies.syncRacePowerupState
    : hasInjectedDeps
      ? async () => {}
      : defaultSyncRacePowerupState;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const requestStepSyncForUsers =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const now = dependencies.now || (() => new Date());
  // C0 (spec §5a item 4): the legacy path ENQUEUES the uploader's active races
  // instead of bulk-writing them inline. Inline resolution here was one of the
  // two bulk writers that could hit one race concurrently with the worker.
  const enqueueRaceResolutionForUser = Object.prototype.hasOwnProperty.call(
    dependencies,
    "enqueueRaceResolutionForUser"
  )
    ? dependencies.enqueueRaceResolutionForUser
    : hasInjectedDeps
      ? async () => []
      : defaultEnqueueRaceResolutionForUser;
  const reconcileUploaderRaces = Object.prototype.hasOwnProperty.call(
    dependencies,
    "reconcileUploaderRaces"
  )
    ? dependencies.reconcileUploaderRaces
    : hasInjectedDeps
      ? async () => ({ resolvedRaceCount: 0 })
      : defaultReconcileUploaderRaces;
  // Injected-deps callers (unit tests) get a DB-free stub unless they pass one:
  // an app-settings read here must never turn a pure unit test into a DB test.
  const settings =
    dependencies.appSettings ||
    (hasInjectedDeps
      ? { getFlag: async () => false }
      : defaultAppSettings);

  return async function recordSteps({ userId, steps, date, timeZone, skipRaceResolution = false }) {
    const existing = await stepsModel.findByUserIdAndDate(userId, date);

    let noopSuppression = false;
    try {
      noopSuppression =
        (await settings.getFlag("raceResolutionNoopInputSuppressionV1Enabled")) === true;
    } catch {}

    let record;
    let scoringChanged = true;

    if (existing) {
      const persisted = await stepsModel.update(existing.id, { steps }, { noopSuppression });
      record = persisted?.record || persisted;
      if (noopSuppression) scoringChanged = persisted?.scoringChanged !== false;
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_UPDATED", { userId, steps, date });
    } else {
      let persisted;
      let created = true;
      try {
        persisted = await stepsModel.create(
          { userId, steps, date, stepGoal: null },
          { noopSuppression }
        );
      } catch (error) {
        // Two devices can both observe an absent daily row. The unique index is
        // the admission authority: after the losing create transaction rolls
        // back, converge through the normal update path instead of returning a
        // 500. Re-read before handling so unrelated P2002 errors still surface.
        if (error?.code !== "P2002") throw error;
        const winner = await stepsModel.findByUserIdAndDate(userId, date);
        if (!winner) throw error;
        persisted = await stepsModel.update(
          winner.id,
          { steps },
          { noopSuppression }
        );
        created = false;
      }
      record = persisted?.record || persisted;
      if (noopSuppression) scoringChanged = persisted?.scoringChanged !== false;
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit(created ? "STEPS_RECORDED" : "STEPS_UPDATED", {
        userId,
        steps,
        date,
      });
    }

    // C4 (spec §5 Phase E): this and `recordStepSyncV2` are the ONLY two writers
    // of the daily `steps` row, so together they are the invalidation seam for
    // `v1:user:daily:{id}:{date}` — the value `GET /friends/steps` serves to
    // every one of this user's friends. Hooked at the COMMAND, not at the three
    // routes that reach it. (`POST /steps/samples` writes only samples, so it
    // has no daily total to invalidate.) Swallowed: bookkeeping never fails a
    // sync.
    await require("../services/dailyStepsCache").invalidateSafe(userId, date);

    // Step-goal coin bonuses (daily_goal_1x / daily_goal_2x) are intentionally
    // gone — replaced by the tap-to-claim StepMilestone rewards on home.

    // When the client is going to immediately POST /steps/samples after this
    // call, race resolution will run again there with fresher sample data —
    // doing it here is duplicate work. The client opts in via
    // skipRaceResolution. Old clients keep the original behavior.
    // Mark every active race of this uploader dirty. Cheap O(1)-per-race upsert;
    // the race-keyed worker owns the bulk write. Done even when the client opted
    // into skipRaceResolution — but note the contract: that enqueue carries a
    // narrow STEP_SYNC scope, and a STEP_SYNC_COMMITTED run only RE-PUBLISHES
    // committed totals; it does not reconcile this request's daily row into
    // race_participants. The uploader's own row is healed by the imminent
    // /steps/samples reconcile — or, if that call never lands, by (a) the next
    // successful sync's reconcile, (b) an UN-MERGED DISPLAY_REFRESH job (base
    // plan FULL), or (c) the findRecoveryRaceIds backstop (~1h worst case).
    //
    // NOT by every progress poll any more: since the dependency-closure work,
    // buildRaceResolutionStepSyncScope admits a coalesced
    // {STEP_SYNC, DISPLAY_REFRESH} envelope, so a poll that COALESCES with a
    // step sync on a zero-effect race takes STEP_SYNC_COMMITTED and writes
    // nothing. Staleness is still bounded by (a)-(c); this note exists so the
    // heal is not assumed to come from the poll.
    let reasonAware = false;
    try {
      reasonAware =
        (await settings.getFlag("raceResolutionReasonAwareV1Enabled")) === true;
    } catch {
      reasonAware = false;
    }

    // Frozen/flag-off clients retain the deployed enqueue-before-reconcile
    // behavior byte-for-byte. The opt-in reason-aware path below reverses the
    // order so a narrow STEP_SYNC can never become claimable before the
    // uploader row it depends on has committed.
    if (!reasonAware && scoringChanged) {
      await enqueueRaceResolutionForUser({
        userId,
        timeZone,
        now: now(),
        reason: "STEP_SYNC",
        priority: "COALESCE",
      });
    }

    // C0: the bulk resolve is gone, but the UPLOADER-ONLY reconcile stays inline
    // — the same one sync-v2 runs in its Transaction B. It writes exactly ONE
    // row (the uploader's own participant) and syncs their box/powerup state, so
    // it is a residual single-row writer under §5a item 7, not a bulk writer.
    // Keeping it is what preserves same-request box minting for frozen legacy
    // clients; pure enqueue-only would defer their box to the next worker cycle.
    // Rival totals, trail mines, overtakes and placements are the worker's.
    let reconciliation = null;
    if (!skipRaceResolution) {
      try {
        reconciliation = await reconcileUploaderRaces({
          userId,
          timeZone,
          includeReconciledRaces: reasonAware,
        });
      } catch (error) {
        console.error("Uploader race reconciliation failed:", error);
      }
    }

    if (reasonAware && scoringChanged) {
      const narrowReady =
        !skipRaceResolution &&
        reconciliation &&
        Array.isArray(reconciliation.reconciledRaces);
      // skipRaceResolution means a /steps/samples call (with its own reconcile
      // and STEP_SYNC enqueue) is imminent; this enqueue is only the
      // convergence backstop, so it must still carry the STEP_SYNC reason. A
      // null reason normalizes to a FULL envelope at the registry, and FULL is
      // sticky across the job row's coalescing merge — one such enqueue per
      // sync cycle poisoned every coalesced big-race job into an IMMEDIATE
      // full-field recompute. Without reconciledRaces the enqueue resolves the
      // uploader's participant scope from findActiveForUser; the claim-time
      // scope/fence validation degrades any incoherent snapshot to FULL.
      const backstopSync = skipRaceResolution === true;
      await enqueueRaceResolutionForUser({
        userId,
        timeZone,
        now: now(),
        // A FAILED reconcile still deliberately normalizes to FULL at the
        // closed registry instead of guessing at a narrow scope.
        reason: narrowReady || backstopSync ? "STEP_SYNC" : null,
        priority: narrowReady || backstopSync ? "COALESCE" : "IMMEDIATE",
        reconciledRaces: narrowReady ? reconciliation.reconciledRaces : null,
      });
    }

    // Rollback lever (ii): with `inlineRaceResolutionFallback` ON, this path
    // resolves inline exactly as it always did (kill switch for a misbehaving
    // worker while staying on the new binary). Default OFF => enqueue only.
    //
    // An EXPLICITLY injected `resolveRaceState` also selects the inline path:
    // that dependency is the seam for driving this pipeline directly, and it is
    // still live code precisely because the lever can turn it back on. The
    // production singleton injects nothing and is therefore flag-driven.
    let inlineFallback = inlineResolutionInjected;
    if (!inlineFallback) {
      try {
        inlineFallback =
          (await settings.getFlag("inlineRaceResolutionFallback")) === true;
      } catch {
        inlineFallback = false;
      }
    }

    if (inlineFallback && !skipRaceResolution) {
      const raceResults = await resolveRaceState({ userId, timeZone });
      if (Array.isArray(raceResults)) {
        await Promise.all(
          raceResults.map((result) =>
            syncRacePowerupState({
              raceId: result.raceId,
              userId,
              race: result.race,
              // Leg Cramp + Wrong Turn immune box-progress total (computed in
              // resolveRaceState) so the roll gate ignores those debuffs.
              boxEffectiveSteps: result.boxEffectiveSteps,
            })
          )
        );

        // Fire-and-forget: never awaited in the response path and never allowed
        // to fail or slow the sync (pattern mirrors modules/social/routes/friends.js).
        Promise.resolve()
          .then(() =>
            nudgeOvertakenRivals({
              raceResults,
              userId,
              participantModel,
              requestStepSyncForUsers,
            })
          )
          .catch((error) => {
            console.error("Overtake step-sync nudge error:", error);
          });
      }
    }

    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps, nudgeOvertakenRivals };
