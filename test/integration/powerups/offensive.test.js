// Canonical powerup integration suite.
// Consolidated from focused historical files so the default integration suite
// owns durable gameplay behavior by domain instead of by feature/bug batch.


// ---- consolidated from bugbatch-b4-rainstorm-percaster.test.js ----
(function bugbatch_b4_rainstorm_percaster_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// B4 — Rainstorm concurrency becomes PER-CASTER, and overlapping storms clamp a
// victim at exactly 0.5x (a single -0.5x), never 0.25x / 0x.
//   * two different users can each have an active storm at once;
//   * the same user cannot start a second storm while their own is active;
//   * a victim under two storms scores at 0.5x through the real steps path;
//   * the B3 redeem pre-flight uses the same per-caster rule.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

const STORE_POWERUPS = [
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", powerupType: "RAINSTORM", priceCoins: 75, sortOrder: 1 },
];

async function seedStoreCatalog() {
  for (const p of STORE_POWERUPS) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      update: { priceCoins: p.priceCoins, active: true },
      create: { ...p, description: `${p.name} test row`, active: true },
    });
  }
}

async function createUser(displayName, coins = 500) {
  const appleId = `apple-b4-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  if (coins > 0) {
    await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
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

async function createActiveRace(creator, opponents) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "B4 Rainstorm",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: creator.token,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: creator.token });
  const start = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function purchase(token, sku, key) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", {
    body: { sku },
    token,
    headers: { "Idempotency-Key": key },
  });
}

async function redeem(token, raceId, powerupType) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType },
    token,
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

// Buy, redeem, and cast a rainstorm from `user`. Returns the use response.
async function castRainstorm(user, raceId, key) {
  const p = await purchase(user.token, "POWERUP_RAINSTORM", key);
  assert.equal(p.status, 200, "rainstorm purchase ok");
  const r = await redeem(user.token, raceId, "RAINSTORM");
  return { redeemRes: r };
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

describe("B4 — per-caster rainstorm limit + 0.5x stacking clamp", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("two different users can each have an active storm at the same time", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4a");
    const bob = await createUser("BobB4a");
    const carol = await createUser("CarolB4a");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    // Alice casts.
    const a = await castRainstorm(alice, raceId, "b4a-alice");
    assert.equal(a.redeemRes.status, 200);
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);

    // Bob casts while Alice's storm is still active — allowed under per-caster.
    const b = await castRainstorm(bob, raceId, "b4a-bob");
    assert.equal(b.redeemRes.status, 200);
    const bStorm = (await b.redeemRes.json()).result.powerup.id;
    const bUse = await usePowerup(bob.token, raceId, bStorm);
    assert.equal(bUse.status, 200, "second caster's storm is allowed");

    const casters = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "RAINSTORM", status: "ACTIVE" },
      distinct: ["sourceUserId"],
    });
    const casterIds = casters.map((e) => e.sourceUserId).sort();
    assert.deepEqual(
      casterIds.sort(),
      [alice.userId, bob.userId].sort(),
      "both casters have active storms"
    );
  });

  it("the same user cannot start a second storm while their own is active", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4b");
    const bob = await createUser("BobB4b");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const a1 = await castRainstorm(alice, raceId, "b4b-1");
    const storm1 = (await a1.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, storm1)).status, 200);

    // Redeem a second (allowed to redeem only because... actually pre-flight
    // blocks it) — verify the USE guard copy directly by seeding a HELD storm.
    const aliceP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    const held = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: aliceP.id,
        userId: alice.userId,
        type: "RAINSTORM",
        status: "HELD",
        earnedAtSteps: null,
      },
    });
    const res = await usePowerup(alice.token, raceId, held.id);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /your rainstorm is already active/i);
    // Not consumed.
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: held.id } })).status,
      "HELD"
    );
  });

  it("B3 redeem pre-flight allows user B to redeem while user A's storm is active", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4c");
    const bob = await createUser("BobB4c");
    const carol = await createUser("CarolB4c");
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    const a = await castRainstorm(alice, raceId, "b4c-alice");
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);

    // Bob redeems his own rainstorm while Alice's is active — must be allowed.
    await purchase(bob.token, "POWERUP_RAINSTORM", "b4c-bob");
    const bobRedeem = await redeem(bob.token, raceId, "RAINSTORM");
    assert.equal(bobRedeem.status, 200, "per-caster: B can redeem while A's storm is active");
  });

  it("a victim under TWO storms scores at exactly 0.5x (not 0.25x)", async () => {
    await seedStoreCatalog();
    const alice = await createUser("AliceB4d");
    const bob = await createUser("BobB4d");
    const carol = await createUser("CarolB4d"); // the victim
    await makeFriends(alice, bob);
    await makeFriends(alice, carol);
    const raceId = await createActiveRace(alice, [bob, carol]);

    // Alice and Bob both cast — Carol is hit by both storms.
    const a = await castRainstorm(alice, raceId, "b4d-alice");
    const aStorm = (await a.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(alice.token, raceId, aStorm)).status, 200);
    const b = await castRainstorm(bob, raceId, "b4d-bob");
    const bStorm = (await b.redeemRes.json()).result.powerup.id;
    assert.equal((await usePowerup(bob.token, raceId, bStorm)).status, 200);

    // Sanity: Carol has two active RAINSTORM effects.
    const carolP = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: carol.userId },
    });
    const carolStorms = await prisma.raceActiveEffect.findMany({
      where: { raceId, type: "RAINSTORM", targetParticipantId: carolP.id, status: "ACTIVE" },
    });
    assert.equal(carolStorms.length, 2, "victim is under two storms");

    // Anchor both storms to a fixed past window so Carol's sample lands inside.
    const windowStart = minutesAgo(40);
    const windowEnd = new Date(Date.now() + 20 * 60 * 1000);
    for (const s of carolStorms) {
      await prisma.raceActiveEffect.update({
        where: { id: s.id },
        data: { startsAt: windowStart, expiresAt: windowEnd },
      });
    }

    // Carol walks 1000 steps entirely within the storm window.
    await recordSamples(carol.token, [
      { periodStart: minutesAgo(30).toISOString(), periodEnd: minutesAgo(20).toISOString(), steps: 1000 },
    ]);

    const progress = await getProgress(carol.token, raceId);
    const carolProg = findUser(progress, carol.userId);
    // Single 0.5x: 1000 - round(1000 * 0.5) = 500. Double-application would be
    // 1000 - (500 + 500) = 0.
    assert.equal(
      carolProg.totalSteps,
      500,
      "overlapping storms clamp the victim at a single 0.5x"
    );
  });
});

})();


// ---- consolidated from powerups-leg-cramp.test.js ----
(function powerups_leg_cramp_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRecomputePlacements,
} = require("../../../src/modules/races/jobs/placementRecompute");

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

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-lc-${++nextAppleId}`;
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

async function createActiveRace(alice, bob, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Leg Cramp Test",
      targetSteps: opts.targetSteps || 200000,
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
  // Default backdate so step samples fall within race window
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

// Override race start to a specific time
async function backdateRaceStart(raceId, startTime) {
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: startTime },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startTime },
  });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
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

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

// Helper: create a date relative to now
function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

