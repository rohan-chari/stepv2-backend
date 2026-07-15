const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecomputePlacements,
} = require("../../src/jobs/placementRecompute");

// Team-race notification evaluation inside the placement recompute cron:
// TR-681 (lead change, armed only when both teams > 0), TR-682 (final-stretch
// team framing), TR-683 (slacker nudge), TR-685 (individual placement pushes
// suppressed inside team races).

function member(userId, team, overrides = {}) {
  return {
    id: `rp-${userId}`,
    userId,
    status: "ACCEPTED",
    team,
    totalSteps: 0,
    lastNotifiedPlacement: null,
    placementAlertsMuted: false,
    finishedAt: null,
    forfeitedAt: null,
    ...overrides,
  };
}

function makeDeps({ race, participants, slackerAlreadySent = false }) {
  const state = { events: [], participantUpdates: [], notificationLookups: [] };
  return {
    state,
    deps: {
      Race: {
        async findActiveInProgress() {
          return [race];
        },
      },
      RaceParticipant: {
        async findAcceptedByRace() {
          return participants;
        },
        async update(id, fields) {
          state.participantUpdates.push({ id, fields });
          const p = participants.find((x) => x.id === id);
          if (p) Object.assign(p, fields);
        },
      },
      Notification: {
        async findFirstByUserTypeRace(userId, type, raceId) {
          state.notificationLookups.push({ userId, type, raceId });
          return slackerAlreadySent ? { id: "n-1" } : null;
        },
      },
      eventBus: {
        emit(event, payload) {
          state.events.push({ event, payload });
        },
      },
      resolveRaceState: async () => {},
      requestStepSyncForUsers: async () => {},
      now: () => new Date("2026-07-12T12:00:00Z"),
      logger: { log() {}, error() {} },
    },
  };
}

function teamRace(overrides = {}) {
  return {
    id: "race-1",
    name: "Team Battle",
    payoutPreset: "WINNER_TAKES_ALL",
    potCoins: 0,
    endsAt: new Date("2026-07-14T12:00:00Z"), // 2 days out (not final stretch)
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    ...overrides,
  };
}

// ── TR-685: individual placement pushes suppressed ──────────────────────────
test("TR-685 team races never emit individual PLACEMENT_CHANGED", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 100, lastNotifiedPlacement: 2 }),
    member("b1", "TEAM_B", { totalSteps: 50, lastNotifiedPlacement: 1 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  const placementEvents = ctx.state.events.filter(
    (e) => e.event === "PLACEMENT_CHANGED"
  );
  assert.equal(placementEvents.length, 0);
});

// ── TR-681: team lead change ────────────────────────────────────────────────
test("TR-681 first observation seeds the team-rank baseline silently", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 100 }),
    member("b1", "TEAM_B", { totalSteps: 50 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_LEAD_CHANGED").length,
    0,
    "no push on the seeding pass"
  );
  // Baselines seeded: TEAM_A members rank 1, TEAM_B rank 2.
  assert.equal(participants[0].lastNotifiedPlacement, 1);
  assert.equal(participants[1].lastNotifiedPlacement, 2);
});

test("TR-681 lead flip emits one TEAM_LEAD_CHANGED with team names", async () => {
  const participants = [
    // Stored baseline says TEAM_A was trailing (rank 2) but now leads.
    member("a1", "TEAM_A", { totalSteps: 100, lastNotifiedPlacement: 2 }),
    member("a2", "TEAM_A", { totalSteps: 40, lastNotifiedPlacement: 2 }),
    member("b1", "TEAM_B", { totalSteps: 90, lastNotifiedPlacement: 1 }),
    member("b2", "TEAM_B", { totalSteps: 20, lastNotifiedPlacement: 1 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  const leadEvents = ctx.state.events.filter(
    (e) => e.event === "TEAM_LEAD_CHANGED"
  );
  assert.equal(leadEvents.length, 1, "exactly one event per flip");
  assert.equal(leadEvents[0].payload.leadingTeam, "TEAM_A");
  assert.equal(leadEvents[0].payload.leadingTeamName, "Swift Capys");
  assert.equal(leadEvents[0].payload.trailingTeamName, "Turbo Beavers");
  assert.deepEqual(
    [...leadEvents[0].payload.memberUserIds].sort(),
    ["a1", "a2", "b1", "b2"],
    "all members of both teams are notified"
  );
});

test("TR-681 no lead-change push while either team is still at zero (arming rule)", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 100, lastNotifiedPlacement: 2 }),
    member("b1", "TEAM_B", { totalSteps: 0, lastNotifiedPlacement: 1 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_LEAD_CHANGED").length,
    0
  );
});

test("TR-681 unchanged lead emits nothing", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 100, lastNotifiedPlacement: 1 }),
    member("b1", "TEAM_B", { totalSteps: 50, lastNotifiedPlacement: 2 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_LEAD_CHANGED").length,
    0
  );
});

