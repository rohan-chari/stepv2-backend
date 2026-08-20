const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { StepSample } = require("../../steps/models/stepSample");
const { Steps } = require("../../steps/models/steps");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
const { eventsForUser } = require("../../steps/services/globalStepEventEntitlement");
const {
  ensureRaceGlobalEventEligibility,
  invalidateHomeActiveGlobalEvent,
} = require("../../steps/services/globalStepEventEntitlement");
const { completeRace } = require("../commands/completeRace");
const { advanceTournament } = require("../../tournaments/commands/advanceTournament");
const { prisma } = require("../../../db");
const {
  calculateBaseAdjusted,
  calculateCurrentTotal,
  determineFinishSnapshot,
} = require("../services/raceStateResolution");
const { raceTimeZone } = require("../raceTimeZone");
const { applyLeechTransfers } = require("../../powerups/leechTransfers");
const {
  collectRaceHitchhikeCopies,
  applyHitchhikeCopies,
} = require("../../powerups/hitchhikeCopies");
const { mintPiggyBank } = require("../../powerups/commands/expireEffects");
const { awardCoins } = require("../../../shared/economy/awardCoins");
const { nextRawSteps } = require("../../powerups/rawPosition");
const { withRaceWriteFence } = require("../services/raceWriteFence");
const { SETTLEMENT_EFFECT_TYPES } = require("../services/raceScoringEffectTypes");
const {
  computeSettlementAttributionVector,
} = require("../services/raceSettlementAttribution");
const derivedCache = require("../../../shared/cache/derivedCache");
const cacheKeys = require("../../../shared/cache/cacheKeys");

// Settlement acquires the race through the SAME fence-first ownership protocol
// the resolution worker uses (spec §5a item 6): the write transaction BEGINS by
// taking the v2 job row FOR UPDATE, before a single participant row is touched.
// Whichever of {settlement, live worker} gets there first holds the row for its
// transaction; the other blocks at the fence instead of interleaving bulk writes
// on the same race. The row is upserted first because a race that never had a
// resolution job would otherwise have nothing to lock.
//
// Rows are written in ASCENDING userId order — the one global lock order shared
// with the worker, forfeitRace's scan, and the multi-target powerups — and the
// whole transaction is retried ONCE on a 40P01 deadlock as defence in depth.
async function withSettlementFence(raceId, write) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await withRaceWriteFence(raceId, write);
    } catch (error) {
      if (error && error.code === "40P01" && attempt === 0) {
        console.warn(`[CRON] settlement deadlock on race ${raceId}; retrying once`);
        continue;
      }
      throw error;
    }
  }
}

function isQuickSettlementRace(race) {
  return (
    race?.creationSource === "QUICK_CREATE" &&
    race?.startPolicy === "ON_MINIMUM_PARTICIPANTS"
  );
}

// Keep the complete/payout/referral phase inside the same C0 ownership fence
// for quick races. The legacy path is deliberately untouched.
function completeRaceUnderSettlementFence(race, args) {
  return isQuickSettlementRace(race)
    ? withSettlementFence(race.id, () => completeRace(args))
    : completeRace(args);
}

// The Race remains the settlement authority. This companion write only keeps
// the private bucket lifecycle/audit row in sync after a successful settlement;
// legacy races have no reciprocal id and remain untouched.
async function markSeededBucketCompleted(race) {
  if (!race?.seededBucketId) return;
  await prisma.seededRaceBucket.updateMany({
    where: { id: race.seededBucketId, status: "ACTIVE" },
    data: { status: "COMPLETED" },
  });
}

const byUserIdAsc = (a, b) =>
  String(a.participant.userId || "").localeCompare(String(b.participant.userId || ""));

function chronologicalEffects(rows) {
  return [...rows].sort((a, b) => {
    const at = new Date(a.startsAt || 0).getTime();
    const bt = new Date(b.startsAt || 0).getTime();
    if (at !== bt) return at - bt;
    return String(a.id).localeCompare(String(b.id));
  });
}

