// No HTTP endpoint exists for the five-minute scheduler. These tests enter at
// the actual scheduled callback seam and use the real JobRun/participant models
// against the disposable integration Postgres.
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const { cleanDatabase, prisma, createTestUser } = require("./setup");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");
const {
  RaceParticipant,
} = require("../../src/modules/races/models/raceParticipant");
const { Race } = require("../../src/modules/races/models/race");
const { JobRun } = require("../../src/shared/db/jobRun");

describe("placement performance scheduler integration", () => {
  beforeEach(cleanDatabase);

  it("allows exactly one real-Postgres bucket winner before the active scan and keeps the flag-off path", async () => {
    // JobRun is deliberately not part of the shared user/race truncate list.
    await prisma.jobRun.deleteMany({ where: { jobName: "placement-recompute-v2" } });
    const at = new Date("2026-08-13T12:03:00.000Z");
    let scans = 0;
    const Race = {
      async findActiveInProgress() {
        scans += 1;
        return [];
      },
    };
    const logger = { log() {}, warn() {}, error() {} };
    const build = (enabled) =>
      buildRecomputePlacements({
        Race,
        JobRun,
        now: () => at,
        logger,
        getPerformanceFlags: () => ({
          placementDistributedClaimEnabled: enabled,
          placementLeanBaselineWritesEnabled: false,
          placementWriteConcurrency: 4,
        }),
      });

    await Promise.all([build(true)(), build(true)()]);
    assert.equal(scans, 1, "the loser must return before the active-race scan");
    assert.equal(
      await JobRun.lastRanFor("placement-recompute-v2"),
      "2026-08-13T12:00:00.000Z"
    );

    scans = 0;
    await Promise.all([build(false)(), build(false)()]);
    assert.equal(scans, 2, "flag false retains the per-process legacy path");
  });

  it("scalar baseline CAS has one winner and never overwrites participant totals", async () => {
    const { user } = await createTestUser();
    const race = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: "Placement CAS",
        targetSteps: 100000,
        status: "ACTIVE",
      },
    });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        totalSteps: 9876,
        lastNotifiedPlacement: 2,
      },
    });
    const winners = await Promise.all([
      RaceParticipant.compareAndSetPlacementBaseline(participant.id, 2, 1),
      RaceParticipant.compareAndSetPlacementBaseline(participant.id, 2, 3),
    ]);
    assert.equal(winners.filter(Boolean).length, 1);
    const persisted = await prisma.raceParticipant.findUnique({
      where: { id: participant.id },
      select: { totalSteps: true, lastNotifiedPlacement: true },
    });
    assert.equal(persisted.totalSteps, 9876);
    assert.ok([1, 3].includes(persisted.lastNotifiedPlacement));
  });

  it("team transition claims dedupe one flip while permitting later reverse and repeat flips", async () => {
    const jobName = "team-lead:race-1";
    await prisma.jobRun.deleteMany({ where: { jobName } });
    assert.equal(await JobRun.claimRun(jobName, "TEAM_A->TEAM_B"), true);
    assert.equal(await JobRun.claimRun(jobName, "TEAM_A->TEAM_B"), false);
    assert.equal(await JobRun.claimRun(jobName, "TEAM_B->TEAM_A"), true);
    assert.equal(await JobRun.claimRun(jobName, "TEAM_A->TEAM_B"), true);
  });

  it("rolls back a team final-stretch reminder claim when its durable event append fails", async () => {
    const first = await createTestUser({ displayName: "Final stretch A" });
    const second = await createTestUser({ displayName: "Final stretch B" });
    const at = new Date("2026-08-28T12:00:00.000Z");
    const race = await prisma.race.create({
      data: {
        creatorId: first.user.id,
        name: "Atomic final stretch",
        targetSteps: 100000,
        status: "ACTIVE",
        isTeamRace: true,
        teamSize: 1,
        teamAName: "A",
        teamBName: "B",
        startedAt: new Date(at.getTime() - 24 * 60 * 60 * 1000),
        endsAt: new Date(at.getTime() + 30 * 60 * 1000),
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        {
          raceId: race.id,
          userId: first.user.id,
          status: "ACCEPTED",
          team: "TEAM_A",
          totalSteps: 100,
        },
        {
          raceId: race.id,
          userId: second.user.id,
          status: "ACCEPTED",
          team: "TEAM_B",
          totalSteps: 50,
        },
      ],
    });

    const jobName = `team-final-stretch-event:${race.id}`;
    const eventKey = `TEAM_FINAL_STRETCH_V1:team-final-stretch:${race.id}:${Math.floor(at.getTime() / (30 * 60 * 1000))}`;
    const build = (afterFinalStretchClaim) => buildRecomputePlacements({
      prisma,
      durableEvents: true,
      produceScoreDrivenPlacements: false,
      Race,
      RaceParticipant,
      JobRun,
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: {
        async findExistingByUserTypeRaceKeys() { return []; },
        async claimDelivery() { return false; },
      },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { async emit() {} },
      afterFinalStretchClaim,
      now: () => at,
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: false,
        placementInertPushSuppressionEnabled: false,
      }),
    });

    await build(async () => { throw new Error("injected append-stage crash"); })();
    assert.equal(await prisma.jobRun.count({ where: { jobName } }), 0);
    assert.equal(await prisma.domainEventOutbox.count({ where: { eventKey } }), 0);

    await build(undefined)();
    assert.equal(await prisma.jobRun.count({ where: { jobName } }), 1);
    assert.equal(await prisma.domainEventOutbox.count({ where: { eventKey } }), 1);
    assert.equal(await prisma.domainEventAudience.count({
      where: { event: { eventKey } },
    }), 2);
  });

  it("recomputes 750 participants with bounded lean CAS and visible events", async () => {
    const count = 750;
    const users = Array.from({ length: count }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      appleId: `placement-750-${index}`,
      displayName: `Runner ${index}`,
    }));
    await prisma.user.createMany({ data: users });
    const race = await prisma.race.create({
      data: {
        creatorId: users[0].id,
        name: "Placement 750",
        targetSteps: 1000000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T00:00:00.000Z"),
        endsAt: new Date("2026-08-20T00:00:00.000Z"),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.createMany({
      data: users.map((user, index) => ({
        id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        totalSteps: count - index,
        joinedAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + index),
        lastNotifiedPlacement: index + 2,
      })),
    });

    let activeWrites = 0;
    let maxActiveWrites = 0;
    const emitted = [];
    const participantModel = {
      ...RaceParticipant,
      async compareAndSetPlacementBaseline(id, expected, next) {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          return await RaceParticipant.compareAndSetPlacementBaseline(id, expected, next);
        } finally {
          activeWrites -= 1;
        }
      },
    };
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant: participantModel,
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 8,
      }),
    });

    const changes = await run();
    assert.equal(changes.length, count);
    assert.equal(emitted.filter((event) => event.type === "PLACEMENT_CHANGED").length, count);
    assert.ok(maxActiveWrites > 1);
    assert.ok(maxActiveWrites <= 8);
    const persisted = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      select: { totalSteps: true, lastNotifiedPlacement: true },
      orderBy: { totalSteps: "desc" },
    });
    assert.deepEqual(
      persisted.map((participant) => participant.lastNotifiedPlacement),
      Array.from({ length: count }, (_, index) => index + 1)
    );
    assert.deepEqual(
      persisted.map((participant) => participant.totalSteps),
      Array.from({ length: count }, (_, index) => count - index),
      "baseline CAS never writes participant totals"
    );
  });

  it("750-row matrix preserves ties, frozen rows, seed/mute/resync/unchanged semantics", async () => {
    const count = 750;
    const users = Array.from({ length: count }, (_, index) => ({
      id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      appleId: `placement-matrix-${index}`,
    }));
    await prisma.user.createMany({ data: users });
    const race = await prisma.race.create({
      data: {
        creatorId: users[0].id,
        name: "Placement matrix 750",
        targetSteps: 1000000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T00:00:00.000Z"),
        endsAt: new Date("2026-08-20T00:00:00.000Z"),
        seedId: null,
      },
    });
    const frozenAt = new Date("2026-08-13T01:00:00.000Z");
    await prisma.raceParticipant.createMany({
      data: users.map((user, index) => ({
        id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        totalSteps: index < 2 ? 10000 : count - index,
        joinedAt: new Date(Date.parse("2026-08-13T00:00:00.000Z") + index),
        lastNotifiedPlacement:
          index === 2 ? null : index === 3 ? 5 : index + 2,
        placementAlertsMuted: index === 2,
        finishedAt: index === 4 ? frozenAt : null,
        finishTotalSteps: index === 4 ? count - index : null,
        forfeitedAt: index === 5 ? frozenAt : null,
      })),
    });
    const emitted = [];
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant,
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      logger: { log() {}, warn() {}, error() {} },
      // Keep this production-scale fixture inside its active window. Its
      // original wall-clock dependency crossed endsAt on 2026-08-20.
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 8,
      }),
    });
    await run();
    const rows = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      select: {
        userId: true,
        lastNotifiedPlacement: true,
        finishedAt: true,
        forfeitedAt: true,
      },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    assert.equal(byUser.get(users[0].id).lastNotifiedPlacement, 2);
    assert.equal(byUser.get(users[1].id).lastNotifiedPlacement, 3);
    assert.equal(byUser.get(users[2].id).lastNotifiedPlacement, 4, "null/muted seed advances silently");
    assert.equal(byUser.get(users[3].id).lastNotifiedPlacement, 5, "unchanged baseline stays unchanged");
    assert.equal(byUser.get(users[4].id).lastNotifiedPlacement, 6, "finished baseline is frozen");
    assert.ok(byUser.get(users[5].id).forfeitedAt);
    assert.equal(
      emitted.some((event) => event.payload?.userId === users[2].id),
      false,
      "muted/null seed emits nothing"
    );
    assert.equal(
      emitted.some((event) => event.payload?.userId === users[4].id),
      false,
      "finished row emits nothing"
    );

    process.env.PLACEMENT_BASELINE_RESYNC = "true";
    try {
      await prisma.raceParticipant.update({
        where: { raceId_userId: { raceId: race.id, userId: users[0].id } },
        data: { lastNotifiedPlacement: 99 },
      });
      emitted.length = 0;
      await run();
      assert.equal(
        (await prisma.raceParticipant.findUnique({
          where: { raceId_userId: { raceId: race.id, userId: users[0].id } },
        })).lastNotifiedPlacement,
        2
      );
      assert.equal(
        emitted.filter((event) => event.type === "PLACEMENT_CHANGED").length,
        1,
        "retired resync env cannot silently suppress a real placement transition"
      );
    } finally {
      delete process.env.PLACEMENT_BASELINE_RESYNC;
    }
  });

  it("recomputes a 750-member team transition and persists the exact team ranks", async () => {
    const count = 750;
    const users = Array.from({ length: count }, (_, index) => ({
      id: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      appleId: `placement-team-matrix-${index}`,
    }));
    await prisma.user.createMany({ data: users });
    const race = await prisma.race.create({
      data: {
        creatorId: users[0].id,
        name: "Placement team matrix 750",
        targetSteps: 1000000,
        status: "ACTIVE",
        isTeamRace: true,
        teamSize: count / 2,
        teamAName: "A",
        teamBName: "B",
      },
    });
    await prisma.raceParticipant.createMany({
      data: users.map((user, index) => {
        const team = index % 2 === 0 ? "TEAM_A" : "TEAM_B";
        return {
          id: `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          raceId: race.id,
          userId: user.id,
          status: "ACCEPTED",
          team,
          totalSteps: team === "TEAM_A" ? 3 : 1,
          lastNotifiedPlacement: team === "TEAM_A" ? 2 : 1,
        };
      }),
    });
    const emitted = [];
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant,
      JobRun,
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 8,
      }),
    });

    await run();
    const rows = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      select: { team: true, lastNotifiedPlacement: true },
    });
    assert.equal(rows.length, count);
    assert.equal(
      rows.every((row) =>
        row.lastNotifiedPlacement === (row.team === "TEAM_A" ? 1 : 2)
      ),
      true
    );
    const teamEvents = emitted.filter((event) => event.type === "TEAM_LEAD_CHANGED");
    assert.equal(teamEvents.length, 1);
    assert.equal(teamEvents[0].payload.leadingTeam, "TEAM_A");
  });

  it("CAS contention with concurrent totals/expiry writers never overwrites totals and emits only won rows", async () => {
    const first = await createTestUser({ displayName: "CAS contender" });
    const second = await createTestUser({ displayName: "CAS stable" });
    const race = await prisma.race.create({
      data: {
        creatorId: first.user.id,
        name: "CAS writer contention",
        targetSteps: 100000,
        status: "ACTIVE",
      },
    });
    const rows = await Promise.all([
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: first.user.id,
          status: "ACCEPTED",
          totalSteps: 200,
          lastNotifiedPlacement: 2,
        },
      }),
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: second.user.id,
          status: "ACCEPTED",
          totalSteps: 100,
          lastNotifiedPlacement: 1,
        },
      }),
    ]);
    const emitted = [];
    let raced = false;
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant: {
        ...RaceParticipant,
        async compareAndSetPlacementBaseline(id, expected, next) {
          if (id === rows[0].id && !raced) {
            raced = true;
            await Promise.all([
              prisma.raceParticipant.update({
                where: { id },
                data: { totalSteps: 999, forfeitedAt: new Date() },
              }),
              prisma.raceParticipant.update({
                where: { id },
                data: { lastNotifiedPlacement: 7 },
              }),
            ]);
          }
          return RaceParticipant.compareAndSetPlacementBaseline(id, expected, next);
        },
      },
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 2,
      }),
    });

    await run();
    const contested = await prisma.raceParticipant.findUnique({ where: { id: rows[0].id } });
    assert.equal(contested.totalSteps, 999);
    assert.equal(contested.lastNotifiedPlacement, 7);
    assert.ok(contested.forfeitedAt);
    assert.equal(
      emitted.some((event) => event.payload?.userId === first.user.id),
      false,
      "lost CAS never emits"
    );
    assert.equal(
      emitted.some((event) => event.payload?.userId === second.user.id),
      true,
      "uncontended later participant still emits"
    );
  });

  it("isolates one baseline CAS failure and continues later participants", async () => {
    const first = await createTestUser({ displayName: "CAS failure" });
    const second = await createTestUser({ displayName: "CAS survivor" });
    const race = await prisma.race.create({
      data: {
        creatorId: first.user.id,
        name: "Placement failure isolation",
        targetSteps: 100000,
        status: "ACTIVE",
      },
    });
    const rows = await Promise.all([
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: first.user.id,
          status: "ACCEPTED",
          totalSteps: 200,
          lastNotifiedPlacement: 2,
        },
      }),
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: second.user.id,
          status: "ACCEPTED",
          totalSteps: 100,
          lastNotifiedPlacement: 1,
        },
      }),
    ]);
    const errors = [];
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant: {
        ...RaceParticipant,
        async compareAndSetPlacementBaseline(id, expected, next) {
          if (id === rows[0].id) throw new Error("injected CAS failure");
          return RaceParticipant.compareAndSetPlacementBaseline(id, expected, next);
        },
      },
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit() {} },
      logger: { log() {}, warn() {}, error(...args) { errors.push(args); } },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 2,
      }),
    });

    const changes = await run();
    assert.equal(changes.length, 1);
    assert.equal(changes[0].userId, second.user.id);
    const after = await prisma.raceParticipant.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      orderBy: { totalSteps: "desc" },
    });
    assert.deepEqual(after.map((row) => row.lastNotifiedPlacement), [2, 2]);
    assert.equal(errors.length, 1);
  });

  it("emits nothing for a fully failed race and continues the later race", async () => {
    const users = Array.from({ length: 4 }, (_, index) => ({
      id: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      appleId: `placement-race-isolation-${index}`,
    }));
    await prisma.user.createMany({ data: users });
    const [failedRace, laterRace] = await Promise.all([
      prisma.race.create({
        data: {
          creatorId: users[0].id,
          name: "Placement fully failed race",
          targetSteps: 100000,
          status: "ACTIVE",
        },
      }),
      prisma.race.create({
        data: {
          creatorId: users[2].id,
          name: "Placement later healthy race",
          targetSteps: 100000,
          status: "ACTIVE",
        },
      }),
    ]);
    const participantRows = await Promise.all([
      prisma.raceParticipant.create({
        data: { raceId: failedRace.id, userId: users[0].id, status: "ACCEPTED", totalSteps: 20, lastNotifiedPlacement: 2 },
      }),
      prisma.raceParticipant.create({
        data: { raceId: failedRace.id, userId: users[1].id, status: "ACCEPTED", totalSteps: 10, lastNotifiedPlacement: 1 },
      }),
      prisma.raceParticipant.create({
        data: { raceId: laterRace.id, userId: users[2].id, status: "ACCEPTED", totalSteps: 20, lastNotifiedPlacement: 2 },
      }),
      prisma.raceParticipant.create({
        data: { raceId: laterRace.id, userId: users[3].id, status: "ACCEPTED", totalSteps: 10, lastNotifiedPlacement: 1 },
      }),
    ]);
    const failedIds = new Set(participantRows.slice(0, 2).map(({ id }) => id));
    const emitted = [];
    const run = buildRecomputePlacements({
      Race,
      RaceParticipant: {
        ...RaceParticipant,
        async compareAndSetPlacementBaseline(id, expected, next) {
          if (failedIds.has(id)) throw new Error("injected race failure");
          return RaceParticipant.compareAndSetPlacementBaseline(id, expected, next);
        },
      },
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 2,
      }),
    });

    await run();
    assert.equal(
      emitted.some((event) => event.payload?.raceId === failedRace.id),
      false
    );
    assert.equal(
      emitted.filter((event) => event.payload?.raceId === laterRace.id).length,
      2
    );
  });

  it("dedupes an actual team lead flip while allowing reverse and repeat transitions", async () => {
    const users = await Promise.all([
      createTestUser({ displayName: "Team A" }),
      createTestUser({ displayName: "Team B" }),
    ]);
    const race = await prisma.race.create({
      data: {
        creatorId: users[0].user.id,
        name: "Team transition",
        targetSteps: 100000,
        status: "ACTIVE",
        isTeamRace: true,
        teamSize: 1,
        teamAName: "A",
        teamBName: "B",
      },
    });
    const rows = await Promise.all([
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: users[0].user.id,
          status: "ACCEPTED",
          team: "TEAM_A",
          totalSteps: 100,
          lastNotifiedPlacement: 2,
        },
      }),
      prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: users[1].user.id,
          status: "ACCEPTED",
          team: "TEAM_B",
          totalSteps: 50,
          lastNotifiedPlacement: 1,
        },
      }),
    ]);
    const emitted = [];
    const build = () => buildRecomputePlacements({
      Race,
      RaceParticipant,
      JobRun,
      RaceActiveEffect: { async findDueRaceIds() { return []; } },
      RaceResolutionJobV2: { async findRecoveryRaceIds() { return []; } },
      Notification: { async findExistingByUserTypeRaceKeys() { return []; } },
      requestStepSyncForUsers: async () => {},
      enqueueRaceResolution: async () => false,
      eventBus: { emit(type, payload) { emitted.push({ type, payload }); } },
      logger: { log() {}, warn() {}, error() {} },
      getPerformanceFlags: () => ({
        placementDistributedClaimEnabled: false,
        placementLeanBaselineWritesEnabled: true,
        placementBaselineWriteConcurrency: 2,
      }),
    });

    await Promise.all([build()(), build()()]);
    assert.equal(emitted.filter((event) => event.type === "TEAM_LEAD_CHANGED").length, 1);
    await prisma.raceParticipant.update({ where: { id: rows[0].id }, data: { totalSteps: 10 } });
    await build()();
    await prisma.raceParticipant.update({ where: { id: rows[0].id }, data: { totalSteps: 100 } });
    await build()();
    assert.deepEqual(
      emitted
        .filter((event) => event.type === "TEAM_LEAD_CHANGED")
        .map((event) => event.payload.leadingTeam),
      ["TEAM_A", "TEAM_B", "TEAM_A"]
    );
  });
});
