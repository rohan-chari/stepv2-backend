const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const CAMPFIRE_FREEZE_MS = 30 * 60 * 1000;
const CAMPFIRE_MULTIPLIER_LEVEL_0 = 2.25;
const CAMPFIRE_BOOST_DURATION_MS_LEVEL_0 = 45 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-cfrh-${++nextAppleId}`;
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
      name: "Campfire+RH Test",
      targetSteps: 200000,
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
  // Backdate so step samples in past windows fall within the race window
  const defaultStart = new Date(Date.now() - 8 * 60 * 60 * 1000);
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
      status: "USED",
      earnedAtSteps,
    },
  });
}

async function createExpiredEffect(raceId, userId, sourceUserId, powerupId, type, startsAt, expiresAt, metadata) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: participant.id,
      targetUserId: userId,
      sourceUserId,
      powerupId,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
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

describe("campfire rest + runner's high overlap", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // Runner's High during the Campfire FREEZE phase should NOT cancel the freeze.
  // Spec (per raceStateResolution.js final-result semantics): freeze wins — steps
  // walked during the freeze are subtracted from the race total.
  it("RH overlapping campfire freeze: freeze still subtracts those steps", async () => {
    const alice = await createUser("AliceCFRH_A1");
    const bob = await createUser("BobCFRH_A111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Campfire freeze: 4h ago → 3.5h ago (30 min freeze)
    // Campfire boost: 3.5h ago → 2.75h ago (45 min boost at lvl 0)
    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // Runner's High wholly inside the campfire freeze: 3h55m ago → 3h35m ago (20 min)
    const rhStart = new Date(cfStart.getTime() + 5 * 60 * 1000);
    const rhEnd = new Date(cfStart.getTime() + 25 * 60 * 1000);
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      rhStart, rhEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 1000 steps inside the RH+freeze overlap (3h50m ago → 3h40m ago)
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfStart.getTime() + 10 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfStart.getTime() + 20 * 60 * 1000).toISOString(),
        steps: 1000,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // Spec: 1000 base - 1000 frozen (RH cannot rescue frozen steps) = 0
    assert.equal(
      aliceP.totalSteps,
      0,
      "Runner's High during freeze must not cancel out the freeze",
    );
  });

  // Runner's High during the Campfire BOOST phase should NOT stack with the boost.
  // Spec: take the larger of the two multipliers (max(2x RH, 2.25x campfire) = 2.25x).
  it("RH overlapping campfire boost: takes max multiplier, does not stack", async () => {
    const alice = await createUser("AliceCFRH_B1");
    const bob = await createUser("BobCFRH_B111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // Runner's High wholly inside the campfire boost phase
    const rhStart = new Date(cfFreezeEnd.getTime() + 5 * 60 * 1000);
    const rhEnd = new Date(cfFreezeEnd.getTime() + 25 * 60 * 1000);
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      rhStart, rhEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 1000 steps inside the RH+boost overlap
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfFreezeEnd.getTime() + 10 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfFreezeEnd.getTime() + 20 * 60 * 1000).toISOString(),
        steps: 1000,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 2026-07-23 sum-stacking rule (see buff-stacking spec): campfire 2.25x + RH
    // 2x now SUM to 4.25x → 1000 base + 3250 buff = 4250 (was max(2.25,2)=2250).
    assert.equal(
      aliceP.totalSteps,
      4250,
      "RH stacks additively on campfire boost — 2.25 + 2 = 4.25x",
    );
  });

  // A sample that spans freeze + boost while RH is active for the whole effect
  // window should freeze the freeze-phase steps and apply the larger of the two
  // multipliers (campfire 2.25x) on the boost-phase steps, never both.
  it("RH spanning freeze+boost: freeze portion frozen, boost portion at max multiplier", async () => {
    const alice = await createUser("AliceCFRH_C1");
    const bob = await createUser("BobCFRH_C111");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const cfStart = hoursAgo(4);
    const cfFreezeEnd = new Date(cfStart.getTime() + CAMPFIRE_FREEZE_MS);
    const cfBoostEnd = new Date(cfFreezeEnd.getTime() + CAMPFIRE_BOOST_DURATION_MS_LEVEL_0);
    const cfPowerup = await giveHeldPowerup(raceId, alice.userId, "CAMPFIRE_REST", 100001);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, cfPowerup.id, "CAMPFIRE_REST",
      cfStart, cfBoostEnd,
      {
        freezeMs: CAMPFIRE_FREEZE_MS,
        boostMs: CAMPFIRE_BOOST_DURATION_MS_LEVEL_0,
        multiplier: CAMPFIRE_MULTIPLIER_LEVEL_0,
        stepsAtRestStart: 0,
        stepsAtExpiry: 0,
      },
    );

    // RH covers the entire campfire window
    const rhPowerup = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 100002);
    await createExpiredEffect(
      raceId, alice.userId, alice.userId, rhPowerup.id, "RUNNERS_HIGH",
      cfStart, cfBoostEnd,
      { stepsAtBuffStart: 0, stepsAtExpiry: 0 },
    );

    // 600 steps fully inside the freeze phase
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfStart.getTime() + 5 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfStart.getTime() + 15 * 60 * 1000).toISOString(),
        steps: 600,
      },
    ]);
    // 800 steps fully inside the boost phase
    await recordSamples(alice.token, [
      {
        periodStart: new Date(cfFreezeEnd.getTime() + 5 * 60 * 1000).toISOString(),
        periodEnd: new Date(cfFreezeEnd.getTime() + 15 * 60 * 1000).toISOString(),
        steps: 800,
      },
    ]);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = findUser(progress, alice.userId);
    // 2026-07-23 sum-stacking rule (see buff-stacking spec):
    //   600 base (freeze) - 600 frozen (RH cannot rescue frozen steps) = 0
    // + 800 base (boost) + 800 * (2.25 + 2 - 1) buff = 800 + 2600 = 3400
    // Total = 3400 (was 1800 under max(campfire, RH)).
    assert.equal(
      aliceP.totalSteps,
      3400,
      "freeze-phase steps stay frozen; boost-phase steps get campfire+RH summed (4.25x)",
    );
  });
});