describe("leg cramp", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("steps walked during freeze window are subtracted from total", async () => {
      const alice = await createUser("AliceCrampAA");
      const bob = await createUser("BobCrampAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply freeze, then backdate its startsAt so we can place samples inside it
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const useRes = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(useRes.status, 200);

      // Backdate freeze to 3h ago → expires 1h ago
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(3), expiresAt: hoursAgo(1) },
      });

      // Bob walks 3000 steps BEFORE freeze window (5h-4h ago, before 3h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 3000 },
      ]);

      // Bob walks 2000 steps DURING freeze window (2.5h-1.5h ago, within 3h-1h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(1.5).toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // Bob should have 3000 (pre-freeze) but not the 2000 during freeze
      assert.equal(bobP.totalSteps, 3000);
    });

    it("steps walked before the freeze still count", async () => {
      const alice = await createUser("AliceCrampBB");
      const bob = await createUser("BobCrampBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob walks before any freeze (1h ago, well within backdated race start of 7h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 8000 },
      ]);

      // Apply freeze NOW (samples are before the freeze window)
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 8000);
    });

    it("can freeze someone with 0 steps", async () => {
      const alice = await createUser("AliceCrampCC");
      const bob = await createUser("BobCrampCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(res.status, 200);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: minutesAgo(20), expiresAt: new Date(Date.now() + 100 * 60 * 1000) },
      });

      // Steps walked during freeze should be frozen
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 1500 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 0);
    });

    it("bonus steps (protein shake) still apply during freeze", async () => {
      const alice = await createUser("AliceCrampDD");
      const bob = await createUser("BobCrampDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Bob uses protein shake while frozen — bonus should still count
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(bob.token, raceId, shake.id);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 1500);
    });
  });

  // === PRORATING (currently broken — tests should expose the bug) ===

  describe("prorating at window boundaries", () => {
    it("sample overlapping freeze start: only steps during freeze are frozen", async () => {
      const alice = await createUser("AlicePrortAA");
      const bob = await createUser("BobProrateAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create a leg cramp effect directly in DB starting 1 hour ago
      const freezeStart = hoursAgo(1);
      const freezeEnd = new Date(freezeStart.getTime() + 2 * 60 * 60 * 1000); // +2h from start
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "ACTIVE",
          startsAt: freezeStart,
          expiresAt: freezeEnd,
          metadata: { stepsAtFreezeStart: 0 },
        },
      });

      // Bob has a sample that spans 90min ago to 30min ago (1 hour sample)
      // Freeze started 60min ago, so overlap is 60min-30min = 30min out of 60min sample
      // 1000 steps in 60 min → ~500 steps should be frozen (30/60 of the sample)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(90).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // With correct prorating: 500 of the 1000 steps overlap the freeze → freeze 500 → total = 500
      // Without prorating (current bug): all 1000 frozen → total = 0
      assert.equal(bobP.totalSteps, 500, "should prorate: only 500 of 1000 steps overlap the freeze window");
    });

    it("sample overlapping freeze end: only steps during freeze are frozen", async () => {
      const alice = await createUser("AlicePrortBB");
      const bob = await createUser("BobProrateBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an EXPIRED leg cramp that ended 30 min ago
      const freezeStart = hoursAgo(2.5);
      const freezeEnd = minutesAgo(30);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "EXPIRED",
          startsAt: freezeStart,
          expiresAt: freezeEnd,
          metadata: { stepsAtFreezeStart: 0, stepsAtExpiry: 0 },
        },
      });

      // Bob has a sample spanning 60min ago to now (1 hour)
      // Freeze ended 30min ago, so overlap is 60min-30min = 30min out of 60min
      // 1000 steps → ~500 should be frozen
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // With correct prorating: 500 frozen → total = 500
      // Without prorating (current bug): all 1000 frozen → total = 0
      assert.equal(bobP.totalSteps, 500, "should prorate: only 500 of 1000 steps overlap the freeze window");
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const res = await usePowerup(alice.token, raceId, cramp.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects if target already has active leg cramp", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const c1 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      const c2 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99902);

      await usePowerup(alice.token, raceId, c1.id, bob.userId);

      const res = await usePowerup(alice.token, raceId, c2.id, bob.userId);
      assert.equal(res.status, 400);
    });

  });

  // === SHIELD INTERACTION ===

  describe("shield interaction", () => {
    it("blocked by compression socks — no effect created", async () => {
      const alice = await createUser("AliceShldAAA");
      const bob = await createUser("BobShieldAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Bob walks and activates shield
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(3).toISOString(), periodEnd: hoursAgo(2).toISOString(), steps: 5000 },
      ]);
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice tries to freeze bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99902);
      const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob walks more — should count (no freeze applied)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 2000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 7000); // 5000 + 2000, no freeze
    });
  });

  // === EFFECT INTERACTIONS ===

  describe("effect interactions", () => {
    it("wrong turn on a cramped target is rejected — the cramp keeps running (owner decision 2026-07-29 — was: cancel)", async () => {
      const alice = await createUser("AliceInterAA");
      const bob = await createUser("BobInterAAAA");
      const charlie = await createUser("CharlieInterA");
      await makeFriends(alice, bob);
      await makeFriends(alice, charlie);

      // Need charlie in the race too
      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: { name: "Interaction Test", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
        token: alice.token,
      });
      const raceId = (await createRes.json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
        body: { inviteeIds: [bob.userId, charlie.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: bob.token });
      await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: charlie.token });
      await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Charlie's wrong turn on the cramped bob is rejected: Leg Cramp and
      // Wrong Turn are mutually exclusive on one target for direct uses.
      const wrongTurn = await giveHeldPowerup(raceId, charlie.userId, "WRONG_TURN", 99902);
      const res = await usePowerup(charlie.token, raceId, wrongTurn.id, bob.userId);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /Leg Cramp/);

      // The cramp is still active, so a second cramp still can't stack either.
      const crampEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, targetUserId: bob.userId, type: "LEG_CRAMP", status: "ACTIVE" },
      });
      assert.ok(crampEffect, "original cramp keeps running");
      const cramp2 = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99903);
      const res2 = await usePowerup(alice.token, raceId, cramp2.id, bob.userId);
      assert.equal(res2.status, 400);
    });
  });

  // === EXPIRY ===

  describe("expiry", () => {
    it("after expiry, new steps resume counting", async () => {
      const alice = await createUser("AliceExpAAAA");
      const bob = await createUser("BobExpAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create an already-expired leg cramp (ended 30 min ago)
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "LEG_CRAMP",
          status: "EXPIRED",
          startsAt: hoursAgo(3),
          expiresAt: hoursAgo(1),
          metadata: { stepsAtFreezeStart: 0, stepsAtExpiry: 0 },
        },
      });

      // Bob walks steps entirely after freeze ended — should count
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 4000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 4000);
    });

    it("feed shows both usage and expiry events", async () => {
      const alice = await createUser("AliceExpBBBB");
      const bob = await createUser("BobExpBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Create leg cramp that should expire immediately
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Force expiry by setting expiresAt to the past
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });

      // The legacy step-ingest path still performs inline expiry freshness for
      // frozen clients; the lean progress projection is intentionally read-only.
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 1, date: new Date().toISOString().slice(0, 10) },
        token: alice.token,
      });
      await drainRaceResolution();

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "LEG_CRAMP"
      );
      assert.ok(useEvent, "feed should have usage event");
      assert.ok(expiryEvent, "feed should have expiry event");
    });
  });
});

})();