// A read-only adapter over the exact settled effect rows. Attribution changes
// only which already-persisted effects are visible to the canonical scorer; it
// does not duplicate multiplier, floor, Leech, or Hitchhike calculations.
function buildAttributionEffectModel({ effectsByParticipant, hitchhikes, includedEffectIds }) {
  const included = includedEffectIds || new Set();
  const select = (rows) => chronologicalEffects((rows || []).filter((row) => included.has(row.id)));
  return {
    async findEffectsForRaceByTypes(_raceId, participantId, types) {
      const rows = select(effectsByParticipant.get(participantId));
      const byType = Object.fromEntries((types || []).map((type) => [type, []]));
      for (const row of rows) if (byType[row.type]) byType[row.type].push(row);
      return byType;
    },
    async findRaceEffectsByType(_raceId, type) {
      return type === "HITCHHIKE" ? select(hitchhikes) : [];
    },
  };
}

async function loadSettlementAttributionEffects({ raceId, participants, raceActiveEffectModel }) {
  const effectsByParticipant = new Map();
  for (const participant of participants) {
    const byType = await raceActiveEffectModel.findEffectsForRaceByTypes(
      raceId, participant.id, SETTLEMENT_EFFECT_TYPES
    );
    effectsByParticipant.set(participant.id, SETTLEMENT_EFFECT_TYPES.flatMap((type) => byType[type] || []));
  }
  const hitchhikes = await raceActiveEffectModel.findRaceEffectsByType(raceId, "HITCHHIKE");
  return { effectsByParticipant, hitchhikes: chronologicalEffects(hitchhikes) };
}

async function computeSettlementEffectAttribution({
  race, acceptedParticipants, preLeech, settlementTime, attributionEffects,
  globalEvents, eventsByUserId,
}) {
  const settledEvents = chronologicalEffects(globalEvents || []);
  const effects = chronologicalEffects([
    ...[...attributionEffects.effectsByParticipant.values()].flat(),
    ...attributionEffects.hitchhikes,
  ]);
  if (effects.length === 0 && settledEvents.length === 0) return null;
  const frozenTotals = new Map(acceptedParticipants
    .filter((participant) => participant.forfeitedAt || participant.finishedAt)
    .map((participant) => [participant.id, participant.finishTotalSteps ?? participant.totalSteps ?? race.targetSteps]));

  const score = async ({ effectIds, globalEvents: scoringGlobalEvents,
    eventsByUserId: scoringEventsByUserId }) => {
    const effectModel = buildAttributionEffectModel({ ...attributionEffects, includedEffectIds: effectIds });
    const active = [];
    for (const entry of preLeech) {
      const recomputed = await calculateCurrentTotal({
        raceId: race.id,
        racePowerupsEnabled: race.powerupsEnabled,
        participant: entry.participant,
        baseAdjusted: entry.baseAdjusted,
        hasSampleData: entry.hasSampleData,
        raceActiveEffectModel: effectModel,
        stepSampleModel: StepSample,
        globalEvents: scoringEventsByUserId
          ? eventsForUser(scoringEventsByUserId, entry.participant.userId)
          : scoringGlobalEvents,
        now: settlementTime,
      });
      active.push({
        participantId: entry.participant.id, userId: entry.participant.userId,
        preLeechTotal: recomputed.total, leechTransfers: recomputed.leechTransfers,
      });
    }
    const copies = await collectRaceHitchhikeCopies({
      raceId: race.id, raceEndsAt: settlementTime, participants: acceptedParticipants,
      raceActiveEffectModel: effectModel, stepSampleModel: StepSample, now: settlementTime,
      globalEvents: scoringGlobalEvents,
      eventsByUserId: scoringEventsByUserId,
    });
    const finals = applyLeechTransfers(applyHitchhikeCopies(active, copies));
    for (const [participantId, total] of frozenTotals) finals.set(participantId, total);
    return finals;
  };

  const vector = await computeSettlementAttributionVector({
    participants: acceptedParticipants, effects, globalEvents: settledEvents,
    eventsByUserId, score,
  });
  return vector;
}

// Env-tunable Bounty payout (§3.11). Frozen into each Bounty's metadata at
// use-time, so this default only applies to rows written before the env existed.
function bountyPayoutFallback() {
  const parsed = Number(process.env.BOUNTY_PAYOUT_COINS);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 150;
}

