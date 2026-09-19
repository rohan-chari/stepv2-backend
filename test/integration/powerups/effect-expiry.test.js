// Canonical powerup integration suite.


// ---- consolidated from powerups-leg-cramp-late-admission.test.js ----
(function powerups_leg_cramp_late_admission_test_js(){
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { buildRaceResolutionWorkerV2 } = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const { buildRecomputePlacements } = require("../../../src/modules/races/jobs/placementRecompute");

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

})();


// ---- consolidated from powerups-rainstorm-late-admission.test.js ----
(function powerups_rainstorm_late_admission_test_js(){
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { buildRaceResolutionWorkerV2 } = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const { buildRecomputePlacements } = require("../../../src/modules/races/jobs/placementRecompute");

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
  const appleId = `apple-late-rain-${++nextAppleId}`;
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
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(alice, bob) {
  const response = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Rainstorm Late Admission",
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
      earnedAtSteps: 99901,
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

describe("Rainstorm late event-time admission", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("admits late historical samples without changing the persisted Rainstorm impact", async () => {
    const alice = await createUser("Late Rain Victim");
    const bob = await createUser("Late Rain Caster");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const effectStart = hoursAgo(4);
    const effectEnd = hoursAgo(1);
    const rainstormPowerup = await giveHeldPowerup(raceId, bob.userId, "RAINSTORM");
    const useResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${rainstormPowerup.id}/use`,
      { token: bob.token },
    );
    assert.equal(useResponse.status, 200, await useResponse.text());

    const effect = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId, type: "RAINSTORM", targetUserId: alice.userId },
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
    const earlyResponse = await recordSamples(alice.token, [early]);
    assert.equal(earlyResponse.status, 200, await earlyResponse.text());
    await drainRaceResolution();

    const impactBefore = await prisma.raceImpactEvent.findFirstOrThrow({
      where: {
        raceId,
        recipientUserId: alice.userId,
        sourceId: effect.id,
      },
    });
    const generationBefore = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: alice.userId },
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
    const upload = await recordSyncV2(alice.token, late);
    assert.equal(upload.status, 202, await upload.text());

    const generationAfter = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: alice.userId },
    });
    assert.ok(BigInt(generationAfter.generation) > BigInt(generationBefore.generation));

    const lateRows = await prisma.stepSample.findMany({
      where: { userId: alice.userId, periodStart: { gte: new Date(late[0].periodStart) } },
      orderBy: { periodStart: "asc" },
      select: { periodStart: true, periodEnd: true },
    });
    assert.equal(lateRows.length, 3);

    const intents = await prisma.historicalRaceReconciliationIntent.findMany({
      where: { raceId, userId: alice.userId },
    });
    assert.equal(intents.length, 1);
    const intent = intents[0];
    assert.equal(intent.raceId, raceId);
    assert.equal(intent.userId, alice.userId);
    assert.equal(BigInt(intent.requestedSourceGeneration), BigInt(generationAfter.generation));
    assert.ok(intent.changedStart.getTime() <= Date.parse(late[0].periodStart));
    assert.ok(intent.changedEnd.getTime() >= Date.parse(late[2].periodEnd));
    assert.equal(intent.status, "QUEUED");

    const impactAfter = await prisma.raceImpactEvent.findFirstOrThrow({
      where: { raceId, recipientUserId: alice.userId, sourceId: effect.id },
    });
    assert.equal(impactAfter.deltaSteps, impactBefore.deltaSteps);

    const duplicateUpload = await recordSyncV2(alice.token, late);
    assert.equal(duplicateUpload.status, 202, await duplicateUpload.text());
    const generationAfterDuplicate = await prisma.userScoringInputVersion.findUniqueOrThrow({
      where: { userId: alice.userId },
    });
    assert.equal(BigInt(generationAfterDuplicate.generation), BigInt(generationAfter.generation));
    assert.equal(await prisma.historicalRaceReconciliationIntent.count({ where: { raceId, userId: alice.userId } }), 1);
    const impactAfterDuplicate = await prisma.raceImpactEvent.findFirstOrThrow({
      where: { raceId, recipientUserId: alice.userId, sourceId: effect.id },
    });
    assert.equal(impactAfterDuplicate.deltaSteps, impactBefore.deltaSteps);
  });
});

})();


// ---- consolidated from leech-expiry-boundary.test.js ----
(function leech_expiry_boundary_test_js(){
process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";
const assert = require("node:assert/strict");
const execFile = require("node:util").promisify(require("node:child_process").execFile);
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const { resolveExpiredRaces } = require("../../../src/modules/races/jobs/raceExpiry");
const { buildRaceResolutionWorkerV2 } = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const { RaceResolutionJobV2 } = require("../../../src/modules/races/models/raceResolutionJobV2");
let server;
let nextAppleId = 0;

const FEAT = {
  // team_races is needed for the mid-race forfeit case below (forfeit is a
  // team-race feature and its create path is capability-gated).
  "X-Client-Features": "characters,powerups2,powerups3,team_races",
};
const HEADERS = { ...FEAT, "X-Timezone": "UTC" };
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-parity-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  // TR-706: any authed request carrying the header records the user's last-seen
  // capability tokens. Without this an invite to a team race is rejected with
  // INVITEE_NEEDS_UPDATE, because the invitee has nothing recorded.
  await request(server.baseUrl, "GET", "/auth/me", {
    token: body.sessionToken,
    headers: HEADERS,
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

// Whole hourly buckets, exactly as the app uploads them, aligned to hour
// boundaries so every bucket in the effect window is CLOSED.
async function giveHourlyBucket(userId, hoursAgo, steps) {
  const periodStart = new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
  await prisma.stepSample.create({
    data: {
      userId,
      periodStart,
      periodEnd: new Date(periodStart.getTime() + HOUR_MS),
      steps,
      sourceName: "healthkit",
    },
  });
}

function hourFloor(hoursAgo) {
  return new Date(
    Math.floor((Date.now() - hoursAgo * HOUR_MS) / HOUR_MS) * HOUR_MS
  );
}

async function giveHeld(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
    },
  });
}

async function usePowerup(raceId, actor, powerupId, body) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body, token: actor.token, headers: HEADERS }
  );
}

async function totalsViaApi(raceId, viewer) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token: viewer.token,
    headers: HEADERS,
  });
  const body = await res.json();
  const totals = {};
  for (const p of body.progress.participants) totals[p.userId] = p.totalSteps;
  return { status: body.progress.status, totals };
}


describe("Leech expiry boundary — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });
  for (const [availableAtExpiry, dailyOnly, sameDay = false, overlapping = false, variant = "ordinary"] of [[0, false], [100, false], [100, true], [100, false, true], [100, false, false, true], [100, false, false, false, "victim-forfeit"], [100, false, false, false, "attacker-forfeit"], [100, true, false, false, "race-cutoff"], [100, false, false, false, "legacy"], [100, false, false, false, "old-client"], [100, false, false, false, "active-attacker-forfeit"], [100, false, false, false, "recursive"], [100, true, false, false, "concurrent-cast"], [100, false, false, false, "worker"], [100, false, false, false, "bonus"], [100, false, false, false, "legacy-script"]]) {
    it(`later walking cannot fund an expired Leech with ${availableAtExpiry} available at expiry (${dailyOnly ? "daily" : "samples"}, sameDay=${sameDay}, overlapping=${overlapping}, ${variant})`, async () => {
      const victim = await createUser("Victim");
      const attacker = await createUser("Attacker");
      // Direct source fixtures need the same generation baseline that public
      // intake creates; settlement deliberately rejects unversioned sources.
      await prisma.userScoringInputVersion.createMany({ data: [victim, attacker].map(user => ({ userId: user.userId, generation: 1n })), skipDuplicates: true });
      await makeFriends(victim, attacker);
      const created = await request(server.baseUrl, "POST", "/races", {
        token: victim.token, headers: HEADERS,
        body: { name: "Leech expiry", targetSteps: 500000, maxDurationDays: 7,
          powerupsEnabled: true, powerupStepInterval: 50000,
          ...(variant.includes("forfeit") ? { isTeamRace: true, teamSize: 1 } : {}) },
      });
      assert.equal(created.status, 201);
      const raceId = (await created.json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        token: victim.token, headers: HEADERS, body: { inviteeIds: [attacker.userId] },
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        token: attacker.token, headers: HEADERS, body: { accept: true },
      });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
        token: victim.token, headers: HEADERS,
      });
      const start = sameDay ? hourFloor(6) : new Date(hourFloor(48).toISOString().slice(0, 10));
      await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, timezone: "UTC" } });
      await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
      // Anchor daily-only fixtures to the effect-expiry UTC date. Using
      // "today" makes the test fail for a few hours after UTC midnight because
      // hourFloor(3) is still yesterday, turning the supposed pre-expiry 100
      // steps into post-expiry walking.
      const dailyDate = new Date(hourFloor(3).toISOString().slice(0, 10));
      if (dailyOnly) await prisma.step.create({ data: { userId: victim.userId, date: dailyDate, steps: 0 } });
      const held = await giveHeld(raceId, attacker.userId, "LEECH");
      let concurrentUse;
      if (variant === "concurrent-cast") {
        await prisma.$transaction(async tx => {
          await tx.$queryRawUnsafe(`SELECT user_id FROM user_scoring_input_versions WHERE user_id=$1 FOR UPDATE`, victim.userId);
          const [{ pid }] = await tx.$queryRawUnsafe(`SELECT pg_backend_pid() AS pid`);
          concurrentUse = usePowerup(raceId, attacker, held.id, { targetUserId: victim.userId });
          let blocked = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const waiting = await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1`, pid);
            if (waiting.length) { blocked = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.ok(blocked, "cast waits for the victim intake lock before initializing its checkpoint");
          await tx.step.update({ where: { userId_date: { userId: victim.userId, date: dailyDate } }, data: { steps: availableAtExpiry } });
        });
      }
      const used = concurrentUse ? await concurrentUse : variant === "old-client" ? await request(server.baseUrl, "POST",
        `/races/${raceId}/powerups/${held.id}/use`, { token: attacker.token,
          headers: { ...HEADERS, "X-Client-Features": "characters,powerups2" },
          body: { targetUserId: victim.userId } }) :
        await usePowerup(raceId, attacker, held.id, { targetUserId: victim.userId });
      assert.equal(used.status, 200);
      if (variant === "old-client") {
        const actual = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH" } });
        assert.equal(actual.expiresAt - actual.startsAt, 30 * 60000);
      }
      if (dailyOnly && variant !== "concurrent-cast") await prisma.step.update({ where: { userId_date: { userId: victim.userId, date: dailyDate } }, data: { steps: availableAtExpiry } });
      if (variant === "bonus") await prisma.raceParticipant.updateMany({ where: { raceId, userId: victim.userId }, data: { bonusSteps: 100 } });
      const expiry = overlapping ? new Date(Date.now() - 60000) : hourFloor(3);
      const effectStart = overlapping ? new Date(expiry.getTime() - 240000) : hourFloor(4);
      const postPeriodStart = overlapping ? new Date(expiry.getTime() + 10000) : hourFloor(2);
      const postPeriodEnd = overlapping ? new Date(expiry.getTime() + 40000) : hourFloor(1);
      await prisma.raceActiveEffect.updateMany({
        where: { raceId, type: "LEECH" },
        data: { startsAt: effectStart, expiresAt: expiry, status: "EXPIRED" },
      });
      if (availableAtExpiry && !dailyOnly) await giveHourlyBucket(victim.userId, 5, availableAtExpiry);
      if (overlapping) await prisma.stepSample.create({ data: {
        userId: attacker.userId, periodStart: effectStart,
        periodEnd: new Date(expiry.getTime() + 120000), steps: 1000,
      } });
      else await giveHourlyBucket(attacker.userId, 4, 1000);
      if (variant.startsWith("legacy")) {
        await prisma.$executeRawUnsafe(`DELETE FROM leech_expiry_checkpoints WHERE race_id=$1`, raceId);
        if (variant === "legacy-script") {
          await execFile(process.execPath, ["scripts/freeze-legacy-leech-transfers.js"], { timeout: 15000 });
          let row = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH" } });
          assert.equal(row.metadata?.leechFinalV1, undefined, "preview rolls back every scoring write");
          const result = await execFile(process.execPath, ["scripts/freeze-legacy-leech-transfers.js", "--apply"], { timeout: 15000 });
          const report = result.stdout.trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(row => row.scanned != null);
          assert.equal(report.frozen, 1);
          assert.deepEqual(report.skipped, []);
          row = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH" } });
          assert.equal(row.metadata.leechFinalV1.amount, 100);
        }
        // Freeze the approved current allocation before adding later walking.
        const first = await totalsViaApi(raceId, victim);
        assert.equal(first.totals[attacker.userId], 1100);
      }
      if (variant === "race-cutoff") {
        await prisma.raceActiveEffect.updateMany({ where: { raceId, type: "LEECH" },
          data: { expiresAt: new Date(Date.now() + HOUR_MS), status: "ACTIVE" } });
        await prisma.race.update({ where: { id: raceId }, data: { endsAt: expiry } });
      }
      // Already expired before the first scoring pass: a delayed worker must
      // reconstruct expiry, not stamp today's balance as the old transfer.
      if (dailyOnly) await prisma.step.update({ where: { userId_date: { userId: victim.userId, date: dailyDate } }, data: { steps: 1000 + availableAtExpiry } });
      else await prisma.stepSample.create({ data: { userId: victim.userId,
        periodStart: postPeriodStart, periodEnd: postPeriodEnd, steps: 1000 } });
      if (variant === "race-cutoff") {
        await resolveExpiredRaces();
        const settled = await totalsViaApi(raceId, victim);
        assert.equal(settled.status, "COMPLETED");
        assert.equal(settled.totals[attacker.userId], 1100, "later daily total cannot fund a transfer after race end");
        return;
      }
      if (variant === "active-attacker-forfeit") {
        await prisma.raceActiveEffect.updateMany({ where: { raceId, type: "LEECH" },
          data: { expiresAt: new Date(Date.now() + HOUR_MS), status: "ACTIVE" } });
        const response = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
          token: attacker.token, headers: HEADERS,
        });
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
        const after = await totalsViaApi(raceId, victim);
        assert.equal(after.totals[attacker.userId], 1500, "active transfer freezes with the forfeiting attacker");
        return;
      }
      if (variant === "recursive") {
        const previous = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH" } });
        const nextHeld = await giveHeld(raceId, attacker.userId, "LEECH");
        await prisma.raceActiveEffect.create({ data: {
          raceId, targetParticipantId: previous.targetParticipantId, targetUserId: victim.userId,
          sourceUserId: attacker.userId, powerupId: nextHeld.id, type: "LEECH", status: "EXPIRED",
          startsAt: expiry, expiresAt: hourFloor(2), metadata: { ratio: 2 },
        } });
        await giveHourlyBucket(attacker.userId, 3, 1000);
        const after = await totalsViaApi(raceId, victim);
        assert.equal(after.totals[attacker.userId], 2100, "later expiry reserves the earlier final debit");
        assert.equal(after.totals[victim.userId], 1000);
        await prisma.stepSample.updateMany({ where: { userId: victim.userId }, data: { steps: 0 } });
        const corrected = await totalsViaApi(raceId, victim);
        assert.equal(corrected.totals[attacker.userId], 2100, "both recursive final amounts are durable");
        return;
      }
      if (variant === "bonus") {
        await prisma.raceParticipant.updateMany({ where: { raceId, userId: victim.userId }, data: { bonusSteps: 1000 } });
        const after = await totalsViaApi(raceId, victim);
        assert.equal(after.totals[attacker.userId], 1200, "only the pre-expiry net bonus funds Leech");
        assert.equal(after.totals[victim.userId], 1900);
        return;
      }
      if (variant === "worker") {
        await prisma.userScoringInputVersion.updateMany({ where: { userId: { in: [victim.userId, attacker.userId] } }, data: { generation: { increment: 1 } } });
        await prisma.raceResolutionJobV2.update({ where: { raceId }, data: { state: "QUEUED", notBeforeAt: new Date(0), retryAt: null } });
        const worker = buildRaceResolutionWorkerV2({ bootAt: 0, RaceResolutionJobV2: {
          ...RaceResolutionJobV2, claimNext: args => RaceResolutionJobV2.claimNext({ ...args, raceId }),
        } });
        assert.ok(await worker.processOne());
        const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH" } });
        assert.equal(effect.metadata?.leechFinalV1?.amount, 100, "the fenced queue commit persists the final amount before any GET");
      }
      let live = await totalsViaApi(raceId, victim);
      assert.equal(live.totals[victim.userId], 1000, "post-expiry steps stay with the victim");
      if (!overlapping) assert.equal(live.totals[attacker.userId], 1000 + availableAtExpiry,
        "unused stealing potential is lost at expiry, including a zero ceiling");
      if (overlapping) {
        await prisma.stepSample.updateMany({ where: { userId: attacker.userId }, data: { periodEnd: postPeriodEnd } });
        live = await totalsViaApi(raceId, victim);
        assert.equal(live.totals[attacker.userId], 1000 + availableAtExpiry);
      }
      if (variant.includes("forfeit")) {
        const actor = variant === "victim-forfeit" ? victim : attacker;
        const response = await request(server.baseUrl, "POST", `/races/${raceId}/forfeit`, {
          token: actor.token, headers: HEADERS,
        });
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
        const after = await totalsViaApi(raceId, victim);
        assert.equal(after.totals[attacker.userId], 1100, "forfeit preserves the transferred credit");
        return;
      }
      // Give settlement timestamped coverage for today's raw total; its
      // existing partial-day policy excludes daily-only raw steps at race end.
      if (dailyOnly) await giveHourlyBucket(victim.userId, 2, 1000 + availableAtExpiry);
      await prisma.stepSample.updateMany({ where: { userId: attacker.userId }, data: { steps: 0 } });
      const attackerCorrected = await totalsViaApi(raceId, victim);
      assert.equal(attackerCorrected.totals[attacker.userId], availableAtExpiry,
        "the credited transfer survives removal of the attacker's original steps");
      await prisma.stepSample.updateMany({ where: { userId: attacker.userId }, data: { steps: 1000 } });
      await prisma.stepSample.updateMany({ where: { userId: victim.userId }, data: { steps: 0 } });
      if (dailyOnly) await prisma.step.update({ where: { userId_date: { userId: victim.userId, date: dailyDate } }, data: { steps: 0 } });
      const victimCorrected = await totalsViaApi(raceId, victim);
      assert.equal(victimCorrected.totals[victim.userId], 0);
      assert.equal(victimCorrected.totals[attacker.userId], 1000 + availableAtExpiry,
        "a corrected zero victim balance does not claw back a frozen transfer");
      await prisma.stepSample.updateMany({ where: { userId: victim.userId, periodStart: postPeriodStart }, data: { steps: 1000 + availableAtExpiry } });
      const recovered = await totalsViaApi(raceId, victim);
      assert.deepEqual(recovered.totals, live.totals, "new walking cannot unlock unused old stealing potential");
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 1000) } });
      await resolveExpiredRaces();
      const settled = await totalsViaApi(raceId, victim);
      assert.equal(settled.status, "COMPLETED");
      assert.deepEqual(settled.totals, live.totals, "settlement honors the same expiry boundary");
    });
  }
});

})();