// ---- consolidated from powerups-wrong-turn.test.js ----
(function powerups_wrong_turn_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRecomputePlacements,
} = require("../../../src/modules/races/jobs/placementRecompute");

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

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-wt-${++nextAppleId}`;
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

async function createActiveRace(alice, bob, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Wrong Turn Test",
      targetSteps: opts.targetSteps || 200000,
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
  const defaultStart = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function backdateRaceStart(raceId, startTime) {
  await prisma.race.update({
    where: { id: raceId },
    data: { startedAt: startTime },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startTime },
  });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: type === "COMPRESSION_SOCKS" ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
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

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

function minutesAgo(m) {
  return new Date(Date.now() - m * 60 * 1000);
}

describe("wrong turn", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CORE MECHANIC ===

  describe("core mechanic", () => {
    it("steps walked during window are reversed (subtracted 2x)", async () => {
      const alice = await createUser("AliceTurnAAA");
      const bob = await createUser("BobTurnAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply wrong turn, then backdate its window so we can place samples inside it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Backdate wrong turn to 3h ago → expires 2h ago (1h duration)
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(3), expiresAt: hoursAgo(2), status: "EXPIRED" },
      });

      // Bob walks 5000 steps BEFORE wrong turn window (5h-4h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 5000 },
      ]);

      // Bob walks 1000 steps DURING wrong turn window (2.5h-2.25h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(2.5).toISOString(), periodEnd: hoursAgo(2.25).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // base = 6000, reversedSteps = 1000, total = 6000 - 2*1000 = 4000
      assert.equal(bobP.totalSteps, 4000);
    });

    it("steps walked before wrong turn are unaffected", async () => {
      const alice = await createUser("AliceTurnBBB");
      const bob = await createUser("BobTurnBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Bob walks 5000 steps before wrong turn
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(5).toISOString(), periodEnd: hoursAgo(4).toISOString(), steps: 5000 },
      ]);

      // Alice applies wrong turn — bob doesn't walk during it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 5000);
    });

    it("steps walked after expiry are unaffected", async () => {
      const alice = await createUser("AliceTurnCCC");
      const bob = await createUser("BobTurnCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create an already-expired Wrong Turn (ended 30 min ago)
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobP.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "EXPIRED",
          startsAt: hoursAgo(2),
          expiresAt: hoursAgo(1),
          metadata: { stepsAtStart: 0 },
        },
      });

      // Bob walks after expiry — should count normally
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobEntry = findUser(progress, bob.userId);
      assert.equal(bobEntry.totalSteps, 3000);
    });

    it("total cannot go below 0", async () => {
      const alice = await createUser("AliceTurnDDD");
      const bob = await createUser("BobTurnDDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Apply wrong turn, then backdate so samples fall inside it
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(1) },
      });

      // Bob walks DURING wrong turn window (all steps reversed)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1.25).toISOString(), steps: 5000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // base = 5000, reversed = 5000, total = max(0, 5000 - 2*5000) = 0
      assert.equal(bobP.totalSteps, 0);
    });
  });

  // === VALIDATION ===

  describe("validation", () => {
    it("requires a target", async () => {
      const alice = await createUser("AliceValAAAA");
      const bob = await createUser("BobValAAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const res = await usePowerup(alice.token, raceId, wt.id);
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const alice = await createUser("AliceValBBBB");
      const bob = await createUser("BobValBBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const res = await usePowerup(alice.token, raceId, wt.id, alice.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack — rejects if target already has active wrong turn", async () => {
      const alice = await createUser("AliceValCCCC");
      const bob = await createUser("BobValCCCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt1 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const wt2 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);

      await usePowerup(alice.token, raceId, wt1.id, bob.userId);
      const res = await usePowerup(alice.token, raceId, wt2.id, bob.userId);
      assert.equal(res.status, 400);
    });

    it("cannot stack via a Mirror reflect bounce landing back on an already-turned attacker", async () => {
      const alice = await createUser("AliceValMirr");
      const bob = await createUser("BobValMirror");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob already has an active Wrong Turn on him (from an earlier direct cast).
      const wt1 = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      const firstRes = await usePowerup(alice.token, raceId, wt1.id, bob.userId);
      assert.equal(firstRes.status, 200);
      const original = await prisma.raceActiveEffect.findFirst({
        where: { raceId, targetUserId: bob.userId, type: "WRONG_TURN", status: "ACTIVE" },
      });
      const originalSnapshot = {
        id: original.id,
        startsAt: original.startsAt,
        expiresAt: original.expiresAt,
        sourceUserId: original.sourceUserId,
        powerupId: original.powerupId,
        status: original.status,
        metadata: original.metadata,
      };

      // Alice activates Mirror.
      const mirror = await giveHeldPowerup(raceId, alice.userId, "MIRROR", 99902);
      const mirrorRes = await usePowerup(alice.token, raceId, mirror.id);
      assert.equal(mirrorRes.status, 200);

      // Bob (already Wrong-Turned) fires his own Wrong Turn at Alice. Alice's
      // Mirror reflects it — the bounce would land back on Bob, who already
      // has one active. That must be rejected, not stacked.
      const wt2 = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99903);
      const res = await usePowerup(bob.token, raceId, wt2.id, alice.userId);
      assert.equal(res.status, 400);

      // Bob still has exactly the ONE original active Wrong Turn — no stack.
      const activeOnBob = await prisma.raceActiveEffect.findMany({
        where: { raceId, targetUserId: bob.userId, type: "WRONG_TURN", status: "ACTIVE" },
      });
      assert.equal(activeOnBob.length, 1);
      const after = await prisma.raceActiveEffect.findUnique({ where: { id: original.id } });
      assert.deepEqual({
        id: after.id,
        startsAt: after.startsAt,
        expiresAt: after.expiresAt,
        sourceUserId: after.sourceUserId,
        powerupId: after.powerupId,
        status: after.status,
        metadata: after.metadata,
      }, originalSnapshot);

      // The rejected bounce must not have consumed Alice's Mirror.
      const mirrorEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, targetUserId: alice.userId, type: "MIRROR" },
      });
      assert.equal(mirrorEffect.status, "ACTIVE");

      // And Bob's Wrong Turn item stays HELD (not consumed) so it can be reused.
      const bobPowerup = await prisma.racePowerup.findUnique({ where: { id: wt2.id } });
      assert.equal(bobPowerup.status, "HELD");
    });

  });

  // === PRORATING ===

  describe("prorating at window boundaries", () => {
    it("sample overlapping wrong turn start — only portion during effect is reversed", async () => {
      const alice = await createUser("AliceProrAAA");
      const bob = await createUser("BobProrAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create wrong turn starting 1 hour ago, lasting 1 hour (ends now-ish)
      const wtStart = hoursAgo(1);
      const wtEnd = new Date(wtStart.getTime() + 1 * 60 * 60 * 1000);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "ACTIVE",
          startsAt: wtStart,
          expiresAt: wtEnd,
          metadata: { stepsAtStart: 0 },
        },
      });

      // Sample: 90min ago to 30min ago (60 min)
      // Wrong turn started 60min ago, so overlap = 60min-30min = 30min out of 60min
      // 1000 steps → 500 should be reversed
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(90).toISOString(), periodEnd: minutesAgo(30).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // base = 1000, reversedSteps = 500 (prorated)
      // total = max(0, 1000 - 2*500) = 0
      assert.equal(bobP.totalSteps, 0, "should prorate: only 500 of 1000 steps reversed");
    });

    it("sample overlapping wrong turn end — only portion during effect is reversed", async () => {
      const alice = await createUser("AliceProrBBB");
      const bob = await createUser("BobProrBBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      await backdateRaceStart(raceId, hoursAgo(6));

      // Create expired wrong turn that ended 30min ago
      const wtStart = hoursAgo(1.5);
      const wtEnd = minutesAgo(30);
      const bobParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const powerup = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await prisma.racePowerup.update({ where: { id: powerup.id }, data: { status: "USED" } });
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobParticipant.id,
          targetUserId: bob.userId,
          sourceUserId: alice.userId,
          powerupId: powerup.id,
          type: "WRONG_TURN",
          status: "EXPIRED",
          startsAt: wtStart,
          expiresAt: wtEnd,
          metadata: { stepsAtStart: 0 },
        },
      });

      // Sample: 60min ago to now (60 min)
      // Wrong turn ended 30min ago, so overlap = 60min-30min = 30min out of 60min
      // 1000 steps → 500 should be reversed
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(60).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);

      // base = 1000, reversedSteps = 500 (prorated)
      // total = max(0, 1000 - 2*500) = 0
      assert.equal(bobP.totalSteps, 0, "should prorate: only 500 of 1000 steps reversed");
    });
  });

  // === EFFECT INTERACTIONS ===

  describe("effect interactions", () => {
    it("direct wrong turn on a cramped target is rejected (owner decision 2026-07-29 — was: cancel the cramp)", async () => {
      const alice = await createUser("AliceInterAA");
      const bob = await createUser("BobInterAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice freezes bob
      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);

      // Verify leg cramp is active
      const crampEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "LEG_CRAMP", status: "ACTIVE" },
      });
      assert.ok(crampEffect);

      // Alice applies wrong turn — rejected: Leg Cramp and Wrong Turn are
      // mutually exclusive on one target for DIRECT uses.
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      const wtRes = await usePowerup(alice.token, raceId, wt.id, bob.userId);
      assert.equal(wtRes.status, 400);
      assert.match((await wtRes.json()).error, /Leg Cramp/);

      // The cramp keeps running untouched.
      const updatedCramp = await prisma.raceActiveEffect.findFirst({
        where: { id: crampEffect.id },
      });
      assert.equal(updatedCramp.status, "ACTIVE");

      // The rejected wrong turn stays HELD for later.
      const wtItem = await prisma.racePowerup.findUnique({ where: { id: wt.id } });
      assert.equal(wtItem.status, "HELD");
    });

    it("cancelled leg cramp stops freezing — window truncated, steps after the wrong turn count", async () => {
      // Direct Wrong Turn on a cramped target is rejected now (owner decision
      // 2026-07-29), so the cancel path is exercised the way it still happens
      // in prod: an INDIRECT landing via a Mirror reflect.
      const alice = await createUser("AliceInterCC");
      const bob = await createUser("BobInterCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
      await usePowerup(alice.token, raceId, cramp.id, bob.userId);
      const crampEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "LEG_CRAMP" },
      });

      // Alice arms a Mirror; Bob fires his own Wrong Turn at her and the
      // bounce lands back on Bob — cancelling his cramp and reversing him.
      const mirror = await giveHeldPowerup(raceId, alice.userId, "MIRROR", 99902);
      assert.equal((await usePowerup(alice.token, raceId, mirror.id)).status, 200);
      const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 99903);
      const reflectRes = await usePowerup(bob.token, raceId, wt.id, alice.userId);
      assert.equal(reflectRes.status, 200);
      assert.equal((await reflectRes.json()).result.outcome, "REFLECTED");

      // Scoring reads EXPIRED rows too and freezes over [startsAt, expiresAt],
      // so the cancel must close the window, not just flip status.
      const cancelledCramp = await prisma.raceActiveEffect.findFirst({
        where: { id: crampEffect.id },
      });
      assert.ok(
        cancelledCramp.expiresAt.getTime() <= Date.now(),
        "cancelled cramp's expiresAt must be truncated to the cancel moment"
      );

      // Rewind the story 70 minutes: cramp cast + cancelled 70min ago, wrong
      // turn ran 70→40min ago. Bob then walks 30min ago → now, after both.
      const shiftMs = 70 * 60 * 1000;
      await prisma.raceActiveEffect.update({
        where: { id: cancelledCramp.id },
        data: {
          startsAt: new Date(cancelledCramp.startsAt.getTime() - shiftMs),
          expiresAt: new Date(cancelledCramp.expiresAt.getTime() - shiftMs),
        },
      });
      const wtEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "WRONG_TURN" },
      });
      await prisma.raceActiveEffect.update({
        where: { id: wtEffect.id },
        data: { startsAt: minutesAgo(70), expiresAt: minutesAgo(40), status: "EXPIRED" },
      });

      await recordSamples(bob.token, [
        { periodStart: minutesAgo(30).toISOString(), periodEnd: new Date().toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // With the stale-window bug the cancelled cramp still freezes these
      // steps (total 0) and reports a frozen multiplier with no visible effect.
      assert.equal(bobP.totalSteps, 1000, "steps after both effects ended must count in full");
      assert.equal(bobP.currentMultiplier, 1, "no phantom frozen multiplier after cancellation");
    });

    it("wrong turn during runners high — overlapping steps reversed not buffed", async () => {
      const alice = await createUser("AliceInterBB");
      const bob = await createUser("BobInterBBBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob activates Runner's High
      const rh = await giveHeldPowerup(raceId, bob.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(bob.token, raceId, rh.id);

      // Alice applies Wrong Turn to bob (both effects active)
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Backdate both effects so samples fall inside them
      const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, targetUserId: bob.userId } });
      for (const e of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: e.id },
          data: { startsAt: hoursAgo(2), expiresAt: hoursAgo(0.5) },
        });
      }

      // Bob walks during both effects (1.5h-1h ago)
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 1000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      // Wrong Turn + Runner's High overlap: steps are reversed, not buffed
      // total should be 0 (all steps penalized)
      assert.equal(bobP.totalSteps, 0);
    });

    it("blocked by compression socks", async () => {
      const alice = await createUser("AliceInterCC");
      const bob = await createUser("BobInterCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Bob activates shield
      const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901);
      await usePowerup(bob.token, raceId, shield.id);

      // Alice uses wrong turn
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99902);
      const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
      assert.equal(res.status, 200);

      const body = await res.json();
      assert.equal(body.result.blocked, true);

      // Bob walks — steps should count normally (no wrong turn effect)
      await recordSamples(bob.token, [
        { periodStart: minutesAgo(10).toISOString(), periodEnd: new Date().toISOString(), steps: 3000 },
      ]);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 3000);
    });
  });

  // === EDGE CASES ===

  describe("edge cases", () => {
    it("bonus steps not affected by wrong turn reversal", async () => {
      const alice = await createUser("AliceEdgeAAA");
      const bob = await createUser("BobEdgeAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      // Alice applies wrong turn to bob
      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Bob uses protein shake during wrong turn — bonus should still count
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 99902);
      await usePowerup(bob.token, raceId, shake.id);

      const progress = await getProgress(alice.token, raceId);
      const bobP = findUser(progress, bob.userId);
      assert.equal(bobP.totalSteps, 1500);
    });
  });

  // === FEED ===

  describe("feed", () => {
    it("shows usage and expiry events", async () => {
      const alice = await createUser("AliceFeedAAA");
      const bob = await createUser("BobFeedAAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99901);
      await usePowerup(alice.token, raceId, wt.id, bob.userId);

      // Force expiry
      const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "WRONG_TURN" } });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: minutesAgo(1) },
      });
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 1, date: new Date().toISOString().slice(0, 10) },
        token: alice.token,
      });
      await drainRaceResolution();

      const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
      const feedBody = await feedRes.json();

      const useEvent = feedBody.events.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "WRONG_TURN"
      );
      const expiryEvent = feedBody.events.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "WRONG_TURN"
      );
      assert.ok(useEvent, "feed should have usage event");
      assert.ok(expiryEvent, "feed should have expiry event");
      assert.ok(useEvent.description.includes("Wrong Turn"));
    });
  });
});

})();


// ---- consolidated from powerups-cramp-wrongturn-conflict.test.js ----
(function powerups_cramp_wrongturn_conflict_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("../setup");

// ---------------------------------------------------------------------------
// Leg Cramp × Wrong Turn mutual exclusion (owner decision 2026-07-29).
//
// A target can never carry BOTH a freeze and a reversal:
//   * DIRECT uses of either type on a target with the other active are
//     rejected with a 400 validation error (item stays HELD, nothing consumed,
//     the existing effect untouched). This REPLACES the old shipped behavior
//     where a direct Wrong Turn silently cancelled the target's Leg Cramp.
//   * INDIRECT landings (Mirror reflect / Decoy redirect) keep cancel
//     semantics — the conflicting effect on the landing target is
//     truncated-expired — so a hidden conflict never wastes the shield or
//     violates the invariant.
//
// End-to-end through the real /use endpoint; the error message must be
// user-facing because frozen clients render it verbatim (powerupUseErrorCopy
// falls through to the server message for unknown codes).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-conflict-${++nextAppleId}`;
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

