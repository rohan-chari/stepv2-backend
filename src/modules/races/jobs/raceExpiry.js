const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { RaceActiveEffect } = require("../../powerups/models/raceActiveEffect");
const { RacePowerupEvent } = require("../../powerups/models/racePowerupEvent");
const { StepSample } = require("../../steps/models/stepSample");
const { Steps } = require("../../steps/models/steps");
const { GlobalStepEvent } = require("../../steps/models/globalStepEvent");
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

// Env-tunable Bounty payout (§3.11). Frozen into each Bounty's metadata at
// use-time, so this default only applies to rows written before the env existed.
function bountyPayoutFallback() {
  const parsed = Number(process.env.BOUNTY_PAYOUT_COINS);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 150;
}

// §3.10 / §3.11 settlement hooks. Piggy Bank mints at min(expiry, settlement);
// Bounty pays out when the caster out-places the target. Both read effect rows
// regardless of ACTIVE/EXPIRED status and are idempotent via awardCoins refId.
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
      let globalEvents = [];
      try {
        globalEvents =
          (await GlobalStepEvent.findActiveInRange(
            race.startedAt,
            settlementTime
          )) || [];
      } catch {
        globalEvents = [];
      }

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
            timeZone: raceTimeZone(race, "UTC"),
            stepsModel: Steps,
            stepSampleModel: StepSample,
            now: settlementTime,
            globalEvents,
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
            globalEvents,
            now: settlementTime,
          });

        preLeech.push({
          participant,
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

      // Phase C: persist each active participant's FINAL total, compute its
      // reached-at snapshot for tie-breaking, and add it to the standings.
      for (const e of preLeech) {
        const total = leechFinals.get(e.participant.id) ?? e.preLeechTotal;
        await RaceParticipant.updateTotalSteps(e.participant.id, total);
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

        standings.push({
          participant: e.participant,
          totalSteps: total,
          reachedAt: reachedSnapshot?.finishedAt || settlementTime,
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

        await completeRace({
          raceId: race.id,
          winnerUserId: null,
          winnerTeam,
          tie: isTie,
          participantUserIds: acceptedParticipants.map((p) => p.userId),
        });

        console.log(
          `[CRON] Team race ${race.id} ("${race.name}") expired. ` +
            (isTie
              ? `Tie at ${teamTotals.TEAM_A} steps — buy-ins refunded`
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

      for (let index = 0; index < standings.length; index++) {
        await RaceParticipant.setPlacement(
          standings[index].participant.id,
          index + 1
        );
      }

      // §3.10 / §3.11: Piggy Bank mint + Bounty payout, using the just-sorted
      // standings for placement. Idempotent via awardCoins refId.
      await settleWave5Economy({ race, standings, settlementTime });

      const participantUserIds = acceptedParticipants.map((p) => p.userId);
      const topUserId = standings[0]?.participant.userId || null;
      const topSteps = standings[0]?.totalSteps || 0;

      await completeRace({
        raceId: race.id,
        winnerUserId: topUserId,
        participantUserIds,
      });

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

module.exports = { resolveExpiredRaces, scheduleRaceExpiryCheck };
