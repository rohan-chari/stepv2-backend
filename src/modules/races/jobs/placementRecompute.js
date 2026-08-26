const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Notification } = require("../../notifications");
const { eventBus } = require("../../../shared/events/eventBus");
const { resolveRaceState } = require("../services/raceStateResolution");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../services/enqueueRaceResolution");
const {
  RaceResolutionJobV2: defaultRaceResolutionJobV2,
} = require("../models/raceResolutionJobV2");
const {
  RaceActiveEffect: defaultRaceActiveEffect,
} = require("../../powerups/models/raceActiveEffect");
const { stepSyncPushService } = require("../../../shared/push/stepSyncPush");
const {
  computeRacePayouts,
  computeFundedPayouts,
} = require("../racePayoutPresets");
const { computePrizePool } = require("../../../shared/economy/prizePool");
const { compareParticipantsForPlacement } = require("../placementOrder");
const { raceTimeZone } = require("../raceTimeZone");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const {
  readPerformanceFlags,
} = require("../../../shared/config/performanceFlags");
const { runBounded } = require("../../../shared/lib/runBounded");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const {
  getDbPoolPressure,
  prisma: defaultPrisma,
  runInPrismaTransaction,
  deferUntilAfterCommit,
} = require("../../../db");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../../domainEvents");
const {
  runCapacityMetricsEntry,
  startCapacityPhase,
} = require("../../../shared/observability/capacityPhaseMetrics");
const { userFanoutDisabled } = require("../../../shared/config/operationalControls");

// Team-race slacker nudge (TR-683): gentle, fires only inside the final 12h,
// to a member contributing < 25% of their team's per-member average (average
// over NON-FORFEITED members only), at most once per race per member.
const SLACKER_WINDOW_MS = 12 * 60 * 60 * 1000;
const SLACKER_FRACTION = 0.25;
const SLACKER_PUSH_TYPE = "TEAM_SLACKER_NUDGE";

const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const RECOVERY_RACE_LIMIT = 2;
function fiveMinuteBucketKey(date) {
  const bucketMs =
    Math.floor(new Date(date).getTime() / RECOMPUTE_INTERVAL_MS) *
    RECOMPUTE_INTERVAL_MS;
  return new Date(bucketMs).toISOString();
}

// Race-ending-soon reminder (§8): one push per active participant of a TIMED
// race, ~2h before it ends. Fired on the FIRST tick where msLeft <= 2h (and > 0),
// then made send-once by a unique deliveryKey claim in the Notification audit
// table — not an in-memory throttle, so it survives restarts and cluster workers.
const RACE_ENDING_SOON_WINDOW_MS = 2 * 60 * 60 * 1000; // fire when <= 2h remain
const RACE_ENDING_SOON_PUSH_TYPE = "RACE_ENDING_SOON";

// Races ending within this window are the "final stretch": we want their
// participants' steps to be as fresh as possible for the last few recomputes, so
// they get a tighter push throttle (below) than the default hourly cooldown.
const FINAL_STRETCH_WINDOW_MS = 60 * 60 * 1000; // ends within the next hour
const FINAL_STRETCH_MIN_INTERVAL_MS = 30 * 60 * 1000; // push at most every 30 min