// ── TR-682: final-stretch team push ─────────────────────────────────────────
test("TR-682 final-stretch team race emits TEAM_FINAL_STRETCH with totals", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 5000, lastNotifiedPlacement: 1 }),
    member("b1", "TEAM_B", { totalSteps: 3000, lastNotifiedPlacement: 2 }),
  ];
  const race = teamRace({
    endsAt: new Date("2026-07-12T12:45:00Z"), // 45 min out
  });
  const ctx = makeDeps({ race, participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  const stretchEvents = ctx.state.events.filter(
    (e) => e.event === "TEAM_FINAL_STRETCH"
  );
  assert.equal(stretchEvents.length, 1);
  assert.equal(stretchEvents[0].payload.teamATotal, 5000);
  assert.equal(stretchEvents[0].payload.teamBTotal, 3000);
  assert.equal(stretchEvents[0].payload.raceId, "race-1");
});

test("TR-682 no final-stretch event outside the window", async () => {
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 5000, lastNotifiedPlacement: 1 }),
    member("b1", "TEAM_B", { totalSteps: 3000, lastNotifiedPlacement: 2 }),
  ];
  const ctx = makeDeps({ race: teamRace(), participants });
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_FINAL_STRETCH").length,
    0
  );
});

// ── TR-683: slacker nudge ───────────────────────────────────────────────────
function slackerSetup({ endsAt, slackerAlreadySent = false, teamSize = 3 }) {
  // 3v3 in final 12h. a3 contributed 100 vs team avg (10000+8000+100)/3 ≈ 6033
  // -> 100 < 25% of avg -> nudge.
  const participants = [
    member("a1", "TEAM_A", { totalSteps: 10000, lastNotifiedPlacement: 1 }),
    member("a2", "TEAM_A", { totalSteps: 8000, lastNotifiedPlacement: 1 }),
    member("a3", "TEAM_A", { totalSteps: 100, lastNotifiedPlacement: 1 }),
    member("b1", "TEAM_B", { totalSteps: 9000, lastNotifiedPlacement: 2 }),
    member("b2", "TEAM_B", { totalSteps: 4000, lastNotifiedPlacement: 2 }),
    member("b3", "TEAM_B", { totalSteps: 4000, lastNotifiedPlacement: 2 }),
  ];
  const race = teamRace({
    teamSize,
    endsAt: new Date("2026-07-12T20:00:00Z"), // 8h out — inside final 12h
    ...(endsAt ? { endsAt } : {}),
  });
  return { race, participants, slackerAlreadySent };
}

test("TR-683 slacker nudge fires for a <25%-of-average member in the final 12h", async () => {
  const setup = slackerSetup({});
  const ctx = makeDeps(setup);
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  const nudges = ctx.state.events.filter((e) => e.event === "TEAM_SLACKER_NUDGE");
  assert.equal(nudges.length, 1);
  assert.equal(nudges[0].payload.userId, "a3");
  assert.equal(nudges[0].payload.raceId, "race-1");
});

test("TR-683 no slacker nudge outside the final 12h", async () => {
  const setup = slackerSetup({ endsAt: new Date("2026-07-13T12:00:00Z") }); // 24h out
  const ctx = makeDeps(setup);
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_SLACKER_NUDGE").length,
    0
  );
});

test("TR-683 slacker nudge is once per race per member (Notification dedup)", async () => {
  const setup = slackerSetup({ slackerAlreadySent: true });
  const ctx = makeDeps(setup);
  const run = buildRecomputePlacements(ctx.deps);
  await run();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_SLACKER_NUDGE").length,
    0
  );
});

test("TR-683 skipped in 1v1 and for forfeited members", async () => {
  // 1v1: trailing member is by definition the only active member of their team.
  const oneVOne = makeDeps({
    race: teamRace({
      teamSize: 1,
      endsAt: new Date("2026-07-12T20:00:00Z"),
    }),
    participants: [
      member("a1", "TEAM_A", { totalSteps: 10000, lastNotifiedPlacement: 1 }),
      member("b1", "TEAM_B", { totalSteps: 10, lastNotifiedPlacement: 2 }),
    ],
  });
  await buildRecomputePlacements(oneVOne.deps)();
  assert.equal(
    oneVOne.state.events.filter((e) => e.event === "TEAM_SLACKER_NUDGE").length,
    0,
    "1v1 never nudges"
  );

  // Forfeited slacker: excluded from the average AND never nudged.
  const setup = slackerSetup({});
  setup.participants[2].forfeitedAt = new Date("2026-07-11T00:00:00Z");
  const ctx = makeDeps(setup);
  await buildRecomputePlacements(ctx.deps)();
  assert.equal(
    ctx.state.events.filter((e) => e.event === "TEAM_SLACKER_NUDGE").length,
    0,
    "forfeited member is not nudged"
  );
});
