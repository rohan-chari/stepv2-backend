// Integration tests: Trail Mine targeting.
//
// Expected behavior (per triggerTrailMines in raceStateResolution.js): the mine
// is planted at the owner's current step total; the FIRST runner (other than
// the owner) whose total CROSSES that point on a later step sync triggers it,
// and when several cross in the same resolution the one closest past the mine
// (lowest new total) is hit. Runners already ahead at plant time never trigger.
//
// The last two tests are INVESTIGATIVE: they document that the mine is planted
// at the owner's last-STORED total (participant.totalSteps at plant time), not
// their real walked position — so if the owner's own sync is stale, the mine
// lands behind them and can immediately hit a runner who is far behind the
// owner's true position. This is the likely mechanism behind "my mine hit
// someone way behind me".
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-tm-${++nextAppleId}`;
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
      name: "Trail Mine Test",
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
  // Backdate so samples recorded hours ago fall within the race window
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

// Syncing through the route triggers resolveRaceState → totals stored +
// trail mines evaluated. This is "a step sync" from the user's phone.
async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

// Inserting rows directly does NOT resolve the race — simulates steps the
// user has walked but not yet synced (stale stored totals).
async function insertSamplesDirect(userId, samples) {
  for (const s of samples) {
    await prisma.stepSample.create({
      data: { userId, periodStart: s.periodStart, periodEnd: s.periodEnd, steps: s.steps },
    });
  }
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

function findUser(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

function sample(fromHoursAgo, toHoursAgo, steps) {
  return {
    periodStart: hoursAgo(fromHoursAgo).toISOString(),
    periodEnd: hoursAgo(toHoursAgo).toISOString(),
    steps,
  };
}

async function getMine(raceId) {
  return prisma.raceActiveEffect.findFirst({ where: { raceId, type: "TRAIL_MINE" } });
}

// Trigger events carry metadata.penalty; the plant event does not.
async function mineTriggerEvents(raceId) {
  const events = await prisma.racePowerupEvent.findMany({
    where: { raceId, powerupType: "TRAIL_MINE" },
    orderBy: { createdAt: "asc" },
  });
  return events.filter((e) => e.metadata && typeof e.metadata.penalty === "number");
}

describe("trail mine targeting", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("the runner whose sync crosses the mine point is hit for 3% of their total", async () => {
    const alice = await createUser("AliceMineAAA");
    const bob = await createUser("BobMineAAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Alice at 10,000 (synced), Bob at 1,000 (synced)
    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);

    const planted = await getMine(raceId);
    assert.equal(planted.metadata.positionSteps, 10000, "mine planted at Alice's total");
    assert.equal(planted.metadata.penaltyPercent, 0.03);

    // Bob's next sync carries him past the mine: 1,000 → 13,000
    await recordSamples(bob.token, [sample(4, 3, 12000)]);

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "exactly one trigger event");
    assert.equal(triggers[0].targetUserId, bob.userId);
    // 3% of Bob's total at the crossing (13,000) = 390
    assert.equal(triggers[0].metadata.penalty, 390);
    assert.equal(triggers[0].metadata.blocked, false);

    const after1 = await getMine(raceId);
    assert.equal(after1.status, "EXPIRED", "mine is consumed");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, bob.userId).totalSteps, 13000 - 390);
    assert.equal(findUser(progress, alice.userId).totalSteps, 10000, "owner unaffected");
  });

  it("a runner who stays behind the mine point is NOT hit", async () => {
    const alice = await createUser("AliceMineBBB");
    const bob = await createUser("BobMineBBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // Bob walks, but only to 3,000 — still behind the 10,000 mine
    await recordSamples(bob.token, [sample(4, 3, 2000)]);

    assert.equal((await mineTriggerEvents(raceId)).length, 0, "no trigger");
    assert.equal((await getMine(raceId)).status, "ACTIVE", "mine still armed");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, bob.userId).totalSteps, 3000, "no penalty");
  });

  it("a runner already ahead of the mine when it is planted never triggers it", async () => {
    const alice = await createUser("AliceMineCCC");
    const bob = await createUser("BobMineCCCCC");
    const dave = await createUser("DaveMineCCCC");
    await makeFriends(alice, bob);
    await makeFriends(alice, dave);
    const raceId = await createActiveRace(alice, [bob, dave]);

    // Dave 12,000 > Alice 10,000 > Bob 1,000 (Alice is not last, so she can plant)
    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(dave.token, [sample(6, 5, 12000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);
    assert.equal((await getMine(raceId)).metadata.positionSteps, 10000);

    // Dave (already past the mine) keeps walking
    await recordSamples(dave.token, [sample(4, 3, 1000)]);

    assert.equal((await mineTriggerEvents(raceId)).length, 0);
    assert.equal((await getMine(raceId)).status, "ACTIVE");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, dave.userId).totalSteps, 13000, "Dave untouched");
  });

  it("when two runners cross in the same resolution, the one closest past the mine is hit (single use)", async () => {
    const alice = await createUser("AliceMineDDD");
    const bob = await createUser("BobMineDDDDD");
    const carol = await createUser("CarolMineDDD");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    await recordSamples(alice.token, [sample(6, 5, 10000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);
    await recordSamples(carol.token, [sample(6, 5.5, 1000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // Both cross the 10,000 mine in the SAME resolution: insert their walked
    // steps directly (no resolve), then let one sync trigger the resolution.
    await insertSamplesDirect(bob.userId, [sample(4, 3, 14000)]); // → 15,000
    await insertSamplesDirect(carol.userId, [sample(4, 3, 11000)]); // → 12,000
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(20).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 10 },
    ]);

    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1, "mine fires exactly once");
    assert.equal(
      triggers[0].targetUserId,
      carol.userId,
      "Carol (12,000) is closer past the 10,000 mine than Bob (15,000)"
    );
    assert.equal(triggers[0].metadata.penalty, Math.round(12000 * 0.03));
    assert.equal((await getMine(raceId)).status, "EXPIRED");

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, carol.userId).totalSteps, 12000 - 360);
    assert.equal(findUser(progress, bob.userId).totalSteps, 15000, "Bob untouched");
  });

  it("cannot plant while in last place", async () => {
    const alice = await createUser("AliceMineEEE");
    const bob = await createUser("BobMineEEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    await recordSamples(alice.token, [sample(6, 5, 1000)]);
    await recordSamples(bob.token, [sample(6, 5, 10000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 400);
    assert.equal(await getMine(raceId), null);
  });

  // ------------------------------------------------------------------
  // REGRESSION — usePowerup resolves race state BEFORE planting, so a stale
  // stored total can't place the mine behind the owner's real position (the
  // old behavior instantly hit runners far behind the owner).
  // ------------------------------------------------------------------

  it("mine is planted at the owner's REAL walked position even when their stored total is stale", async () => {
    const alice = await createUser("AliceMineFFF");
    const bob = await createUser("BobMineFFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Stored totals: Alice 2,000, Bob 1,000
    await recordSamples(alice.token, [sample(6, 5.5, 2000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);

    // Alice has really walked 10,000 but her phone hasn't synced the last 8,000
    await insertSamplesDirect(alice.userId, [sample(5, 4, 8000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    const res = await usePowerup(alice.token, raceId, mine.id);
    assert.equal(res.status, 200);

    // usePowerup resolves race state before planting, so the mine lands at
    // Alice's real 10,000 — not the stale stored 2,000.
    const planted = await getMine(raceId);
    assert.equal(
      planted.metadata.positionSteps,
      10000,
      "mine placed at the owner's real position, not the stale stored total"
    );
  });

  it("a stale owner sync never detonates the mine on a runner far behind the owner", async () => {
    const alice = await createUser("AliceMineGGG");
    const bob = await createUser("BobMineGGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Stored: Alice 2,000, Bob 1,000. Real (unsynced): Alice 10,000, Bob 5,000.
    await recordSamples(alice.token, [sample(6, 5.5, 2000)]);
    await recordSamples(bob.token, [sample(6, 5.5, 1000)]);
    await insertSamplesDirect(alice.userId, [sample(5, 4, 8000)]);
    await insertSamplesDirect(bob.userId, [sample(5, 4, 4000)]);

    const mine = await giveHeldPowerup(raceId, alice.userId, "TRAIL_MINE", 99901);
    await usePowerup(alice.token, raceId, mine.id);

    // Pre-plant resolve puts the mine at Alice's real 10,000 and refreshes
    // Bob to 5,000 — still behind the mine, so nothing detonates. (Before the
    // fix the mine landed at the stale 2,000 and hit Bob in the same request.)
    assert.equal((await mineTriggerEvents(raceId)).length, 0, "no instant detonation");
    const planted = await getMine(raceId);
    assert.equal(planted.status, "ACTIVE");
    assert.equal(planted.metadata.positionSteps, 10000);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(findUser(progress, alice.userId).totalSteps, 10000);
    assert.equal(findUser(progress, bob.userId).totalSteps, 5000, "Bob unharmed");

    // Bob later genuinely crossing the mine still triggers it normally
    await recordSamples(bob.token, [sample(3, 2, 6000)]); // 5,000 → 11,000
    const triggers = await mineTriggerEvents(raceId);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].targetUserId, bob.userId);
    assert.equal(triggers[0].metadata.penalty, Math.round(11000 * 0.03));
  });
});
