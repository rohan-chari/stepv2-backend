// Leech granularity generalization (spec §3.4 / §7 item 4).
//
// The Leech clamp used to exclude the whole in-progress HOUR bucket. It now
// prorates only samples whose periodEnd <= now (exclude any not-yet-closed
// bucket, whatever its size). With 5-min buckets the transfer credits closed
// 5-min buckets of the leecher's walking within the current hour — steps the old
// hour clamp would have wholly deferred — while still excluding a bucket that
// straddles `now`, and stays monotonic as buckets close.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-leechgran-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Leech granularity",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function seedSample(userId, startMs, endMs, steps) {
  return prisma.stepSample.create({
    data: {
      userId,
      periodStart: new Date(startMs),
      periodEnd: new Date(endMs),
      steps,
    },
  });
}

// LEECH effect: alice (leecher/source) drains bob (victim/target).
async function seedLeech(raceId, alice, bob, startsAt, expiresAt) {
  const victimP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
  const backing = await prisma.racePowerup.create({
    data: { raceId, participantId: victimP.id, userId: bob.userId, type: "LEECH", rarity: "UNCOMMON", status: "USED" },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: victimP.id,
      targetUserId: bob.userId,
      sourceUserId: alice.userId,
      powerupId: backing.id,
      type: "LEECH",
      status: "ACTIVE",
      startsAt,
      expiresAt,
      metadata: { ratio: 2, scoringVersion: 2 },
    },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}
function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

const MIN = 60 * 1000;

describe("leech granularity — closed-bucket generalization", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  it("credits closed 5-min buckets and excludes a bucket straddling now", async () => {
    const alice = await createUser("LeechAlice");
    const bob = await createUser("LeechBob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const now = Date.now();
    // Leech active: started 35 min ago, expires 40 min in the future.
    await seedLeech(raceId, alice, bob, new Date(now - 35 * MIN), new Date(now + 40 * MIN));

    // Leecher (alice) closed 5-min buckets — all periodEnd <= now, all inside the
    // current hour that the OLD hour-clamp would have deferred entirely.
    await seedSample(alice.userId, now - 30 * MIN, now - 25 * MIN, 500);
    await seedSample(alice.userId, now - 25 * MIN, now - 20 * MIN, 500);
    await seedSample(alice.userId, now - 20 * MIN, now - 15 * MIN, 500);
    await seedSample(alice.userId, now - 15 * MIN, now - 10 * MIN, 500);
    // A bucket straddling `now` (periodEnd in the future) — must be excluded.
    await seedSample(alice.userId, now - 3 * MIN, now + 7 * MIN, 2000);

    // Victim (bob) has plenty of drainable balance from an old closed bucket.
    await seedSample(bob.userId, now - 5 * 60 * MIN, now - 4 * 60 * MIN, 10000);

    const progress = await getProgress(bob.token, raceId);
    const bobP = findUser(progress, bob.userId);
    // Closed leecher steps = 2000 -> earnedTransfer = floor(2000/2) = 1000.
    // The straddling bucket (2000) is EXCLUDED, so bob is drained by exactly 1000.
    assert.equal(bobP.totalSteps, 10000 - 1000);
  });

  it("is monotonic: as the straddling bucket closes, the transfer does not shrink", async () => {
    const alice = await createUser("LeechAlice2");
    const bob = await createUser("LeechBob2");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const now = Date.now();
    await seedLeech(raceId, alice, bob, new Date(now - 35 * MIN), new Date(now + 40 * MIN));
    await seedSample(alice.userId, now - 30 * MIN, now - 25 * MIN, 500);
    await seedSample(alice.userId, now - 25 * MIN, now - 20 * MIN, 500);
    await seedSample(alice.userId, now - 20 * MIN, now - 15 * MIN, 500);
    await seedSample(alice.userId, now - 15 * MIN, now - 10 * MIN, 500);
    const straddler = await seedSample(alice.userId, now - 3 * MIN, now + 7 * MIN, 2000);
    await seedSample(bob.userId, now - 5 * 60 * MIN, now - 4 * 60 * MIN, 10000);

    const first = findUser(await getProgress(bob.token, raceId), bob.userId).totalSteps;

    // The straddling bucket matures into a closed bucket (periodEnd now in the
    // past) — as would happen on the next sync. Its steps now count.
    await prisma.stepSample.update({
      where: { id: straddler.id },
      data: { periodEnd: new Date(Date.now() - 1000) },
    });

    const second = findUser(await getProgress(bob.token, raceId), bob.userId).totalSteps;
    // Victim's total is non-increasing (the leech transfer is non-decreasing).
    assert.ok(second <= first, `transfer must not shrink: first drain->${first}, second->${second}`);
    assert.ok(second < first, "the now-closed bucket increases the transfer");
  });
});
