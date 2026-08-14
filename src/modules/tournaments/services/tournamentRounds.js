const { snapshotBaselineFields } = require("../../races/services/raceBaseline");
const { roundLabel, clampMatchupDuration } = require("../constants/tournaments");
const { Steps } = require("../../steps/models/steps");
const {
  enqueueRaceResolution,
} = require("../../races/services/enqueueRaceResolution");

const RACE_NAME_MAX = 50;

// Create + start one round's matchup races INSIDE the caller's transaction, so a
// crash never leaves a half-created round. Each matchup is an ordinary
// time-based WINNER_TAKES_ALL race (money lives on the tournament); both players
// are created ACCEPTED with a snapshotted baseline and joinedAt = startedAt.
//
// `matchups` is an ordered array of [userIdA, userIdB] pairs; the array index is
// the tournamentMatchIndex. The @@unique([tournamentId, round, matchIndex])
// constraint makes a double-create a hard DB error (advancement backstop).
//
// Returns [{ raceId, round, matchIndex, userIds: [a, b] }] for push building.
async function createRoundRaces({
  tx,
  tournament,
  round,
  matchups,
  startedAt,
  stepsModel = Steps,
}) {
  const label = roundLabel(tournament.bracketSize, round);
  const name = `${tournament.name}: ${label}`.slice(0, RACE_NAME_MAX);
  // §3.5 defensive clamp: any tournament row carrying a legacy 1-day duration
  // (created before the 2-day minimum shipped) yields 2-day round races.
  const durationDays = clampMatchupDuration(tournament.matchupDurationDays);
  const endsAt = new Date(
    startedAt.getTime() + durationDays * 24 * 60 * 60 * 1000
  );

  const created = [];
  for (let matchIndex = 0; matchIndex < matchups.length; matchIndex++) {
    const [userA, userB] = matchups[matchIndex];

    const race = await tx.race.create({
      data: {
        creatorId: tournament.creatorId,
        name,
        targetSteps: 0,
        status: "ACTIVE",
        maxDurationDays: durationDays,
        buyInAmount: 0,
        payoutPreset: "WINNER_TAKES_ALL",
        potCoins: 0,
        startedAt,
        endsAt,
        scheduledStartAt: null,
        timezone: tournament.timezone,
        timeBased: true,
        isPublic: false,
        maxParticipants: 2,
        powerupsEnabled: tournament.powerupsEnabled === true,
        powerupStepInterval: tournament.powerupsEnabled
          ? tournament.powerupStepInterval
          : null,
        shareToken: null,
        tournamentId: tournament.id,
        tournamentRound: round,
        tournamentMatchIndex: matchIndex,
      },
    });

    for (const userId of [userA, userB]) {
      const baseline = await snapshotBaselineFields({
        participant: { userId },
        race: {
          powerupsEnabled: tournament.powerupsEnabled === true,
          powerupStepInterval: tournament.powerupStepInterval,
        },
        startedAt,
        stepsModel,
      });
      await tx.raceParticipant.create({
        data: {
          raceId: race.id,
          userId,
          status: "ACCEPTED",
          buyInAmount: 0,
          buyInStatus: "NONE",
          baselineSteps: baseline.baselineSteps,
          joinedAt: baseline.joinedAt,
          ...(baseline.nextBoxAtSteps != null
            ? { nextBoxAtSteps: baseline.nextBoxAtSteps }
            : {}),
        },
      });
    }

    await enqueueRaceResolution({
      raceId: race.id,
      reason: "RACE_START",
      priority: "IMMEDIATE",
    }, tx);

    created.push({
      raceId: race.id,
      round,
      matchIndex,
      userIds: [userA, userB],
    });
  }

  return created;
}

module.exports = { createRoundRaces, RACE_NAME_MAX };