// §3.10 / §3.11 settlement hooks. Piggy Bank mints at min(expiry, settlement);
// Bounty pays out when the caster out-places the target. Both read effect rows
// regardless of ACTIVE/EXPIRED status and are idempotent via awardCoins refId.
// Item 4 (batch 2026-07-26) — COMMS ONLY. No mechanic change.
//
// Prod forensics settled the "my Trail Mine never activated" report: mines
// detonate ~94% of the time fleet-wide (292 expired vs 17 live). The reporter
// was a runaway leader whose three live mines sat above the entire field, so
// nobody ever walked through them. That is working as coded — but the owner
// silently never learns the outcome, which is what makes it feel broken.
//
// So at race end, every mine still ACTIVE (i.e. never crossed) gets one feed
// line telling its owner it expired untriggered. Explicitly NOT doing: no
// positionSteps offset, no plant-behind, no refund, no change to the
// "cannot plant while last" rule.
async function announceUntriggeredTrailMines({ race }) {
  if (!race.powerupsEnabled) return;
  try {
    const mines = await RaceActiveEffect.findRaceEffectsByType(
      race.id,
      "TRAIL_MINE"
    );
    for (const mine of mines) {
      if (mine.status !== "ACTIVE") continue; // a detonated mine is EXPIRED
      const positionSteps = (mine.metadata || {}).positionSteps;
      try {
        await RacePowerupEvent.create({
          raceId: race.id,
          actorUserId: mine.sourceUserId,
          eventType: "POWERUP_USED",
          powerupType: "TRAIL_MINE",
          targetUserId: null,
          description:
            typeof positionSteps === "number"
              ? `A Trail Mine at ${positionSteps.toLocaleString()} steps was never triggered. Nobody crossed it.`
              : "A Trail Mine was never triggered. Nobody crossed it.",
          metadata: {
            mineId: mine.id,
            positionSteps: positionSteps ?? null,
            untriggered: true,
          },
        });
        await RaceActiveEffect.update(mine.id, { status: "EXPIRED" });
      } catch (e) {
        console.error(`[CRON] Trail Mine expiry feed failed (${mine.id}):`, e);
      }
    }
  } catch (e) {
    console.error("[CRON] Trail Mine expiry query failed:", e);
  }
}

async function settleWave5Economy({ race, standings, settlementTime }) {
  if (!race.powerupsEnabled) return;

  // Piggy Bank — every piggy in the race, capped at settlement time.
  try {
    const piggies = await RaceActiveEffect.findRaceEffectsByType(race.id, "PIGGY_BANK");
    for (const effect of piggies) {
      try {
        await mintPiggyBank({ effect, stepSampleModel: StepSample, awardCoins, endCap: settlementTime });
      } catch (e) {
        console.error(`[CRON] Piggy Bank settle mint failed (${effect.id}):`, e);
      }
    }
  } catch (e) {
    console.error("[CRON] Piggy Bank settlement query failed:", e);
  }

  // Bounty — only individual races (disabled in team races at use-time).
  if (race.isTeamRace) return;
  try {
    const bounties = await RaceActiveEffect.findRaceEffectsByType(race.id, "BOUNTY");
    if (bounties.length === 0) return;
    // placement map from the final standings order (index+1). A user absent from
    // standings ranks worst.
    const placementByUser = new Map();
    standings.forEach((s, i) => placementByUser.set(s.participant.userId, i + 1));
    const worst = standings.length + 1;
    for (const effect of bounties) {
      try {
        const casterUserId = effect.sourceUserId;
        const targetUserId = (effect.metadata || {}).targetUserId || effect.targetUserId;
        const casterPlace = placementByUser.get(casterUserId) ?? worst;
        const targetPlace = placementByUser.get(targetUserId) ?? worst;
        if (casterPlace < targetPlace) {
          const payout = Number((effect.metadata || {}).payoutCoins);
          const coins = Number.isInteger(payout) && payout >= 0 ? payout : bountyPayoutFallback();
          if (coins > 0) {
            await awardCoins({ userId: casterUserId, amount: coins, reason: "bounty_payout", refId: effect.id });
            await RacePowerupEvent.create({
              raceId: race.id,
              actorUserId: casterUserId,
              eventType: "POWERUP_USED",
              powerupType: "BOUNTY",
              targetUserId,
              description: `Bounty collected! Out-placed the target and earned ${coins} coins.`,
              metadata: { outcome: "PAID", coins },
            });
          }
        }
      } catch (e) {
        console.error(`[CRON] Bounty payout failed (${effect.id}):`, e);
      }
    }
  } catch (e) {
    console.error("[CRON] Bounty settlement query failed:", e);
  }
}

