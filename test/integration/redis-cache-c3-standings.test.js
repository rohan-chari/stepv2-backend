// Phase D / C3 — the live-standings snapshot and the removal of
// `GET /races/:id/progress`'s write-back.
// (docs/redis-derived-data-layer-requirements.md §2 item 4-C3, §3's
// `v1:race:{id}:progress` row, §5 Phase D steps 6-9, §7's divergence table,
// §8 tests 2, 4, 5, 5b and 5e.)
//
// This is the incident fix. Before it, every poll of this endpoint replayed the
// whole race AND rewrote every participant row — 6.3M updates on 2,396 live
// rows, with no mutual exclusion, which is the bulk-writer deadlock class the
// 2026-08-07 incident traced to. The properties that make the fix real, and
// that every test below exists to pin:
//
//   1. The response is JSON-contract IDENTICAL with the flag on or off, for the
//      requester AND for anyone else looking at the same race (test 2).
//   2. The endpoint issues ZERO `race_participants` writes with the flag on,
//      totals still converge (via the enqueued race-keyed job), and settlement
//      lands on the same placements and the same coins (test 4).
//   3. The expensive replay runs AT MOST ONCE per lock window, never from a
//      lock loser, and NEVER AT ALL when Redis is unavailable (tests 5, 5e) —
//      because a waiter that holds a pooled Postgres connection is precisely
//      the 2026-07-18 pool-drain incident.
//   4. The cached value contains no requester-derived field, enforced by an
//      allowlist assertion over the real Redis payload (test 5b).
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "t:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { startTestRedis } = require("./redisTestServer");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const cache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const snapshotStore = require("../../src/modules/races/services/raceProgressSnapshot");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const { appSettings } = require("../../src/shared/config/appSettings");
const { recentBoxMints } = require("../../src/modules/races/services/recentBoxMints");
const {
  enqueueRaceResolution,
} = require("../../src/modules/races/services/enqueueRaceResolution");

const FEAT =
  "tournaments,characters,powerups2,powerups3,powerups4,powerups5,remote_assets";
const HOUR_MS = 60 * 60 * 1000;

let server;
let live = null;
let skipReason = null;
let probe = null;
let nextAppleId = 0;

before(async () => {
  server = await getSharedServer();
  live = await startTestRedis();
  if (!live) {
    skipReason =
      "no local Redis available (install redis-server or set REDIS_TEST_URL)";
  }
});

after(async () => {
  await disableRedis();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
});

// ── environment plumbing ───────────────────────────────────────────────────

async function enableRedis(url) {
  process.env.REDIS_URL = url || live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await cache.close();
  derivedCache.reset();
  if (!probe) probe = new IORedis(live.url);
  await probe.flushdb();
  snapshotStore.__resetCounters();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await cache.close();
  derivedCache.reset();
  snapshotStore.__resetCounters();
}

async function setFlag(value) {
  await appSettings.setFlag("redisStandingsEnabled", value);
  appSettings.bustCache();
}

// ── fixtures ───────────────────────────────────────────────────────────────