// Live placement broadcast (Phase 0). Reads persisted standings for every
// ACTIVE, not-yet-expired race and emits PLACEMENT_CHANGED when a participant's
// live rank changes, so users see standings update without opening the race.
// Backend-only: works for every shipped app version (the fan-out is server-side).
//
// Mutation paths keep these rows fresh through the race-keyed resolution queue.
// This scan derives a transient "live rank" from the persisted totals (the
// settlement `placement` column stays null until the race ends). Idempotent: a
// participant whose rank is unchanged is not re-notified.
function buildRecomputePlacements(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  const immediateEvents = dependencies.eventBus || eventBus;
  const events = hasInjectedDeps
    ? immediateEvents
    : {
        async emit(eventName, data) {
          const occurredAt = data?.occurredAt || now();
          let eventType;
          let sourceId;
          let payload;
          let audience;
          if (eventName === "RACE_ENDING_SOON") {
            eventType = "RACE_ENDING_SOON_V1";
            sourceId = `cron:RACE_ENDING_SOON:${data.raceId}:${data.userId}`;
            payload = { raceId: data.raceId, raceName: data.raceName, endsAt: data.endsAt, observationKey: sourceId };
            audience = [{ recipientId: data.userId, facts: {} }];
          } else if (eventName === "TEAM_LEAD_CHANGED") {
            eventType = "TEAM_LEAD_CHANGED_V1"; sourceId = data.notificationIntentId;
            payload = { raceId: data.raceId, raceName: data.raceName, leadingTeamName: data.leadingTeamName, trailingTeamName: data.trailingTeamName, transitionId: sourceId, endsAt: data.endsAt ?? null };
            audience = data.memberUserIds.map((recipientId) => ({ recipientId, facts: {} }));
          } else if (eventName === "TEAM_FINAL_STRETCH") {
            eventType = "TEAM_FINAL_STRETCH_V1"; sourceId = data.notificationIntentId;
            payload = { raceId: data.raceId, raceName: data.raceName, teamATotal: data.teamATotal, teamBTotal: data.teamBTotal, endsAt: data.endsAt, transitionId: sourceId };
            audience = data.memberUserIds.map((recipientId) => ({ recipientId, facts: { memberTeam: data.memberTeams?.[recipientId] ?? null } }));
          } else if (eventName === "TEAM_SLACKER_NUDGE") {
            eventType = "TEAM_SLACKER_NUDGE_V1";
            sourceId = `cron:TEAM_SLACKER_NUDGE:${data.raceId}:${data.userId}`;
            payload = { raceId: data.raceId, raceName: data.raceName, teamName: data.teamName, observationKey: sourceId, endsAt: data.endsAt ?? null };
            audience = [{ recipientId: data.userId, facts: {} }];
          } else if (eventName === "PLACEMENT_CHANGED") {
            eventType = "PLACEMENT_CHANGED_V1"; sourceId = data.notificationIntentId;
            payload = { transitionId: sourceId, raceId: data.raceId, raceName: data.raceName, userId: data.userId, previousPlacement: data.previousPlacement, placement: data.placement, paidPlaces: data.paidPlaces, endsAt: data.endsAt ?? null };
            audience = [{ recipientId: data.userId, facts: {} }];
          } else {
            throw new Error(`unsupported placement domain event ${eventName}`);
          }
          await appendDomainEvent(defaultPrisma, {
            eventKey: `${eventType}:${sourceId}`, eventType, schemaVersion: 1,
            aggregateType: "RACE", aggregateId: data.raceId,
            occurredAt, payload, audience,
          });
          // Compatibility hint for old workers/handlers during the additive
          // drain. It is post-commit and cannot make the observation claim or
          // durable append fail.
          return deferUntilAfterCommit(() => immediateEvents.emit(eventName, data));
        },
      };
  const resolve = dependencies.resolveRaceState || resolveRaceState;
  // C0 (spec §5a item 4): real mutations enqueue at their write seams. This
  // cron evaluates notifications from persisted standings and only enqueues a
  // bounded recovery set for missing/failed/hour-old job rows.
  //
  // The notification evaluation below stays here, reading the persisted rows the
  // worker keeps fresh. Deliberate: moving it into the worker's post-commit hook
  // would re-evaluate every placement push at the worker's cadence (up to once
  // per race per 5s) instead of once per 5 minutes, changing push volume and the
  // meaning of `lastNotifiedPlacement`'s "last live rank" baseline. Its inputs
  // (totalSteps) are at most one worker cycle stale, which is the D-3 bound this
  // cron already lived with.
  //
  // An EXPLICITLY injected `resolveRaceState` still runs inline: that dependency
  // is the seam callers use to drive the recompute directly, and the inline path
  // is still live code behind the `inlineRaceResolutionFallback` lever. The
  // production singleton injects nothing, so production uses the bounded queue.
  const inlineResolveInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  const enqueue = dependencies.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const resolutionJobModel =
    dependencies.RaceResolutionJobV2 || defaultRaceResolutionJobV2;
  const effectModel = dependencies.RaceActiveEffect || defaultRaceActiveEffect;
  // Production owns reminder/placement claims in the domain-event projector.
  // Keep the established injected-command seam on the legacy durable audit
  // model so older workers and focused callers still serialize concurrent
  // reminder observations during the additive compatibility drain.
  const notificationModel = Object.prototype.hasOwnProperty.call(
    dependencies,
    "Notification",
  )
    ? dependencies.Notification
    : hasInjectedDeps
      ? Notification
      : null;
  const requestStepSync =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const now = dependencies.now || (() => new Date());
  const withDomainTransaction = hasInjectedDeps
    ? async (work) => work()
    : runInPrismaTransaction;
  const logger = dependencies.logger || console;
  const jobRunModel = dependencies.JobRun || defaultJobRun;
  const getPerformanceFlags = dependencies.getPerformanceFlags ||
    (() => hasInjectedDeps
      ? {
          ...readPerformanceFlags(),
          placementDistributedClaimEnabled: false,
          placementLeanBaselineWritesEnabled: false,
          placementInertPushSuppressionEnabled: false,
        }
      : readPerformanceFlags());
  let activePerformanceFlags = getPerformanceFlags();
  const monotonicNow = dependencies.monotonicNow || Date.now;
  const capacitySettings =
    dependencies.appSettings ||
    (hasInjectedDeps ? { getFlag: async () => false } : defaultAppSettings);
  // §8 kill switch: RACE_ENDING_REMINDER_DISABLED=true stops the race-ending-soon
  // reminder without stopping placement pushes. Injectable for tests.
  const isRaceEndingReminderDisabled =
    dependencies.isRaceEndingReminderDisabled ||
    (() => userFanoutDisabled("RACE_ENDING_REMINDER_DISABLED"));

  const auditKey = (userId, type, raceId) => `${userId}|${type}|${raceId}`;

  async function claimNotification(
    userId,
    type,
    raceId,
    existingNotificationKeys
  ) {
    if (!notificationModel) return true;
    const key = auditKey(userId, type, raceId);
    if (existingNotificationKeys?.has(key)) return false;

    // Degraded fallback: if the bulk audit snapshot was unavailable, preserve
    // legacy rows created before deliveryKey claims existed. This N+1 lookup is
    // intentionally limited to the error path; normal ticks use the batch set.
    if (
      existingNotificationKeys == null &&
      typeof notificationModel.findFirstByUserTypeRace === "function"
    ) {
      const alreadySent = await notificationModel.findFirstByUserTypeRace(
        userId,
        type,
        raceId
      );
      if (alreadySent) return false;
    }

    if (typeof notificationModel.claimDelivery === "function") {
      try {
        const claimed = await notificationModel.claimDelivery({
          userId,
          type,
          raceId,
          deliveryKey: `cron:${type}:${raceId}:${userId}`,
        });
        if (claimed && existingNotificationKeys) {
          existingNotificationKeys.add(key);
        }
        return claimed;
      } catch (error) {
        logger.error("[CRON] placementRecompute: notification claim failed:", {
          userId,
          type,
          raceId,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }

    // Compatibility seam for focused tests and rollback injections that still
    // provide the older notification model shape.
    const alreadySent = await notificationModel.findFirstByUserTypeRace(
      userId,
      type,
      raceId
    );
    return !alreadySent;
  }

  // §8: emit a one-shot RACE_ENDING_SOON per eligible participant of a timed race
  // ~2h before it ends. Applies to BOTH individual and team races (any race with a
  // definite end instant). Excludes finished/forfeited participants. Send-once via
  // the durable audit-row guard, so repeated ticks and restarts never re-send.
  async function evaluateRaceEndingSoon({
    race,
    participants,
    currentTime,
    existingNotificationKeys,
  }) {
    if (isRaceEndingReminderDisabled()) return;
    // Seeded daily/weekly challenges are excluded (owner decision 2026-07-24).
    // Every opted-in user is auto-enrolled into these every day, so a "2h left"
    // nudge on each one is a recurring push nobody chose to receive. The nudge
    // is for races a user deliberately started or joined. `seedId` is selected
    // by findActiveInProgress — if it is ever dropped from that select this
    // reads undefined and the suppression silently stops working, which is what
    // race-ending-soon-skips-seeded.test.js locks down against the real DB.
    if (race.seedId) return;
    // Qualify on a definite end instant only (endsAt != null). Open-ended
    // step-target races have no fixed end and are excluded.
    if (!race.endsAt) return;
    const endMs = new Date(race.endsAt).getTime();
    const msLeft = endMs - currentTime.getTime();
    if (!(msLeft > 0) || msLeft > RACE_ENDING_SOON_WINDOW_MS) return;
    // Short-race guard: a seeded race whose TOTAL scheduled duration is <= 2h
    // starts already inside the window, so a "~2h left" nudge at launch is
    // nonsensical. Only fire when endsAt - startedAt > 2h. If startedAt is absent
    // (defensive — findActiveInProgress now selects it), skip rather than misfire.
    if (!race.startedAt) return;
    const totalDurationMs = endMs - new Date(race.startedAt).getTime();
    if (totalDurationMs <= RACE_ENDING_SOON_WINDOW_MS) return;

    for (const p of participants) {
      // Exclude finished (frozen standings) and forfeited participants.
      if (p.finishedAt || p.forfeitedAt) continue;
      const claimed = await claimNotification(
        p.userId,
        RACE_ENDING_SOON_PUSH_TYPE,
        race.id,
        existingNotificationKeys
      );
      if (!claimed) continue;
      await events.emit("RACE_ENDING_SOON", {
        raceId: race.id,
        raceName: race.name,
        endsAt: race.endsAt,
        userId: p.userId,
        occurredAt: new Date(new Date(race.endsAt).getTime() - RACE_ENDING_SOON_WINDOW_MS),
        notificationClaimed:
          typeof notificationModel?.claimDelivery === "function",
      });
    }
  }

  // ── Team-race evaluation (TR-681/682/683/685) ────────────────────────────
  // Inside a team race, individual placement/overtake pushes are SUPPRESSED
  // (TR-685) — team pushes are the only standings notifications. The
  // lastNotifiedPlacement column doubles as the member's last-seen TEAM rank
  // (1 = leading side, 2 = trailing side); it is never returned by any API and
  // individual placement events never fire for team races, so the reuse is
  // invisible outside this job.
  async function evaluateTeamRace({
    race,
    participants,
    currentTime,
    existingNotificationKeys,
  }) {
    const totals = { TEAM_A: 0, TEAM_B: 0 };
    const members = participants.filter(
      (p) => p.team === "TEAM_A" || p.team === "TEAM_B"
    );
    for (const p of members) {
      totals[p.team] += p.totalSteps || 0;
    }

    const tie = totals.TEAM_A === totals.TEAM_B;
    const leadingTeam = tie
      ? null
      : totals.TEAM_A > totals.TEAM_B
        ? "TEAM_A"
        : "TEAM_B";

    // TR-681 lead-change: compare each member's stored team rank to the fresh
    // one. First observation seeds silently; flips push only once ARMED (both
    // teams > 0 — kills the day-one "first to sync leads over 0" false
    // positive). While unarmed, baselines still advance silently so the armed
    // flip fires exactly once when it becomes real.
    if (!tie && leadingTeam) {
      const rankFor = (p) => (p.team === leadingTeam ? 1 : 2);
      const storedRanks = members
        .map((p) => p.lastNotifiedPlacement)
        .filter((r) => r != null);
      const hadBaseline = storedRanks.length > 0;
      const previousLeader = hadBaseline
        ? members.find((p) => p.lastNotifiedPlacement === 1)?.team ?? null
        : null;
      const armed = totals.TEAM_A > 0 && totals.TEAM_B > 0;
      const flipped =
        hadBaseline && previousLeader != null && previousLeader !== leadingTeam;

      for (const p of members) {
        const rank = rankFor(p);
        if (p.lastNotifiedPlacement !== rank) {
          await participantModel.update(p.id, { lastNotifiedPlacement: rank });
        }
      }

      if (flipped && armed) {
        let mayEmit = true;
        if (activePerformanceFlags.placementLeanBaselineWritesEnabled) {
          mayEmit = await jobRunModel.claimRun(
            `team-lead:${race.id}`,
            `${previousLeader}->${leadingTeam}`
          );
        }
        if (mayEmit) {
          const trailingTeam = leadingTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
          await events.emit("TEAM_LEAD_CHANGED", {
          notificationIntentId: `team-lead:${race.id}:${previousLeader}->${leadingTeam}:${fiveMinuteBucketKey(currentTime)}`,
          raceId: race.id,
          raceName: race.name,
          leadingTeam,
          leadingTeamName:
            leadingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
          trailingTeamName:
            trailingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
          leadingTotal: totals[leadingTeam],
          trailingTotal: totals[trailingTeam],
          endsAt: race.endsAt ?? null,
          memberUserIds: members.map((p) => p.userId),
          memberTeams: Object.fromEntries(
            members.map((p) => [p.userId, p.team])
          ),
          occurredAt: new Date(fiveMinuteBucketKey(currentTime)),
          });
        }
      }
    }

    const raceEnd = race.endsAt ? new Date(race.endsAt) : null;
    const msLeft = raceEnd ? raceEnd.getTime() - currentTime.getTime() : null;

    // TR-682 final-stretch push with team framing, on the existing final-
    // stretch timing; the notification handler applies the 30-min throttle.
    if (msLeft != null && msLeft > 0 && msLeft <= FINAL_STRETCH_WINDOW_MS) {
      const activeMembers = members.filter((p) => !p.forfeitedAt);
      if (activeMembers.length > 0) {
        const finalStretchBucket = Math.floor(currentTime.getTime() / (30 * 60 * 1000));
        const mayEmit = hasInjectedDeps || await jobRunModel.claimRun(
          `team-final-stretch-event:${race.id}`,
          String(finalStretchBucket),
        );
        if (mayEmit) await events.emit("TEAM_FINAL_STRETCH", {
          notificationIntentId: `team-final-stretch:${race.id}:${finalStretchBucket}`,
          raceId: race.id,
          raceName: race.name,
          teamAName: race.teamAName,
          teamBName: race.teamBName,
          teamATotal: totals.TEAM_A,
          teamBTotal: totals.TEAM_B,
          endsAt: race.endsAt,
          memberUserIds: activeMembers.map((p) => p.userId),
          memberTeams: Object.fromEntries(
            activeMembers.map((p) => [p.userId, p.team])
          ),
          occurredAt: new Date(finalStretchBucket * 30 * 60 * 1000),
        });
      }
    }

    // TR-683 slacker nudge: final 12h only, never in (configured or effective)
    // 1v1, average over non-forfeited members, once per race per member (the
    // Notification audit row is the durable dedup key).
    if (
      msLeft != null &&
      msLeft > 0 &&
      msLeft <= SLACKER_WINDOW_MS &&
      (race.teamSize ?? 0) > 1
    ) {
      for (const team of ["TEAM_A", "TEAM_B"]) {
        const active = members.filter((p) => p.team === team && !p.forfeitedAt);
        if (active.length <= 1) continue; // sole active member is never shamed
        const average =
          active.reduce((sum, p) => sum + (p.totalSteps || 0), 0) /
          active.length;
        if (average <= 0) continue;
        for (const p of active) {
          if ((p.totalSteps || 0) >= average * SLACKER_FRACTION) continue;
          const claimed = await claimNotification(
            p.userId,
            SLACKER_PUSH_TYPE,
            race.id,
            existingNotificationKeys
          );
          if (!claimed) continue;
          await events.emit("TEAM_SLACKER_NUDGE", {
            raceId: race.id,
            raceName: race.name,
            userId: p.userId,
            teamName: team === "TEAM_A" ? race.teamAName : race.teamBName,
            endsAt: race.endsAt,
            occurredAt: new Date(new Date(race.endsAt).getTime() - SLACKER_WINDOW_MS),
            totalSteps: Math.max(0, Number(p.totalSteps) || 0),
            teamAverage: Math.round(average),
            notificationClaimed:
              typeof notificationModel?.claimDelivery === "function",
          });
        }
      }
    }
  }

  async function recomputePlacementsInternal(capacity, capacityState) {
    const startedAtMs = monotonicNow();
    const currentTime = now();
    activePerformanceFlags = getPerformanceFlags();
    const emitted = [];
    let participantCount = 0;
    let recoveryEnqueues = 0;
    let dueEffectEnqueues = 0;
    let baselineProposals = 0;
    let baselineCasWins = 0;
    let baselineCasLosses = 0;
    let claimOutcome = activePerformanceFlags.placementDistributedClaimEnabled
      ? "pending"
      : "disabled";
    const phaseMs = {
      claim: 0,
      raceScan: 0,
      auxiliaryScans: 0,
      participantScan: 0,
      baselineWrites: 0,
      eventDispatch: 0,
      stepSyncScheduling: 0,
      total: 0,
    };
    let activeRaceCount = 0;
    const logStructuredPerformance = (outcome) => {
      capacityState.outcome = outcome;
      phaseMs.total = Math.max(0, monotonicNow() - startedAtMs);
      logger.log?.("[PERF] placement recompute", {
        outcome,
        claimOutcome,
        activeRaces: activeRaceCount,
        participants: participantCount,
        dueEffectEnqueues,
        recoveryEnqueues,
        baselineProposals,
        baselineCasWins,
        baselineCasLosses,
        emittedEvents: emitted.length,
        // Inert classification happens in the async notification handler, not
        // this scheduler. Its own structured completion log owns that count.
        skippedInertEvents: 0,
        finalStretchStepSyncUsers: finalStretchUserIds.size,
        normalStepSyncUsers: normalUserIds.size,
        handlerDrainTracked: false,
        phaseMs: { ...phaseMs },
      });
      capacity.recordPhases(phaseMs);
      capacity.setCounts({
        activeRaces: activeRaceCount,
        participants: participantCount,
        placementProposals: baselineProposals,
        placementCasWins: baselineCasWins,
        placementCasLosses: baselineCasLosses,
        placementEvents: emitted.length,
        dueEffectEnqueues,
        recoveryEnqueues,
      });
      capacity.setDimensions({ claimOutcome });
    };
    // Split for the step-sync "pull" below: participants of at least one race
    // ending within the next hour ("final stretch") get a tighter push throttle;
    // everyone else keeps the default hourly cooldown.
    const finalStretchUserIds = new Set();
    const normalUserIds = new Set();

    if (activePerformanceFlags.placementDistributedClaimEnabled) {
      const claimStartedAt = monotonicNow();
      try {
        const claimed = await jobRunModel.claimRun(
          "placement-recompute-v2",
          fiveMinuteBucketKey(currentTime)
        );
        if (!claimed) {
          claimOutcome = "lost";
          phaseMs.claim = Math.max(0, monotonicNow() - claimStartedAt);
          logger.log("[CRON] placementRecompute lost distributed bucket claim");
          logStructuredPerformance("claim-lost");
          return emitted;
        }
        claimOutcome = "won";
      } catch (error) {
        claimOutcome = "error";
        phaseMs.claim = Math.max(0, monotonicNow() - claimStartedAt);
        logger.error(
          "[CRON] placementRecompute distributed claim failed:",
          error
        );
        logStructuredPerformance("claim-error");
        return emitted;
      }
      phaseMs.claim = Math.max(0, monotonicNow() - claimStartedAt);
    }

    let races;
    const raceScanStartedAt = monotonicNow();
    try {
      races = await raceModel.findActiveInProgress(currentTime);
    } catch (error) {
      phaseMs.raceScan = Math.max(0, monotonicNow() - raceScanStartedAt);
      logger.error("[CRON] placementRecompute: failed to load active races:", error);
      logStructuredPerformance("race-scan-error");
      return emitted;
    }
    phaseMs.raceScan = Math.max(0, monotonicNow() - raceScanStartedAt);
    activeRaceCount = races?.length || 0;

    if (!races || races.length === 0) {
      logger.log(
        `[CRON] placementRecompute completed races=0 participants=0 dueEffectEnqueues=0 recoveryEnqueues=0 baselineProposals=0 baselineCasWins=0 baselineCasLosses=0 emitted=0 durationMs=${Math.max(0, monotonicNow() - startedAtMs)}`
      );
      logStructuredPerformance("completed");
      return emitted;
    }

    // Time itself is a mutation source for expiring powerups. Preserve the old
    // <=5-minute expiry/adjudication/mint bound by enqueueing every ACTIVE race
    // with an effect due now. These are correctness jobs and are deliberately
    // outside the two-race insurance cap.
    const activeRaceIds = new Set(races.map((race) => race.id));
    const auxiliaryScansStartedAt = monotonicNow();
    const dueEffectRaceIds = new Set();
    if (!inlineResolveInjected) {
      try {
        const dueRaceIds = await effectModel.findDueRaceIds(
          currentTime,
          [...activeRaceIds]
        );
        for (const raceId of dueRaceIds || []) {
          if (activeRaceIds.has(raceId)) dueEffectRaceIds.add(raceId);
        }
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: failed to select due effects:",
          error
        );
      }
    }

    const recoveryRaceIds = new Set();
    if (!inlineResolveInjected) {
      try {
        const candidates = await resolutionJobModel.findRecoveryRaceIds({
          raceIds: races.map((race) => race.id),
          now: currentTime,
          limit: RECOVERY_RACE_LIMIT,
        });
        for (const raceId of candidates || []) {
          if (recoveryRaceIds.size >= RECOVERY_RACE_LIMIT) break;
          recoveryRaceIds.add(raceId);
        }
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: failed to select recovery races:",
          error
        );
      }
    }

    // The production path fetches every accepted participant in one lean query.
    // Inline resolution must retain the per-race read-after-write behavior used
    // by tests and the rollback lever.
    let participantsByRace = null;
    if (
      !inlineResolveInjected &&
      typeof participantModel.findAcceptedByRaces === "function"
    ) {
      try {
        const participantScanStartedAt = monotonicNow();
        const allParticipants = await participantModel.findAcceptedByRaces(
          races.map((race) => race.id)
        );
        phaseMs.participantScan += Math.max(
          0,
          monotonicNow() - participantScanStartedAt
        );
        participantsByRace = new Map();
        for (const participant of allParticipants || []) {
          if (!participantsByRace.has(participant.raceId)) {
            participantsByRace.set(participant.raceId, []);
          }
          participantsByRace.get(participant.raceId).push(participant);
        }
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: participant batch read failed; falling back:",
          error
        );
        participantsByRace = null;
      }
    }

    // Only the ending-soon and team-slacker branches consult the durable audit
    // log. Fetch all potentially relevant audit rows once, then match exact
    // user/type/race triples in memory before the insert-first claim.
    let existingNotificationKeys = null;
    if (
      participantsByRace &&
      notificationModel &&
      typeof notificationModel.findExistingByUserTypeRaceKeys === "function"
    ) {
      const keys = [];
      for (const race of races) {
        const participants = participantsByRace.get(race.id) || [];
        const endMs = race.endsAt ? new Date(race.endsAt).getTime() : null;
        const msLeft = endMs == null ? null : endMs - currentTime.getTime();
        const durationMs =
          endMs != null && race.startedAt
            ? endMs - new Date(race.startedAt).getTime()
            : null;
        if (
          !race.seedId &&
          msLeft != null &&
          msLeft > 0 &&
          msLeft <= RACE_ENDING_SOON_WINDOW_MS &&
          durationMs != null &&
          durationMs > RACE_ENDING_SOON_WINDOW_MS
        ) {
          for (const participant of participants) {
            if (!participant.finishedAt && !participant.forfeitedAt) {
              keys.push({
                userId: participant.userId,
                type: RACE_ENDING_SOON_PUSH_TYPE,
                raceId: race.id,
              });
            }
          }
        }
        if (
          race.isTeamRace &&
          (race.teamSize ?? 0) > 1 &&
          msLeft != null &&
          msLeft > 0 &&
          msLeft <= SLACKER_WINDOW_MS
        ) {
          for (const participant of participants) {
            keys.push({
              userId: participant.userId,
              type: SLACKER_PUSH_TYPE,
              raceId: race.id,
            });
          }
        }
      }
      try {
        const existing =
          await notificationModel.findExistingByUserTypeRaceKeys(keys);
        existingNotificationKeys = new Set(
          (existing || []).map((row) =>
            auditKey(row.userId, row.type, row.raceId)
          )
        );
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: notification batch read failed; falling back:",
          error
        );
        existingNotificationKeys = null;
      }
    }
    phaseMs.auxiliaryScans = Math.max(
      0,
      monotonicNow() - auxiliaryScansStartedAt
    );

    // Sequential over races bounds notification writes and preserves ordering.
    for (const race of races) {
      try {
        await withDomainTransaction(async () => {
        // B-12b — the cron used to call resolve() with NO timeZone, which
        // falls through to UTC inside raceStateResolution while every live
        // surface resolves raceTimeZone(race, viewerTz). For a user-created
        // race (timezone NULL) the two bucket steps into different calendar
        // days for hours around local midnight, which is exactly how the
        // false "you slipped to Nth" pushes were produced. Resolve the race's
        // own tz explicitly, falling back to the CREATOR's tz before UTC.
        const raceTz = raceTimeZone(race, race.creator?.timezone || "UTC");
        if (dueEffectRaceIds.has(race.id) || recoveryRaceIds.has(race.id)) {
          const queued = await enqueue({
            raceId: race.id,
            timeZone: raceTz,
            now: currentTime,
            reason: dueEffectRaceIds.has(race.id)
              ? "EFFECT_BOUNDARY"
              : "RECOVERY",
            priority: "IMMEDIATE",
            queuePriority: "RECOVERY",
          });
          if (queued) {
            if (dueEffectRaceIds.has(race.id)) dueEffectEnqueues += 1;
            else recoveryEnqueues += 1;
          }
        }
        if (inlineResolveInjected) {
          await resolve({ raceId: race.id, timeZone: raceTz });
        }

        const participants = participantsByRace
          ? participantsByRace.get(race.id) || []
          : await (async () => {
              const participantScanStartedAt = monotonicNow();
              const rows = await participantModel.findAcceptedByRace(race.id);
              phaseMs.participantScan += Math.max(
                0,
                monotonicNow() - participantScanStartedAt
              );
              return rows;
            })();
        if (!participants || participants.length === 0) return;
        participantCount += participants.length;

        // Collect for the step-sync "pull" below. A time-based race ending within
        // the hour is "final stretch"; step-target races (endsAt null) never are.
        const raceEnd = race.endsAt ? new Date(race.endsAt) : null;
        const isFinalStretch =
          raceEnd != null &&
          raceEnd.getTime() - currentTime.getTime() <= FINAL_STRETCH_WINDOW_MS;
        const bucket = isFinalStretch ? finalStretchUserIds : normalUserIds;
        for (const p of participants) bucket.add(p.userId);

        // §8: race-ending-soon reminder — applies to every timed race (individual
        // or team), independent of the placement/team-push logic below.
        await evaluateRaceEndingSoon({
          race,
          participants,
          currentTime,
          existingNotificationKeys,
        });

        // Team races: individual placement events are suppressed (TR-685);
        // evaluate the team pushes instead and skip the individual loop.
        if (race.isTeamRace) {
          await evaluateTeamRace({
            race,
            participants,
            currentTime,
            existingNotificationKeys,
          });
          return;
        }

        // B-12a — the SHARED comparator (finishers first, then steps desc,
        // then joinedAt, then userId). The old local sort was steps-desc only,
        // so at 0 steps (start of day) it produced a DB-order rank unrelated to
        // what home/list/detail showed.
        const ranked = [...participants].sort(compareParticipantsForPlacement);

        // How many places are "in the money" for this race, so the handler can
        // alert only on a meaningful threshold crossing (dropping out of the
        // payout) instead of every one-spot slip. 0 when there's no pot — a free
        // race has no paid places, so only lead changes are meaningful.
        const paidPlaces = race.fundedPrize
          ? computeFundedPayouts({
              preset: race.payoutPreset,
              // Projected from the live field, exactly as the race screen shows
              // it; the settled pool is recomputed from actual finishers.
              //
              // No team multiplier here, deliberately (batch 2026-08-08 item 5):
              // team races `continue` above and never reach this branch, and the
              // only thing read off this value is `.length` — how many places are
              // "in the money" for a rank-drop push. Scaling the pool cannot
              // change that count. Consistent with settlement by construction:
              // a team race's paid places are decided by completeRace's team
              // branch (everyone on the winning side), not by this helper.
              poolCoins: computePrizePool({
                playerCount: ranked.length,
                durationDays: race.maxDurationDays || 7,
              }),
              participantCount: ranked.length,
              // Only .length is read here (both distributions return exactly
              // `slots` entries), but pass it anyway so this site can never
              // drift from the read/settlement sites.
              curve: race.payoutCurve ?? null,
            }).length
          : (race.potCoins || 0) > 0
            ? computeRacePayouts({
                preset: race.payoutPreset,
                potCoins: race.potCoins,
                participantCount: ranked.length,
              }).length
            : 0;

        if (activePerformanceFlags.placementLeanBaselineWritesEnabled) {
          const baselineStartedAt = monotonicNow();
          const proposals = [];
          for (let i = 0; i < ranked.length; i++) {
            const participant = ranked[i];
            const liveRank = i + 1;
            if (participant.finishedAt) continue;

            let kind = "ordinary";
            if (participant.lastNotifiedPlacement == null) {
              kind = "first-observation";
            } else if (participant.placementAlertsMuted) {
              kind = "muted";
            }
            if (participant.lastNotifiedPlacement === liveRank) continue;
            proposals.push({
              participant,
              liveRank,
              kind,
              change:
                kind === "ordinary"
                  ? {
                      raceId: race.id,
                      raceName: race.name,
                      userId: participant.userId,
                      previousPlacement:
                        participant.lastNotifiedPlacement,
                      placement: liveRank,
                      totalParticipants: ranked.length,
                      paidPlaces,
                      endsAt: race.endsAt || null,
                    }
                  : null,
            });
          }

          const outcomes = await runBounded(
            proposals,
            activePerformanceFlags.placementBaselineWriteConcurrency,
            async (proposal) => {
              try {
                const won =
                  await participantModel.compareAndSetPlacementBaseline(
                    proposal.participant.id,
                    proposal.participant.lastNotifiedPlacement,
                    proposal.liveRank
                  );
                return { ...proposal, won };
              } catch (error) {
                logger.error(
                  `[CRON] placementRecompute: participant baseline ${proposal.participant.id} failed:`,
                  error
                );
                return { ...proposal, won: false };
              }
            }
          );
          baselineProposals += proposals.length;
          for (const outcome of outcomes) {
            if (outcome.won) baselineCasWins += 1;
            else baselineCasLosses += 1;
            if (!outcome.won || outcome.kind !== "ordinary") continue;
            const eventStartedAt = monotonicNow();
            const change = {
              ...outcome.change,
              notificationIntentId: `placement:${outcome.participant.id}:${fiveMinuteBucketKey(currentTime)}:${outcome.participant.lastNotifiedPlacement}->${outcome.liveRank}`,
            };
            await events.emit("PLACEMENT_CHANGED", change);
            phaseMs.eventDispatch += Math.max(
              0,
              monotonicNow() - eventStartedAt
            );
            emitted.push(change);
          }
          phaseMs.baselineWrites += Math.max(
            0,
            monotonicNow() - baselineStartedAt
          );
        } else for (let i = 0; i < ranked.length; i++) {
          const participant = ranked[i];
          const liveRank = i + 1;

          // Finished participants have frozen standings — never notify them.
          if (participant.finishedAt) continue;

          // First observation: seed the baseline silently (avoids a rollout-day
          // notification storm). Only notify on a SUBSEQUENT change.
          if (participant.lastNotifiedPlacement == null) {
            await participantModel.update(participant.id, {
              lastNotifiedPlacement: liveRank,
            });
            continue;
          }

          // Per-race opt-out: keep the baseline in sync (so unmuting doesn't
          // replay a backlog of missed moves) but emit nothing — no visible
          // alert and no silent refresh — for a muted participant.
          if (participant.placementAlertsMuted) {
            if (participant.lastNotifiedPlacement !== liveRank) {
              await participantModel.update(participant.id, {
                lastNotifiedPlacement: liveRank,
              });
            }
            continue;
          }

          if (participant.lastNotifiedPlacement === liveRank) continue; // no change

          const change = {
            notificationIntentId: `placement:${participant.id}:${fiveMinuteBucketKey(currentTime)}:${participant.lastNotifiedPlacement}->${liveRank}`,
            raceId: race.id,
            raceName: race.name,
            userId: participant.userId,
            previousPlacement: participant.lastNotifiedPlacement,
            placement: liveRank,
            totalParticipants: ranked.length,
            paidPlaces,
            // Batch 2026-08-10 item 3: the handler gates the payout-drop alert
            // on time-to-end. Passed through from the row already in scope
            // rather than re-queried per participant. NULL for step-target
            // races, where the handler deliberately skips the gate.
            endsAt: race.endsAt || null,
          };
          const eventStartedAt = monotonicNow();
          await events.emit("PLACEMENT_CHANGED", change);
          phaseMs.eventDispatch += Math.max(
            0,
            monotonicNow() - eventStartedAt
          );
          emitted.push(change);

          await participantModel.update(participant.id, {
            lastNotifiedPlacement: liveRank,
          });
        }
        });
      } catch (error) {
        logger.error(`[CRON] placementRecompute: race ${race.id} failed:`, error);
        // continue with the next race
      }
    }

    // Phase 3 — on-demand "pull": nudge active-race participants to upload fresh
    // steps so the NEXT recompute reflects them (devices take seconds-to-minutes to
    // wake, upload, and POST, so this improves the following tick, not this one).
    // requestStepSync self-throttles per user — it skips anyone synced or pushed
    // within its throttle window — so this won't spam even at a 5-minute cadence.
    //
    // Final-stretch participants get a tighter (30-min) window; everyone else keeps
    // the default hourly cooldown. A user in both kinds of race belongs to the
    // final-stretch set only, so we never nudge them twice in one tick.
    for (const userId of finalStretchUserIds) normalUserIds.delete(userId);
    const stepSyncStartedAt = monotonicNow();

    if (finalStretchUserIds.size > 0) {
      try {
        await requestStepSync([...finalStretchUserIds], {
          minIntervalMs: FINAL_STRETCH_MIN_INTERVAL_MS,
        });
      } catch (error) {
        logger.error(
          "[CRON] placementRecompute: final-stretch step-sync pull failed:",
          error
        );
      }
    }

    if (normalUserIds.size > 0) {
      try {
        await requestStepSync([...normalUserIds], {});
      } catch (error) {
        logger.error("[CRON] placementRecompute: step-sync pull failed:", error);
      }
    }
    phaseMs.stepSyncScheduling = Math.max(
      0,
      monotonicNow() - stepSyncStartedAt
    );

    logger.log(
      `[CRON] placementRecompute completed races=${races.length} participants=${participantCount} dueEffectEnqueues=${dueEffectEnqueues} recoveryEnqueues=${recoveryEnqueues} baselineProposals=${baselineProposals} baselineCasWins=${baselineCasWins} baselineCasLosses=${baselineCasLosses} emitted=${emitted.length} durationMs=${Math.max(0, monotonicNow() - startedAtMs)}`
    );
    logStructuredPerformance("completed");
    return emitted;
  }

  async function recomputePlacementsMeasured() {
    const capacity = startCapacityPhase("placement");
    const capacityState = { outcome: "error" };
    try {
      // One enclosing async query phase owns the whole tick. Its branches are
      // intentionally not measured with overlapping request-wide snapshots.
      return await capacity.measurePhase(
        "tick",
        () => recomputePlacementsInternal(capacity, capacityState),
      );
    } finally {
      capacity.finish(capacityState.outcome);
    }
  }

  return function recomputePlacements() {
    return runCapacityMetricsEntry(
      {
        settings: capacitySettings,
        logger,
        env: dependencies.capacityMetricsEnv || process.env,
        random: dependencies.capacityMetricsRandom || Math.random,
        readDbPoolPressure:
          dependencies.getDbPoolPressure || getDbPoolPressure,
        // This tick occurs only every five minutes. Always retain it once the
        // operator enables telemetry; otherwise a deliberately triggered heavy
        // placement cohort could have no placement sample at all.
        forceSample: true,
      },
      recomputePlacementsMeasured,
    );
  };
}

function scheduleRecomputePlacements(dependencies = {}) {
  const run = buildRecomputePlacements(dependencies);
  const logger = dependencies.logger || console;
  const setIntervalFn = dependencies.setInterval || setInterval;
  let running = false;

  async function tick() {
    if (running) {
      const message =
        "[CRON] placementRecompute skipped overlapping five-minute tick";
      if (typeof logger.warn === "function") logger.warn(message);
      else logger.log(message);
      return;
    }
    running = true;
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] placementRecompute tick error:", error);
    } finally {
      running = false;
    }
  }

  tick(); // run once shortly after boot
  const interval = setIntervalFn(tick, RECOMPUTE_INTERVAL_MS);
  logger.log("[CRON] Live placement recompute scheduled (every 5 minutes)");
  return { tick, interval };
}

module.exports = {
  buildRecomputePlacements,
  fiveMinuteBucketKey,
  scheduleRecomputePlacements,
};
