const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildGetTournamentsForUser,
} = require("../../src/modules/tournaments/queries/getTournamentsForUser");

// ---------------------------------------------------------------------------
// GET /races — additive `myCurrentMatch` on tournament summaries (§5).
//
// `myCurrentMatchRaceId` is RETAINED for clients already reading it. The nested
// object adds the same inventory/box/placement language ordinary active race
// summaries use, so an active tournament row can render like an active race row.
//
// It MUST be bulk-fetched: query count stays flat as the number of live
// matchups grows (no per-tournament or per-row amplification).
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-20T20:00:00Z");
const ENDS = new Date("2026-07-20T22:00:00Z");

function tournamentRow(id, overrides = {}) {
  return {
    id,
    name: `Bracket ${id}`,
    status: "ACTIVE",
    bracketSize: 4,
    currentRound: 2,
    createdAt: NOW,
    participants: [
      { userId: "me", status: "ACCEPTED", eliminatedInRound: null },
    ],
    ...overrides,
  };
}

function matchupRace(id, tournamentId, overrides = {}) {
  return {
    id,
    tournamentId,
    status: "ACTIVE",
    endsAt: ENDS,
    powerupsEnabled: true,
    participants: [
      {
        id: `p-${id}-me`,
        userId: "me",
        status: "ACCEPTED",
        totalSteps: 4000,
        joinedAt: NOW,
        finishedAt: null,
        placement: null,
      },
      {
        id: `p-${id}-rival`,
        userId: "rival",
        status: "ACCEPTED",
        totalSteps: 9000,
        joinedAt: NOW,
        finishedAt: null,
        placement: null,
      },
    ],
    ...overrides,
  };
}

function makeDeps({ rows, races, inventory = [], detours = [] } = {}) {
  const counts = { raceFindMany: 0, inventory: 0, detour: 0 };
  return {
    counts,
    deps: {
      Tournament: {
        async findForUser() {
          return rows;
        },
      },
      prisma: {
        race: {
          async findMany() {
            counts.raceFindMany += 1;
            return races;
          },
        },
      },
      RacePowerup: {
        async findInventoryForParticipants(participantIds) {
          counts.inventory += 1;
          return inventory.filter((r) =>
            participantIds.includes(r.participantId)
          );
        },
      },
      RaceActiveEffect: {
        async findActiveByTypeForParticipants(participantIds, type) {
          counts.detour += 1;
          assert.equal(type, "DETOUR_SIGN");
          return detours.filter((r) =>
            participantIds.includes(r.targetParticipantId)
          );
        },
      },
    },
  };
}

test("retains myCurrentMatchRaceId and adds the myCurrentMatch inventory object", async () => {
  const ctx = makeDeps({
    rows: [tournamentRow("t-1")],
    races: [matchupRace("race-1", "t-1")],
    inventory: [
      {
        id: "pw-1",
        participantId: "p-race-1-me",
        type: "LEG_CRAMP",
        rarity: "UNCOMMON",
        status: "HELD",
      },
      {
        id: "box-1",
        participantId: "p-race-1-me",
        type: null,
        rarity: null,
        status: "MYSTERY_BOX",
      },
      {
        id: "q-1",
        participantId: "p-race-1-me",
        type: null,
        rarity: null,
        status: "QUEUED",
      },
      // A rival's inventory must never leak into the viewer's summary.
      {
        id: "pw-2",
        participantId: "p-race-1-rival",
        type: "SHORTCUT",
        rarity: "RARE",
        status: "HELD",
      },
    ],
  });

  const [summary] = await buildGetTournamentsForUser(ctx.deps)("me");

  assert.equal(summary.myCurrentMatchRaceId, "race-1", "legacy field retained");
  const match = summary.myCurrentMatch;
  assert.equal(match.raceId, "race-1");
  assert.equal(new Date(match.endsAt).getTime(), ENDS.getTime());
  assert.equal(match.myPlacement, 2, "9000 > 4000, so the viewer is 2nd");
  assert.equal(match.myPlacementHidden, false);
  assert.equal(match.queuedBoxCount, 1);
  assert.equal(match.mysteryBoxCount, 1);
  assert.deepEqual(match.slotItems, [
    { id: "pw-1", type: "LEG_CRAMP", rarity: "UNCOMMON", status: "HELD" },
    { id: "box-1", type: null, rarity: null, status: "MYSTERY_BOX" },
  ]);
});

test("a Detour Sign masks the viewer's matchup placement", async () => {
  const ctx = makeDeps({
    rows: [tournamentRow("t-1")],
    races: [matchupRace("race-1", "t-1")],
    detours: [{ targetParticipantId: "p-race-1-me" }],
  });
  const [summary] = await buildGetTournamentsForUser(ctx.deps)("me");
  assert.equal(summary.myCurrentMatch.myPlacement, null);
  assert.equal(summary.myCurrentMatch.myPlacementHidden, true);
});

test("myCurrentMatch is null with no live matchup, and for pending/completed brackets", async () => {
  const ctx = makeDeps({
    rows: [
      tournamentRow("t-1"),
      tournamentRow("t-2", { status: "PENDING" }),
      tournamentRow("t-3", { status: "COMPLETED" }),
    ],
    races: [],
  });
  const summaries = await buildGetTournamentsForUser(ctx.deps)("me");
  for (const s of summaries) {
    assert.equal(s.myCurrentMatch, null, s.id);
    assert.equal(s.myCurrentMatchRaceId, null, s.id);
  }
});

test("inventory is BULK-fetched: query count is flat as live matchups grow", async () => {
  const many = [];
  const manyRaces = [];
  for (let i = 0; i < 8; i++) {
    many.push(tournamentRow(`t-${i}`));
    manyRaces.push(matchupRace(`race-${i}`, `t-${i}`));
  }
  const ctx = makeDeps({ rows: many, races: manyRaces });
  const summaries = await buildGetTournamentsForUser(ctx.deps)("me");

  assert.equal(summaries.length, 8);
  assert.equal(ctx.counts.raceFindMany, 1, "one matchup query for all brackets");
  assert.equal(ctx.counts.inventory, 1, "ONE bulk inventory query, not 8");
  assert.equal(ctx.counts.detour, 1, "ONE bulk detour query, not 8");
});

test("a matchup with powerups disabled reports empty inventory, never throws", async () => {
  const ctx = makeDeps({
    rows: [tournamentRow("t-1")],
    races: [matchupRace("race-1", "t-1", { powerupsEnabled: false })],
  });
  const [summary] = await buildGetTournamentsForUser(ctx.deps)("me");
  assert.deepEqual(summary.myCurrentMatch.slotItems, []);
  assert.equal(summary.myCurrentMatch.queuedBoxCount, 0);
  assert.equal(summary.myCurrentMatch.mysteryBoxCount, 0);
});

test("degrades safely when the bulk models are unavailable", async () => {
  const ctx = makeDeps({
    rows: [tournamentRow("t-1")],
    races: [matchupRace("race-1", "t-1")],
  });
  delete ctx.deps.RacePowerup;
  delete ctx.deps.RaceActiveEffect;
  const [summary] = await buildGetTournamentsForUser({
    ...ctx.deps,
    RacePowerup: {},
    RaceActiveEffect: {},
  })("me");
  assert.equal(summary.myCurrentMatch.raceId, "race-1");
  assert.deepEqual(summary.myCurrentMatch.slotItems, []);
  assert.equal(summary.myCurrentMatch.myPlacementHidden, false);
});
