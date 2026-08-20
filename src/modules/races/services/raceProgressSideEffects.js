// C3 (spec §5 Phase D steps 8 + 9, §5a item 5): everything the `/progress`
// endpoint used to do BESIDES answering the request, relocated to the
// race-keyed v2 worker's post-commit hook.
//
// ── Why this module exists at all ──────────────────────────────────────────
// Phase D step 8 says the endpoint's side effects "move to the resolution
// worker and expireEffects cron where they already exist". Auditing the tree
// found that only ONE of the three was actually covered:
//
//   syncRacePowerupState  ALREADY in the v2 worker (raceResolutionQueueV2.js —
//                         it runs for every user in the claimed job's
//                         processing snapshot, and a progress poll enqueues
//                         with the viewing userId, so the viewer is one).
//   expireEffects         NOT covered. `grep -rn expireEffects src/` finds
//                         exactly two live call sites: getRaceProgress and its
//                         own definition. There is no expireEffects cron. It
//                         is what stamps `stepsAtExpiry`, reverts Fanny Pack
//                         slots, judges Drill Sergeant dares and MINTS PIGGY
//                         BANK COINS — deleting it from the request path
//                         without a replacement would silently stop all four.
//   high-multiplier alert NOT covered. `evaluateHighMultiplierAlert` ran from
//                         getRaceProgress (the re-arm/event-crossing path) and
//                         from usePowerup (the immediate self-buff spike). Only
//                         the latter survives the endpoint change, so the
//                         event-driven crossing and the re-arm-on-decay would
//                         both be lost.
//
// Both missing ones are wired HERE, into the worker's flow — never back into
// the endpoint. Everything is best-effort: a failure is logged and swallowed,
// because none of it may take down a resolution run that already committed.
//
// ── And the snapshot publish ───────────────────────────────────────────────
// After the fenced Postgres commit the worker SETs (replaces) the race's Redis
// snapshot from the totals it just committed. Never a DEL: the worker's value
// is the freshest there is, so the worker is deliberately absent from §3's
// DEL-hook list. A failed SET is logged and ignored — the older snapshot goes
// stale within 15s and the next reader rebuilds.

const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const {
  GlobalStepEventEntitlement,
} = require("../../steps/models/globalStepEventEntitlement");
const {
  eventsForUser,
} = require("../../steps/services/globalStepEventEntitlement");
const {
  expireEffects: defaultExpireEffects,
} = require("../../powerups/commands/expireEffects");
const {
  evaluateHighMultiplierAlert: defaultEvaluateHighMultiplierAlert,
} = require("./highMultiplierAlert");
const { signedMultiplierForEffects } = require("./effectiveStepScoring");
const defaultSnapshotStore = require("./raceProgressSnapshot");
const { appSettings: defaultAppSettings } = require("../../../shared/config/appSettings");
const redisCache = require("../../../shared/cache/redisCache");
const { eventBus } = require("../../../shared/events/eventBus");
const {
  raceResolutionDeliveryIntents: defaultDeliveryIntents,
} = require("./raceResolutionDeliveryIntents");

