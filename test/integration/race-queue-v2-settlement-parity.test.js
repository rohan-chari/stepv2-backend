// C0 — settlement parity and expiry/worker mutual exclusion
// (docs/redis-derived-data-layer-requirements.md §5a items 5-6, test plan 5a).
//
// The acceptance question this file answers: does a race whose standings were
// maintained ENTIRELY by the race-keyed worker settle to the same placements and
// the same payouts as a control race resolved the old way (inline, via the
// `inlineRaceResolutionFallback` lever)? If C0 changed a single settled coin the
// whole change is unshippable, so the assertion is a full lifecycle — create ->
// syncs -> powerup -> expiry -> completeRace — run twice over identical inputs.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;
let nextAppleId = 0;
const HOUR_MS = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-c0p-${++nextAppleId}-${Date.now()}`;
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

async function createActiveRace(owner, others, name) {
  for (const o of others) await makeFriends(owner, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
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

function makeWorker(overrides = {}) {
  return buildRaceResolutionWorkerV2({ bootAt: 0, ...overrides });
}

async function drain(worker = makeWorker(), maxJobs = 50) {
  for (let i = 0; i < maxJobs; i++) {
    if (!(await worker.processOne())) break;
  }
}

// Grant a powerup directly and use it through the real endpoint, so the
// lifecycle exercises the enqueue-after-powerup seam.
async function useProteinShake(user, raceId) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
    select: { id: true },
  });
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: 0,
    },
  });
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/use`, {
    body: { powerupId: powerup.id },
    token: user.token,
  });
}

// The observable settlement outcome: who placed where, with what total, and how
// many coins each racer walked away with.
async function settlementOutcome(raceId, users) {
  const participants = await prisma.raceParticipant.findMany({
    where: { raceId },
    orderBy: { placement: "asc" },
    select: { userId: true, placement: true, totalSteps: true },
  });
  const race = await prisma.race.findUnique({
    where: { id: raceId },
    select: { status: true, winnerUserId: true },
  });
  const byName = new Map(users.map((u) => [u.userId, u.displayName]));
  const coins = [];
  for (const u of users) {
    const row = await prisma.user.findUnique({
      where: { id: u.userId },
      select: { coins: true },
    });
    coins.push([u.displayName, row.coins]);
  }
  return {
    status: race.status,
    winner: byName.get(race.winnerUserId) ?? null,
    standings: participants.map((p) => ({
      name: byName.get(p.userId),
      placement: p.placement,
      totalSteps: p.totalSteps,
    })),
    coins: coins.sort(),
  };
}

before(async () => {
  server = await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

after(async () => {
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
});

// One full lifecycle over identical inputs. `queued` selects which side of the
// C0 change drives standings: the race-keyed worker, or the old inline path
// restored by the rollback lever.
async function runLifecycle({ queued }) {
  await appSettings.setFlag("inlineRaceResolutionFallback", !queued);

  const alice = await createUser("Alice");
  const bob = await createUser("Bob");
  const cara = await createUser("Cara");
  const raceId = await createActiveRace(alice, [bob, cara], "Lifecycle");

  // Deterministic, identical step history on both sides.
  await postSamples(alice, [sampleAt(6, 3000), sampleAt(5, 2500)]);
  await postSamples(bob, [sampleAt(6, 1800), sampleAt(5, 1500)]);
  await postSamples(cara, [sampleAt(6, 900), sampleAt(5, 700)]);

  await useProteinShake(bob, raceId);

  if (queued) await drain();

  // Expire and settle through the real cron entry point.
  await prisma.race.update({
    where: { id: raceId },
    data: { endsAt: new Date(Date.now() - 60 * 1000) },
  });
  await resolveExpiredRaces();

  return settlementOutcome(raceId, [alice, bob, cara]);
}

describe("settlement parity — queue-maintained vs inline-maintained", () => {
  it("a full lifecycle under the race-keyed queue settles to the same placements and payouts as an inline control", async () => {
    const queuedOutcome = await runLifecycle({ queued: true });
    await cleanDatabase();
    const controlOutcome = await runLifecycle({ queued: false });

    assert.equal(queuedOutcome.status, "COMPLETED");
    assert.equal(controlOutcome.status, "COMPLETED");
    assert.deepEqual(
      queuedOutcome,
      controlOutcome,
      "C0 must not move a single placement, total, or coin"
    );
    // Guard against a vacuous pass: the fixture really did produce a ranked field.
    assert.deepEqual(
      queuedOutcome.standings.map((s) => s.placement),
      [1, 2, 3]
    );
    assert.ok(queuedOutcome.standings[0].totalSteps > 0);
  });
});

describe("5a — raceExpiry vs a live worker are mutually exclusive", () => {
  it("concurrent settlement and live resolution on one race never interleave, and the settled standings stand", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    const raceId = await createActiveRace(alice, [bob], "Expiry vs worker");

    await postSamples(alice, [sampleAt(6, 5000)]);
    await postSamples(bob, [sampleAt(6, 2000)]);
    await drain();

    // Both writers are made eligible at the same instant: the race is past its
    // end AND its job row is dirty.
    await prisma.race.update({
      where: { id: raceId },
      data: { endsAt: new Date(Date.now() - 60 * 1000) },
    });
    await postSamples(alice, [sampleAt(5, 4000)]);

    const outcomes = await Promise.allSettled([
      resolveExpiredRaces(),
      drain(),
      drain(makeWorker()),
    ]);
    for (const o of outcomes) {
      assert.equal(
        o.status,
        "fulfilled",
        `no writer may fail: ${o.reason && o.reason.message}`
      );
    }

    // Settlement won the race to a conclusion: placements are set and the
    // live worker did not resurrect the race or scramble the standings.
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
      select: { userId: true, placement: true },
    });
    assert.deepEqual(
      participants.map((p) => p.placement),
      [1, 2]
    );
    assert.equal(participants[0].userId, alice.userId);

    const race = await prisma.race.findUnique({
      where: { id: raceId },
      select: { status: true },
    });
    assert.equal(race.status, "COMPLETED");

    // Post-settlement the worker is a no-op: resolveRaceState refuses to
    // live-resolve a race past endsAt, so nothing can un-settle it.
    await RaceResolutionJobV2.enqueue({ raceId, userId: alice.userId });
    await drain();
    const after = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
      select: { placement: true },
    });
    assert.deepEqual(
      after.map((p) => p.placement),
      [1, 2]
    );
  });
});
