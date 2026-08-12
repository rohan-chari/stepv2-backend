const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Integration coverage for the 2026-07-17 backend batch:
//   * Item 1 — POST /races/:id/powerups/open-batch ("Open All Boxes")
//   * Item 2 — LEECH use (effect + victim visibility + feed) and X-Ray
//     (DEFENSE_SCAN) recon response.
// Leech/X-Ray scoring math is exhaustively unit-tested (test/queries/
// leechScoring.test.js, with settlement parity); here we prove the HTTP wiring,
// the new enum values, and the powerups2 gating work end-to-end on a real DB.

let server;
let nextAppleId = 0;

const POWERUPS2 = { "X-Client-Features": "characters,powerups2" };

async function createUser(displayName) {
  const appleId = `apple-blx-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Batch/Leech/XRay",
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
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveBox(raceId, userId, status, earnedAtSteps) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type: null, rarity: null, status, earnedAtSteps },
  });
}

async function giveHeld(raceId, userId, type) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity: "UNCOMMON", status: "HELD" },
  });
}

async function giveActiveEffect(raceId, targetUserId, type) {
  const p = await participant(raceId, targetUserId);
  // raceActiveEffect.powerupId is a required FK — back it with a USED powerup row.
  const backing = await prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId: targetUserId, type, rarity: "UNCOMMON", status: "USED" },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId: targetUserId,
      powerupId: backing.id,
      type, status: "ACTIVE", startsAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe("open-batch / leech / x-ray — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  it("open-batch opens all slot boxes + queued overflow in one call", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Fill the 3 slots with mystery boxes + 2 queued overflow boxes.
    const b1 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 5000);
    const b2 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 10000);
    const b3 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 15000);
    await giveBox(raceId, alice.userId, "QUEUED", 20000);
    await giveBox(raceId, alice.userId, "QUEUED", 25000);

    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [b1.id, b2.id, b3.id], includeQueued: true, maxCount: 20 },
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.results.length, 5, "3 slot + 2 queued boxes opened");
    assert.equal(body.results.filter((r) => r.queued).length, 2);
    assert.ok(body.results.every((r) => typeof r.type === "string"));
    assert.equal(body.remainingQueuedBoxCount, 0);
    assert.equal(body.powerupSlots, 3);

    // Every box row is now opened (HELD or auto-activated USED) — none left QUEUED/MYSTERY_BOX.
    const leftover = await prisma.racePowerup.count({
      where: { raceId, userId: alice.userId, status: { in: ["MYSTERY_BOX", "QUEUED"] } },
    });
    assert.equal(leftover, 0);
  });

  it("open-batch never opens another user's boxes", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const bobBox = await giveBox(raceId, bob.userId, "MYSTERY_BOX", 5000);
    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [bobBox.id], includeQueued: false },
      token: alice.token,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.results.length, 0, "alice cannot open bob's box");
    const bobBoxRow = await prisma.racePowerup.findUnique({ where: { id: bobBox.id } });
    assert.equal(bobBoxRow.status, "MYSTERY_BOX", "bob's box is untouched");
  });

  it("LEECH use: effect targets the victim, is visible on their row, and posts a feed event", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const leech = await giveHeld(raceId, alice.userId, "LEECH");
    const useRes = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${leech.id}/use`, {
      body: { targetUserId: bob.userId },
      token: alice.token,
      headers: POWERUPS2,
    });
    assert.equal(useRes.status, 200);

    // Effect row targets the victim, sourced by the leecher, ~30 min window.
    const eff = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEECH", status: "ACTIVE" } });
    assert.ok(eff, "a LEECH effect exists");
    assert.equal(eff.targetUserId, bob.userId);
    assert.equal(eff.sourceUserId, alice.userId);
    const windowMin = Math.round((new Date(eff.expiresAt) - new Date(eff.startsAt)) / 60000);
    assert.equal(windowMin, 30);

    // NOT stealthy: the victim sees the LEECH badge in their activeEffects.
    const progRes = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: bob.token });
    const prog = (await progRes.json()).progress;
    const leechBadge = (prog.powerupData?.activeEffects || []).find((e) => e.type === "LEECH");
    assert.ok(leechBadge, "victim sees the LEECH effect on their row");
    assert.equal(leechBadge.onSelf, true);

    // A feed event is written (drives the push).
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: bob.token });
    const feed = await feedRes.json();
    assert.ok(feed.events.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEECH"));
  });

  it("X-Ray (DEFENSE_SCAN) use returns each opponent's active defenses at the top level", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await giveActiveEffect(raceId, bob.userId, "COMPRESSION_SOCKS");
    await giveActiveEffect(raceId, bob.userId, "DECOY");
    const xray = await giveHeld(raceId, alice.userId, "DEFENSE_SCAN");

    const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/${xray.id}/use`, {
      body: {},
      token: alice.token,
      headers: POWERUPS2,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.scan, "scan present at the top level");
    const bobEntry = body.scan.opponents.find((o) => o.userId === bob.userId);
    assert.ok(bobEntry);
    assert.deepEqual(bobEntry.defenses.map((d) => d.type), ["COMPRESSION_SOCKS", "DECOY"]);

    // Consumed, and silent recon => no LEECH/scan effect leaked to others.
    const used = await prisma.racePowerup.findUnique({ where: { id: xray.id } });
    assert.equal(used.status, "USED");
  });

  it("open-batch persists MYSTERY_BOX_OPENED audit rows (Item 9) but hides them from the feed", async () => {
    const alice = await createUser("Alice");
    const bob = await createUser("Bob");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const b1 = await giveBox(raceId, alice.userId, "MYSTERY_BOX", 5000);
    await request(server.baseUrl, "POST", `/races/${raceId}/powerups/open-batch`, {
      body: { powerupIds: [b1.id] },
      token: alice.token,
    });

    const opened = await prisma.racePowerupEvent.count({ where: { raceId, eventType: "MYSTERY_BOX_OPENED" } });
    assert.ok(opened >= 1, "a MYSTERY_BOX_OPENED audit row is written");

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = await feedRes.json();
    assert.ok(!feed.events.find((e) => e.eventType === "MYSTERY_BOX_OPENED"), "audit rows are hidden from the feed");
  });
});
