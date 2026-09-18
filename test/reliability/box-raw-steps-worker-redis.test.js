// raw_steps under the PROD configuration: `redisStandingsEnabled` ON.
// (docs/box-raw-steps-position-and-option-h-requirements.md, test plan 6b + the
// snapshot-served and persisted-fallback halves of test 2.)
//
// With the flag on, `GET /races/:id/progress` writes NOTHING — the race-keyed
// v2 worker is the only writer of participant totals, through its capture
// record and fenced replay. A `raw_steps` design that missed that path would
// leave the column NULL forever in prod and the exploit wide open, and no
// flag-OFF test would notice. This file is that guard.
//
// It SKIPS (never fails) when no local Redis is available, exactly like
// redis-cache-c3-standings.test.js — the suite must stay green with REDIS_URL
// unset (test 6d).
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { startTestRedis } = require("./redisTestServer");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildOpenMysteryBox,
} = require("../../src/modules/powerups/commands/openMysteryBox");
const {
  rollPowerup: realRollPowerup,
} = require("../../src/modules/powerups/powerupOdds");

const HOUR_MS = 60 * 60 * 1000;
const FEAT =
  "tournaments,characters,powerups2,powerups3,powerups4,powerups5,remote_assets";

let server;
let spyServer;
let live = null;
let skipReason = null;
let probe = null;
let nextAppleId = 0;
const rolls = [];

function spyRoller(position, totalParticipants, rng, options) {
  rolls.push({ position, totalParticipants });
  return realRollPowerup(position, totalParticipants, rng, options);
}

