// Integration proof for Phase C4: the per-race advisory lock inside
// resolveRaceState serializes concurrent full-field reconciliations on the SAME
// race, so a trail mine that a victim crosses fires EXACTLY ONCE even when the
// legacy /steps path (resolveRaceState({userId})), placementRecompute
// (resolveRaceState({raceId})), and the durable worker (resolveRaceState({raceId}))
// all run at the same instant. Without the lock these interleave and the mine
// double-fires (duplicate POWERUP_USED event + double penalty). WITH the lock the
// second actor re-reads the effect as EXPIRED and skips — one serialized outcome.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { resolveRaceState } = require("../../src/services/raceStateResolution");
const { withRaceResolutionLock } = require("../../src/services/withRaceResolutionLock");
const crypto = require("node:crypto");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let nextAppleId = 0;
const TZ = "America/New_York";

async function createUser(displayName) {
  const appleId = `apple-lock-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Lock Test",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
  const start = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}
function sample(fromH, toH, steps) {
  return { periodStart: hoursAgo(fromH).toISOString(), periodEnd: hoursAgo(toH).toISOString(), steps };
}
async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", { body: { samples }, token });
}
async function insertSamplesDirect(userId, samples) {
  for (const s of samples) {
    await prisma.stepSample.create({
      data: { userId, periodStart: s.periodStart, periodEnd: s.periodEnd, steps: s.steps },
    });
  }
}
async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: participant.id, userId, type, rarity: "RARE", status: "HELD", earnedAtSteps },
  });
}
async function getMine(raceId) {
  return prisma.raceActiveEffect.findFirst({ where: { raceId, type: "TRAIL_MINE" } });
}
async function mineTriggerEvents(raceId) {
  const events = await prisma.racePowerupEvent.findMany({
    where: { raceId, powerupType: "TRAIL_MINE" },
    orderBy: { createdAt: "asc" },
  });
  return events.filter((e) => e.metadata && typeof e.metadata.penalty === "number");
}

// Build a race where `bob` has UNSYNCED steps carrying him from a stored total of
// 1,000 to a real 15,000, past a mine planted at alice's 10,000. Returns raceId
// + bob's userId so the caller can fire concurrent reconciliations.
async function seedCrossingScenario() {
  const alice = await createUser(`AliceLock${nextAppleId}`);
  const bob = await createUser(`BobLockAA${nextAppleId}`);
  await makeFriends(alice, bob);
  const raceId = await createActiveRace(alice, [bob]);

  await recordSamples(alice.token, [sample(6, 5, 10000)]);
  await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

  const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
  const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${mine.id}/use`, {
    body: {},
    token: alice.token,
  });
  assert.equal(res.status, 200);
  assert.equal((await getMine(raceId)).metadata.positionSteps, 10000);

  // Bob's real (unsynced) crossing steps: stored stays 1,000, computed = 15,000.
  await insertSamplesDirect(bob.userId, [sample(4, 3, 14000)]);

  return { raceId, bobUserId: bob.userId };
}

// Deterministic proof of the lock PRIMITIVE that every full-reconciliation path
// (legacy sync, placementRecompute, usePowerup, worker — all via resolveRaceState
// which wraps each race in withRaceResolutionLock) shares. A behavioral end-to-end
// race is timing-dependent (node may schedule the two chains sequentially), so we
// prove the mechanism directly: same-race callbacks are mutually exclusive;
// different-race callbacks overlap.
describe("Phase C4 — withRaceResolutionLock mutual exclusion (the shared primitive)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  it("two concurrent locks on the SAME race id run strictly non-overlapping", async () => {
    const raceId = crypto.randomUUID();
    const order = [];
    const critical = (tag) =>
      withRaceResolutionLock(raceId, async () => {
        order.push(`${tag}:enter`);
        await sleep(120);
        order.push(`${tag}:exit`);
      });

    await Promise.all([critical("A"), critical("B")]);

    // Whoever enters first must EXIT before the other enters (no interleave).
    const firstTag = order[0].split(":")[0];
    assert.equal(order[0], `${firstTag}:enter`);
    assert.equal(order[1], `${firstTag}:exit`, "same-race section is serialized");
    assert.equal(order.length, 4);
  });

  it("two concurrent locks on DIFFERENT race ids overlap (not globally serialized)", async () => {
    const order = [];
    const critical = (tag) =>
      withRaceResolutionLock(crypto.randomUUID(), async () => {
        order.push(`${tag}:enter`);
        await sleep(120);
        order.push(`${tag}:exit`);
      });

    await Promise.all([critical("A"), critical("B")]);

    // Different locks => both enter before either exits.
    assert.ok(order[0].endsWith("enter") && order[1].endsWith("enter"),
      "different-race sections run concurrently");
  });
});

describe("Phase C4 — per-race advisory lock serializes concurrent full reconciliation", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("legacy /steps path vs worker on the SAME race: trail mine fires exactly once", async () => {
    const { raceId, bobUserId } = await seedCrossingScenario();

    // Fire the legacy primitive ({userId}) and the worker/placement primitive
    // ({raceId}) concurrently on the same race.
    await Promise.all([
      resolveRaceState({ userId: bobUserId, timeZone: TZ }),
      resolveRaceState({ raceId, timeZone: TZ }),
    ]);

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "mine fires exactly once under the lock");
    assert.equal(triggers[0].targetUserId, bobUserId);
    assert.equal((await getMine(raceId)).status, "EXPIRED");
  });

  it("placement vs worker (both {raceId}) plus extra concurrent actors: still exactly one fire", async () => {
    const { raceId, bobUserId } = await seedCrossingScenario();

    // Five concurrent full reconciliations of the same race (placement + worker +
    // retries). The advisory lock serializes them all.
    await Promise.all(
      Array.from({ length: 5 }, () => resolveRaceState({ raceId, timeZone: TZ }))
    );

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "mine fires exactly once despite 5 concurrent reconciliations");
    assert.equal(triggers[0].targetUserId, bobUserId);

    // Penalty applied once: 3% of the crossing total (15,000) = 450.
    assert.equal(triggers[0].metadata.penalty, Math.round(15000 * 0.03));
    assert.equal((await getMine(raceId)).status, "EXPIRED");
  });
});
