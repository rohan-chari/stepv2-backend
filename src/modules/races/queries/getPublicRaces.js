const { Race } = require("../models/race");
const {
  buildRaceMoneyView,
  serializePayouts,
} = require("../racePrizePool");
const { buildTeamsBlockFromParticipants } = require("../teamRaces");

// Shared visibility predicate for a browsable public race, applied over the
// rows findPublicPending returns. Reused by getPublicRaceCount so the count and
// the full list can never diverge in membership/capacity/seed/team rules. Reads
// only tournamentId, isTeamRace, status, participants[].userId/status, and
// maxParticipants, so it works on both the full and lean participant shapes.
function isVisiblePublicRace(race, userId, supportsTeamRaces) {
  // Matchup races are never browsable — managed only via the tournament UI.
  if (race.tournamentId) return false;
  if (race.isTeamRace && !supportsTeamRaces) return false;
  if (race.isTeamRace && race.status !== "PENDING") return false;
  const participants = race.participants || [];
  if (participants.some((p) => p.userId === userId)) return false;
  const acceptedCount = participants.filter((p) => p.status === "ACCEPTED").length;
  // null => unlimited; a full race is skipped, but unlimited is never full.
  const maxParticipants = race.maxParticipants ?? null;
  if (maxParticipants != null && acceptedCount >= maxParticipants) return false;
  return true;
}

function buildGetPublicRaces(dependencies = {}) {
  const raceModel = dependencies.Race || Race;

  // `supportsTeamRaces` (TR-702): old clients never see team races in the
  // browser. TR-204: team races are browsable only while PENDING — once ACTIVE
  // they lock, unlike individual public races which stay joinable mid-flight.
  return async function getPublicRaces({
    userId,
    supportsTeamRaces = false,
    // Additive, internal-only Home inputs. Both default false so every existing
    // caller — especially GET /races/public — stays on the byte-identical
    // legacy path below.
    excludeSeeded = false,
    hiddenSeededWindows = [],
    suggestionMode = false,
  }) {
    if (suggestionMode) {
      const rows = await raceModel.findPublicSuggestions({
        userId,
        supportsTeamRaces,
        excludeSeeded,
        limit: 4,
      });
      return rows.map((raw) => {
        const race = {
          ...raw,
          status: String(raw.status || "").toUpperCase(),
          payoutPreset: raw.payoutPreset
            ? String(raw.payoutPreset).toUpperCase()
            : null,
          participants: raw.participants || [],
        };
        const acceptedCount = Number(raw.acceptedCount || 0);
        const maxParticipants = race.maxParticipants ?? null;
        const money = buildRaceMoneyView({
          race,
          participants: race.participants,
          acceptedCount,
        });

        return {
          id: race.id,
          name: race.name,
          status: race.status,
          maxDurationDays: race.maxDurationDays,
          endsAt: race.endsAt,
          scheduledStartAt: race.scheduledStartAt ?? null,
          scheduledEndAt: race.scheduledEndAt ?? null,
          startedAt: race.startedAt,
          participantCount: acceptedCount,
          maxParticipants,
          buyInAmount: money.buyInAmount,
          payoutRoundingVersion: race.payoutRoundingVersion ?? 0,
          payoutPreset: race.payoutPreset,
          powerupsEnabled: race.powerupsEnabled === true,
          prizePool: money.prizePool,
          isTeamRace: race.isTeamRace === true,
          teamSize: race.teamSize ?? null,
          teamAName: race.teamAName ?? null,
          teamBName: race.teamBName ?? null,
          teams: race.isTeamRace
            ? buildTeamsBlockFromParticipants(race, race.participants)
            : null,
          createdAt: race.createdAt,
        };
      });
    }

    const hiddenWindows = new Set(hiddenSeededWindows.map(
      (row) => `${row.seedId}:${new Date(row.windowStart).toISOString()}`
    ));
    const races = await raceModel.findPublicPending({ excludeSeeded });

    const results = [];
    for (const race of races) {
      if (excludeSeeded && race.seedId) continue;
      if (race.seedId && hiddenWindows.has(`${race.seedId}:${new Date(race.scheduledStartAt || race.startedAt).toISOString()}`)) continue;
      if (!isVisiblePublicRace(race, userId, supportsTeamRaces)) continue;
      const participants = race.participants || [];
      const acceptedCount = participants.filter(
        (p) => p.status === "ACCEPTED"
      ).length;
      // null => unlimited; a full race is skipped, but unlimited is never full.
      const maxParticipants = race.maxParticipants ?? null;

      // Legacy buy-in pot OR app-funded prize pool (race.fundedPrize decides).
      const money = buildRaceMoneyView({ race, participants, acceptedCount });
      const { payouts: legacyPayouts, payoutTiers } = serializePayouts(
        money.payouts
      );

      results.push({
        id: race.id,
        name: race.name,
        status: race.status,
        maxDurationDays: race.maxDurationDays,
        endsAt: race.endsAt,
        scheduledStartAt: race.scheduledStartAt ?? null,
        scheduledEndAt: race.scheduledEndAt ?? null,
        startedAt: race.startedAt,
        targetSteps: race.targetSteps, // 1.1.4 compat
        buyInAmount: money.buyInAmount,
        payoutRoundingVersion: race.payoutRoundingVersion ?? 0,
        payoutPreset: race.payoutPreset,
        powerupsEnabled: race.powerupsEnabled,
        powerupStepInterval: race.powerupStepInterval,
        maxParticipants,
        participantCount: acceptedCount,
        projectedPotCoins: money.projectedPotCoins,
        // App-funded prize pool (additive); null for a legacy buy-in race.
        prizePool: money.prizePool,
        // Legacy three-place shape for app builds that predate payoutTiers; they
        // show only the podium, which degrades gracefully for field-scaled presets.
        payouts: legacyPayouts,
        // Full breakdown (placement 1..N); newer builds render it, older ignore it.
        payoutTiers,
        finishReward: money.finishReward,
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

module.exports = { buildGetPublicRaces, getPublicRaces, isVisiblePublicRace };
