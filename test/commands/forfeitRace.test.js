const assert = require("node:assert/strict");
const test = require("node:test");

const { buildForfeitRace } = require("../../src/modules/races/commands/forfeitRace");

function member(userId, team, overrides = {}) {
  return {
    id: `rp-${userId}`,
    userId,
    status: "ACCEPTED",
    team,
    totalSteps: 0,
    forfeitedAt: null,
    buyInAmount: 0,
    buyInStatus: "NONE",
    user: { displayName: userId },
    ...overrides,
  };
}

function teamRace(participants, overrides = {}) {
  return {
    id: "race-1",
    name: "Team Battle",
    creatorId: "a1",
    status: "ACTIVE",
    isTeamRace: true,
    teamSize: 2,
    teamAName: "Swift Capys",
    teamBName: "Turbo Beavers",
    startedAt: new Date("2026-07-10T00:00:00Z"),
    endsAt: new Date("2026-07-20T00:00:00Z"),
    powerupsEnabled: true,
    participants,
    ...overrides,
  };
}

function makeDeps({ race, effectiveTotal = 1234 }) {
  const state = {
    forfeitWrites: [],
    completions: [],
    events: [],
    logs: [],
    lockedLifecycleRaces: [],
    lockedRaces: [],
  };
  // The fake tx mirrors the tiny surface the command uses.
  const tx = {
    async $queryRawUnsafe(sql, raceId) {
      if (sql.includes("race_participants")) {
        state.lockedRaces.push(raceId);
      } else if (sql.includes("FROM races")) {
        state.lockedLifecycleRaces.push(raceId);
      }
      return [];
    },
    raceParticipant: {
      async updateMany({ where, data }) {
        const target = race.participants.find((p) => p.id === where.id);
        if (!target || target.forfeitedAt) return { count: 0 };
        Object.assign(target, data);
        state.forfeitWrites.push({ id: where.id, ...data });
        return { count: 1 };
      },
      async findMany({ where }) {
        return race.participants.filter(
          (p) => p.raceId === undefined || true
        ).filter((p) => p.status === "ACCEPTED");
      },
    },
  };
  return {
    state,
    deps: {
      Race: {
        async findById() {
          return race;
        },
      },
      prisma: {
        async $transaction(fn) {
          return fn(tx);
        },
      },
      computeParticipantEffectiveTotal: async () => effectiveTotal,
      completeRace: async (payload) => {
        state.completions.push(payload);
        return { id: race.id, status: "COMPLETED" };
      },
      RaceParticipant: {
        async findByRaceAndUser(raceId, userId) {
          return race.participants.find((p) => p.userId === userId) || null;
        },
      },
      RacePowerupEvent: {
        async create(payload) {
          state.events.push(payload);
          return payload;
        },
      },
      eventBus: { emit(event, payload) { state.events.push({ event, payload }); } },
      logger: { log(line) { state.logs.push(JSON.parse(line)); } },
      now: () => new Date("2026-07-12T12:00:00Z"),
    },
  };
}

// ── TR-601: freeze as-is at forfeit moment ──────────────────────────────────
test("TR-601 forfeit freezes the member's effective total as-is and marks forfeitedAt", async () => {
  const race = teamRace([
    member("a1", "TEAM_A"),
    member("a2", "TEAM_A"),
    member("b1", "TEAM_B"),
    member("b2", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race, effectiveTotal: 4321 });
  const forfeitRace = buildForfeitRace(ctx.deps);
  await forfeitRace({ userId: "a2", raceId: "race-1" });

  assert.equal(ctx.state.forfeitWrites.length, 1);
  assert.equal(ctx.state.forfeitWrites[0].id, "rp-a2");
  assert.equal(ctx.state.forfeitWrites[0].totalSteps, 4321);
  assert.ok(ctx.state.forfeitWrites[0].forfeitedAt instanceof Date);
  assert.equal(ctx.state.completions.length, 0, "no collapse — team A still alive");
  assert.equal(ctx.state.logs.length, 1);
  assert.deepEqual(
    {
      event: ctx.state.logs[0].event,
      sourceCount: ctx.state.logs[0].sourceCount,
      durationIsAggregate: Number.isFinite(ctx.state.logs[0].transactionDurationMs),
      leaksSourceIds: Object.hasOwn(ctx.state.logs[0], "sourceIds"),
    },
    {
      event: "race_forfeit_terminal_impact",
      sourceCount: 0,
      durationIsAggregate: true,
      leaksSourceIds: false,
    },
  );
});

test("TR-601 forfeit is permanent — a second forfeit fails", async () => {
  const race = teamRace([
    member("a1", "TEAM_A"),
    member("a2", "TEAM_A", { forfeitedAt: new Date("2026-07-11T00:00:00Z") }),
    member("b1", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race });
  const forfeitRace = buildForfeitRace(ctx.deps);
  await assert.rejects(
    () => forfeitRace({ userId: "a2", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test("forfeit rejects non-team races and non-ACTIVE races", async () => {
  const individual = teamRace([member("a1", null)], {
    isTeamRace: false,
  });
  let ctx = makeDeps({ race: individual });
  let forfeitRace = buildForfeitRace(ctx.deps);
  await assert.rejects(
    () => forfeitRace({ userId: "a1", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );

  const pending = teamRace(
    [member("a1", "TEAM_A"), member("b1", "TEAM_B")],
    { status: "PENDING" }
  );
  ctx = makeDeps({ race: pending });
  forfeitRace = buildForfeitRace(ctx.deps);
  await assert.rejects(
    () => forfeitRace({ userId: "a1", raceId: "race-1" }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

// ── TR-603: team collapse = instant win for the other side ─────────────────
test("TR-603 last member of a team forfeiting completes the race for the other team", async () => {
  const race = teamRace([
    member("a1", "TEAM_A", { forfeitedAt: new Date("2026-07-11T00:00:00Z") }),
    member("a2", "TEAM_A"),
    member("b1", "TEAM_B"),
    member("b2", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race });
  const forfeitRace = buildForfeitRace(ctx.deps);
  await forfeitRace({ userId: "a2", raceId: "race-1" });

  assert.equal(ctx.state.completions.length, 1);
  assert.equal(ctx.state.completions[0].winnerTeam, "TEAM_B");
  assert.equal(ctx.state.completions[0].raceId, "race-1");
});

// ── TR-604: collapse is evaluated under the per-race lock ───────────────────
test("TR-604 forfeit locks the race participants before evaluating collapse", async () => {
  const race = teamRace([
    member("a1", "TEAM_A"),
    member("b1", "TEAM_B"),
  ]);
  const ctx = makeDeps({ race });
  const forfeitRace = buildForfeitRace(ctx.deps);
  await forfeitRace({ userId: "a1", raceId: "race-1" });
  assert.deepEqual(ctx.state.lockedLifecycleRaces, ["race-1"]);
  assert.deepEqual(ctx.state.lockedRaces, ["race-1"]);
  // 1v1: a1 forfeiting collapses team A instantly.
  assert.equal(ctx.state.completions.length, 1);
  assert.equal(ctx.state.completions[0].winnerTeam, "TEAM_B");
});