async function createUser(displayName) {
  const appleId = `apple-c3-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
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

/**
 * A started, powerup-enabled race whose `timezone` is pinned to UTC. Pinning it
 * matters: a NULL-timezone race scores in the REQUESTER's header tz, and the
 * snapshot is deliberately invalid for a viewer in another tz (see
 * cacheKeys.raceProgress). A canonical-tz race is the shared case.
 */
async function createActiveRace(owner, others, name, extra = {}) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      ...(extra.createBody || {}),
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

/** A started 1v1 TEAM race built through the real API (the TR accept flow). */
async function createTeamRace(owner, opponent, name) {
  const headers = { "X-Client-Features": `${FEAT},team_races` };
  // TR-706: an invitee is only eligible once the backend has SEEN them send the
  // `team_races` capability token. One authed request each records it.
  for (const u of [owner, opponent]) {
    await request(server.baseUrl, "GET", "/auth/me", { token: u.token, headers });
  }
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 1,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      // Public so the private-race auto-start does not fire: this helper starts
      // the race explicitly below and then rewrites startedAt/joinedAt.
      isPublic: true,
    },
    token: owner.token,
    headers,
  });
  const race = (await createRes.json()).race;
  assert.ok(race, "team race creation failed");
  await makeFriends(owner, opponent);
  await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
    body: { inviteeIds: [opponent.userId] },
    token: owner.token,
    headers,
  });
  const accept = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
    body: { accept: true, team: "TEAM_B" },
    token: opponent.token,
    headers,
  });
  assert.equal(accept.status, 200, await accept.text());
  const startRes = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
    token: owner.token,
    headers,
  });
  assert.equal(startRes.status, 200, await startRes.text());
  const start = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: race.id },
    data: {
      startedAt: start,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId: race.id },
    data: { joinedAt: start },
  });
  return race.id;
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

async function progressRes(user, raceId) {
  return request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: user.token,
    headers: { "X-Client-Features": FEAT, "X-Timezone": "UTC" },
  });
}

async function progress(user, raceId) {
  const res = await progressRes(user, raceId);
  if (res.status !== 200) {
    assert.fail(`progress ${res.status}: ${await res.text()}`);
  }
  return (await res.json()).progress;
}

function makeWorker(overrides = {}) {
  return buildRaceResolutionWorkerV2({ bootAt: 0, ...overrides });
}

async function drain(worker = makeWorker(), maxJobs = 50) {
  for (let i = 0; i < maxJobs; i++) {
    if (!(await worker.processOne())) break;
  }
}

async function participantRows(raceId) {
  return prisma.raceParticipant.findMany({
    where: { raceId },
    orderBy: { userId: "asc" },
    select: {
      userId: true,
      totalSteps: true,
      totalsUpdatedAt: true,
      nextBoxAtSteps: true,
    },
  });
}

async function grantAndUse(user, raceId, type) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
    select: { id: true },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type,
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  const res = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerup.id}/use`,
    { token: user.token, headers: { "X-Client-Features": FEAT } }
  );
  if (res.status !== 200) assert.fail(`use ${type}: ${res.status} ${await res.text()}`);
  return res;
}

async function rawSnapshot(raceId) {
  const value = await probe.get(`${ENV_PREFIX}${cacheKeys.raceProgress(raceId)}`);
  return value ? JSON.parse(value) : null;
}