async function createActiveRace(creator, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Cramp WT Conflict Test",
      targetSteps: 200000,
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
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type,
      rarity: type === "MIRROR" ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { body: targetUserId ? { targetUserId } : {}, token }
  );
}

async function activeEffects(raceId, targetUserId, type) {
  return prisma.raceActiveEffect.findMany({
    where: { raceId, targetUserId, type, status: "ACTIVE" },
  });
}

describe("Leg Cramp × Wrong Turn mutual exclusion", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("direct Wrong Turn on a cramped target is rejected; the cramp keeps running", async () => {
    const alice = await createUser("AliceConfA");
    const bob = await createUser("BobConfA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5001);
    assert.equal((await usePowerup(alice.token, raceId, cramp.id, bob.userId)).status, 200);
    const [crampEffect] = await activeEffects(raceId, bob.userId, "LEG_CRAMP");
    assert.ok(crampEffect);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5002);
    const res = await usePowerup(alice.token, raceId, wt.id, bob.userId);
    assert.equal(res.status, 400);
    const body = await res.json();
    // Frozen clients render this message verbatim — it must be user-facing.
    assert.match(body.error, /Leg Cramp/);
    assert.equal(body.code, "TARGET_EFFECT_CONFLICT");

    // The cramp is untouched: still ACTIVE, window not truncated.
    const after = await prisma.raceActiveEffect.findUnique({ where: { id: crampEffect.id } });
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.expiresAt.getTime(), crampEffect.expiresAt.getTime());

    // No Wrong Turn effect was created and the item stays HELD.
    assert.equal((await activeEffects(raceId, bob.userId, "WRONG_TURN")).length, 0);
    const item = await prisma.racePowerup.findUnique({ where: { id: wt.id } });
    assert.equal(item.status, "HELD");
  });

  it("direct Leg Cramp on a wrong-turned target is rejected; the reversal keeps running", async () => {
    const alice = await createUser("AliceConfB");
    const bob = await createUser("BobConfB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    const wt = await giveHeldPowerup(raceId, alice.userId, "WRONG_TURN", 5001);
    assert.equal((await usePowerup(alice.token, raceId, wt.id, bob.userId)).status, 200);
    const [wtEffect] = await activeEffects(raceId, bob.userId, "WRONG_TURN");
    assert.ok(wtEffect);

    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5002);
    const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Wrong Turn/);
    assert.equal(body.code, "TARGET_EFFECT_CONFLICT");

    const after = await prisma.raceActiveEffect.findUnique({ where: { id: wtEffect.id } });
    assert.equal(after.status, "ACTIVE");
    assert.equal(after.expiresAt.getTime(), wtEffect.expiresAt.getTime());

    assert.equal((await activeEffects(raceId, bob.userId, "LEG_CRAMP")).length, 0);
    const item = await prisma.racePowerup.findUnique({ where: { id: cramp.id } });
    assert.equal(item.status, "HELD");
  });

  it("a reflected Leg Cramp landing on an attacker with an active Wrong Turn cancels the reversal (invariant holds, mirror not wasted)", async () => {
    const alice = await createUser("AliceConfC");
    const bob = await createUser("BobConfC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob]);

    // Bob reverses Alice, then arms a Mirror.
    const wt = await giveHeldPowerup(raceId, bob.userId, "WRONG_TURN", 5001);
    assert.equal((await usePowerup(bob.token, raceId, wt.id, alice.userId)).status, 200);
    const [aliceWT] = await activeEffects(raceId, alice.userId, "WRONG_TURN");
    assert.ok(aliceWT);
    const mirror = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 5002);
    assert.equal((await usePowerup(bob.token, raceId, mirror.id)).status, 200);

    // Alice cramps Bob (Bob is clean, so the direct pre-check passes) — the
    // Mirror reflects it back onto Alice, who has an active Wrong Turn.
    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 5003);
    const res = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.outcome, "REFLECTED");

    // Invariant: Alice now carries the cramp and her Wrong Turn was cancelled
    // with a truncated window (scoring reads EXPIRED rows over
    // [startsAt, expiresAt], so status-only cancels leave phantom effects).
    assert.equal((await activeEffects(raceId, alice.userId, "LEG_CRAMP")).length, 1);
    assert.equal((await activeEffects(raceId, alice.userId, "WRONG_TURN")).length, 0);
    const cancelledWT = await prisma.raceActiveEffect.findUnique({ where: { id: aliceWT.id } });
    assert.equal(cancelledWT.status, "EXPIRED");
    assert.ok(
      cancelledWT.expiresAt.getTime() <= Date.now(),
      "cancelled Wrong Turn's expiresAt must be truncated to the cancel moment"
    );
  });
});

})();


