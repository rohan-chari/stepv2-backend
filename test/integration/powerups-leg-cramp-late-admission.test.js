const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { buildRaceResolutionWorkerV2 } = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { buildRecomputePlacements } = require("../../src/modules/races/jobs/placementRecompute");

let server;
let nextAppleId = 0;

async function drainRaceResolution() {
  await buildRecomputePlacements({
    requestStepSyncForUsers: async () => {},
    logger: { log() {}, warn() {}, error(error) { throw error; } },
  })();
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    logger: { log() {}, error(error) { throw error; } },
  });
  while (await worker.processOne()) {}
}

async function createUser(displayName) {
  const appleId = `apple-late-cramp-${++nextAppleId}`;
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
  const response = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const friendshipId = (await response.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(alice, bob) {
  const response = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Leg Cramp Late Admission",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await response.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [bob.userId] },
    token: alice.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: bob.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

  const start = hoursAgo(7);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type) {
  const participant = await prisma.raceParticipant.findFirstOrThrow({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps: 99902,
    },
  });
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples },
    token,
  });
}

async function recordSyncV2(token, samples) {
  return request(server.baseUrl, "POST", "/steps/sync-v2", {
    body: {
      date: new Date().toISOString().slice(0, 10),
      steps: 1900,
      samples,
    },
    headers: { "Idempotency-Key": randomUUID() },
    token,
  });
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

describe("Leg Cramp late event-time admission", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("admits late target samples without changing persisted Leg Cramp attribution", async () => {
    const target = await createUser("Late Cramp Target");
    const attacker = await createUser("Late Cramp Attacker");
    await makeFriends(target, attacker);
    const raceId = await createActiveRace(target, attacker);

    const effectStart = hoursAgo(4);
    const effectEnd = hoursAgo(1);
    const powerup = await giveHeldPowerup(raceId, attacker.userId, "LEG_CRAMP");
    const useResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${powerup.id}/use`,
      { body: { targetUserId: target.userId }, token: attacker.token },
    );
    assert.equal(useResponse.status, 200, await useResponse.text());

    const effect = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId, type: "LEG_CRAMP", targetUserId: target.userId },
    });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: effectStart, expiresAt: effectEnd },
    });

    const early = {
      periodStart: hoursAgo(3.5).toISOString(),
      periodEnd: hoursAgo(3).toISOString(),
      steps: 100,
    };
    const earlyResponse = await recordSamples(target.token, [early]);
    assert.equal(earlyResponse.status, 200, await earlyResponse.text());
    await drainRaceResolution();

    const impactBefore = await prisma.raceImpactEvent.findFirstOrThrow({
      where: {
        raceId,
        recipientUserId: target.userId,
        sourceId: effect.id,
      },
    });
    const generationBefore = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: target.userId },
    });

    await prisma.race.update({
      where: { id: raceId },
      data: { status: "COMPLETED", endsAt: hoursAgo(0.5), completedAt: hoursAgo(0.5) },
    });

    const late = [
      { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 500 },
      { periodStart: hoursAgo(2).toISOString(), periodEnd: hoursAgo(1.5).toISOString(), steps: 600 },
      { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 700 },
    ];
    const upload = await recordSyncV2(target.token, late);
    assert.equal(upload.status, 202, await upload.text());

    const generationAfter = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: target.userId },
    });
    assert.ok(BigInt(generationAfter.generation) > BigInt(generationBefore.generation));

    const changedSamples = await prisma.stepSample.findMany({
      where: { userId: target.userId, periodStart: { gte: new Date(late[0].periodStart) } },
      orderBy: { periodStart: "asc" },
      select: { periodStart: true, periodEnd: true },
    });
    assert.equal(changedSamples.length, 3, "the changed envelope contains the three late buckets");

    const intents = await prisma.historicalRaceReconciliationIntent.findMany({
      where: { raceId, userId: target.userId },
    });
    assert.equal(intents.length, 1);
    const intent = intents[0];
    assert.equal(intent.raceId, raceId);
    assert.equal(intent.userId, target.userId);
    assert.equal(BigInt(intent.requestedSourceGeneration), BigInt(generationAfter.generation));
    assert.ok(intent.changedStart.getTime() <= Date.parse(late[0].periodStart));
    assert.ok(intent.changedEnd.getTime() >= Date.parse(late[2].periodEnd));
    assert.equal(intent.status, "QUEUED");

    const impactAfter = await prisma.raceImpactEvent.findFirstOrThrow({
      where: { raceId, recipientUserId: target.userId, sourceId: effect.id },
    });
    assert.equal(impactAfter.deltaSteps, impactBefore.deltaSteps);
    assert.equal(impactAfter.recipientUserId, target.userId);
    assert.equal(await prisma.raceImpactEvent.count({ where: { raceId, sourceId: effect.id } }), 1);

    const duplicateUpload = await recordSyncV2(target.token, late);
    assert.equal(duplicateUpload.status, 202, await duplicateUpload.text());
    const generationAfterDuplicate = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: target.userId },
    });
    assert.equal(BigInt(generationAfterDuplicate.generation), BigInt(generationAfter.generation));
    assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId, userId: target.userId } }), 1);
    assert.equal(await prisma.raceImpactEvent.count({ where: { raceId, sourceId: effect.id } }), 1);
  });
});
