const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { eventBus } = require("../../src/shared/events/eventBus");

// Item 6 (2026-07-24): per-participant `currentMultiplier` on the progress
// payload (6a) + the high-multiplier push once per spike with re-arm (6b).

let server;
let nextAppleId = 0;
let alerts = [];

function createUser(displayName) {
  return (async () => {
    const appleId = `apple-fb724mult-${++nextAppleId}`;
    const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
    const body = await res.json();
    await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
    return { userId: body.user.id, token: body.sessionToken };
  })();
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: "Mult Test", targetSteps: 500000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: [bob.userId] }, token: alice.token });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: bob.token });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: twoHoursAgo } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: twoHoursAgo } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveBoxHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity: "UNCOMMON", status: "HELD", earnedAtSteps },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { body, token });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

function find(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

let seedSeq = 0;
// Seed an ACTIVE buff effect row (with a backing RacePowerup) directly, so the
// participant's multiplier can be driven to a precise value.
async function seedBuffEffect(raceId, part, type, metadata) {
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: part.id, userId: part.userId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: 800000 + seedSeq++ },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: part.id, targetUserId: part.userId, sourceUserId: part.userId,
      powerupId: pw.id, type, status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000), expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: metadata || {},
    },
  });
}

describe("feature batch 2026-07-24 — currentMultiplier + high-multiplier push", () => {
  before(async () => {
    server = await getSharedServer();
    eventBus.on("HIGH_MULTIPLIER_ALERT", (data) => alerts.push(data));
  });

  beforeEach(async () => {
    await cleanDatabase();
    // global_step_events survive cleanDatabase (no user FK) — clear them so a
    // leftover 2x window doesn't fold into another test's multiplier.
    await prisma.globalStepEvent.deleteMany({});
    nextAppleId = 0;
    alerts = [];
    delete process.env.HIGH_MULTIPLIER_PUSH_DISABLED;
    delete process.env.HIGH_MULTIPLIER_PUSH_THRESHOLD;
  });

  // ── 6a: currentMultiplier ──────────────────────────────────────────────────
  describe("6a — currentMultiplier per participant", () => {
    it("a Runner's High reads 2, and an active global 2x event doubles it to 4", async () => {
      const alice = await createUser("AliceMultA");
      const bob = await createUser("BobMultAAAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const rh = await giveBoxHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901);
      await usePowerup(alice.token, raceId, rh.id);

      let progress = await getProgress(alice.token, raceId);
      assert.equal(find(progress, alice.userId).currentMultiplier, 2);
      // Neutral bob reads 1.
      assert.equal(find(progress, bob.userId).currentMultiplier, 1);

      // A global 2x event active now folds in, doubling the magnitude.
      await prisma.globalStepEvent.create({
        data: { startsAt: new Date(Date.now() - 10 * 60 * 1000), endsAt: new Date(Date.now() + 20 * 60 * 1000), multiplier: 2 },
      });
      progress = await getProgress(alice.token, raceId);
      assert.equal(find(progress, alice.userId).currentMultiplier, 4);
      assert.equal(find(progress, bob.userId).currentMultiplier, 2);
    });

    it("a Leg-Cramped racer reads 0 and a Wrong-Turned racer reads negative", async () => {
      const alice = await createUser("AliceMultB");
      const bob = await createUser("BobMultBBBB");
      await makeFriends(alice, bob);

      // Frozen (Leg Cramp).
      const raceFrozen = await createActiveRace(alice, bob);
      const cramp = await giveBoxHeldPowerup(raceFrozen, alice.userId, "LEG_CRAMP", 99902);
      await usePowerup(alice.token, raceFrozen, cramp.id, { targetUserId: bob.userId });
      let progress = await getProgress(alice.token, raceFrozen);
      assert.equal(find(progress, bob.userId).currentMultiplier, 0);

      // Reversed (Wrong Turn) — a fresh race so the cramp doesn't interfere.
      const raceRev = await createActiveRace(alice, bob);
      const wt = await giveBoxHeldPowerup(raceRev, alice.userId, "WRONG_TURN", 99903);
      await usePowerup(alice.token, raceRev, wt.id, { targetUserId: bob.userId });
      progress = await getProgress(alice.token, raceRev);
      assert.ok(find(progress, bob.userId).currentMultiplier < 0, "wrong-turned reads negative");
    });
  });

  // ── 6b: high-multiplier push ────────────────────────────────────────────────
  describe("6b — high-multiplier push (once per spike, re-arm on drop)", () => {
    it("emits one alert to the other racer above 4x, none while still above, re-arms below, re-emits on re-crossing", async () => {
      const alice = await createUser("AliceMultC");
      const bob = await createUser("BobMultCCCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      const aliceP = await participant(raceId, alice.userId);

      // Drive Alice to 6x (three stacked Runner's High rows).
      const seedThree = async () => {
        await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");
        await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");
        await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");
      };
      await seedThree();

      // First recompute → exactly one alert to Bob, flag set.
      let progress = await getProgress(bob.token, raceId);
      assert.equal(find(progress, alice.userId).currentMultiplier, 6);
      const alicesAlerts = () => alerts.filter((a) => a.actorUserId === alice.userId);
      assert.equal(alicesAlerts().length, 1);
      assert.deepEqual(alicesAlerts()[0].recipientUserIds, [bob.userId]);
      assert.equal(alicesAlerts()[0].multiplier, 6);
      let freshAlice = await participant(raceId, alice.userId);
      assert.ok(freshAlice.highMultiplierNotifiedAt != null, "flag set on spike");

      // Second recompute while still > 4 → no new alert.
      await getProgress(bob.token, raceId);
      assert.equal(alicesAlerts().length, 1);

      // Drop below the threshold → the flag re-arms (cleared), still no new alert.
      await prisma.raceActiveEffect.deleteMany({ where: { raceId, targetParticipantId: aliceP.id, type: "RUNNERS_HIGH" } });
      progress = await getProgress(bob.token, raceId);
      assert.equal(find(progress, alice.userId).currentMultiplier, 1);
      freshAlice = await participant(raceId, alice.userId);
      assert.equal(freshAlice.highMultiplierNotifiedAt, null, "flag re-armed");
      assert.equal(alicesAlerts().length, 1);

      // Cross again → a fresh alert fires.
      await seedThree();
      await getProgress(bob.token, raceId);
      assert.equal(alicesAlerts().length, 2);
    });

    it("respects the HIGH_MULTIPLIER_PUSH_DISABLED kill switch", async () => {
      process.env.HIGH_MULTIPLIER_PUSH_DISABLED = "true";
      const alice = await createUser("AliceMultD");
      const bob = await createUser("BobMultDDDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);
      const aliceP = await participant(raceId, alice.userId);
      await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");
      await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");
      await seedBuffEffect(raceId, aliceP, "RUNNERS_HIGH");

      await getProgress(bob.token, raceId);
      assert.equal(alerts.filter((a) => a.actorUserId === alice.userId).length, 0);
      const freshAlice = await participant(raceId, alice.userId);
      assert.equal(freshAlice.highMultiplierNotifiedAt, null);
    });
  });
});
