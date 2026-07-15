// Integration tests: "steps until next box" must track RAW WALKED STEPS only.
// Runner's High, Wrong Turn (and the 2x global step event) move the LEADERBOARD
// total, but they must never move the box countdown or the box-mint gate
// (computeBoxEffectiveSteps in src/utils/boxSteps.js).
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const INTERVAL = 5000;

async function createUser(displayName) {
  const appleId = `apple-box-${++nextAppleId}`;
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
      name: "Box Immunity Test",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: INTERVAL,
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

function minutesFromNow(m) {
  return new Date(Date.now() + m * 60 * 1000);
}

// Backdate the newest ACTIVE effect of `type` so a sample window falls inside it.
async function backdateEffect(raceId, type, startsAt, expiresAt) {
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type },
    orderBy: { startsAt: "desc" },
  });
  await prisma.raceActiveEffect.update({
    where: { id: effect.id },
    data: { startsAt, expiresAt },
  });
}

// Boxes minted for this user in this race (in-slot or queued).
async function mintedBoxCount(raceId, userId) {
  return prisma.racePowerup.count({
    where: { raceId, userId, status: { in: ["MYSTERY_BOX", "QUEUED"] } },
  });
}

describe("box progress immune to step-multiplier effects", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
    await prisma.globalStepEvent.deleteMany();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.globalStepEvent.deleteMany();
    nextAppleId = 0;
  });

  it("baseline: countdown reflects raw walked steps", async () => {
    const alice = await createUser("AliceBoxAAAA");
    const bob = await createUser("BobBoxAAAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await recordSamples(alice.token, [
      { periodStart: hoursAgo(6).toISOString(), periodEnd: hoursAgo(5).toISOString(), steps: 2000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(progress.powerupData.stepsUntilNextPowerup, INTERVAL - 2000);
  });

  it("Runner's High + Wrong Turn active: countdown unchanged even when leaderboard total is zeroed", async () => {
    const alice = await createUser("AliceBoxBBBB");
    const bob = await createUser("BobBoxBBBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // 2,000 raw steps before any effect
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(6).toISOString(), periodEnd: hoursAgo(5).toISOString(), steps: 2000 },
    ]);

    // Both effects active on Alice over the same 2h window
    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
    await usePowerup(alice.token, raceId, rh.id);
    await backdateEffect(raceId, "RUNNERS_HIGH", hoursAgo(2), minutesFromNow(60));

    const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99902);
    await usePowerup(bob.token, raceId, wt.id, alice.userId);
    await backdateEffect(raceId, "WRONG_TURN", hoursAgo(2), minutesFromNow(60));

    // 1,000 raw steps inside both effect windows → raw total 3,000
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Leaderboard: 3000 base + (1000 - 2*1000) buffed - 2*1000 reversed = 0
    assert.equal(aliceP.totalSteps, 0, "effects really applied to the leaderboard");
    // Box countdown: raw 3,000 walked → 2,000 to go. NOT clamped/ratcheted by
    // the doubling or the reversal.
    assert.equal(progress.powerupData.stepsUntilNextPowerup, INTERVAL - 3000);
  });

  it("Runner's High alone: doubled leaderboard steps do not shrink the countdown or mint a box", async () => {
    const alice = await createUser("AliceBoxCCCC");
    const bob = await createUser("BobBoxCCCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await recordSamples(alice.token, [
      { periodStart: hoursAgo(6).toISOString(), periodEnd: hoursAgo(5).toISOString(), steps: 2000 },
    ]);

    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
    await usePowerup(alice.token, raceId, rh.id);
    await backdateEffect(raceId, "RUNNERS_HIGH", hoursAgo(2), minutesFromNow(60));

    // 1,500 raw in the buff → leaderboard 2000 + 3000 = 5000 (crosses the
    // interval if buffed steps counted), raw only 3,500 (does not cross)
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1500 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    assert.equal(aliceP.totalSteps, 5000, "leaderboard shows the doubled steps");
    assert.equal(progress.powerupData.stepsUntilNextPowerup, INTERVAL - 3500);
    assert.equal(
      await mintedBoxCount(raceId, alice.userId),
      0,
      "no box minted off buffed steps"
    );
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(participant.nextBoxAtSteps, INTERVAL, "gate did not ratchet");
  });

  it("Wrong Turn alone: reversed leaderboard steps do not inflate the countdown", async () => {
    const alice = await createUser("AliceBoxDDDD");
    const bob = await createUser("BobBoxDDDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await recordSamples(alice.token, [
      { periodStart: hoursAgo(6).toISOString(), periodEnd: hoursAgo(5).toISOString(), steps: 2000 },
    ]);

    const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99901);
    await usePowerup(bob.token, raceId, wt.id, alice.userId);
    await backdateEffect(raceId, "WRONG_TURN", hoursAgo(2), minutesFromNow(60));

    // 1,000 raw while reversed → leaderboard 3000 - 2000 = 1000, raw 3,000
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    assert.equal(aliceP.totalSteps, 1000, "leaderboard shows the reversal");
    // Countdown keeps counting the walked 3,000 — walking during a Wrong Turn
    // still earns box progress (raw steps only).
    assert.equal(progress.powerupData.stepsUntilNextPowerup, INTERVAL - 3000);
  });

  it("2x global event: boosted leaderboard steps do not shrink the countdown or mint a box", async () => {
    const alice = await createUser("AliceBoxEEEE");
    const bob = await createUser("BobBoxEEEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await recordSamples(alice.token, [
      { periodStart: hoursAgo(6).toISOString(), periodEnd: hoursAgo(5).toISOString(), steps: 2000 },
    ]);

    await prisma.globalStepEvent.create({
      data: {
        startsAt: hoursAgo(2),
        endsAt: minutesFromNow(30),
        multiplier: 2,
        label: "test 2x event",
      },
    });

    // 1,500 raw inside the event → leaderboard 2000 + 3000 = 5000, raw 3,500
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1500 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    assert.equal(aliceP.totalSteps, 5000, "leaderboard shows the event boost");
    assert.equal(progress.powerupData.stepsUntilNextPowerup, INTERVAL - 3500);
    assert.equal(await mintedBoxCount(raceId, alice.userId), 0);
  });

  it("really walking across the interval still mints exactly one box under Runner's High", async () => {
    const alice = await createUser("AliceBoxFFFF");
    const bob = await createUser("BobBoxFFFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const rh = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
    await usePowerup(alice.token, raceId, rh.id);
    await backdateEffect(raceId, "RUNNERS_HIGH", hoursAgo(3), minutesFromNow(60));

    // 6,000 raw inside the buff: raw crosses 5,000 once; the doubled
    // leaderboard total (12,000) would have crossed twice.
    await recordSamples(alice.token, [
      { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 6000 },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    assert.equal(aliceP.totalSteps, 12000);
    assert.equal(
      await mintedBoxCount(raceId, alice.userId),
      1,
      "exactly one box — raw steps crossed one interval, buffed total would be two"
    );
    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(participant.nextBoxAtSteps, 2 * INTERVAL, "gate advanced by one interval only");
    assert.equal(progress.powerupData.stepsUntilNextPowerup, 2 * INTERVAL - 6000);
  });
});
