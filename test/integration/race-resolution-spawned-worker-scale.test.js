const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");

const workerScript = path.join(__dirname, "../../scripts/test-race-resolution-worker-once.js");
let server;

function runWorker(mode = "process") {
  return new Promise((resolve, reject) => {
    const workerEnv = { ...process.env, RACE_QUEUE_V2_QUIET_PERIOD_MS: "0" };
    delete workerEnv.NODE_TEST_CONTEXT;
    const child = fork(workerScript, mode === "claim" ? ["--claim-only"] : [], {
      env: workerEnv,
      // Do not inherit node --test from this integration process: the probe
      // must boot as the same plain Node worker used in production.
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let message = null;
    child.on("message", (value) => { message = value; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 && !message?.error
      ? resolve(message)
      : reject(new Error(message?.error || `worker exited ${code}`)));
  });
}

async function seedPublicRace(size) {
  const { user: owner, token } = await createTestUser({ displayName: `Spawn Owner ${size}` });
  const users = Array.from({ length: size - 1 }, (_, index) => ({
    id: randomUUID(), appleId: `spawn-scale-${size}-${index}`,
    displayName: `Spawn ${size}-${index}`,
  }));
  await prisma.user.createMany({ data: users });
  const now = new Date();
  const race = await prisma.race.create({ data: {
    creatorId: owner.id, name: `Spawn scale ${size}`, targetSteps: 100000,
    status: "ACTIVE", startedAt: new Date(now.getTime() - 3 * 3600_000),
    endsAt: new Date(now.getTime() + 24 * 3600_000), timezone: "UTC",
  }});
  await prisma.raceParticipant.createMany({ data: [owner, ...users].map((user) => ({
    id: randomUUID(), raceId: race.id, userId: user.id, status: "ACCEPTED",
    joinedAt: new Date(now.getTime() - 3 * 3600_000),
  })) });
  const end = new Date(now.getTime() - 3600_000);
  const response = await request(server.baseUrl, "POST", "/steps/samples", {
    token,
    body: { samples: [{
      periodStart: new Date(end.getTime() - 3600_000).toISOString(),
      periodEnd: end.toISOString(), steps: 1234,
    }] },
  });
  assert.equal(response.status, 200, `public enqueue at ${size}`);
  return { raceId: race.id, ownerId: owner.id };
}

before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);

describe("spawned production worker public scale and crash recovery", () => {
  it("processes public queue rows at 10/100/350 participants and recovers a claimed-worker crash", async () => {
    for (const size of [10, 100, 350]) {
      const { raceId, ownerId } = await seedPublicRace(size);
      // A separately spawned process claims and exits before processing. This
      // simulates a production worker crash after durable ownership.
      assert.ok((await runWorker("claim")).claimed, `spawned claim at ${size}`);
      await prisma.raceResolutionJobV2.update({
        where: { raceId }, data: { leaseExpiresAt: new Date(Date.now() - 1) },
      });
      assert.ok((await runWorker()).claimed, `spawned recovery at ${size}`);
      const participant = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId, userId: ownerId }, select: { totalSteps: true },
      });
      assert.equal(participant.totalSteps, 1234, `public total at ${size}`);
      const job = await prisma.raceResolutionJobV2.findUniqueOrThrow({ where: { raceId } });
      assert.ok(job.lastCompletedAt, `terminal recovery at ${size}`);
    }
  });
});