before(async () => {
  server = await getSharedServer();
  spyServer = await startServer({
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
    openMysteryBox: buildOpenMysteryBox({ rollPowerupOdds: spyRoller }),
  });
  live = await startTestRedis();
  if (!live) {
    skipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  await disableRedis();
  await appSettings.setFlag("redisStandingsEnabled", false);
  appSettings.bustCache();
  if (spyServer) await spyServer.close();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
  snapshotStore.__resetCounters();
  await appSettings.setFlag("redisStandingsEnabled", true);
  appSettings.bustCache();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
  snapshotStore.__resetCounters();
}

async function createUser(displayName) {
  const appleId = `apple-rawworker-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  await prisma.user.update({
    where: { id: body.user.id },
    data: { timezone: "UTC" },
  });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendship = (await sendRes.json()).friendship;
  if (!friendship) return;
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(owner, others, name) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 500000,
    },
    token: owner.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: owner.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: owner.token,
  });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  return {
    periodStart: new Date(end.getTime() - HOUR_MS).toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

async function postSamples(user, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token: user.token,
  });
}

async function progress(user, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: user.token,
    headers: { "X-Client-Features": FEAT, "X-Timezone": "UTC" },
  });
  // The route answers `{ progress: {...} }`.
  const payload = await res.json();
  assert.equal(res.status, 200, JSON.stringify(payload));
  return payload.progress || payload;
}

async function drain(worker, maxJobs = 20) {
  for (let i = 0; i < maxJobs; i++) {
    if (!(await worker.processOne())) break;
  }
}

async function rows(raceId) {
  const list = await prisma.raceParticipant.findMany({
    where: { raceId, status: "ACCEPTED" },
    select: { id: true, userId: true, totalSteps: true, rawSteps: true },
  });
  return Object.fromEntries(list.map((r) => [r.userId, r]));
}

describe("6b — raw_steps under the v2 worker (redisStandingsEnabled ON)", () => {
  beforeEach(async () => {
    await cleanDatabase();
    rolls.length = 0;
    await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
    await appSettings.setFlag("inlineRaceResolutionFallback", false);
  });

  it("the worker writes raw_steps under its fence, and the snapshot-served odds agree with a real open", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    try {
      const alice = await createUser("AliceWk");
      const bob = await createUser("BobWk");
      const carol = await createUser("CarolWk");
      const raceId = await createActiveRace(alice, [bob, carol], "Worker raw");

      await postSamples(alice, [sampleAt(2, 3000)]);
      await postSamples(bob, [sampleAt(2, 6000)]);
      await postSamples(carol, [sampleAt(2, 9000)]);

      // Only the uploader-reconcile has touched raw_steps so far. Wipe it: the
      // WORKER must be provably the writer for every row below.
      await prisma.raceParticipant.updateMany({
        where: { raceId },
        data: { rawSteps: null, bonusSteps: 0 },
      });
      await prisma.raceParticipant.updateMany({
        where: { raceId, userId: alice.userId },
        data: { bonusSteps: 20000, maxBonusSteps: 20000 },
      });

      await prisma.$executeRawUnsafe(
        `UPDATE race_resolution_jobs_v2 SET state = 'queued', not_before_at = NULL, generation = generation + 1`
      );
      await drain(buildRaceResolutionWorkerV2({ bootAt: 0 }));

      const state = await rows(raceId);
      assert.equal(state[alice.userId].rawSteps, 3000, "worker wrote raw_steps");
      assert.equal(state[bob.userId].rawSteps, 6000);
      assert.equal(state[carol.userId].rawSteps, 9000);
      assert.ok(
        state[alice.userId].totalSteps > state[carol.userId].totalSteps,
        "…while Alice is the bonus-boosted leaderboard leader"
      );

      // Snapshot-served disclosure (the worker SETs the snapshot post-commit).
      const body = await progress(alice, raceId);
      assert.equal(body.powerupData.dropOdds.position, 3);
      assert.equal(body.powerupData.dropOdds.totalParticipants, 3);

      // …and a REAL open agrees with the quoted number.
      const p = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: alice.userId },
      });
      const box = await prisma.racePowerup.create({
        data: {
          raceId,
          participantId: p.id,
          userId: alice.userId,
          type: "MYSTERY_BOX",
          status: "MYSTERY_BOX",
          earnedAtSteps: 4242,
        },
      });
      const openRes = await request(
        spyServer.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${box.id}/open`,
        { token: alice.token, headers: { "X-Client-Features": FEAT } }
      );
      assert.equal(openRes.status, 200, await openRes.text());
      assert.equal(rolls.length, 1);
      assert.equal(
        rolls[0].position,
        body.powerupData.dropOdds.position,
        "snapshot-served odds and the actual roll must agree"
      );
    } finally {
      await disableRedis();
      await appSettings.setFlag("redisStandingsEnabled", false);
      appSettings.bustCache();
    }
  });

  it("the persisted-columns fallback (Redis bypassed) quotes the same raw position", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    try {
      const alice = await createUser("AliceFb");
      const bob = await createUser("BobFb");
      const raceId = await createActiveRace(alice, [bob], "Fallback raw");

      await postSamples(alice, [sampleAt(2, 2000)]);
      await postSamples(bob, [sampleAt(2, 8000)]);
      await prisma.raceParticipant.updateMany({
        where: { raceId, userId: alice.userId },
        data: { bonusSteps: 30000, maxBonusSteps: 30000 },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE race_resolution_jobs_v2 SET state = 'queued', not_before_at = NULL, generation = generation + 1`
      );
      await drain(buildRaceResolutionWorkerV2({ bootAt: 0 }));

      // Pull the rug: REDIS_URL stays SET (so the flag stays ON) but nothing
      // answers, which is the outage path — every request takes the cheap
      // persisted-columns read and the replay never runs.
      process.env.REDIS_URL = "redis://127.0.0.1:6399";
      await cache.close();
      derivedCache.reset();
      snapshotStore.__resetCounters();

      const body = await progress(alice, raceId);
      assert.equal(
        snapshotStore.__counters.persistedFallbacks,
        1,
        "this case must exercise the persisted-columns path"
      );
      assert.equal(
        body.powerupData.dropOdds.position,
        2,
        "the persisted fallback ranks on raw steps too"
      );
      assert.equal(
        body.participants[0].userId,
        alice.userId,
        "…while the leaderboard still shows the boosted leader first"
      );
    } finally {
      await disableRedis();
      await appSettings.setFlag("redisStandingsEnabled", false);
      appSettings.bustCache();
    }
  });
});
