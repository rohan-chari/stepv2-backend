// Integration tests: the daily global 2x step event (GlobalStepEvent) must
// actually boost race totals, and must stack sanely with Runner's High /
// Wrong Turn / Leg Cramp. Exercises the display path (GET /races/:id/progress),
// which shares computeEffectModifiers + computeGlobalEventBoost with settlement.
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-gse-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Global Event Test",
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
  // Backdate so samples recorded with minutesAgo/hoursAgo fall within race window
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
      rarity: "UNCOMMON",
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

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
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

function minutesFromNow(m) {
  return new Date(Date.now() + m * 60 * 1000);
}

// The 30-min 2x window the daily scheduler would create.
async function createGlobalEvent({ startsAt, endsAt, multiplier = 2 }) {
  return prisma.globalStepEvent.create({
    data: { startsAt, endsAt, multiplier, label: "test 2x event" },
  });
}

describe("global 2x step event in races", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
    // global_step_events is not in setup.js's TRUNCATE list — clean up so
    // later test files never see a stray active 2x window.
    await prisma.globalStepEvent.deleteMany();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.globalStepEvent.deleteMany();
    nextAppleId = 0;
  });

  it("steps walked during an active 2x event count double in race totals", async () => {
    const alice = await createUser("AliceGseAAAA");
    const bob = await createUser("BobGseAAAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await createGlobalEvent({
      startsAt: minutesAgo(40),
      endsAt: minutesFromNow(20),
    });

    // 1000 steps fully inside the event window
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 1000 base + 1000 event boost = 2000
    assert.equal(aliceP.totalSteps, 2000);

    // The progress payload should also surface the active-event banner
    assert.ok(progress.globalEvent, "progress should include globalEvent while one is active");
    assert.equal(progress.globalEvent.active, true);
    assert.equal(progress.globalEvent.multiplier, 2);
  });

  it("steps outside the event window are not boosted", async () => {
    const alice = await createUser("AliceGseBBBB");
    const bob = await createUser("BobGseBBBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Event ended 90 minutes ago
    await createGlobalEvent({
      startsAt: minutesAgo(120),
      endsAt: minutesAgo(90),
    });

    // 500 steps inside the window, 1000 steps well after it
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(110).toISOString(), periodEnd: minutesAgo(100).toISOString(), steps: 500 },
      { periodStart: minutesAgo(60).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 500*2 (in window) + 1000 (outside, unboosted) = 2000
    assert.equal(aliceP.totalSteps, 2000);
    assert.equal(progress.globalEvent, undefined, "no banner when no event is live");
  });

  it("a sample partially overlapping the window is prorated", async () => {
    const alice = await createUser("AliceGseCCCC");
    const bob = await createUser("BobGseCCCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await createGlobalEvent({
      startsAt: minutesAgo(30),
      endsAt: minutesFromNow(30),
    });

    // 1000 steps spread over the last 60 minutes; only the last 30 overlap the event
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 1000 base + 500 boosted (the in-window half) = 1500
    assert.equal(aliceP.totalSteps, 1500);
  });

  it("stacks multiplicatively with Runner's High (2x buff during 2x event = 4x)", async () => {
    const alice = await createUser("AliceGseDDDD");
    const bob = await createUser("BobGseDDDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Runner's High covering the whole event window
    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
    const res = await usePowerup(alice.token, raceId, rh.id);
    assert.equal(res.status, 200);
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: minutesAgo(50), expiresAt: minutesFromNow(120) },
    });

    await createGlobalEvent({
      startsAt: minutesAgo(40),
      endsAt: minutesFromNow(20),
    });

    // 1000 steps fully inside BOTH windows
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // base 1000 + RH buff 1000 + event boost 1000 * 2(RH) * (2-1) = 2000 → 4000 total (4x)
    assert.equal(aliceP.totalSteps, 4000);
  });

  it("Runner's High steps outside the event window get only the 2x buff, not 4x", async () => {
    const alice = await createUser("AliceGseEEEE");
    const bob = await createUser("BobGseEEEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
    await usePowerup(alice.token, raceId, rh.id);
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "RUNNERS_HIGH" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: hoursAgo(4), expiresAt: minutesFromNow(120) },
    });

    // Event covers only the recent half-hour
    await createGlobalEvent({
      startsAt: minutesAgo(30),
      endsAt: minutesFromNow(30),
    });

    // 1000 steps under RH but BEFORE the event (3h-2h ago),
    // 1000 steps under RH AND inside the event (last 25 min)
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(3).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 1000 },
      { periodStart: minutesAgo(25).toISOString(), periodEnd: minutesAgo(5).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Pre-event: 1000 * 2 (RH only) = 2000
    // In-event:  1000 * 2 (RH) * 2 (event) = 4000
    assert.equal(aliceP.totalSteps, 6000);
  });

  it("frozen steps (Leg Cramp) during the event get no boost", async () => {
    const alice = await createUser("AliceGseFFFF");
    const bob = await createUser("BobGseFFFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const cramp = await giveHeldPowerup(raceId, bob.userId, "LEG_CRAMP", 99901);
    await usePowerup(bob.token, raceId, cramp.id, alice.userId);
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: minutesAgo(50), expiresAt: minutesFromNow(60) },
    });

    await createGlobalEvent({
      startsAt: minutesAgo(40),
      endsAt: minutesFromNow(20),
    });

    // 1000 steps while frozen AND inside the event
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Frozen steps are removed and never boosted: 1000 - 1000 + 0 = 0
    assert.equal(aliceP.totalSteps, 0);
  });

  it("the event boost never amplifies a Wrong Turn reversal", async () => {
    const alice = await createUser("AliceGseGGGG");
    const bob = await createUser("BobGseGGGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99901);
    await usePowerup(bob.token, raceId, wt.id, alice.userId);
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: minutesAgo(50), expiresAt: minutesFromNow(60) },
    });

    await createGlobalEvent({
      startsAt: minutesAgo(40),
      endsAt: minutesFromNow(20),
    });

    // 1000 steps while reversed AND inside the event
    await recordSamples(alice.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(10).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Reversal: 1000 - 2*1000 = -1000. Event boost stays POSITIVE (+1000, its
    // sign deliberately ignores Wrong Turn) → max(0, -1000 + 1000) = 0.
    // Crucially NOT -2000-ish: the 2x event must never double the penalty.
    assert.equal(aliceP.totalSteps, 0);
  });
});
