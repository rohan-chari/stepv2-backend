const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../events/eventBus");
const { resolveRaceState } = require("../services/raceStateResolution");
const { stepSyncPushService } = require("../services/stepSyncPush");
const { computeRacePayouts } = require("../utils/racePayoutPresets");

const RECOMPUTE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Races ending within this window are the "final stretch": we want their
// participants' steps to be as fresh as possible for the last few recomputes, so
// they get a tighter push throttle (below) than the default hourly cooldown.
const FINAL_STRETCH_WINDOW_MS = 60 * 60 * 1000; // ends within the next hour
const FINAL_STRETCH_MIN_INTERVAL_MS = 30 * 60 * 1000; // push at most every 30 min

// Live placement broadcast (Phase 0). Recomputes standings for every ACTIVE,
// not-yet-expired race and emits PLACEMENT_CHANGED when a participant's live rank
// changes, so users see standings update without opening the race. Backend-only:
// works for every shipped app version (the fan-out is server-side).
//
// The recompute primitive is resolveRaceState({ raceId }) — it already fetches the
// race, loops all ACCEPTED participants, and persists totalSteps/placement/finish
// state, defaulting timeZone to UTC when called without a requesting user. We then
// read the freshly-updated participants and derive a transient "live rank" by
// sorting totalSteps desc (the settlement `placement` column stays null until the
// race ends). Idempotent: a participant whose rank is unchanged is not re-notified.
function buildRecomputePlacements(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const events = dependencies.eventBus || eventBus;
  const resolve = dependencies.resolveRaceState || resolveRaceState;
  const requestStepSync =
    dependencies.requestStepSyncForUsers ||
    stepSyncPushService.requestStepSyncForUsers;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  return async function recomputePlacements() {
    const currentTime = now();
    const emitted = [];
    // Split for the step-sync "pull" below: participants of at least one race
    // ending within the next hour ("final stretch") get a tighter push throttle;
    // everyone else keeps the default hourly cooldown.
    const finalStretchUserIds = new Set();
    const normalUserIds = new Set();

    let races;
    try {
      races = await raceModel.findActiveInProgress(currentTime);
    } catch (error) {
      logger.error("[CRON] placementRecompute: failed to load active races:", error);
      return emitted;
    }

    if (!races || races.length === 0) return emitted;

    // Sequential over races: resolveRaceState fans out participants in parallel
    // internally, so looping races one-at-a-time bounds peak DB connections under
    // the pool cap.
    for (const race of races) {
      try {
        await resolve({ raceId: race.id });

        const participants = await participantModel.findAcceptedByRace(race.id);
        if (!participants || participants.length === 0) continue;

        // Collect for the step-sync "pull" below. A time-based race ending within
        // the hour is "final stretch"; step-target races (endsAt null) never are.
        const raceEnd = race.endsAt ? new Date(race.endsAt) : null;
        const isFinalStretch =
          raceEnd != null &&
          raceEnd.getTime() - currentTime.getTime() <= FINAL_STRETCH_WINDOW_MS;
        const bucket = isFinalStretch ? finalStretchUserIds : normalUserIds;
        for (const p of participants) bucket.add(p.userId);

        const ranked = [...participants].sort(
          (a, b) => (b.totalSteps ?? 0) - (a.totalSteps ?? 0)
        );

        // How many places are "in the money" for this race, so the handler can
        // alert only on a meaningful threshold crossing (dropping out of the
        // payout) instead of every one-spot slip. 0 when there's no pot — a free
        // race has no paid places, so only lead changes are meaningful.
        const paidPlaces =
          (race.potCoins || 0) > 0
            ? computeRacePayouts({
                preset: race.payoutPreset,
                potCoins: race.potCoins,
                participantCount: ranked.length,
              }).length
            : 0;

        for (let i = 0; i < ranked.length; i++) {
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
            raceId: race.id,
            raceName: race.name,
            userId: participant.userId,
            previousPlacement: participant.lastNotifiedPlacement,
            placement: liveRank,
            totalParticipants: ranked.length,
            paidPlaces,
          };
          events.emit("PLACEMENT_CHANGED", change);
          emitted.push(change);

          await participantModel.update(participant.id, {
            lastNotifiedPlacement: liveRank,
          });
        }
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

    return emitted;
  };
}

function scheduleRecomputePlacements(dependencies = {}) {
  const run = buildRecomputePlacements(dependencies);
  const logger = dependencies.logger || console;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] placementRecompute tick error:", error);
    }
  }

  tick(); // run once shortly after boot
  setInterval(tick, RECOMPUTE_INTERVAL_MS);
  logger.log("[CRON] Live placement recompute scheduled (every 5 minutes)");
}

module.exports = { buildRecomputePlacements, scheduleRecomputePlacements };
