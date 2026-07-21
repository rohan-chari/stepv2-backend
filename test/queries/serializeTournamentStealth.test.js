const assert = require("node:assert/strict");
const test = require("node:test");

const {
  serializeTournamentPayload,
} = require("../../src/modules/tournaments/queries/serializeTournament");

// Item 11: a masked (stealthed/detoured) player on a LIVE matchup serializes
// with stealthed:true AND totalSteps:null — parallel to the race leaderboard —
// so the bracket renders "???" instead of a blank/0. Unmasked players are
// unaffected, and a COMPLETED matchup shows true finals.

const FUTURE = new Date("2026-07-18T00:00:00Z");
const NOW = new Date("2026-07-17T12:00:00Z");

function tournament(matchupOverrides = {}) {
  return {
    id: "t1", name: "Dash", status: "ACTIVE", bracketSize: 2, matchupDurationDays: 1,
    buyInAmount: 0, potCoins: 0, powerupsEnabled: true, powerupStepInterval: 2000,
    isPublic: false, shareToken: null, currentRound: 1, totalRounds: 1,
    creatorId: "p1", seedId: null, seed: null, championUserId: null,
    startedAt: NOW, completedAt: null,
    participants: [
      { userId: "p1", status: "ACCEPTED", user: { displayName: "P1" } },
      { userId: "p2", status: "ACCEPTED", user: { displayName: "P2" } },
    ],
    races: [{
      id: "m1", tournamentRound: 1, tournamentMatchIndex: 0, status: "ACTIVE",
      endsAt: FUTURE, powerupsEnabled: true, winnerUserId: null,
      participants: [
        { userId: "p1", status: "ACCEPTED", totalSteps: 5000, finishedAt: null, forfeitedAt: null },
        { userId: "p2", status: "ACCEPTED", totalSteps: 8000, finishedAt: null, forfeitedAt: null },
      ],
      activeEffects: [],
      ...matchupOverrides,
    }],
  };
}

function playersFor(t, viewer) {
  const payload = serializeTournamentPayload(t, viewer, { now: () => NOW });
  const matchup = payload.rounds[0].matchups[0];
  return Object.fromEntries(matchup.players.map((p) => [p.userId, p]));
}

test("a stealthed opponent serializes with stealthed:true + totalSteps:null", async () => {
  const t = tournament({ activeEffects: [{ type: "STEALTH_MODE", targetUserId: "p2", expiresAt: FUTURE }] });
  const players = playersFor(t, "p1"); // p1 views; p2 is stealthed
  assert.equal(players["p2"].stealthed, true);
  assert.equal(players["p2"].totalSteps, null);
  // The viewer themselves is never masked.
  assert.equal(players["p1"].stealthed, false);
  assert.equal(players["p1"].totalSteps, 5000);
});

test("no illusions => stealthed:false + real steps", async () => {
  const players = playersFor(tournament(), "p1");
  assert.equal(players["p1"].stealthed, false);
  assert.equal(players["p2"].stealthed, false);
  assert.equal(players["p2"].totalSteps, 8000);
});

test("a detoured viewer sees ALL opponents masked (stealthed + null)", async () => {
  const t = tournament({ activeEffects: [{ type: "DETOUR_SIGN", targetUserId: "p1", expiresAt: FUTURE }] });
  const players = playersFor(t, "p1"); // p1 is detoured => everyone masked to p1
  assert.equal(players["p2"].stealthed, true);
  assert.equal(players["p2"].totalSteps, null);
});
