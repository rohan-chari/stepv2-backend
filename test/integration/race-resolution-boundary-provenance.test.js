const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { RaceResolutionPostTask } = require("../../src/modules/races/models/raceResolutionPostTask");

describe("GLOBAL_EVENT_BOUNDARY post-task provenance", () => {
  beforeEach(cleanDatabase);

  async function createRace() {
    const creator = await createTestUser({ displayName: "Boundary Provenance Creator" });
    return prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: "Boundary Provenance Race",
        targetSteps: 10_000,
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T11:00:00.000Z"),
        endsAt: new Date("2026-08-15T11:00:00.000Z"),
      },
    });
  }

  async function createTask(raceId, sourceGeneration, includesGlobalEventBoundary) {
    return RaceResolutionPostTask.create({
      raceId,
      sourceGeneration,
      includesGlobalEventBoundary,
      snapshotCommand: { raceId, timeZone: "UTC" },
      intents: [],
    });
  }

  it("records provenance only for boundary-bearing committed generations", async () => {
    const race = await createRace();
    const cases = [
      [1, ["GLOBAL_EVENT_BOUNDARY"], true],
      [2, ["GLOBAL_EVENT_BOUNDARY", "DISPLAY_REFRESH"], true],
      [3, ["GLOBAL_EVENT_BOUNDARY", "STEP_INPUT_CHANGED"], true],
      [4, ["GLOBAL_EVENT_BOUNDARY", "EFFECT_BOUNDARY"], true],
      [5, ["DISPLAY_REFRESH"], false],
    ];

    for (const [generation, reasons, expected] of cases) {
      await createTask(race.id, generation, reasons.includes("GLOBAL_EVENT_BOUNDARY"));
      const row = await prisma.raceResolutionPostTask.findUniqueOrThrow({
        where: { raceId_sourceGeneration: { raceId: race.id, sourceGeneration: generation } },
        select: { includesGlobalEventBoundary: true },
      });
      assert.equal(row.includesGlobalEventBoundary, expected, `${generation}: ${reasons.join(",")}`);
    }
  });

  it("keeps provenance tied to generation identity across retries and later work", async () => {
    const race = await createRace();
    await createTask(race.id, 10, true);
    const retry = await createTask(race.id, 10, false);
    assert.equal(retry.created, false);

    await createTask(race.id, 11, false);
    const rows = await prisma.raceResolutionPostTask.findMany({
      where: { raceId: race.id },
      orderBy: { sourceGeneration: "asc" },
      select: { sourceGeneration: true, includesGlobalEventBoundary: true },
    });
    assert.deepEqual(rows, [
      { sourceGeneration: 10, includesGlobalEventBoundary: true },
      { sourceGeneration: 11, includesGlobalEventBoundary: false },
    ]);
  });

  it("does not leave provenance when the transaction containing task creation rolls back", async () => {
    const race = await createRace();
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await RaceResolutionPostTask.create({
          raceId: race.id,
          sourceGeneration: 20,
          includesGlobalEventBoundary: true,
          snapshotCommand: { raceId: race.id, timeZone: "UTC" },
          intents: [],
        }, tx);
        throw new Error("simulated scoring transaction failure");
      }),
      /simulated scoring transaction failure/,
    );
    assert.equal(await prisma.raceResolutionPostTask.count({
      where: { raceId: race.id, sourceGeneration: 20 },
    }), 0);
  });
});
