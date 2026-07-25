const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");

// ---------------------------------------------------------------------------
// RACE_ENDING_SOON fires for user-created races, NEVER for the seeded
// daily/weekly challenges.
//
// The ~2h "final push" nudge is welcome on a race you deliberately started with
// friends. On the seeded DAILY/WEEKLY challenges — which every opted-in user is
// auto-enrolled into, every single day — it is a recurring push nobody asked
// for. A seeded race is exactly the set with `Race.seedId != null`.
//
// This is deliberately an INTEGRATION test against the real DB and the real
// Race model, not the stubbed job harness in test/jobs/. The whole failure mode
// is that `findActiveInProgress`'s `select` doesn't return `seedId`, in which
// case the skip reads undefined and silently never fires. A stubbed Race model
// hands the job a hand-written row and would pass while prod pushed anyway.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;
const HOUR = 60 * 60 * 1000;

async function createUser(displayName) {
  const appleId = `apple-res-${++nextAppleId}`;
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

// A started, time-based race ending in ~1.5h whose total duration is 24h, so it
// clears the short-race guard and sits inside the 2h reminder window.
async function createEndingSoonRace(alice, bob, name) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name, timeBased: true, maxDurationDays: 7 },
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const startedAt = new Date(Date.now() - 22.5 * HOUR);
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt, endsAt: new Date(Date.now() + 1.5 * HOUR) },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt },
  });
  return raceId;
}

// Attach a race to a RaceSeed, exactly as seededRaceRenewal does when it mints
// the day's challenge.
async function attachToSeed(raceId, { kind, cadence }) {
  const seed = await prisma.raceSeed.upsert({
    where: { kind },
    update: {},
    create: {
      id: `seed-${kind}`,
      kind,
      name: `${kind} Challenge`,
      targetSteps: 10000,
      durationHours: cadence === "WEEKLY" ? 168 : 24,
      cadence,
      timeBased: true,
    },
  });
  await prisma.race.update({
    where: { id: raceId },
    data: { seedId: seed.id },
  });
  return seed;
}

async function runJob() {
  const emitted = [];
  const recompute = buildRecomputePlacements({
    eventBus: { emit: (event, data) => emitted.push({ event, data }) },
    requestStepSyncForUsers: async () => {},
    logger: { log() {}, warn() {}, error() {} },
    isRaceEndingReminderDisabled: () => false,
  });
  await recompute();
  return emitted.filter((e) => e.event === "RACE_ENDING_SOON");
}

describe("race-ending-soon skips seeded daily/weekly challenges", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("fires for a user-created race", async () => {
    const alice = await createUser("AliceEnding");
    const bob = await createUser("BobEnding");
    await makeFriends(alice, bob);
    const raceId = await createEndingSoonRace(alice, bob, "Friends Race");

    const ending = await runJob();
    assert.equal(ending.length, 2, "both participants are nudged");
    assert.ok(ending.every((e) => e.data.raceId === raceId));
  });

  it("does NOT fire for a seeded DAILY challenge", async () => {
    const alice = await createUser("AliceDaily");
    const bob = await createUser("BobDaily");
    await makeFriends(alice, bob);
    const raceId = await createEndingSoonRace(alice, bob, "Daily 10K");
    await attachToSeed(raceId, { kind: "DAILY_10K", cadence: "DAILY" });

    const ending = await runJob();
    assert.equal(ending.length, 0, "seeded daily challenge sends no nudge");
  });

  it("does NOT fire for a seeded WEEKLY challenge", async () => {
    const alice = await createUser("AliceWeekly");
    const bob = await createUser("BobWeekly");
    await makeFriends(alice, bob);
    const raceId = await createEndingSoonRace(alice, bob, "Weekly 50K");
    await attachToSeed(raceId, { kind: "WEEKLY_50K", cadence: "WEEKLY" });

    const ending = await runJob();
    assert.equal(ending.length, 0, "seeded weekly challenge sends no nudge");
  });

  it("a seeded race does not suppress a concurrent user race", async () => {
    const alice = await createUser("AliceBoth");
    const bob = await createUser("BobBoth");
    await makeFriends(alice, bob);
    const seededId = await createEndingSoonRace(alice, bob, "Daily 10K");
    await attachToSeed(seededId, { kind: "DAILY_10K", cadence: "DAILY" });
    const ownId = await createEndingSoonRace(alice, bob, "Our Own Race");

    const ending = await runJob();
    assert.equal(ending.length, 2, "only the user-created race nudges");
    assert.ok(
      ending.every((e) => e.data.raceId === ownId),
      "no event references the seeded race"
    );
  });
});
