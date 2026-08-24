const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  getSharedServer,
  cleanDatabase,
  createTestUser,
  request,
  prisma,
} = require("./setup");
const crypto = require("node:crypto");
const { eventBus } = require("../../src/shared/events/eventBus");

async function activeRaceWith(userId) {
  const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const race = await prisma.race.create({
    data: {
      creatorId: userId,
      name: `Atomic intake ${Date.now()}`,
      targetSteps: 0,
      isPublic: false,
      timeBased: true,
      timezone: "UTC",
      maxParticipants: 10,
      maxDurationDays: 7,
      status: "ACTIVE",
      startedAt,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      potCoins: 0,
    },
  });
  await prisma.raceParticipant.create({
    data: { raceId: race.id, userId, status: "ACCEPTED", joinedAt: startedAt },
  });
  return race.id;
}

async function installQueueFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_step_intake_queue()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'induced atomic intake queue failure';
    END $$;
    CREATE TRIGGER test_fail_step_intake_queue_trigger
    BEFORE INSERT OR UPDATE ON race_resolution_jobs_v2
    FOR EACH ROW EXECUTE FUNCTION test_fail_step_intake_queue();
  `);
}

async function removeQueueFailureTrigger() {
  await prisma.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS test_fail_step_intake_queue_trigger
      ON race_resolution_jobs_v2;
    DROP FUNCTION IF EXISTS test_fail_step_intake_queue();
  `);
}

// Frozen binaries use these two endpoints. These public-path fixtures pin the
// legacy successful status and JSON shape while their derived race work moves
// behind the durable queue.
describe("legacy step intake wire compatibility", () => {
  let baseUrl;

  before(async () => {
    baseUrl = (await getSharedServer()).baseUrl;
  });

  beforeEach(cleanDatabase);

  for (const skipRaceResolution of [false, true]) {
    it(`POST /steps preserves the exact record envelope (skipRaceResolution=${skipRaceResolution})`, async () => {
      const { token, user } = await createTestUser();
      const response = await request(baseUrl, "POST", "/steps", {
        token,
        body: {
          date: "2026-08-24",
          steps: 4321,
          skipRaceResolution,
        },
      });

      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body), ["record"]);
      assert.deepEqual(Object.keys(body.record).sort(), [
        "createdAt",
        "date",
        "id",
        "stepGoal",
        "steps",
        "userId",
      ]);
      assert.equal(body.record.userId, user.id);
      assert.equal(body.record.steps, 4321);
      assert.equal(body.record.stepGoal, 5000);
      assert.equal(new Date(body.record.date).toISOString(), "2026-08-24T00:00:00.000Z");
    });
  }

  it("POST /steps classifies concurrent same-day intake from the authoritative locked write", async () => {
    const { token, user } = await createTestUser();
    const date = "2026-08-24";
    const emitted = [];
    eventBus.on("STEPS_RECORDED", (payload) => {
      if (payload.userId === user.id && payload.date === date) emitted.push("RECORDED");
    });
    eventBus.on("STEPS_UPDATED", (payload) => {
      if (payload.userId === user.id && payload.date === date) emitted.push("UPDATED");
    });

    const [first, second] = await Promise.all([
      request(baseUrl, "POST", "/steps", {
        token,
        body: { date, steps: 4321 },
      }),
      request(baseUrl, "POST", "/steps", {
        token,
        body: { date, steps: 5432 },
      }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(emitted.sort(), ["RECORDED", "UPDATED"]);
    assert.equal(
      await prisma.step.count({ where: { userId: user.id, date: new Date(date) } }),
      1
    );
  });

  it("POST /steps/samples preserves HTTP 200 and the exact normalized count envelope", async () => {
    const { token } = await createTestUser();
    const response = await request(baseUrl, "POST", "/steps/samples", {
      token,
      body: {
        samples: [
          {
            periodStart: "2026-08-24T10:00:00.000Z",
            periodEnd: "2026-08-24T11:00:00.000Z",
            steps: 100,
            recordingMethod: "automatic",
          },
          {
            periodStart: "2026-08-24T10:15:00.000Z",
            periodEnd: "2026-08-24T10:20:00.000Z",
            steps: 20,
            recordingMethod: "active",
          },
        ],
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 1 });
  });

  it("identical legacy samples preserve count while suppressing scoring and queue generations", async () => {
    const { token, user } = await createTestUser();
    const raceId = await activeRaceWith(user.id);
    const sample = {
      periodStart: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      periodEnd: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      steps: 250,
      recordingMethod: "automatic",
    };
    const first = await request(baseUrl, "POST", "/steps/samples", {
      token,
      body: { samples: [sample] },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { count: 1 });
    const firstJob = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId },
    });
    const firstVersion = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });

    const second = await request(baseUrl, "POST", "/steps/samples", {
      token,
      body: { samples: [sample] },
    });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { count: 1 });
    const secondJob = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId },
    });
    const secondVersion = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: user.id },
    });
    assert.equal(secondJob.generation, firstJob.generation);
    assert.equal(secondVersion.generation, firstVersion.generation);
    assert.equal(
      secondVersion.sourceQueueSemanticsGeneration,
      secondVersion.generation
    );
  });

  it("POST /steps/samples keeps the frozen validation response for an empty batch", async () => {
    const { token } = await createTestUser();
    const response = await request(baseUrl, "POST", "/steps/samples", {
      token,
      body: { samples: [] },
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "samples must be a non-empty array",
    });
  });

  for (const endpoint of ["steps", "samples", "sync-v2"]) {
    it(`${endpoint} rolls source and reservation back when atomic queue handoff fails`, async () => {
      const { token, user } = await createTestUser();
      await activeRaceWith(user.id);
      await installQueueFailureTrigger();
      try {
        const sharedSample = {
          periodStart: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          periodEnd: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          steps: 777,
          recordingMethod: "automatic",
        };
        let response;
        if (endpoint === "steps") {
          response = await request(baseUrl, "POST", "/steps", {
            token,
            body: {
              date: new Date().toISOString().slice(0, 10),
              steps: 777,
            },
          });
        } else if (endpoint === "samples") {
          response = await request(baseUrl, "POST", "/steps/samples", {
            token,
            body: { samples: [sharedSample] },
          });
        } else {
          response = await request(baseUrl, "POST", "/steps/sync-v2", {
            token,
            headers: { "Idempotency-Key": crypto.randomUUID() },
            body: {
              date: new Date().toISOString().slice(0, 10),
              steps: 777,
              samples: [sharedSample],
            },
          });
        }
        assert.equal(response.status, 500);
        assert.equal(await prisma.step.count({ where: { userId: user.id } }), 0);
        assert.equal(
          await prisma.stepSample.count({ where: { userId: user.id } }),
          0
        );
        assert.equal(
          await prisma.stepSyncRequest.count({ where: { userId: user.id } }),
          0
        );
        assert.equal(await prisma.raceResolutionJobV2.count(), 0);
      } finally {
        await removeQueueFailureTrigger();
      }
    });
  }
});