beforeEach(async () => {
  await cleanDatabase();
  await prisma.appSetting.deleteMany({});
  appSettings.bustCache();
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
  snapshotStore.__resetCounters();
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 2 — PARITY. Cold-cache flag-on response ≡ flag-off response.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — §8 test 2 parity (cold cache ≡ flag off)", () => {
  it("matches for the requester AND for another viewer, with effects, teams, a finisher and a forfeiter", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await disableRedis();
    await setFlag(false);

    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const cara = await createUser("Cara");
    const dan = await createUser("Dan");
    const raceId = await createActiveRace(alice, [bob, cara, dan], "Parity");

    await postSamples(alice, [sampleAt(6, 3000), sampleAt(5, 2500)]);
    await postSamples(bob, [sampleAt(6, 1800), sampleAt(5, 1500)]);
    await postSamples(cara, [sampleAt(6, 900), sampleAt(5, 700)]);
    await postSamples(dan, [sampleAt(6, 400)]);

    // An ACTIVE effect on the board (the per-viewer filter's subject) …
    await grantAndUse(bob, raceId, "RUNNERS_HIGH");
    // … a FINISHED participant …
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: cara.userId },
      data: { finishedAt: new Date(), finishTotalSteps: 1600, totalSteps: 1600 },
    });
    // … and a FORFEITED one.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: dan.userId },
      data: { forfeitedAt: new Date(), totalSteps: 400 },
    });

    // Two flag-off reads: the FIRST one may mint a mystery box (the box gate is
    // a side effect of the legacy path), so the SECOND is the steady state the
    // flag-on path must equal.
    for (const viewer of [alice, bob]) await progress(viewer, raceId);
    const baseline = {
      alice: await progress(alice, raceId),
      bob: await progress(bob, raceId),
    };

    await enableRedis();
    await setFlag(true);

    const cold = { alice: await progress(alice, raceId) };
    // Bob reads the SAME shared snapshot Alice just installed — the case a
    // whole-response cache would have got wrong.
    cold.bob = await progress(bob, raceId);
    const warm = {
      alice: await progress(alice, raceId),
      bob: await progress(bob, raceId),
    };

    assert.deepEqual(cold.alice, baseline.alice, "cold requester ≢ flag-off");
    assert.deepEqual(cold.bob, baseline.bob, "cold second viewer ≢ flag-off");
    assert.deepEqual(warm.alice, baseline.alice, "warm requester ≢ flag-off");
    assert.deepEqual(warm.bob, baseline.bob, "warm second viewer ≢ flag-off");

    // Exactly one replay served all four flag-on reads.
    assert.equal(snapshotStore.__counters.requestReplays, 1);
  });

  it("matches on a TEAM race (the teams block is shared, not per-viewer)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await disableRedis();
    await setFlag(false);

    const alice = await createUser("TeamAlice");
    const bob = await createUser("TeamBob");
    const raceId = await createTeamRace(alice, bob, "TeamParity");
    await postSamples(alice, [sampleAt(6, 2200)]);
    await postSamples(bob, [sampleAt(6, 1100)]);

    await progress(alice, raceId);
    const baseline = await progress(alice, raceId);
    assert.ok(baseline.teams, "fixture must produce a teams block");

    await enableRedis();
    await setFlag(true);
    assert.deepEqual(await progress(alice, raceId), baseline);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 4 — the write-back is GONE, totals still converge, settlement matches.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — §8 test 4 (zero request-path participant writes)", () => {
  it("N concurrent polls issue no race_participants UPDATE, and the enqueued job converges the totals", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("W4Alice");
    const bob = await createUser("W4Bob");
    const raceId = await createActiveRace(alice, [bob], "WriteRemoval");
    await postSamples(alice, [sampleAt(6, 3000), sampleAt(5, 2500)]);
    await postSamples(bob, [sampleAt(6, 1800)]);

    // The sync path enqueues; drain it so the "before" row state is settled and
    // any subsequent movement can only have come from the endpoint.
    await drain();
    await probe.flushdb();
    snapshotStore.__resetCounters();

    const before = await participantRows(raceId);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        progress(i % 2 === 0 ? alice : bob, raceId)
      )
    );
    assert.equal(responses.length, 12);
    for (const r of responses) assert.equal(r.raceId, raceId);

    // The instrumented counter that pins the removal: the endpoint's
    // `updateTotalSteps` loop never ran.
    assert.equal(
      snapshotStore.__counters.writeBacks,
      0,
      "the endpoint must issue zero participant write-backs"
    );
    // …and the rows themselves are untouched, `totalsUpdatedAt` included.
    const after = await participantRows(raceId);
    assert.deepEqual(after, before, "no race_participants row may have moved");

    // Convergence: the poll enqueued the viewed race, so the worker persists.
    await postSamples(alice, [sampleAt(4, 4000)]);
    await progress(alice, raceId);
    await drain();
    const converged = await participantRows(raceId);
    const aliceRow = converged.find((r) => r.userId === alice.userId);
    assert.ok(
      aliceRow.totalSteps > before.find((r) => r.userId === alice.userId).totalSteps,
      "persisted totals must keep converging via the enqueued job"
    );
  });

  it("a full expiry -> completeRace settlement matches a flag-off control race", async (t) => {
    if (skipReason) return t.skip(skipReason);

    async function lifecycle({ cached }) {
      await cleanDatabase();
      await prisma.appSetting.deleteMany({});
      appSettings.bustCache();
      if (cached) {
        await enableRedis();
        await setFlag(true);
      } else {
        await disableRedis();
        await setFlag(false);
      }

      const alice = await createUser("SAlice");
      const bob = await createUser("SBob");
      const cara = await createUser("SCara");
      const raceId = await createActiveRace(alice, [bob, cara], "Settle");

      await postSamples(alice, [sampleAt(6, 3000), sampleAt(5, 2500)]);
      await postSamples(bob, [sampleAt(6, 1800), sampleAt(5, 1500)]);
      await postSamples(cara, [sampleAt(6, 900), sampleAt(5, 700)]);

      // Watchers poll — the behaviour under test.
      for (const u of [alice, bob, cara]) await progress(u, raceId);
      await drain();

      await prisma.race.update({
        where: { id: raceId },
        data: { endsAt: new Date(Date.now() - 60 * 1000) },
      });
      await resolveExpiredRaces();

      const rows = await prisma.raceParticipant.findMany({
        where: { raceId },
        orderBy: { placement: "asc" },
        select: { userId: true, placement: true, totalSteps: true },
      });
      const names = new Map(
        [alice, bob, cara].map((u) => [u.userId, u.displayName])
      );
      const coins = [];
      for (const u of [alice, bob, cara]) {
        const row = await prisma.user.findUnique({
          where: { id: u.userId },
          select: { coins: true },
        });
        coins.push([u.displayName, row.coins]);
      }
      return {
        standings: rows.map((r) => ({
          name: names.get(r.userId),
          placement: r.placement,
          totalSteps: r.totalSteps,
        })),
        coins: coins.sort(),
      };
    }

    const control = await lifecycle({ cached: false });
    const cached = await lifecycle({ cached: true });
    assert.deepEqual(cached, control, "settlement diverged with C3 on");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 5 — STAMPEDE. Exactly one replay; losers never run it.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — §8 test 5 (stampede)", () => {
  it("20 concurrent cold requests produce exactly ONE replay and 20 valid responses", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("StampAlice");
    const bob = await createUser("StampBob");
    const raceId = await createActiveRace(alice, [bob], "Stampede");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await postSamples(bob, [sampleAt(6, 1200)]);
    await drain();

    await probe.flushdb();
    snapshotStore.__resetCounters();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => progressRes(alice, raceId))
    );

    for (const res of results) assert.equal(res.status, 200);
    const bodies = await Promise.all(results.map((r) => r.json()));
    for (const body of bodies) {
      const p = body.progress;
      // Every response is the full contract shape — whether it came from the
      // snapshot or from the cheap persisted fallback.
      assert.equal(p.raceId, raceId);
      assert.equal(p.status, "ACTIVE");
      assert.equal(p.participants.length, 2);
      assert.ok(Object.prototype.hasOwnProperty.call(p, "myPlacement"));
      assert.ok(p.powerupData && p.powerupData.enabled === true);
    }

    assert.equal(
      snapshotStore.__counters.requestReplays,
      1,
      "the expensive replay must run exactly once across the stampede"
    );
    // Every non-winner was served either the snapshot or the fallback — the
    // three counters must account for all 20 requests and nothing else.
    const c = snapshotStore.__counters;
    assert.equal(
      c.requestReplays + c.snapshotHits + c.staleServes + c.persistedFallbacks,
      20,
      `unaccounted requests: ${JSON.stringify(c)}`
    );
    assert.equal(c.writeBacks, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 5b — two-viewer isolation + the allowlist regression guard.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — §8 test 5b (viewer isolation)", () => {
  it("B's myPlacement/box/dropOdds are B's, never A's, off one warm snapshot", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("IsoAlice");
    const bob = await createUser("IsoBob");
    const raceId = await createActiveRace(alice, [bob], "Isolation");
    await postSamples(alice, [sampleAt(6, 5200)]);
    await postSamples(bob, [sampleAt(6, 900)]);
    await drain();
    await probe.flushdb();
    snapshotStore.__resetCounters();

    const a = await progress(alice, raceId); // installs the snapshot
    const b = await progress(bob, raceId); // reads the SAME snapshot

    assert.equal(snapshotStore.__counters.requestReplays, 1, "B must not replay");

    assert.equal(a.myPlacement, 1);
    assert.equal(b.myPlacement, 2);
    assert.notEqual(a.myPlacement, b.myPlacement);

    assert.equal(a.powerupData.dropOdds.position, 1);
    assert.equal(b.powerupData.dropOdds.position, 2);

    // Box countdown is per-viewer state read from that viewer's own row.
    assert.notEqual(
      a.powerupData.stepsUntilNextPowerup,
      b.powerupData.stepsUntilNextPowerup
    );
  });

  it("the stored snapshot contains NO requester-specific field (pinned allowlist)", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("AllowAlice");
    const bob = await createUser("AllowBob");
    const raceId = await createActiveRace(alice, [bob], "Allowlist");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await grantAndUse(alice, raceId, "RUNNERS_HIGH");
    await drain();
    await probe.flushdb();
    await progress(alice, raceId);

    const stored = await rawSnapshot(raceId);
    assert.ok(stored, "the lock winner must have installed a snapshot");

    // Iterate the REAL keys of the REAL stored payload against the pinned list.
    for (const key of Object.keys(stored)) {
      assert.ok(
        snapshotStore.SNAPSHOT_FIELDS.includes(key),
        `snapshot.${key} is not on the pinned allowlist`
      );
    }
    for (const key of Object.keys(stored.race)) {
      assert.ok(
        snapshotStore.SNAPSHOT_RACE_FIELDS.includes(key),
        `snapshot.race.${key} is not on the pinned allowlist`
      );
    }
    for (const p of stored.participants) {
      for (const key of Object.keys(p)) {
        assert.ok(
          snapshotStore.SNAPSHOT_PARTICIPANT_FIELDS.includes(key),
          `snapshot.participants[].${key} is not on the pinned allowlist`
        );
      }
    }
    for (const e of stored.activeEffects) {
      for (const key of Object.keys(e)) {
        assert.ok(
          snapshotStore.SNAPSHOT_EFFECT_FIELDS.includes(key),
          `snapshot.activeEffects[].${key} is not on the pinned allowlist`
        );
      }
    }
    // And the named requester fields are absent anywhere in the serialized blob.
    const blob = JSON.stringify(stored);
    for (const forbidden of ["myPlacement", "dropOdds", "powerupData", "queuedBoxCount"]) {
      assert.ok(
        !blob.includes(`"${forbidden}"`),
        `snapshot leaks the requester-specific field ${forbidden}`
      );
    }
    // The embedded freshness marker the soft/physical TTL split depends on.
    assert.ok(stored.asOf, "snapshot must embed asOf");
    assert.equal(stored.scoringTimeZone, "UTC");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 5e — Redis fully down, flag ON.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — §8 test 5e (Redis down, flag on)", () => {
  it("every request serves the cheap persisted read and the replay never runs", async (t) => {
    if (skipReason) return t.skip(skipReason);

    // Seed and warm with a WORKING Redis, then pull the rug.
    await enableRedis();
    await setFlag(true);
    const alice = await createUser("DownAlice");
    const bob = await createUser("DownBob");
    const raceId = await createActiveRace(alice, [bob], "RedisDown");
    await postSamples(alice, [sampleAt(6, 3100)]);
    await postSamples(bob, [sampleAt(6, 1400)]);
    await drain(); // persisted columns now hold real totals

    // Point at a port with nothing on it: `REDIS_URL` is SET (so the flag stays
    // on) but every command fails. This is the outage case, not the kill switch.
    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await cache.close();
    derivedCache.reset();
    snapshotStore.__resetCounters();

    const bodies = [];
    for (let i = 0; i < 6; i++) bodies.push(await progress(alice, raceId));

    for (const p of bodies) {
      assert.equal(p.raceId, raceId);
      assert.equal(p.status, "ACTIVE");
      assert.equal(p.participants.length, 2);
      // Contract shape, not deep-equality with the replay: the degradation to
      // persisted freshness is the design (spec §8 test 1, C3 carve-out).
      assert.equal(typeof p.myPlacement, "number");
      assert.ok(p.powerupData.enabled);
      const persisted = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: alice.userId },
        select: { totalSteps: true },
      });
      const row = p.participants.find((x) => x.userId === alice.userId);
      assert.equal(row.totalSteps, persisted.totalSteps);
    }

    assert.equal(
      snapshotStore.__counters.requestReplays,
      0,
      "the replay must NEVER run in the request path with Redis down"
    );
    assert.equal(snapshotStore.__counters.persistedFallbacks, 6);
    assert.equal(snapshotStore.__counters.writeBacks, 0);

    await enableRedis();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 test 3 — invalidation at the write seams.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — invalidation hooks", () => {
  it("using a powerup DELs the snapshot, and the next read reflects the effect", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("InvAlice");
    const bob = await createUser("InvBob");
    const raceId = await createActiveRace(alice, [bob], "Invalidate");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await postSamples(bob, [sampleAt(6, 1200)]);
    await drain();
    await probe.flushdb();

    const before = await progress(alice, raceId);
    assert.equal(before.powerupData.activeEffects.length, 0);
    assert.ok(await rawSnapshot(raceId), "warm snapshot expected");

    await grantAndUse(alice, raceId, "RUNNERS_HIGH");
    assert.equal(
      await rawSnapshot(raceId),
      null,
      "usePowerup must DEL the race's snapshot"
    );

    const after = await progress(alice, raceId);
    assert.equal(after.powerupData.activeEffects.length, 1);
    assert.equal(after.powerupData.activeEffects[0].type, "RUNNERS_HIGH");
  });

  it("forfeiting DELs the snapshot and the next read shows the frozen participant", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    // Forfeiting is a TEAM-race mechanic (individual races reject it).
    const alice = await createUser("FfAlice");
    const bob = await createUser("FfBob");
    const raceId = await createTeamRace(alice, bob, "Forfeit");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await postSamples(bob, [sampleAt(6, 1200)]);
    await drain();
    await probe.flushdb();

    const before = await progress(alice, raceId);
    assert.equal(
      before.participants.find((p) => p.userId === bob.userId).forfeitedAt,
      null
    );

    const res = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
      token: bob.token,
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(await rawSnapshot(raceId), null, "forfeit must DEL the snapshot");

    const after = await progress(alice, raceId);
    assert.ok(
      after.participants.find((p) => p.userId === bob.userId).forfeitedAt,
      "the frozen participant must show as forfeited on the next read"
    );
  });

  it("the worker REPLACES (SET) the snapshot post-commit and never deletes it", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("PubAlice");
    const bob = await createUser("PubBob");
    const raceId = await createActiveRace(alice, [bob], "WorkerPublish");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await postSamples(bob, [sampleAt(6, 1200)]);
    await probe.flushdb();

    await drain();

    const stored = await rawSnapshot(raceId);
    assert.ok(stored, "the worker's post-commit hook must SET the snapshot");
    assert.equal(stored.source, "worker");
    snapshotStore.assertAllowlisted(stored);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Flag OFF — today's behaviour, write-back included.
// ═══════════════════════════════════════════════════════════════════════════

describe("C3 standings — flag off keeps every legacy behaviour", () => {
  it("the endpoint still write-backs participant totals and touches no Redis key", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis(); // Redis IS available — only the flag is off.
    await setFlag(false);

    const alice = await createUser("OffAlice");
    const bob = await createUser("OffBob");
    const raceId = await createActiveRace(alice, [bob], "FlagOff");
    await postSamples(alice, [sampleAt(6, 3300)]);
    await postSamples(bob, [sampleAt(6, 1500)]);

    // Clear whatever the sync path enqueued/persisted, then reset counters.
    await probe.flushdb();
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { totalSteps: 0, totalsUpdatedAt: null },
    });
    snapshotStore.__resetCounters();

    await progress(alice, raceId);

    assert.ok(
      snapshotStore.__counters.writeBacks >= 2,
      "flag off must keep the per-poll write-back"
    );
    const rows = await participantRows(raceId);
    assert.ok(
      rows.every((r) => r.totalSteps > 0 && r.totalsUpdatedAt),
      "flag off must persist totals from the request path"
    );

    assert.equal(
      await rawSnapshot(raceId),
      null,
      "flag off must never publish a snapshot"
    );
    assert.equal(snapshotStore.__counters.requestReplays, 0);
    assert.equal(snapshotStore.__counters.snapshotHits, 0);
  });

  it("works with REDIS_URL unset (Redis-less CI)", async () => {
    await disableRedis();
    await setFlag(true); // flag on, but the wrapper is inert => legacy path

    const alice = await createUser("NoUrlAlice");
    const bob = await createUser("NoUrlBob");
    const raceId = await createActiveRace(alice, [bob], "NoRedisUrl");
    await postSamples(alice, [sampleAt(6, 2100)]);

    const p = await progress(alice, raceId);
    assert.equal(p.raceId, raceId);
    assert.ok(snapshotStore.__counters.writeBacks >= 1);
    assert.equal(snapshotStore.__counters.requestReplays, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Spec v9 item 2 — the mystery-box TOAST survives the write-back removal.
//
// `newMysteryBoxes`/`newQueuedBoxes` are a DELTA ("minted by this call"), and
// Phase D moved the minting to the worker. Without the recent-mints key those
// fields would be permanently empty and the race-detail toast would silently
// die. The worker records; the overlay consumes, atomically, per race.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arm the box gate below the user's raw total and run the worker, so the
 * worker's `syncRacePowerupState` provably mints exactly one mystery box.
 */
/**
 * Make the WORKER mint exactly one mystery box for `user` in `raceId`.
 *
 * FINDING that shapes this helper: the legacy `/steps` + `/steps/samples`
 * commands still call `syncRacePowerupState` INLINE (C0 removed their
 * `resolveRaceState` call, not their box sync), so posting samples already
 * mints the 2,000-step box and ratchets `nextBoxAtSteps` to 4,000. Those mints
 * were never toasted by `/progress` before C3 either, so they are correctly out
 * of scope here. Parking the gate at 2,500 — a threshold no box row exists for,
 * and below the user's raw total — makes the next resolution the provable
 * minter, which is exactly the case the recent-mints key exists to cover.
 */
async function armBoxAndMint(user, raceId, threshold = 2500) {
  const before = await prisma.racePowerup.count({
    where: { raceId, userId: user.userId },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId, userId: user.userId },
    data: { nextBoxAtSteps: threshold },
  });
  await enqueueRaceResolution({ raceId, userId: user.userId, timeZone: "UTC" });
  await drain();
  const after = await prisma.racePowerup.count({
    where: { raceId, userId: user.userId },
  });
  assert.equal(after - before, 1, "the worker must have minted exactly one box");
}

describe("C3 standings — box-mint toast (spec v9 item 2)", () => {
  it("(a) a worker mint between polls toasts exactly once, then is consumed", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("MintAlice");
    const bob = await createUser("MintBob");
    const raceId = await createActiveRace(alice, [bob], "MintToast");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await postSamples(bob, [sampleAt(6, 900)]);
    await drain();

    // Baseline poll: nothing pending.
    const before = await progress(alice, raceId);
    assert.deepEqual(before.powerupData.newMysteryBoxes, []);
    assert.equal(before.powerupData.newQueuedBoxes, 0);

    await armBoxAndMint(alice, raceId);

    // The toast: same field, same shape, one poll later.
    const toasted = await progress(alice, raceId);
    assert.equal(toasted.powerupData.newMysteryBoxes.length, 1);
    assert.ok(
      toasted.powerupData.newMysteryBoxes[0].id,
      "the box object itself must be carried through, not a stub"
    );
    // …and the box is in the tray, exactly as it would have been before C3
    // (two boxes now: the step-sync one at 2,000 and the worker one at 2,500).
    assert.equal(
      toasted.powerupData.inventory.filter((p) => p.status === "MYSTERY_BOX").length,
      2
    );

    // Consumed: the very next poll must not re-toast it.
    const after = await progress(alice, raceId);
    assert.deepEqual(after.powerupData.newMysteryBoxes, []);
    assert.equal(after.powerupData.newQueuedBoxes, 0);

    // Nothing left pending for this user.
    assert.deepEqual(await recentBoxMints.peek(alice.userId), []);
  });

  it("(b) two CONCURRENT polls toast the mint at most once in total", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("RaceyAlice");
    const bob = await createUser("RaceyBob");
    const raceId = await createActiveRace(alice, [bob], "MintRacey");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await drain();
    await progress(alice, raceId); // warm + drain any pending entry

    await armBoxAndMint(alice, raceId);

    const [p1, p2] = await Promise.all([
      progress(alice, raceId),
      progress(alice, raceId),
    ]);
    const total =
      p1.powerupData.newMysteryBoxes.length + p2.powerupData.newMysteryBoxes.length;
    assert.equal(total, 1, "the Lua consume must be atomic — no double toast");
  });

  it("(c) polling race B never eats race A's pending toast", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("TwoRaceAlice");
    const bob = await createUser("TwoRaceBob");
    const raceA = await createActiveRace(alice, [bob], "MintRaceA");
    const raceB = await createActiveRace(alice, [bob], "MintRaceB");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await drain();
    await progress(alice, raceA);
    await progress(alice, raceB);

    // Mint in A only.
    await armBoxAndMint(alice, raceA);
    assert.equal((await recentBoxMints.peek(alice.userId)).length, 1);

    // A poll of B must leave A's entry alone — a GETDEL here would destroy it.
    const bPoll = await progress(alice, raceB);
    assert.deepEqual(bPoll.powerupData.newMysteryBoxes, []);
    assert.equal(
      (await recentBoxMints.peek(alice.userId)).length,
      1,
      "race B's poll must not consume race A's entry"
    );

    const aPoll = await progress(alice, raceA);
    assert.equal(aPoll.powerupData.newMysteryBoxes.length, 1);
  });

  it("(d) Redis down: empty delta, no error", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis();
    await setFlag(true);

    const alice = await createUser("MintDownAlice");
    const bob = await createUser("MintDownBob");
    const raceId = await createActiveRace(alice, [bob], "MintRedisDown");
    await postSamples(alice, [sampleAt(6, 2600)]);
    await drain();
    await progress(alice, raceId);
    await armBoxAndMint(alice, raceId);

    process.env.REDIS_URL = "redis://127.0.0.1:6399";
    await cache.close();
    derivedCache.reset();

    const res = await progressRes(alice, raceId);
    assert.equal(res.status, 200);
    const p = (await res.json()).progress;
    assert.deepEqual(p.powerupData.newMysteryBoxes, []);
    assert.equal(p.powerupData.newQueuedBoxes, 0);

    await enableRedis();
  });

  it("(e) flag OFF still reports the mint inline and writes no recent-mints key", async (t) => {
    if (skipReason) return t.skip(skipReason);

    await enableRedis(); // Redis available; only the flag is off.
    await setFlag(false);

    const alice = await createUser("MintOffAlice");
    const bob = await createUser("MintOffBob");
    const raceId = await createActiveRace(alice, [bob], "MintFlagOff");
    await postSamples(alice, [sampleAt(6, 2600)]);
    // Park the gate below the raw total at a threshold with no box row (see
    // armBoxAndMint) so the POLL itself is what mints — the legacy behaviour.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: alice.userId },
      data: { nextBoxAtSteps: 2500 },
    });
    await probe.flushdb();

    // The legacy path mints DURING the poll and reports it in the same response.
    const p = await progress(alice, raceId);
    assert.equal(p.powerupData.newMysteryBoxes.length, 1);
    // …and nothing was recorded for later consumption.
    assert.deepEqual(await recentBoxMints.peek(alice.userId), []);
    assert.equal(
      (await probe.keys(`${ENV_PREFIX}v1:user:recentmints:*`)).length,
      0
    );

    // Second poll: the delta is empty because the box already exists — the
    // pre-C3 behaviour, unchanged.
    const p2 = await progress(alice, raceId);
    assert.deepEqual(p2.powerupData.newMysteryBoxes, []);
  });
});