// ---- consolidated from red-card-cap.test.js ----
(function red_card_cap_test_js(){
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const path = require("node:path");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("../setup");

let server;
const MODERN = { "X-Client-Features": "characters,team_races,powerups5,resolved_impact_events_v2" };
const LEGACY = { "X-Client-Features": "characters" };

async function fixture(scores, { team = false } = {}) {
  const users = [];
  for (let i = 0; i < scores.length; i++) users.push(await createTestUser({ displayName: `CapRunner${i}` }));
  const startedAt = new Date(Date.now() - 3600000);
  const race = await prisma.race.create({ data: {
    creatorId: users[0].user.id, name: "Red Card cap", status: "ACTIVE",
    targetSteps: 1000000, startedAt, endsAt: new Date(Date.now() + 86400000),
    powerupsEnabled: true, isTeamRace: team, ...(team ? { teamSize: 2, teamAName: "A", teamBName: "B" } : {}),
  } });
  await prisma.raceParticipant.createMany({ data: users.map(({ user }, i) => ({
    raceId: race.id, userId: user.id, status: "ACCEPTED", joinedAt: startedAt,
    totalSteps: scores[i], bonusSteps: scores[i], ...(team ? { team: i < 2 ? "TEAM_A" : "TEAM_B" } : {}),
  })) });
  let earned = 900000;
  async function held(i, type = "RED_CARD") {
    const p = await prisma.raceParticipant.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: users[i].user.id } } });
    return prisma.racePowerup.create({ data: { raceId: race.id, userId: p.userId, participantId: p.id, type, rarity: "RARE", status: "HELD", earnedAtSteps: ++earned } });
  }
  async function use(i, card, headers = MODERN) {
    return request(server.baseUrl, "POST", `/races/${race.id}/powerups/${card.id}/use`, { token: users[i].token, body: {}, headers });
  }
  async function defend(i, type) {
    const card = await held(i, type);
    const res = await use(i, card);
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    return card;
  }
  async function checkLoss(i, loss, headers = MODERN) {
    const p = await prisma.raceParticipant.findUniqueOrThrow({ where: { raceId_userId: { raceId: race.id, userId: users[i].user.id } } });
    assert.equal(p.totalSteps, scores[i] - loss);
    assert.equal(p.bonusSteps, scores[i] - loss);
    const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, { token: users[i].token, headers });
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.participants.find(p => p.userId === users[i].user.id).totalSteps, scores[i] - loss);
    return progress;
  }
  async function checkEvent(i, penalty) {
    const events = await prisma.racePowerupEvent.findMany({ where: { raceId: race.id, powerupType: "RED_CARD", eventType: "POWERUP_USED", targetUserId: users[i].user.id } });
    assert.equal(events.length, 1);
    assert.equal(events[0].metadata.penalty, penalty);
    const impacts = await prisma.raceImpactEvent.findMany({ where: { raceId: race.id, recipientUserId: users[i].user.id, powerupType: "RED_CARD" } });
    if (penalty > 0) {
      assert.equal(impacts.length, 1);
      assert.equal(impacts[0].deltaSteps, -penalty);
    }
    const feed = await request(server.baseUrl, "GET", `/races/${race.id}/feed`, { token: users[i].token, headers: MODERN });
    assert.equal(feed.status, 200);
    const event = (await feed.json()).events.find(e => e.id === events[0].id);
    assert.ok(event);
    assert.ok(event.description.includes(`${penalty.toLocaleString()} steps`));
  }
  return { users, race, held, use, defend, checkLoss, checkEvent };
}

describe("Red Card 10,000 step cap through real HTTP", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  for (const [score, penalty] of [[4, 0], [5, 1], [1555, 156], [50000, 5000], [99994, 9999], [99995, 10000], [100000, 10000], [100004, 10000], [100005, 10000], [200000, 10000]]) {
    it(`score ${score} loses ${penalty}, matching durable state and public feed`, async () => {
      const f = await fixture([0, score]);
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(1, penalty);
      await f.checkEvent(1, penalty);
    });
  }

  it("legacy request keeps the result envelope and capped penalty without any new parameter", async () => {
    const f = await fixture([500, 200000]);
    const res = await f.use(0, await f.held(0), LEGACY);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["result"]);
    assert.equal(body.result.outcome, "APPLIED");
    assert.equal(body.result.penalty, 10000);
    await f.checkLoss(1, 10000, LEGACY);
    await f.checkEvent(1, 10000);
  });

  for (const score of [0, 50000, 150000]) {
    it(`Mirror calculates against the final recipient's ${score} steps`, async () => {
      const f = await fixture([score, 200000]);
      await f.defend(1, "MIRROR");
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      const penalty = Math.min(10000, Math.round(score * 0.1));
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(0, penalty);
      await f.checkLoss(1, 0);
      await f.checkEvent(0, penalty);
    });
  }

  for (const score of [50000, 150000]) {
    it(`Decoy calculates against redirected recipient's ${score} steps`, async () => {
      const f = await fixture([500, 200000, score]);
      await f.defend(1, "DECOY");
      const res = await f.use(0, await f.held(0));
      assert.equal(res.status, 200);
      const body = await res.json();
      const penalty = Math.min(10000, Math.round(score * 0.1));
      assert.equal(body.result.penalty, penalty);
      await f.checkLoss(1, 0);
      await f.checkLoss(2, penalty);
      await f.checkEvent(2, penalty);
    });
  }

  for (const defense of ["COMPRESSION_SOCKS", "DECOY"]) {
    it(`${defense} still blocks a high-score attack without deducting steps`, async () => {
      const f = await fixture([500, 200000]);
      await f.defend(1, defense);
      const card = await f.held(0);
      const res = await f.use(0, card);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result.blocked, true);
      await f.checkLoss(1, 0);
      assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: card.id } })).status, "USED");
    });
  }

  it("distinct cards each cap at 10k and concurrent duplicate retries consume one card once", async () => {
    const f = await fixture([500, 200000]);
    const card = await f.held(0);
    const responses = await Promise.all([f.use(0, card), f.use(0, card)]);
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.ok(responses.some(r => r.status >= 400 && r.status < 500));
    const successful = await responses.find(r => r.status === 200).json();
    assert.equal(successful.result.penalty, 10000);
    await f.checkLoss(1, 10000);
    await f.checkEvent(1, 10000);
    const second = await f.use(0, await f.held(0));
    assert.equal(second.status, 200);
    assert.equal((await second.json()).result.penalty, 10000);
    await f.checkLoss(1, 20000);
  });

  it("concurrent distinct cards preserve nonnegative low scores and actual-loss conservation", async () => {
    const f = await fixture([0, 5, 0]);
    const cards = [await f.held(0), await f.held(2)];
    const responses = await Promise.all([f.use(0, cards[0]), f.use(2, cards[1])]);
    let loss = 0;
    for (const response of responses) {
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.result.penalty >= 0 && body.result.penalty <= 1);
      loss += body.result.penalty;
    }
    assert.ok(loss <= 5);
    await f.checkLoss(1, loss);
  });

  it("team mode subtracts one capped individual loss from only the enemy team", async () => {
    const f = await fixture([500, 1000, 200000, 150000], { team: true });
    const res = await f.use(0, await f.held(0));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result.penalty, 10000);
    const progress = await f.checkLoss(2, 10000);
    await f.checkLoss(3, 0);
    await f.checkEvent(2, 10000);
    assert.equal(progress.teams.teamB.totalSteps, 340000);
    assert.equal(progress.teams.teamA.totalSteps, 1500);
  });
  it("the deployment copy sync exposes the cap through the current and legacy catalog", async () => {
    execFileSync(process.execPath, ["scripts/powerup-copy-sync.js", "--apply"], { env: process.env, stdio: "pipe" });
    for (const headers of [MODERN, LEGACY]) {
      const res = await request(server.baseUrl, "GET", "/powerups/catalog", { headers });
      assert.equal(res.status, 200);
      const body = await res.json();
      const redCard = body.powerups.find(p => p.type === "RED_CARD");
      assert.equal(redCard.description, "Remove 10% of the leader's steps, up to 10,000 steps.");
    }
  });

  it("a real queued worker replays a historical 20k penalty unchanged alongside a new capped attack", async () => {
    const f = await fixture([500, 180000]);
    const t = f.race.startedAt.getTime();
    await prisma.racePowerupEvent.createMany({ data: [
      { raceId: f.race.id, actorUserId: f.users[1].user.id, eventType: "POWERUP_USED", powerupType: "PROTEIN_SHAKE", description: "Historical bonus", metadata: { bonus: 200000 }, createdAt: new Date(t + 1000) },
      { raceId: f.race.id, actorUserId: f.users[0].user.id, targetUserId: f.users[1].user.id, eventType: "POWERUP_USED", powerupType: "RED_CARD", description: "Historical Red Card: lost 20,000 steps.", metadata: { penalty: 20000 }, createdAt: new Date(t + 2000) },
    ] });
    const response = await f.use(0, await f.held(0));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.penalty, 10000);
    const env = { ...process.env, RACE_QUEUE_V2_QUIET_PERIOD_MS: "0" };
    delete env.NODE_TEST_CONTEXT;
    const worker = await new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, "../../scripts/test-race-resolution-worker-once.js"), [], { env, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      let result;
      child.on("message", value => { result = value; });
      child.on("error", reject);
      child.on("exit", code => code === 0 && !result?.error ? resolve(result) : reject(new Error(result?.error || `worker exit ${code}`)));
    });
    assert.equal(worker.claimed, true);
    await f.checkLoss(1, 10000);
    const feed = await request(server.baseUrl, "GET", `/races/${f.race.id}/feed`, { token: f.users[1].token, headers: LEGACY });
    assert.equal(feed.status, 200);
    assert.ok((await feed.json()).events.some(e => e.description === "Historical Red Card: lost 20,000 steps."));
    const oldEvent = await prisma.racePowerupEvent.findFirstOrThrow({ where: { raceId: f.race.id, powerupType: "RED_CARD", createdAt: new Date(t + 2000) } });
    assert.equal(oldEvent.metadata.penalty, 20000);
  });

});

})();


