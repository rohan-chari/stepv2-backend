const { Race } = require("../models/race");
const { startRace: defaultStartRace } = require("../commands/startRace");

// Auto-start scheduled races (1.1.7). Runs on the same 5-minute cadence as the
// other cron jobs in src/index.js. Finds PENDING user-created races whose
// scheduledStartAt has arrived and starts them via the EXISTING startRace logic
// (baseline snapshot, RACE_STARTED notification, pot commit). The "which races
// are due?" decision is the PURE function selectRacesToAutoStart; this job only
// does the DB read + the per-race start.
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Pure selection. Given a batch of candidate races and the current time, return
// only those that should auto-start now:
//   - status PENDING (idempotent: ACTIVE/COMPLETED races are never re-started)
//   - a scheduledStartAt that is set and <= now
//   - NOT a seeded race (seedId == null) — seeded races have their own
//     auto-start/renewal in seededRaceRenewal.js, so we never double-handle them
function selectRacesToAutoStart({ races = [], now }) {
  const cutoff = now.getTime();
  return races.filter((race) => {
    if (!race || race.status !== "PENDING") return false;
    if (race.seedId) return false;
    if (!race.scheduledStartAt) return false;
    const scheduled = new Date(race.scheduledStartAt);
    if (Number.isNaN(scheduled.getTime())) return false;
    return scheduled.getTime() <= cutoff;
  });
}

function buildAutoStartScheduledRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const startRace = dependencies.startRace || defaultStartRace;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  // Returns the list of race ids that were started this tick.
  return async function autoStartScheduledRaces() {
    const currentTime = now();

    const candidates = (await raceModel.findScheduledDue(currentTime)) || [];
    const due = selectRacesToAutoStart({ races: candidates, now: currentTime });

    const started = [];
    for (const race of due) {
      try {
        // Anchor the start to the scheduled moment: pin now() to
        // scheduledStartAt so startRace sets endsAt = scheduledStart +
        // maxDurationDays. bypassSchedule skips the manual-start guard (the
        // schedule is satisfied by definition here).
        const scheduledStart = new Date(race.scheduledStartAt);
        await startRace({
          userId: race.creatorId,
          raceId: race.id,
          bypassSchedule: true,
          now: () => scheduledStart,
        });
        started.push(race.id);
        logger.log(
          `[CRON] Auto-started scheduled race ${race.id} ` +
            `(scheduled ${scheduledStart.toISOString()})`
        );
      } catch (error) {
        // A race can fail to start for legitimate reasons (e.g. fewer than 2
        // accepted participants by the scheduled time). Log and move on — it
        // stays PENDING and the creator can start it manually now that the
        // schedule guard has passed. Never let one failure block the others.
        logger.error(
          `[CRON] Failed to auto-start scheduled race ${race.id}:`,
          error?.message || error
        );
      }
    }

    return started;
  };
}

const autoStartScheduledRaces = buildAutoStartScheduledRaces();

function scheduleAutoStartScheduledRaces(dependencies = {}) {
  const interval = dependencies.intervalMs || SCHEDULER_INTERVAL_MS;
  const logger = dependencies.logger || console;
  const runFn =
    dependencies.autoStartScheduledRaces || autoStartScheduledRaces;

  async function run() {
    try {
      await runFn();
    } catch (error) {
      logger.error("[CRON] Auto-start scheduled races error:", error);
    }
  }

  run();
  setInterval(run, interval);
  logger.log(
    `[CRON] Auto-start scheduled races scheduled (every ${interval / 1000}s)`
  );
}

module.exports = {
  selectRacesToAutoStart,
  buildAutoStartScheduledRaces,
  autoStartScheduledRaces,
  scheduleAutoStartScheduledRaces,
  SCHEDULER_INTERVAL_MS,
};
