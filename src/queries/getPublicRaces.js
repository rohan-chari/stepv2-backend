const { Race } = require("../models/race");
const { computeRacePayouts } = require("../utils/racePayoutPresets");
const {
  computeFinishRewardPool,
  computeFinishRewardPlaces,
} = require("../constants/raceFinishReward");
const { buildTeamsBlockFromParticipants } = require("../utils/teamRaces");

function buildGetPublicRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;

  // `supportsTeamRaces` (TR-702): old clients never see team races in the
  // browser. TR-204: team races are browsable only while PENDING — once ACTIVE
  // they lock, unlike individual public races which stay joinable mid-flight.
  return async function getPublicRaces({ userId, supportsTeamRaces = false }) {
    const races = await raceModel.findPublicPending();

    const results = [];
    for (const race of races) {
      // Matchup races are never browsable — managed only via the tournament UI.
      if (race.tournamentId) continue;
      if (race.isTeamRace && !supportsTeamRaces) continue;
      if (race.isTeamRace && race.status !== "PENDING") continue;
      const participants = race.participants || [];
      const userInRace = participants.some((p) => p.userId === userId);
      if (userInRace) continue;

      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      // null => unlimited; a full race is skipped, but unlimited is never full.
      const maxParticipants = race.maxParticipants ?? null;
      if (maxParticipants != null && acceptedCount >= maxParticipants) continue;

      const heldPotCoins = participants.reduce((sum, p) => {
        if (p.buyInStatus === "HELD") {
          return sum + (p.buyInAmount || 0);
        }
        return sum;
      }, 0);
      const projectedPotCoins = (race.potCoins || 0) + heldPotCoins;
      const payouts = computeRacePayouts({
        preset: race.payoutPreset,
        potCoins: projectedPotCoins,
        participantCount: acceptedCount,
      });
      const finishRewardPool = computeFinishRewardPool(
        race.seedId,
        acceptedCount
      );
      const finishRewardPlaces = computeFinishRewardPlaces(
        race.seedId,
        acceptedCount,
        finishRewardPool
      );

      results.push({
        id: race.id,
        name: race.name,
        status: race.status,
        maxDurationDays: race.maxDurationDays,
        endsAt: race.endsAt,
        startedAt: race.startedAt,
        targetSteps: race.targetSteps, // 1.1.4 compat
        buyInAmount: race.buyInAmount,
        payoutPreset: race.payoutPreset,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        maxParticipants,
        participantCount: acceptedCount,
        projectedPotCoins,
        // Legacy three-place shape for app builds that predate payoutTiers; they
        // show only the podium, which degrades gracefully for field-scaled presets.
        payouts: {
          first: payouts[0] || 0,
          second: payouts[1] || 0,
          third: payouts[2] || 0,
        },
        // Full breakdown (placement 1..N); newer builds render it, older ignore it.
        payoutTiers: payouts.map((amount, index) => ({
          placement: index + 1,
          amount,
        })),
        finishReward:
          finishRewardPool > 0
            ? { pool: finishRewardPool, paidPlaces: finishRewardPlaces }
            : null,
        creator: race.creator,
        createdAt: race.createdAt,
        // ── Team races (TR-206) — additive; only sent to token clients (the
        // filter above drops team races for everyone else). Open-slot counts
        // let the card render "2v2 · 1 slot left on Blue".
        isTeamRace: race.isTeamRace === true,
        teamSize: race.teamSize ?? null,
        teamAName: race.teamAName ?? null,
        teamBName: race.teamBName ?? null,
        // Canonical H2H block (same shape as progress/list) — carries the
        // per-side memberCount the slots line reads. Totals are 0 on a PENDING
        // lobby, which is exactly right for a not-yet-started race.
        teams: race.isTeamRace
          ? buildTeamsBlockFromParticipants(race, participants)
          : null,
        teamAOpenSlots: race.isTeamRace
          ? Math.max(
              0,
              (race.teamSize || 0) -
                participants.filter(
                  (p) => p.status === "ACCEPTED" && p.team === "TEAM_A"
                ).length
            )
          : null,
        teamBOpenSlots: race.isTeamRace
          ? Math.max(
              0,
              (race.teamSize || 0) -
                participants.filter(
                  (p) => p.status === "ACCEPTED" && p.team === "TEAM_B"
                ).length
            )
          : null,
      });
    }
    return results;
  };
}

const getPublicRaces = buildGetPublicRaces();

module.exports = { buildGetPublicRaces, getPublicRaces };