// ---- consolidated from quicksand-powerup.test.js ----
(function quicksand_powerup_test_js(){
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, createTestUser } = require("../setup");
const { RaceActiveEffect } = require("../../../src/modules/powerups/models/raceActiveEffect");
const { buildHistoricalRaceReconciliationWorker } = require("../../../src/modules/races/jobs/historicalRaceReconciliation");
const { StepSample } = require("../../../src/modules/steps/models/stepSample");
const { computeEffectModifiers } = require("../../../src/modules/races/services/effectiveStepScoring");
const { computeHitchhikeCopiedSteps } = require("../../../src/modules/powerups/hitchhikeCopies");
let server;
const P4 = { "X-Client-Features": "powerups4", "X-Release-Channel": "testflight" };

// isPublic keeps the race ineligible for private-race auto-start, so this
// helper keeps starting the race through the manual POST /races/:id/start.
async function activeRace(users) {
  for (const user of users.slice(1)) {
    const sent = await request(server.baseUrl, "POST", "/friends/request", { token: users[0].token, body: { addresseeId: user.user.id } });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { token: user.token, body: { accept: true } });
  }
  const made = await request(server.baseUrl, "POST", "/races", { token: users[0].token, body: { name: "Quicksand Integration", maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000, isPublic: true } });
  const raceId = (await made.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { token: users[0].token, body: { inviteeIds: users.slice(1).map((u) => u.user.id) } });
  for (const user of users.slice(1)) await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { token: user.token, body: { accept: true } });
  const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: users[0].token });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  return raceId;
}

async function held(raceId, userId, earnedAtSteps = Math.floor(Math.random() * 1000000000)) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({ data: { raceId, participantId: participant.id, userId, type: "QUICKSAND", rarity: "RARE", status: "HELD", earnedAtSteps } });
}

async function makeGold(userId) {
  const identity = await prisma.billingIdentity.create({ data: { userId } });
  await prisma.billingSubscription.create({
    data: {
      id: `quicksand-gold-${userId}`,
      identityId: identity.id,
      productId: "bara_plus_weekly_v1",
      startsAt: new Date(),
      periodStartsAt: new Date(),
      accessUntil: new Date(Date.now() + 86400000),
      givesAccess: true,
      benefitContract: "bara_gold_v1",
      observedAt: new Date(),
    },
  });
}

const HISTORICAL_START = new Date("2026-09-16T10:00:00.000Z");
const HISTORICAL_END = new Date("2026-09-16T23:00:00.000Z");

async function historicalFixture({ status = "COMPLETED", users = 1 } = {}) {
  const accounts = await Promise.all(Array.from({ length: users }, () => createTestUser()));
  const race = await prisma.race.create({
    data: {
      creatorId: accounts[0].user.id,
      name: "Dedicated Quicksand history",
      targetSteps: 100000,
      status,
      startedAt: HISTORICAL_START,
      endsAt: HISTORICAL_END,
      completedAt: status === "COMPLETED" ? HISTORICAL_END : null,
      timezone: "UTC",
      powerupsEnabled: true,
      timeBased: true,
      maxDurationDays: 1,
    },
  });
  const participants = [];
  for (const account of accounts) {
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: account.user.id,
        status: "ACCEPTED",
        joinedAt: HISTORICAL_START,
        totalSteps: 0,
        rawSteps: 0,
      },
    });
    await prisma.userScoringInputVersion.create({
      data: { userId: account.user.id, generation: 2 },
    });
    participants.push(participant);
  }
  return { accounts, race, participants };
}

async function historicalEffect(data, participantIndex, type, startsAt, expiresAt, metadata = {}, sourceParticipantIndex = 0) {
  const account = data.accounts[participantIndex];
  const participant = data.participants[participantIndex];
  const source = data.accounts[sourceParticipantIndex];
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId: data.race.id,
      participantId: data.participants[sourceParticipantIndex].id,
      userId: source.user.id,
      type,
      rarity: "RARE",
      status: "USED",
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId: data.race.id,
      targetParticipantId: participant.id,
      targetUserId: account.user.id,
      sourceUserId: source.user.id,
      powerupId: powerup.id,
      type,
      status: "EXPIRED",
      startsAt,
      expiresAt,
      metadata,
    },
  });
}

async function historicalSamples(userId, rows) {
  await prisma.stepSample.createMany({
    data: rows.map(([periodStart, periodEnd, steps]) => ({
      userId,
      periodStart,
      periodEnd,
      steps,
      sourceName: "healthkit",
    })),
  });
}

async function queueHistorical(data, changedStart = HISTORICAL_START, changedEnd = HISTORICAL_END, generation = 2, userIndex = 0) {
  const account = data.accounts[userIndex];
  return prisma.historicalRaceReconciliationIntent.upsert({
    where: { raceId_userId: { raceId: data.race.id, userId: account.user.id } },
    create: {
      raceId: data.race.id,
      userId: account.user.id,
      changedStart,
      changedEnd,
      requestedSourceGeneration: generation,
      phase2Eligible: true,
      createdAt: new Date("2026-09-16T23:01:00.000Z"),
    },
    update: {
      changedStart,
      changedEnd,
      requestedSourceGeneration: generation,
      phase2Eligible: true,
      status: "QUEUED",
      availableAt: new Date("2026-09-16T23:01:00.000Z"),
    },
  });
}

async function reconcileHistorical() {
  return buildHistoricalRaceReconciliationWorker({
    now: () => new Date("2026-09-16T23:02:00.000Z"),
    logger: { log() {}, warn() {}, error(error) { throw error; } },
  }).runOnce();
}

