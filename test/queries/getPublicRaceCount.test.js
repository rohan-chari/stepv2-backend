const assert = require("node:assert/strict");
const test = require("node:test");
const { buildGetPublicRaces } = require("../../src/queries/getPublicRaces");
const { buildGetPublicRaceCount } = require("../../src/queries/getPublicRaceCount");

// One shared fixture set of "already-visible-by-where-clause" public races
// (findPublicPending's SQL where already filtered isPublic/status/review/seeded-
// pending). The remaining membership/capacity/team/tournament rules live in the
// shared predicate, which both getPublicRaces and getPublicRaceCount apply.
const p = (userId, status = "ACCEPTED") => ({ userId, status });

const RACES = [
  // open individual race, viewer not in it → visible
  { id: "a", tournamentId: null, isTeamRace: false, status: "ACTIVE", maxParticipants: 10, potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("x")] },
  // viewer already in it → hidden
  { id: "b", tournamentId: null, isTeamRace: false, status: "ACTIVE", maxParticipants: 10, potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("viewer")] },
  // full (accepted >= max) → hidden
  { id: "c", tournamentId: null, isTeamRace: false, status: "ACTIVE", maxParticipants: 2, potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("x"), p("y")] },
  // unlimited (maxParticipants null) → visible even with many
  { id: "d", tournamentId: null, isTeamRace: false, status: "ACTIVE", maxParticipants: null, potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("x"), p("y"), p("z")] },
  // matchup race (tournamentId set) → hidden for everyone
  { id: "e", tournamentId: "t1", isTeamRace: false, status: "ACTIVE", maxParticipants: 10, potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [] },
  // team race, PENDING → visible only to team-capable clients
  { id: "f", tournamentId: null, isTeamRace: true, status: "PENDING", maxParticipants: 4, teamSize: 2, teamAName: "A", teamBName: "B", potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("x")] },
  // team race, ACTIVE → hidden (team races browsable only while PENDING)
  { id: "g", tournamentId: null, isTeamRace: true, status: "ACTIVE", maxParticipants: 4, teamSize: 2, teamAName: "A", teamBName: "B", potCoins: 0, payoutPreset: "WINNER_TAKES_ALL", seedId: null, creator: null, createdAt: new Date(), participants: [p("x")] },
];

function leanOf(races) {
  return races.map((r) => ({
    id: r.id,
    tournamentId: r.tournamentId,
    isTeamRace: r.isTeamRace,
    status: r.status,
    maxParticipants: r.maxParticipants,
    participants: r.participants.map((pt) => ({ userId: pt.userId, status: pt.status })),
  }));
}

const model = {
  findPublicPending: async () => RACES,
  findPublicPendingLean: async () => leanOf(RACES),
};

for (const supportsTeamRaces of [false, true]) {
  test(`getPublicRaceCount matches getPublicRaces length (team_races=${supportsTeamRaces})`, async () => {
    const list = await buildGetPublicRaces({ Race: model })({ userId: "viewer", supportsTeamRaces });
    const count = await buildGetPublicRaceCount({ Race: model })({ userId: "viewer", supportsTeamRaces });
    assert.equal(count, list.length);
  });
}

test("team-capable clients count one more (the PENDING team race)", async () => {
  const without = await buildGetPublicRaceCount({ Race: model })({ userId: "viewer", supportsTeamRaces: false });
  const withTeam = await buildGetPublicRaceCount({ Race: model })({ userId: "viewer", supportsTeamRaces: true });
  assert.equal(withTeam, without + 1);
});
