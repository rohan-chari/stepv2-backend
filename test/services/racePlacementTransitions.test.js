const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  planRacePlacementTransitions,
} = require("../../src/modules/races/services/racePlacementTransitions");

const at = new Date("2026-08-27T12:00:00.000Z");
const race = {
  id: "race-1",
  name: "Race",
  payoutPreset: "WINNER_TAKES_ALL",
  potCoins: 0,
  fundedPrize: false,
  endsAt: new Date("2026-08-28T12:00:00.000Z"),
};
const participant = (id, userId, totalSteps, joinedAt, baseline, extra = {}) => ({
  id, raceId: race.id, userId, totalSteps, joinedAt,
  status: "ACCEPTED", lastNotifiedPlacement: baseline,
  placementAlertsMuted: false, finishedAt: null, forfeitedAt: null,
  placement: null, team: null, ...extra,
});

describe("canonical race placement transition planner", () => {
  it("uses joined time then user id for tied live ranks and generation-stamped identity", () => {
    const plan = planRacePlacementTransitions({
      race,
      sourceGeneration: 7,
      occurredAt: at,
      participants: [
        participant("p2", "z-user", 10, new Date("2026-08-27T00:00:00.000Z"), 1),
        participant("p1", "a-user", 10, new Date("2026-08-27T00:00:00.000Z"), 2),
      ],
    });
    const a = plan.baselineChanges.find((change) => change.userId === "a-user");
    assert.equal(a.nextPlacement, 1);
    assert.equal(
      a.event.payload.transitionId,
      "placement:p1:resolution:7:2->1",
    );
    assert.equal(Object.hasOwn(a.event.payload, "totalParticipants"), false);
  });

  it("seeds null and muted baselines silently, freezes finished, and ignores unchanged", () => {
    const plan = planRacePlacementTransitions({
      race,
      sourceGeneration: 1,
      occurredAt: at,
      participants: [
        participant("seed", "seed", 40, at, null),
        participant("muted", "muted", 30, at, 4, { placementAlertsMuted: true }),
        participant("finished", "finished", 20, at, 9, { finishedAt: at, placement: 3 }),
        participant("same", "same", 10, at, 4),
      ],
    });
    assert.deepEqual(
      plan.baselineChanges.map((change) => [change.participantId, change.silent]),
      [["seed", true], ["muted", true]],
    );
    assert.deepEqual(plan.events, []);
  });

  it("plans one armed team flip with current member population and stable claim value", () => {
    const plan = planRacePlacementTransitions({
      race: { ...race, isTeamRace: true, teamAName: "A", teamBName: "B" },
      sourceGeneration: 9,
      occurredAt: at,
      participants: [
        participant("a", "a", 20, at, 2, { team: "TEAM_A" }),
        participant("b", "b", 10, at, 1, { team: "TEAM_B", forfeitedAt: at }),
      ],
    });
    assert.equal(plan.events.length, 1);
    assert.deepEqual(plan.events[0].audience.map((row) => row.recipientId), ["a", "b"]);
    assert.equal(plan.teamClaim.value, "TEAM_B->TEAM_A");
    assert.equal(
      plan.events[0].payload.transitionId,
      "team-lead:race-1:resolution:9:TEAM_B->TEAM_A",
    );
  });
});