async function seedQuicksandCatalog() {
  await prisma.powerupShopItem.upsert({
    where: { sku: "POWERUP_QUICKSAND" },
    update: { active: true, dailyRewardEligible: true, testOnly: false },
    create: {
      sku: "POWERUP_QUICKSAND",
      name: "Quicksand",
      description: "Freeze three",
      priceCoins: 300,
      powerupType: "QUICKSAND",
      active: true,
      testOnly: false,
      dailyRewardEligible: true,
      sortOrder: 99,
    },
  });
}

describe("Quicksand real HTTP contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("purchases for 300, redeems, and resolves three ordered targets independently", async () => {
    const users = await Promise.all([0, 1, 2, 3].map(() => createTestUser()));
    await makeGold(users[0].user.id);
    await prisma.user.update({ where: { id: users[0].user.id }, data: { coins: 300 } });
    await prisma.powerupShopItem.upsert({ where: { sku: "POWERUP_QUICKSAND" }, update: {}, create: { sku: "POWERUP_QUICKSAND", name: "Quicksand", description: "Freeze three", priceCoins: 300, powerupType: "QUICKSAND", active: true, testOnly: true, sortOrder: 99 } });
    const purchase = await request(server.baseUrl, "POST", "/shop/powerups/purchase", { token: users[0].token, headers: { ...P4, "Idempotency-Key": "quicksand-buy-1" }, body: { powerupType: "QUICKSAND" } });
    assert.equal(purchase.status, 200);
    assert.equal((await purchase.json()).purchase.coinsSpent, 255, "Gold receives the 15% member discount");
    const raceId = await activeRace(users);
    const redeem = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, { token: users[0].token, headers: P4, body: { powerupType: "QUICKSAND" } });
    const redeemBody = await redeem.json();
    assert.equal(redeem.status, 200, JSON.stringify(redeemBody));
    const powerupId = redeemBody.result.powerup.id;
    const shielded = await prisma.raceParticipant.findFirst({ where: { raceId, userId: users[2].user.id } });
    const socks = await prisma.racePowerup.create({ data: {
      raceId, participantId: shielded.id, userId: users[2].user.id,
      type: "COMPRESSION_SOCKS", rarity: "UNCOMMON", status: "USED",
      earnedAtSteps: 87654321, usedAt: new Date(),
    } });
    await RaceActiveEffect.create({ raceId, targetParticipantId: shielded.id, targetUserId: users[2].user.id, sourceUserId: users[2].user.id, powerupId: socks.id, type: "COMPRESSION_SOCKS", startsAt: new Date(), expiresAt: new Date(Date.now() + 3600000) });
    const ids = users.slice(1).map((u) => u.user.id);
    const used = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: ids } });
    assert.equal(used.status, 200);
    const result = (await used.json()).result;
    assert.equal(result.outcome, "PARTIAL"); assert.equal(result.durationMs, 3600000);
    assert.deepEqual(result.targetResults.map((r) => [r.targetUserId, r.outcome]), [[ids[0], "APPLIED"], [ids[1], "BLOCKED"], [ids[2], "APPLIED"]]);
    const effects = await prisma.raceActiveEffect.findMany({ where: { raceId, type: "QUICKSAND" }, orderBy: { targetUserId: "asc" } });
    assert.equal(effects.length, 2);
    for (const effect of effects) {
      assert.equal(effect.sourceUserId, users[0].user.id);
      assert.equal(effect.status, "ACTIVE");
      assert.equal(effect.expiresAt.getTime() - effect.startsAt.getTime(), 3600000);
      assert.equal(effect.metadata.stepsAtFreezeStart, 0);
    }
  });

  it("rejects malformed and legacy requests without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users); const item = await held(raceId, users[0].user.id);
    for (const [headers, body] of [[P4, { targetUserIds: [] }], [P4, { targetUserIds: [users[1].user.id, users[1].user.id] }], [{}, { targetUserIds: [users[1].user.id] }]]) {
      const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, { token: users[0].token, headers, body });
      assert.equal(res.status, 400);
    }
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: item.id } })).status, "HELD");
  });

  it("serializes concurrent freezes and preserves the losing item", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users); const [a, b] = await Promise.all([held(raceId, users[0].user.id), held(raceId, users[0].user.id)]);
    const use = (id) => request(server.baseUrl, "POST", `/races/${raceId}/powerups/${id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    const responses = await Promise.all([use(a.id), use(b.id)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
    const rows = await prisma.racePowerup.findMany({ where: { id: { in: [a.id, b.id] } } });
    assert.deepEqual(rows.map((r) => r.status).sort(), ["HELD", "USED"]);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId, type: "QUICKSAND", status: "ACTIVE" } }), 1);
  });

  it("rejects self, cross-race, and already-frozen targets without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    const raceId = await activeRace(users.slice(0, 2));
    const otherRaceId = await activeRace([users[0], users[2]]);
    const self = await held(raceId, users[0].user.id);
    const selfRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${self.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[0].user.id] } });
    assert.equal(selfRes.status, 400);
    assert.equal((await selfRes.json()).code, "INVALID_TARGETS");

    const crossRace = await held(raceId, users[0].user.id);
    const crossRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${crossRace.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[2].user.id] } });
    assert.equal(crossRes.status, 400);
    assert.equal((await crossRes.json()).code, "INVALID_TARGET");

    const first = await held(raceId, users[0].user.id);
    const firstRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${first.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    assert.equal(firstRes.status, 200);
    const second = await held(raceId, users[0].user.id);
    const secondRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${second.id}/use`, { token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] } });
    assert.equal(secondRes.status, 400);
    assert.equal((await secondRes.json()).code, "TARGET_ALREADY_FROZEN");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: second.id } })).status, "HELD");
    assert.ok(otherRaceId);
  });

  it("rejects a nonexistent target and an inactive race without consuming", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const missing = await held(raceId, users[0].user.id);
    const missingResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${missing.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: ["00000000-0000-0000-0000-000000000000"] },
    });
    assert.equal(missingResponse.status, 400);
    assert.equal((await missingResponse.json()).code, "INVALID_TARGET");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: missing.id } })).status, "HELD");

    const inactive = await held(raceId, users[0].user.id);
    await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED", completedAt: new Date() } });
    const inactiveResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${inactive.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: [users[1].user.id] },
    });
    assert.equal(inactiveResponse.status, 400);
    const inactiveBody = await inactiveResponse.json();
    assert.match(String(inactiveBody.code || inactiveBody.error || ""), /RACE|ACTIVE|ended/i);
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: inactive.id } })).status, "HELD");
  });

  it("rejects a second source targeting the same frozen participant", async () => {
    const users = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const first = await held(raceId, users[0].user.id);
    const second = await held(raceId, users[1].user.id);
    const firstResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${first.id}/use`, {
      token: users[0].token, headers: P4, body: { targetUserIds: [users[2].user.id] },
    });
    assert.equal(firstResponse.status, 200);
    const secondResponse = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${second.id}/use`, {
      token: users[1].token, headers: P4, body: { targetUserIds: [users[2].user.id] },
    });
    assert.equal(secondResponse.status, 400);
    assert.equal((await secondResponse.json()).code, "TARGET_ALREADY_FROZEN");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: first.id } })).status, "USED");
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: second.id } })).status, "HELD");
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId, type: "QUICKSAND" } }), 1);
  });

  it("records exact historical before, during, and after freeze boundaries", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND",
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T12:00:00Z"),
      { stepsAtFreezeStart: 0 },
    );
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T09:59:00Z"), new Date("2026-09-16T10:00:00Z"), 100],
      [new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T10:30:00Z"), 100],
      [new Date("2026-09-16T10:30:00Z"), new Date("2026-09-16T11:30:00Z"), 200],
      [new Date("2026-09-16T11:30:00Z"), new Date("2026-09-16T12:00:00Z"), 100],
      [new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T12:30:00Z"), 100],
    ]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(projection.currentDeltaSteps, -400, "only the 400 steps inside [10:00,12:00) are frozen");
  });

  it("preserves partial-overlap semantics at the start and expiry boundaries", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND",
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T12:00:00Z"),
      { stepsAtFreezeStart: 0 },
    );
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T09:30:00Z"), new Date("2026-09-16T10:30:00Z"), 600],
      [new Date("2026-09-16T11:30:00Z"), new Date("2026-09-16T12:30:00Z"), 600],
    ]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(projection.currentDeltaSteps, -600, "each half-overlapping sample contributes only its in-window half");
  });

  it("is invariant to one large, several small, or many tiny samples", async () => {
    const cases = [
      [[new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), 1000]],
      Array.from({ length: 10 }, (_, index) => [
        new Date(Date.parse("2026-09-16T10:00:00Z") + index * 6 * 60 * 1000),
        new Date(Date.parse("2026-09-16T10:00:00Z") + (index + 1) * 6 * 60 * 1000),
        100,
      ]),
      Array.from({ length: 1000 }, (_, index) => [
        new Date(Date.parse("2026-09-16T10:00:00Z") + index * 3600),
        new Date(Date.parse("2026-09-16T10:00:00Z") + (index + 1) * 3600),
        1,
      ]),
    ];
    const projections = [];
    for (const rows of cases) {
      const data = await historicalFixture();
      const effect = await historicalEffect(
        data, 0, "QUICKSAND",
        new Date("2026-09-16T10:00:00Z"),
        new Date("2026-09-16T11:00:00Z"),
        { stepsAtFreezeStart: 0 },
      );
      await historicalSamples(data.accounts[0].user.id, rows);
      await queueHistorical(data);
      await reconcileHistorical();
      const projection = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
      projections.push(projection.currentDeltaSteps);
    }
    assert.deepEqual(projections, [-1000, -1000, -1000]);
  });

  it("reconciles both upward and downward late historical corrections without double application", async () => {
    const data = await historicalFixture();
    const effect = await historicalEffect(
      data, 0, "QUICKSAND", HISTORICAL_START,
      new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 },
    );
    const row = [HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 800];
    await historicalSamples(data.accounts[0].user.id, [row]);
    await queueHistorical(data);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -800);

    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 1000 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 3 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 3);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -1000);

    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 600 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 4 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 4);
    assert.equal((await reconcileHistorical()).corrected, 1);
    assert.equal((await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).currentDeltaSteps, -600);
    assert.equal(await prisma.historicalEffectCorrection.count({ where: { projectionId: (await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } })).id } }), 3);
    assert.equal((await reconcileHistorical()).claimed, 0, "a repeated reconciliation is a no-op");
  });

  it("uses freeze precedence over Runner's High for the same target window", async () => {
    const data = await historicalFixture();
    const quicksand = await historicalEffect(data, 0, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const runnersHigh = await historicalEffect(data, 0, "RUNNERS_HIGH", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtBuffStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand, runnersHigh], 1000, data.accounts[0].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    assert.equal(modifiers.frozenSteps, 1000, "Quicksand freeze precedence cancels Runner's High in the overlap");
    assert.equal(modifiers.buffedSteps, 0, "Runner's High contributes no boost while frozen");
  });

  it("keeps sequential Quicksand windows separate and prevents expiry bleed", async () => {
    const data = await historicalFixture();
    const first = await historicalEffect(data, 0, "QUICKSAND", new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const second = await historicalEffect(data, 0, "QUICKSAND", new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T13:00:00Z"), { stepsAtFreezeStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [
      [new Date("2026-09-16T10:00:00Z"), new Date("2026-09-16T11:00:00Z"), 100],
      [new Date("2026-09-16T11:00:00Z"), new Date("2026-09-16T12:00:00Z"), 200],
      [new Date("2026-09-16T12:00:00Z"), new Date("2026-09-16T13:00:00Z"), 300],
      [new Date("2026-09-16T13:00:00Z"), new Date("2026-09-16T14:00:00Z"), 400],
    ]);
    await queueHistorical(data);
    await reconcileHistorical();
    const rows = await prisma.historicalEffectContribution.findMany({ where: { effectId: { in: [first.id, second.id] } } });
    assert.equal(rows.find((row) => row.effectId === first.id).currentDeltaSteps, -100);
    assert.equal(rows.find((row) => row.effectId === second.id).currentDeltaSteps, -300);
  });

  it("documents Quicksand plus Hitchhike as post-effect target scoring", async () => {
    const data = await historicalFixture({ users: 2 });
    const target = data.participants[1];
    const quicksand = await historicalEffect(data, 1, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const hitchhike = await historicalEffect(data, 1, "HITCHHIKE", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { copyRatio: 0.5, scoringVersion: 2 }, 0);
    await historicalSamples(data.accounts[1].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand], 1000, data.accounts[1].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    const copied = await computeHitchhikeCopiedSteps(
      hitchhike, StepSample, new Date("2026-09-16T23:02:00Z"), {
        targetParticipantId: target.id,
        raceId: data.race.id,
        raceActiveEffectModel: RaceActiveEffect,
      },
    );
    assert.equal(modifiers.frozenSteps, 1000);
    assert.equal(copied, 0, "Hitchhike observes post-effect target steps");
  });

  it("keeps Quicksand + Leech freeze precedence deterministic", async () => {
    const data = await historicalFixture({ users: 2 });
    const quicksand = await historicalEffect(data, 1, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    const leech = await historicalEffect(data, 1, "LEECH", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { ratio: 2 }, 0);
    await historicalSamples(data.accounts[1].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 1000]]);
    const modifiers = await computeEffectModifiers(
      [quicksand, leech], 1000, data.accounts[1].user.id, StepSample, true, null,
      new Date("2026-09-16T11:00:00Z"),
    );
    assert.equal(modifiers.frozenSteps, 1000);
    assert.equal(modifiers.leechTransfers.length, 1);
    assert.equal(modifiers.leechTransfers[0].earnedTransfer, 0, "a frozen target has no eligible steps to leech");
  });

  it("keeps completed-race Quicksand history deterministic after late samples", async () => {
    const data = await historicalFixture({ status: "COMPLETED" });
    const effect = await historicalEffect(data, 0, "QUICKSAND", HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), { stepsAtFreezeStart: 0 });
    await historicalSamples(data.accounts[0].user.id, [[HISTORICAL_START, new Date("2026-09-16T11:00:00Z"), 900]]);
    await queueHistorical(data);
    await reconcileHistorical();
    const first = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(first.currentDeltaSteps, -900);
    await prisma.stepSample.updateMany({ where: { userId: data.accounts[0].user.id }, data: { steps: 1200 } });
    await prisma.userScoringInputVersion.update({ where: { userId: data.accounts[0].user.id }, data: { generation: 3 } });
    await queueHistorical(data, HISTORICAL_START, HISTORICAL_END, 3);
    await reconcileHistorical();
    const final = await prisma.historicalEffectContribution.findFirstOrThrow({ where: { effectId: effect.id } });
    assert.equal(final.currentDeltaSteps, -1200);
  });

  it("keeps Quicksand visible to free users but only eligible for Gold Daily Spin selection", async () => {
    await seedQuicksandCatalog();
    const free = await createTestUser();
    const gold = await createTestUser();
    await makeGold(gold.user.id);
    const headers = { "X-Client-Features": "spinPowerups,powerups4" };
    const path = `/daily-reward/status?localDate=2026-09-16`;
    const freeStatus = await request(server.baseUrl, "GET", path, { token: free.token, headers });
    const goldStatus = await request(server.baseUrl, "GET", path, { token: gold.token, headers });
    const freeBody = await freeStatus.json();
    const goldBody = await goldStatus.json();
    assert.equal(freeStatus.status, 200);
    assert.equal(goldStatus.status, 200);
    assert.ok(freeBody.box.powerupPool.some((item) => item.powerupType === "QUICKSAND"));
    assert.ok(!freeBody.box.eligiblePowerupTypes.includes("QUICKSAND"));
    assert.ok(goldBody.box.eligiblePowerupTypes.includes("QUICKSAND"));
  });

  it("keeps Quicksand out of in-race mystery-box drops while retaining its shop row", async () => {
    await seedQuicksandCatalog();
    const row = await prisma.powerupShopItem.findUniqueOrThrow({ where: { sku: "POWERUP_QUICKSAND" } });
    assert.equal(row.active, true);
    assert.equal(row.dailyRewardEligible, true);
    const { balanceConfig } = require("../../../src/modules/economy/balanceConfig");
    const config = await balanceConfig.getConfig();
    assert.ok(!Object.values(config.dropPool).some((pool) => pool.includes("QUICKSAND")));
  });

  it("allows a non-Gold user to use already-owned Quicksand", async () => {
    const users = await Promise.all([createTestUser(), createTestUser()]);
    const raceId = await activeRace(users);
    const item = await held(raceId, users[0].user.id);
    const response = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${item.id}/use`, {
      token: users[0].token,
      headers: P4,
      body: { targetUserIds: [users[1].user.id] },
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal((await prisma.racePowerup.findUniqueOrThrow({ where: { id: item.id } })).status, "USED");
  });
});

})();