async function resolveExpiredRaces() {
  console.log("[CRON] Checking for expired races...");

  const now = new Date();
  const expiredRaces = await Race.findActiveExpired(now);

  if (expiredRaces.length === 0) {
    console.log("[CRON] No expired races found");
    return;
  }

  console.log(`[CRON] Found ${expiredRaces.length} expired race(s)`);

  for (const race of expiredRaces) {
    try {
      const acceptedParticipants = race.participants.filter(
        (p) => p.status === "ACCEPTED"
      );
      const settlementTime = race.endsAt || now;

      // GlobalStepEvents overlapping the race window. Passed into the SHARED
      // resolution so the settled standings match what getRaceProgress showed.
      // This is settlement input, not an optional display decoration. If the
      // event read fails, leave the race ACTIVE so the next cron retries the
      // same canonical scorer rather than completing with a fabricated zero
      // global vector and permanently stranding its PENDING recap rows.
      const eventsByUserId = await ensureRaceGlobalEventEligibility({
        race,
        at: settlementTime,
      });
      await invalidateHomeActiveGlobalEvent(
        acceptedParticipants.map((participant) => participant.userId)
      );
      const globalEvents = [...new Map(
        acceptedParticipants.flatMap((participant) =>
          eventsForUser(eventsByUserId, participant.userId)
        ).map((event) => [`${event.entitlementId || event.id}:${event.id}`, event])
      ).values()];

      // Seeded races settle in their canonical tz so settled totals match what
      // getRaceProgress showed live; user races keep UTC (legacy).
      const settlementTz = raceTimeZone(race, "UTC");

      const standings = [];

      // Phase A: per-participant PRE-LEECH totals + the leeches targeting each.
      // Leech is a cross-participant zero-sum transfer, resolved race-wide in
      // phase B so settled totals match what getRaceProgress showed live. Frozen
      // (finished/forfeited) participants keep their stored totals and take no
      // part in the transfer, but still count toward the team total below.
      const preLeech = [];
      for (const participant of acceptedParticipants) {
        // TR-601: a forfeited team-race member's total is FROZEN at the value
        // snapshotted by the forfeit command — never recomputed (an active
        // debuff at forfeit time bites permanently). It still counts toward
        // the team total below.
        if (participant.forfeitedAt) {
          standings.push({
            participant,
            totalSteps: participant.totalSteps || 0,
            reachedAt: new Date(participant.forfeitedAt),
          });
          continue;
        }

        if (participant.finishedAt) {
          standings.push({
            participant,
            totalSteps:
              participant.finishTotalSteps ??
              participant.totalSteps ??
              race.targetSteps,
            reachedAt: new Date(participant.finishedAt),
          });
          continue;
        }

        const { baseAdjusted, hasSampleData, effectiveStart } =
          await calculateBaseAdjusted({
            participant,
            raceStartedAt: race.startedAt,
            // Seeded races settle in their canonical tz so settled totals match
            // what getRaceProgress showed live; user races keep UTC (legacy).
            timeZone: settlementTz,
            stepsModel: Steps,
            stepSampleModel: StepSample,
            now: settlementTime,
            raceEndsAt: race.endsAt,
            globalEvents: eventsForUser(eventsByUserId, participant.userId),
          });

        const {
          total,
          leechTransfers,
          legCramps,
          runnersHighs,
          wrongTurns,
          campfires,
          rainstorms,
          uprisings,
          rallyFlags,
          coinFlipWins,
          coinFlipLoses,
          ghostPeppers,
        } = await calculateCurrentTotal({
            raceId: race.id,
            racePowerupsEnabled: race.powerupsEnabled,
            participant,
            baseAdjusted,
            hasSampleData,
            raceActiveEffectModel: RaceActiveEffect,
            stepSampleModel: StepSample,
            globalEvents: eventsForUser(eventsByUserId, participant.userId),
            now: settlementTime,
          });

        preLeech.push({
          participant,
          baseAdjusted,
          hasSampleData,
          rawSteps: nextRawSteps(participant.rawSteps, baseAdjusted),
          preLeechTotal: total,
          leechTransfers,
          effectiveStart,
          effectGroups: {
            legCramps,
            runnersHighs,
            wrongTurns,
            campfires,
            rainstorms,
            uprisings,
            rallyFlags,
            coinFlipWins,
            coinFlipLoses,
            ghostPeppers,
          },
        });
      }

      // Phase A2 — HITCHHIKE (§7.3). The SAME insertion as the live display path
      // (getRaceProgress) and the background resolver (raceStateResolution): the
      // copy is folded into the CASTER's pre-leech total BEFORE the leech
      // resolution. This is the site that decides the FINAL settled standings, so
      // omitting it here is exactly the "score changes at race end" divergence the
      // spec's parity requirement exists to prevent. Each link's window is clamped
      // to race end here, so a settled copy can never include post-race walking.
      const hitchhikeCopies = race.powerupsEnabled
        ? await collectRaceHitchhikeCopies({
            raceId: race.id,
            raceEndsAt: settlementTime,
            participants: race.participants,
            raceActiveEffectModel: RaceActiveEffect,
            stepSampleModel: StepSample,
            now: settlementTime,
            globalEvents,
            eventsByUserId,
          })
        : [];

      // Phase B: resolve every leech race-wide (zero-sum, deterministic).
      const leechFinals = applyLeechTransfers(
        applyHitchhikeCopies(
          preLeech.map((e) => ({
            participantId: e.participant.id,
            userId: e.participant.userId,
            preLeechTotal: e.preLeechTotal,
            leechTransfers: e.leechTransfers,
          })),
          hitchhikeCopies
        )
      );

      // Phase C: compute each active participant's FINAL total and its reached-at
      // snapshot for tie-breaking. NOTHING is written here — determineFinishSnapshot
      // is an expensive read (samples + the full powerup event log), and holding
      // the settlement fence across it would pin the race's job row for the whole
      // replay. Writes are batched into the fenced transaction below.
      const finalTotals = [];
      for (const e of preLeech) {
        const total = leechFinals.get(e.participant.id) ?? e.preLeechTotal;
        const reachedSnapshot = await determineFinishSnapshot({
          participant: e.participant,
          currentTotal: total,
          targetSteps: total,
          effectiveStart: e.effectiveStart,
          effectGroups: e.effectGroups,
          stepSampleModel: StepSample,
          powerupEventModel: RacePowerupEvent,
          raceId: race.id,
          now: settlementTime,
        });

        finalTotals.push({
          participant: e.participant,
          totalSteps: total,
          rawSteps: e.rawSteps,
        });
        standings.push({
          participant: e.participant,
          totalSteps: total,
          reachedAt: reachedSnapshot?.finishedAt || settlementTime,
        });
      }

      // Re-run only the existing whole-race scorer under ordered subsets of
      // already-settled effect rows. Any attribution failure leaves canonical
      // settlement untouched and produces no fabricated explanation rows.
      let effectAttribution = null;
      try {
        const attributionEffects = await loadSettlementAttributionEffects({
          raceId: race.id,
          participants: acceptedParticipants,
          raceActiveEffectModel: RaceActiveEffect,
        });
        effectAttribution = await computeSettlementEffectAttribution({
          race,
          acceptedParticipants,
          preLeech,
          settlementTime,
          attributionEffects,
          globalEvents,
          eventsByUserId,
        });
      } catch (error) {
        console.error(`[CRON] Effect attribution failed for race ${race.id}:`, error);
      }

      // Fenced write #1 — settled totals. Fence acquired FIRST, then rows in
      // ascending userId order.
      finalTotals.sort(byUserIdAsc);
      const settledTotalsWritten = await withSettlementFence(race.id, async (tx) => {
        const lockedParticipants = await tx.raceParticipant.findMany({
          where: { raceId: race.id, status: "ACCEPTED" },
          select: { id: true },
        });
        const lockedIds = new Set(lockedParticipants.map((row) => row.id));
        if (
          lockedIds.size !== acceptedParticipants.length ||
          acceptedParticipants.some((row) => !lockedIds.has(row.id))
        ) {
          return false;
        }
        for (const row of finalTotals) {
          await tx.raceParticipant.update({
            where: { id: row.participant.id },
            data: {
              totalSteps: row.totalSteps,
              rawSteps: row.rawSteps,
              totalsUpdatedAt: new Date(),
            },
          });
        }
        for (const row of effectAttribution?.effectImpacts || []) {
          await tx.raceEffectImpact.upsert({
            where: { raceId_userId_effectId: { raceId: race.id, userId: row.userId, effectId: row.effectId } },
            update: {},
            create: {
              raceId: race.id, userId: row.userId, effectId: row.effectId,
              powerupType: row.powerupType, deltaSteps: row.deltaSteps,
              attributionVersion: effectAttribution.attributionVersion,
              settledAt: settlementTime,
            },
          });
        }
        // PENDING is normally written at event start/race start/late join.
        // Upserting the final canonical vector here is also the repair fence
        // for a previously interrupted enrollment write: it never derives any
        // score itself, and the recap worker still waits for event close plus
        // every enrolled race/user to be FINAL.
        for (const row of effectAttribution?.globalImpacts || []) {
          await tx.globalEventRaceImpact.upsert({
            where: { eventId_raceId_userId: { eventId: row.eventId, raceId: race.id, userId: row.userId } },
            update: {
              status: "FINAL", deltaSteps: row.deltaSteps,
              attributionVersion: effectAttribution.attributionVersion,
              settledAt: settlementTime,
            },
            create: {
              eventId: row.eventId, raceId: race.id, userId: row.userId,
              status: "FINAL", deltaSteps: row.deltaSteps,
              attributionVersion: effectAttribution.attributionVersion,
              settledAt: settlementTime,
            },
          });
        }
        return true;
      });
      if (!settledTotalsWritten) {
        console.log(
          `[CRON] Race ${race.id} membership changed before settlement; retrying next tick`,
        );
        continue;
      }
      // The upsert above is also the final-impact repair path. Any previously
      // cached Home eligibility must be discarded after that transaction
      // commits; Redis remains best-effort and Postgres remains authoritative.
      for (const userId of new Set(
        (effectAttribution?.globalImpacts || []).map((row) => row.userId)
      )) {
        await derivedCache.invalidate({
          keys: [cacheKeys.homeImpactSummary(userId)],
          prefix: cacheKeys.PREFIX.HOME_IMPACT_SUMMARY,
        });
      }

      // ── Team settlement (TR-401/402/404) ─────────────────────────────────
      // Team total = sum of member effective totals (forfeited members' frozen
      // totals included). Higher total wins; equal totals are a TIE — no
      // sudden death, completeRace refunds every buy-in. Placements (1 for the
      // whole winning team, 2 for the losers, all 1 on tie) are set INSIDE
      // completeRace so the deadline path and the collapse path share it.
      if (race.isTeamRace) {
        // Piggy Bank mints in team races too (Bounty is individual-only and a
        // no-op here). Runs before completeRace so the coins land at settlement.
        await settleWave5Economy({ race, standings, settlementTime });
        await announceUntriggeredTrailMines({ race });

        const teamTotals = { TEAM_A: 0, TEAM_B: 0 };
        for (const standing of standings) {
          const team = standing.participant.team;
          if (team === "TEAM_A" || team === "TEAM_B") {
            teamTotals[team] += standing.totalSteps || 0;
          }
        }

        const isTie = teamTotals.TEAM_A === teamTotals.TEAM_B;
        const winnerTeam = isTie
          ? null
          : teamTotals.TEAM_A > teamTotals.TEAM_B
            ? "TEAM_A"
            : "TEAM_B";

        await completeRaceUnderSettlementFence(race, {
          raceId: race.id,
          winnerUserId: null,
          winnerTeam,
          tie: isTie,
          participantUserIds: acceptedParticipants.map((p) => p.userId),
        });
        await markSeededBucketCompleted(race);

        console.log(
          `[CRON] Team race ${race.id} ("${race.name}") expired. ` +
            (isTie
              ? `Tie at ${teamTotals.TEAM_A} steps — buy-ins refunded` +
                (race.fundedPrize === true ? ", pool split across both teams" : "")
              : `Winner: ${winnerTeam} (${teamTotals.TEAM_A} vs ${teamTotals.TEAM_B})`)
        );
        continue;
      }

      standings.sort((a, b) => {
        const totalDiff = b.totalSteps - a.totalSteps;
        if (totalDiff !== 0) return totalDiff;

        const reachedDiff =
          new Date(a.reachedAt).getTime() - new Date(b.reachedAt).getTime();
        if (reachedDiff !== 0) return reachedDiff;

        return (a.participant.userId || "").localeCompare(b.participant.userId || "");
      });

      // Fenced write #2 — final placements. Same protocol: fence first, then the
      // rows in ascending userId order (the placement each row gets comes from
      // the sorted standings above, so the write ORDER does not change the
      // values it writes).
      const placements = standings.map((standing, index) => ({
        participant: standing.participant,
        placement: index + 1,
      }));
      placements.sort(byUserIdAsc);
      const placementsWritten = await withSettlementFence(race.id, async (tx) => {
        const lockedParticipants = await tx.raceParticipant.findMany({
          where: { raceId: race.id, status: "ACCEPTED" },
          select: { id: true },
        });
        const lockedIds = new Set(lockedParticipants.map((row) => row.id));
        if (
          lockedIds.size !== acceptedParticipants.length ||
          acceptedParticipants.some((row) => !lockedIds.has(row.id))
        ) {
          return false;
        }
        for (const row of placements) {
          await tx.raceParticipant.update({
            where: { id: row.participant.id },
            data: { placement: row.placement },
          });
        }
        return true;
      });
      if (!placementsWritten) {
        console.log(
          `[CRON] Race ${race.id} membership changed before placements; retrying next tick`,
        );
        continue;
      }

      // §3.10 / §3.11: Piggy Bank mint + Bounty payout, using the just-sorted
      // standings for placement. Idempotent via awardCoins refId.
      await settleWave5Economy({ race, standings, settlementTime });
      await announceUntriggeredTrailMines({ race });

      const participantUserIds = acceptedParticipants.map((p) => p.userId);
      const topUserId = standings[0]?.participant.userId || null;
      const topSteps = standings[0]?.totalSteps || 0;

      await completeRaceUnderSettlementFence(race, {
        raceId: race.id,
        winnerUserId: topUserId,
        participantUserIds,
      });
      await markSeededBucketCompleted(race);

      console.log(
        `[CRON] Race ${race.id} ("${race.name}") expired. Winner: ${topUserId || "none"} with ${topSteps} steps`
      );
    } catch (error) {
      console.error(`[CRON] Failed to resolve expired race ${race.id}:`, error);
    }
  }

  // Belt-and-braces tournament advancement sweep: settling a matchup already
  // drives advanceTournament via completeRace, but a crash between settling the
  // last matchup and advancing would strand a bracket. advanceTournament is a
  // cheap no-op when the current round isn't fully settled, so call it for every
  // ACTIVE tournament each sweep.
  try {
    const activeTournaments = await prisma.tournament.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });
    for (const t of activeTournaments) {
      try {
        await advanceTournament({ tournamentId: t.id });
      } catch (error) {
        console.error(`[CRON] Tournament advance sweep failed for ${t.id}:`, error);
      }
    }
  } catch (error) {
    console.error("[CRON] Tournament advance sweep query failed:", error);
  }
}

function scheduleRaceExpiryCheck() {
  // Every 5 minutes — matches the seeded-race renewal cadence so a finished
  // daily/weekly race is settled promptly and the next one spins up within
  // minutes (keeps the Featured section from showing a long "starting soon"
  // gap). The check is idempotent (completeRace early-returns on non-ACTIVE).
  const INTERVAL = 5 * 60 * 1000; // every 5 minutes

  async function run() {
    try {
      await resolveExpiredRaces();
    } catch (error) {
      console.error("[CRON] Race expiry check error:", error);
    }
  }

  setInterval(run, INTERVAL);
  console.log("[CRON] Race expiry check scheduled (hourly)");
}

module.exports = {
  resolveExpiredRaces,
  scheduleRaceExpiryCheck,
  completeRaceUnderSettlementFence,
};
