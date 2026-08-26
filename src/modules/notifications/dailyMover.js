const { Race } = require("../races/models/race");
const { RaceParticipant } = require("../races/models/raceParticipant");
const { JobRun } = require("../../shared/db/jobRun");
const { prisma: defaultPrisma, runInPrismaTransaction } = require("../../db");
const { appendDomainEvent: defaultAppendDomainEvent } = require("../domainEvents");
const { resolveRaceState } = require("../races/services/raceStateResolution");
const {
  enqueueRaceResolution: defaultEnqueueRaceResolution,
} = require("../races/services/enqueueRaceResolution");
const { dailyRunKey } = require("../../shared/time/etSchedule");
const { nextMidnightNewYork } = require("../../shared/time/week");

const JOB_NAME = "daily_mover";
const TICK_INTERVAL_MS = 5 * 60 * 1000; // ride the shared 5-minute cadence
const TARGET_HOUR_ET = 16; // 4pm ET
const MIN_MOVE = 3; // must move MORE than 3 places (i.e. >= 4) to notify

// Daily biggest-mover digest. Once per ET day at 4pm, send each active racer ONE
// notification for the race in which their live rank moved the most over the last
// 24h (since the previous 4pm run), in either direction, provided the move is
// bigger than MIN_MOVE places. Rides the shared 5-minute tick and fires exactly
// once per ET day via the JobRun marker (restart-safe, DST-proof).
//
// Movement = dayStartPlacement (the rank we snapshotted last run) minus the
// current live rank, so a POSITIVE value is a climb. The snapshot is reset to the
// current rank every run, giving a clean rolling 24h window. A participant with no
// snapshot yet is seeded silently (no digest for that first partial window), and a
// participant who muted a race's placement alerts is kept in sync but never
// notified — mirroring placementRecompute.
function buildDailyMover(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const jobRunModel = dependencies.JobRun || JobRun;
  const compatibilityEvents = dependencies.eventBus || null;
  const db = dependencies.prisma || defaultPrisma;
  const appendDomainEvent = dependencies.appendDomainEvent || defaultAppendDomainEvent;
  const durable = !dependencies.eventBus && !dependencies.RaceParticipant;
  // C0 (spec §5a): this daily digest used to be a fourth bulk writer of
  // race_participants. It now ENQUEUES and reads the persisted totals the
  // race-keyed worker maintains — at most one worker cycle stale, against a
  // once-a-day job whose inputs are day-scale movements. An explicitly injected
  // resolveRaceState still runs inline (the live-code seam, as elsewhere in C0).
  const inlineResolveInjected = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  );
  const resolve = dependencies.resolveRaceState || resolveRaceState;
  const enqueue = dependencies.enqueueRaceResolution || defaultEnqueueRaceResolution;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const targetHour = dependencies.targetHour ?? TARGET_HOUR_ET;
  const minMove = dependencies.minMove ?? MIN_MOVE;
  const updateBaseline = (update) => participantModel.update(
    update.participantId,
    { dayStartPlacement: update.liveRank }
  );

  // Returns the array of emitted DAILY_MOVER changes when it ran this tick, or
  // null when the tick wasn't the daily run.
  return async function runDailyMover() {
    const currentTime = now();

    const lastRanFor = await jobRunModel.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({ now: currentTime, targetHour, lastRanFor });
    if (!runKey) return null;

    // candidatesByUser: userId -> [{ raceId, raceName, movement, absMovement,
    // placement }] across all of the user's races, for the per-user pick below.
    const candidatesByUser = new Map();
    const baselineUpdates = [];

    let races;
    try {
      races = await raceModel.findActiveInProgress(currentTime);
    } catch (error) {
      logger.error("[CRON] dailyMover: failed to load active races:", error);
      return null; // not marked -> retried next tick
    }

    for (const race of races || []) {
      try {
        await enqueue({
          raceId: race.id,
          now: currentTime,
          reason: "DAILY_MOVER",
          priority: "IMMEDIATE",
        });
        if (inlineResolveInjected) await resolve({ raceId: race.id });

        const participants = await participantModel.findAcceptedByRace(race.id);
        if (!participants || participants.length === 0) continue;

        const ranked = [...participants].sort(
          (a, b) => (b.totalSteps ?? 0) - (a.totalSteps ?? 0)
        );

        for (let i = 0; i < ranked.length; i++) {
          const participant = ranked[i];
          const liveRank = i + 1;

          // Frozen standings — no movement to report, no baseline to keep.
          if (participant.finishedAt) continue;

          const prior = participant.dayStartPlacement;

          // Reset the window baseline to the current rank (unless unchanged), so
          // the next run measures the following 24h. Done for muted/unseeded
          // participants too, so the window stays aligned for everyone.
          if (prior !== liveRank) {
            baselineUpdates.push({ participantId: participant.id, liveRank });
          }

          // First partial window (no prior snapshot) or muted -> seed/sync only.
          if (prior == null || participant.placementAlertsMuted) continue;

          const movement = prior - liveRank; // positive = climbed
          const absMovement = Math.abs(movement);
          if (absMovement <= minMove) continue;

          const list = candidatesByUser.get(participant.userId) || [];
          list.push({
            raceId: race.id,
            raceName: race.name,
            movement,
            absMovement,
            placement: liveRank,
          });
          candidatesByUser.set(participant.userId, list);
        }
      } catch (error) {
        logger.error(`[CRON] dailyMover: race ${race.id} failed:`, error);
        // continue with the next race
      }
    }

    // Per user, pick the single biggest move. Equal maxima use the lowest race
    // ID so a crash/replay cannot choose a different digest payload.
    const emitted = [];
    for (const [userId, candidates] of candidatesByUser) {
      const max = Math.max(...candidates.map((c) => c.absMovement));
      const chosen = candidates
        .filter((c) => c.absMovement === max)
        .sort((a, b) => String(a.raceId).localeCompare(String(b.raceId)))[0];

      const change = {
        digestId: `daily-mover:${runKey}:${userId}`,
        notificationIntentId: `daily-mover:${runKey}:${userId}`,
        userId,
        raceId: chosen.raceId,
        raceName: chosen.raceName,
        movement: chosen.movement,
        placement: chosen.placement,
      };
      emitted.push(change);
    }
    if (durable) {
      await runInPrismaTransaction(async (tx) => {
        for (const update of baselineUpdates) {
          // The model uses the transaction-scoped Prisma proxy, which keeps
          // this write atomic with the event and JobRun while preserving the
          // single race-participant write surface audited by structural tests.
          await updateBaseline(update);
        }
        for (const change of emitted) {
          await appendDomainEvent(tx, {
            eventKey: `DAILY_MOVER_V1:${change.digestId}`,
            eventType: "DAILY_MOVER_V1", schemaVersion: 1,
            aggregateType: "USER", aggregateId: change.userId,
            occurredAt: currentTime,
            payload: {
              digestId: change.digestId, userId: change.userId,
              raceId: change.raceId, raceName: change.raceName,
              movement: change.movement, placement: change.placement,
              localDate: runKey,
            },
            audience: [{ recipientId: change.userId, facts: {
              expiresAt: nextMidnightNewYork(currentTime, "America/New_York"),
            } }],
          });
        }
        await tx.jobRun.upsert({
          where: { jobName: JOB_NAME },
          create: { jobName: JOB_NAME, lastRanFor: runKey },
          update: { lastRanFor: runKey },
        });
      });
    } else {
      for (const update of baselineUpdates) {
        await updateBaseline(update);
      }
      for (const change of emitted) compatibilityEvents?.emit("DAILY_MOVER", change);
      await jobRunModel.markRan(JOB_NAME, runKey);
    }
    logger.log(
      `[CRON] Daily mover: sent ${emitted.length} digests (run for ${runKey})`
    );
    return emitted;
  };
}

function scheduleDailyMover(dependencies = {}) {
  const run = buildDailyMover(dependencies);
  const logger = dependencies.logger || console;
  const interval = dependencies.intervalMs || TICK_INTERVAL_MS;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] dailyMover tick error:", error);
    }
  }

  tick(); // run once shortly after boot (no-op unless it's past 4pm ET and unrun)
  setInterval(tick, interval);
  logger.log("[CRON] Daily mover digest scheduled (4pm ET)");
}

module.exports = { buildDailyMover, scheduleDailyMover, JOB_NAME };