function buildRaceProgressPostCommit(dependencies = {}) {
  const effectModel = dependencies.RaceActiveEffect || RaceActiveEffect;
  const globalStepEventModel = dependencies.GlobalStepEvent || GlobalStepEvent;
  const entitlementModel =
    dependencies.GlobalStepEventEntitlement || GlobalStepEventEntitlement;
  const expireEffectsFn = dependencies.expireEffects || defaultExpireEffects;
  const evaluateAlert =
    dependencies.evaluateHighMultiplierAlert || defaultEvaluateHighMultiplierAlert;
  const snapshotStore = dependencies.raceProgressSnapshot || defaultSnapshotStore;
  const settings = dependencies.appSettings || defaultAppSettings;
  const logger = dependencies.logger || console;
  const deliveryIntents =
    dependencies.raceResolutionDeliveryIntents || defaultDeliveryIntents;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  // Same two-condition gate the endpoint uses. With the flag off the worker
  // publishes nothing and runs no relocated side effect, so the endpoint (which
  // is still doing all three itself) is not double-firing anything.
  async function enabled() {
    if (dependencies.redisStandingsEnabled != null) {
      return dependencies.redisStandingsEnabled === true;
    }
    if (!redisCache.isEnabled()) return false;
    try {
      return (await settings.getFlag("redisStandingsEnabled")) === true;
    } catch {
      return false;
    }
  }

  /** Relocated from getRaceProgress: expire timed effects for this race. */
  async function runExpireEffects({ raceId, result }) {
    try {
      await expireEffectsFn({
        raceId,
        // Additive field on resolveRaceState's return (C3). Absent on an older
        // shape => expireEffects simply skips the stepsAtExpiry stamp, exactly
        // as it does today when a caller omits the map.
        participantSteps: result?.baseAdjustedByParticipantId || {},
      });
    } catch (error) {
      logger.error(`[C3] expireEffects failed (race ${raceId}):`, error);
    }
  }

  /**
   * Relocated from getRaceProgress §6b: the event-driven crossing + re-arm.
   * The multiplier is rebuilt from ONE `findActiveForRace` read grouped by
   * participant — the same `signedMultiplierForEffects` the display path folds,
   * times any live global 2x event (magnitude only, sign preserved).
   */
  async function runHighMultiplierAlert({
    raceId,
    result,
    deferDelivery = false,
    sourceGeneration = null,
  }) {
    const race = result?.race;
    if (!race || !race.powerupsEnabled) return [];
    const intentClaims = [];
    try {
      const accepted = (race.participants || []).filter(
        (p) => p.status === "ACCEPTED"
      );
      if (accepted.length === 0) return intentClaims;

      const activeEffects = (await effectModel.findActiveForRace(raceId)) || [];
      const byParticipant = new Map();
      for (const effect of activeEffects) {
        const key = effect.targetParticipantId;
        if (!key) continue;
        if (!byParticipant.has(key)) byParticipant.set(key, []);
        byParticipant.get(key).push(effect);
      }

      const nowTime = now();
      const nowMs = nowTime.getTime();
      let eventsByUserId = new Map(accepted.map((p) => [p.userId, []]));
      try {
        if (typeof entitlementModel.findEligibleByRace === "function") {
          eventsByUserId = await entitlementModel.findEligibleByRace({
            raceId,
            userIds: accepted.map((p) => p.userId),
            rangeStart: race.startedAt,
            rangeEnd: nowTime,
          });
        } else {
          const legacyEvents =
            (await globalStepEventModel.findActiveInRange(race.startedAt, nowTime)) || [];
          eventsByUserId = new Map(
            accepted.map((p) => [p.userId, legacyEvents])
          );
        }
      } catch {
        eventsByUserId = new Map(accepted.map((p) => [p.userId, []]));
      }

      const activeForAlert = accepted.filter((p) => !p.finishedAt && !p.forfeitedAt);
      for (const p of accepted) {
        const frozen = Boolean(p.finishedAt || p.forfeitedAt);
        const raw = frozen
          ? 1
          : signedMultiplierForEffects(byParticipant.get(p.id) || [], nowMs);
        const liveEvent = eventsForUser(eventsByUserId, p.userId).find((ev) => {
          const s = new Date(ev.startsAt).getTime();
          const e = new Date(ev.endsAt).getTime();
          return s <= nowMs && nowMs < e && Number(ev.multiplier) > 1;
        });
        const eventMult = liveEvent ? Number(liveEvent.multiplier) : 1;
        try {
          const outcome = await evaluateAlert({
            participant: p,
            currentMultiplier: raw * eventMult,
            race,
            otherParticipants: activeForAlert,
            now,
            ...(deferDelivery ? {
              deferClaim: true,
              emitAlert: async (alert, participantClaim) => {
                intentClaims.push({
                  kind: "HIGH_MULTIPLIER",
                  data: alert,
                  participantClaim,
                  sourceGeneration,
                });
                return [];
              },
            } : {}),
          });
          void outcome;
        } catch (error) {
          logger.error("[C3] high-multiplier alert eval failed:", error);
        }
      }
    } catch (error) {
      logger.error(`[C3] high-multiplier pass failed (race ${raceId}):`, error);
    }
    return intentClaims;
  }

  /** SET (never DEL) the race's shared standings snapshot. */
  async function publishSnapshot({ raceId, timeZone, result }) {
    try {
      // Lazy require: getRaceProgress pulls in most of the race module, and the
      // worker is constructed at process start.
      const getRaceProgress =
        dependencies.getRaceProgress ||
        require("../queries/getRaceProgress").getRaceProgress;
      const snapshot = await getRaceProgress.computePersistedSnapshot({
        raceId,
        timeZone: timeZone || "UTC",
        baseAdjustedByParticipantId:
          result?.baseAdjustedByParticipantId || null,
      });
      if (!snapshot) return false;
      snapshot.source = "worker";
      return await snapshotStore.writeSnapshot(raceId, snapshot);
    } catch (error) {
      // Logged and ignored by contract: the previous snapshot ages out of
      // freshness within 15s and the next reader rebuilds it.
      logger.error(`[C3] snapshot publish failed (race ${raceId}):`, error);
      return false;
    }
  }

  /**
   * The v2 worker's `onCommitted` hook. Runs strictly AFTER the fenced Postgres
   * commit, holds no lock, and never throws.
   */
  async function onCommitted({
    raceId,
    job,
    result,
    superseded = false,
    deferEffectExpiry = false,
    deferSnapshot = false,
    deferDelivery = false,
  } = {}) {
    if (!raceId) return;
    if (!(await enabled())) return;
    // With v2 event materialization enabled, an ordinary score generation must
    // not consume a due source before the durable EFFECT_BOUNDARY claim can
    // calculate and commit its event. The boundary run performs the normal
    // expiry immediately after its atomic C0 write.
    if (!deferEffectExpiry) await runExpireEffects({ raceId, result });
    const intentClaims = await runHighMultiplierAlert({
      raceId,
      result,
      deferDelivery,
      sourceGeneration: job?.processingGeneration ?? null,
    });
    // A newer generation arrived while this one ran. Its mutation already
    // invalidated the snapshot; do not overwrite that DEL with older committed
    // totals while the follow-up worker is waiting in the quiet period.
    const snapshotCommand = {
      raceId,
      timeZone: job?.processingTimeZone || job?.resolutionTimeZone || "UTC",
    };
    if (deferSnapshot) {
      return deferDelivery ? { snapshotCommand, intentClaims } : { snapshotCommand };
    }
    if (superseded) return { snapshotCommand: null, intentClaims: [] };
    await publishSnapshot({ ...snapshotCommand, result });
    return { snapshotCommand: null, intentClaims: [] };
  }

  // The durable post-task runner receives only the allowlisted command. It
  // re-reads committed rows and never re-enters scoring/RNG/recipient logic.
  onCommitted.publishSnapshotCommand = async function publishSnapshotCommand(command) {
    if (
      !command ||
      typeof command.raceId !== "string" ||
      typeof command.timeZone !== "string"
    ) {
      return false;
    }
    return publishSnapshot(command);
  };

  return onCommitted;
}

const raceProgressPostCommit = buildRaceProgressPostCommit();

module.exports = { buildRaceProgressPostCommit, raceProgressPostCommit };
