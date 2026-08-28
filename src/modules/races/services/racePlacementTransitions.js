const { compareParticipantsForPlacement } = require("../placementOrder");
const {
  computeRacePayouts,
  computeFundedPayouts,
} = require("../racePayoutPresets");
const { computePrizePool } = require("../../../shared/economy/prizePool");

function paidPlacesFor(race, participantCount) {
  if (race.fundedPrize) {
    return computeFundedPayouts({
      preset: race.payoutPreset,
      poolCoins: computePrizePool({
        playerCount: participantCount,
        durationDays: race.maxDurationDays || 7,
      }),
      participantCount,
      curve: race.payoutCurve ?? null,
    }).length;
  }
  if ((race.potCoins || 0) > 0) {
    return computeRacePayouts({
      preset: race.payoutPreset,
      potCoins: race.potCoins,
      participantCount,
    }).length;
  }
  return 0;
}

function teamPlan({ race, participants, sourceGeneration, occurredAt }) {
  const members = participants.filter(
    (participant) => participant.team === "TEAM_A" || participant.team === "TEAM_B",
  );
  const totals = { TEAM_A: 0, TEAM_B: 0 };
  for (const member of members) totals[member.team] += member.totalSteps || 0;
  if (totals.TEAM_A === totals.TEAM_B) {
    return { kind: "team", baselineChanges: [], events: [], teamClaim: null };
  }
  const leadingTeam = totals.TEAM_A > totals.TEAM_B ? "TEAM_A" : "TEAM_B";
  const previousLeader = members.find(
    (member) => member.lastNotifiedPlacement === 1,
  )?.team ?? null;
  const hadBaseline = members.some(
    (member) => member.lastNotifiedPlacement != null,
  );
  const armed = totals.TEAM_A > 0 && totals.TEAM_B > 0;
  const flipped = hadBaseline && previousLeader && previousLeader !== leadingTeam;
  const baselineChanges = members.flatMap((participant) => {
    const nextPlacement = participant.team === leadingTeam ? 1 : 2;
    return participant.lastNotifiedPlacement === nextPlacement ? [] : [{
      participantId: participant.id,
      userId: participant.userId,
      expectedPlacement: participant.lastNotifiedPlacement,
      nextPlacement,
      silent: true,
      event: null,
    }];
  });
  if (!flipped || !armed) {
    return { kind: "team", baselineChanges, events: [], teamClaim: null };
  }
  const trailingTeam = leadingTeam === "TEAM_A" ? "TEAM_B" : "TEAM_A";
  const transitionId =
    `team-lead:${race.id}:resolution:${sourceGeneration}:${previousLeader}->${leadingTeam}`;
  const event = {
    eventKey: `TEAM_LEAD_CHANGED_V1:${transitionId}`,
    eventType: "TEAM_LEAD_CHANGED_V1",
    schemaVersion: 1,
    aggregateType: "RACE",
    aggregateId: race.id,
    occurredAt,
    payload: {
      raceId: race.id,
      raceName: race.name,
      leadingTeamName: leadingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
      trailingTeamName: trailingTeam === "TEAM_A" ? race.teamAName : race.teamBName,
      transitionId,
      endsAt: race.endsAt ?? null,
    },
    audience: members.map((member) => ({ recipientId: member.userId, facts: {} })),
  };
  return {
    kind: "team",
    baselineChanges,
    events: [event],
    teamClaim: {
      jobName: `team-lead:${race.id}`,
      value: `${previousLeader}->${leadingTeam}`,
      eventKey: event.eventKey,
    },
  };
}

function planRacePlacementTransitions({
  race,
  participants,
  sourceGeneration,
  occurredAt,
}) {
  if (!race || !Array.isArray(participants)) {
    throw new TypeError("race and participants are required");
  }
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) {
    throw new TypeError("sourceGeneration must be positive");
  }
  const stableOccurredAt = new Date(occurredAt);
  if (Number.isNaN(stableOccurredAt.getTime())) {
    throw new TypeError("occurredAt must be a valid date");
  }
  if (race.isTeamRace) {
    return teamPlan({
      race,
      participants,
      sourceGeneration,
      occurredAt: stableOccurredAt,
    });
  }

  const ranked = [...participants].sort(compareParticipantsForPlacement);
  const paidPlaces = paidPlacesFor(race, ranked.length);
  const baselineChanges = [];
  for (let index = 0; index < ranked.length; index += 1) {
    const participant = ranked[index];
    const nextPlacement = index + 1;
    if (participant.finishedAt || participant.lastNotifiedPlacement === nextPlacement) {
      continue;
    }
    const silent = participant.lastNotifiedPlacement == null ||
      participant.placementAlertsMuted === true;
    const transitionId = silent ? null :
      `placement:${participant.id}:resolution:${sourceGeneration}:` +
      `${participant.lastNotifiedPlacement}->${nextPlacement}`;
    baselineChanges.push({
      participantId: participant.id,
      userId: participant.userId,
      expectedPlacement: participant.lastNotifiedPlacement,
      nextPlacement,
      silent,
      event: silent ? null : {
        eventKey: `PLACEMENT_CHANGED_V1:${transitionId}`,
        eventType: "PLACEMENT_CHANGED_V1",
        schemaVersion: 1,
        aggregateType: "RACE",
        aggregateId: race.id,
        occurredAt: stableOccurredAt,
        payload: {
          transitionId,
          raceId: race.id,
          raceName: race.name,
          userId: participant.userId,
          previousPlacement: participant.lastNotifiedPlacement,
          placement: nextPlacement,
          paidPlaces,
          endsAt: race.endsAt ?? null,
        },
        audience: [{ recipientId: participant.userId, facts: {} }],
      },
    });
  }
  return {
    kind: "individual",
    baselineChanges,
    events: baselineChanges.flatMap((change) => change.event ? [change.event] : []),
    teamClaim: null,
    totalParticipants: ranked.length,
  };
}

module.exports = { planRacePlacementTransitions };
