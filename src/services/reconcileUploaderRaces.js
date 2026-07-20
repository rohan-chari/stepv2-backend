const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { Steps } = require("../models/steps");
const { StepSample } = require("../models/stepSample");
const { RaceActiveEffect } = require("../models/raceActiveEffect");
const { GlobalStepEvent } = require("../models/globalStepEvent");
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
const { computeBoxEffectiveSteps } = require("../utils/boxSteps");
const { raceTimeZone } = require("../utils/raceTimeZone");
const { applyLeechTransfers } = require("../utils/leechTransfers");

// Narrowly-scoped uploader reconciliation for POST /steps/sync-v2 (§6.4 / Phase
// C2). For each of the uploader's ACTIVE races it computes and persists ONLY the
// uploader's own participant total (using the SAME primitives and timezone rules
// as resolveRaceState) and runs syncRacePowerupState for that uploader so newly
// earned mystery boxes / queued powerups are current in the same pull.
//
// It explicitly does NOT evaluate trail mines, overtakes, rival totals, rival
// writes, placement events, or any other cross-participant work — the durable
// full-field worker owns all of that. Each race is processed under the shared
// per-race advisory lock, in stable sorted race-id order, so it never interleaves
// with the worker/legacy/placement paths or deadlocks a multi-race user.

function buildReconcileUploaderRaces(dependencies = {}) {
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

  return async function reconcileUploaderRaces({ userId, timeZone = "UTC" }) {
    const races = await raceModel.findActiveForUser(userId);
    // Stable sorted order to avoid advisory-lock deadlocks across paths.
    const ordered = [...races].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    let resolvedRaceCount = 0;

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

      await withRaceResolutionLock(race.id, async () => {
        const currentTime = now();

        let globalEvents = [];
        try {
          globalEvents =
            (await globalStepEventModel.findActiveInRange(
              race.startedAt,
              currentTime
            )) || [];
        } catch {
          globalEvents = [];
        }

        const scoreTz = raceTimeZone(race, timeZone);
        const { baseAdjusted, hasSampleData } = await calculateBaseAdjusted({
          participant,
          raceStartedAt: race.startedAt,
          timeZone: scoreTz,
          stepsModel,
          stepSampleModel,
          now: currentTime,
        });

        const { total, leechTransfers } = await calculateCurrentTotal({
          raceId: race.id,
          racePowerupsEnabled: race.powerupsEnabled,
          participant,
          baseAdjusted,
          hasSampleData,
          raceActiveEffectModel,
          stepSampleModel,
          globalEvents,
          now: currentTime,
        });

        // §5: apply DRAIN-ONLY leech for the uploader. This narrow path persists
        // only the uploader's own row, so we resolve the leeches TARGETING the
        // uploader (draining their pre-leech total, floored at 0) but do NOT
        // compute the uploader's attacker credit for leeches THEY cast on rivals —
        // that requires the victims' availability and is applied by the durable
        // full-field worker (resolveRaceState) shortly after, matching the same
        // rival-staleness tradeoff sync-v2 already accepts (D14). Passing a single
        // entry yields drain-only by construction: with no attacker participant
        // present, applyLeechTransfers credits nobody.
        const leechFinals = applyLeechTransfers([
          {
            participantId: participant.id,
            userId: participant.userId,
            preLeechTotal: total,
            leechTransfers,
          },
        ]);
        const finalTotal = leechFinals.get(participant.id) ?? total;

        await participantModel.updateTotalSteps(participant.id, finalTotal);

        // Box progress uses the RAW-walked box total in boxTz = raceTimeZone(
        // race, "UTC") — device-independent, immune to buff/debuff multipliers —
        // exactly like the resolver's userBoxEffectiveSteps.
        const boxTz = raceTimeZone(race, "UTC");
        let boxBaseAdjusted;
        if (scoreTz === boxTz) {
          boxBaseAdjusted = baseAdjusted;
        } else {
          ({ baseAdjusted: boxBaseAdjusted } = await calculateBaseAdjusted({
            participant,
            raceStartedAt: race.startedAt,
            timeZone: boxTz,
            stepsModel,
            stepSampleModel,
            now: currentTime,
          }));
        }
        const boxEffectiveSteps = computeBoxEffectiveSteps({
          baseAdjusted: boxBaseAdjusted,
          bonusSteps: participant.bonusSteps || 0,
          maxBonusSteps: participant.maxBonusSteps || 0,
        });

        // Sync ONLY the uploader's box/powerup state. Pass the lean race so no
        // duplicate findById round-trip; syncRacePowerupState self-refetches when
        // a roll mutates the field.
        await syncRacePowerupState({
          raceId: race.id,
          userId,
          race,
          boxEffectiveSteps,
        });
      });

      resolvedRaceCount += 1;
    }

    return { resolvedRaceCount, boxStateCurrent: true };
  };
}

const reconcileUploaderRaces = buildReconcileUploaderRaces();

module.exports = { buildReconcileUploaderRaces, reconcileUploaderRaces };
