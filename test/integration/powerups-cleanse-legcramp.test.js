const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// LEG CRAMP -> CLEANSE -> steps must resume counting
//
// Bug report: "if someone is leg-cramped and then cleanses it, their steps
// aren't counting." A leg cramp freezes steps whose sample timestamps fall in
// the window [startsAt, expiresAt] (getRaceProgress.js). Cleanse is supposed to
// TRUNCATE that window to the cleanse moment (usePowerup.js: status -> EXPIRED
// AND expiresAt -> cleanse time), so steps walked AFTER the cleanse fall outside
// the window and count again. If Cleanse left the original (future) expiresAt in
// place, everything up to the original 2h expiry would stay frozen — that is the
// "steps aren't counting" bug.
//
// This is a regression-lock over a ~3h simulated timeline using the modern
// sample-based path. The real Cleanse command runs and is asserted at the source
// (step 2). Because the real Cleanse stamps expiresAt = now(), we then backdate
// the truncated window into the past so post-cleanse samples can live in the
// realistic past (same timeline manipulation the existing leg-cramp tests use).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-clz-${++nextAppleId}`;
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
      name: "Cleanse Leg Cramp Test",
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
  // Backdate the race start well before any sample so all samples fall in-window.
  const start = hoursAgo(8);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "CLEANSE"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", { body: { samples }, token });
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

function sample(startH, endH, steps) {
  return { periodStart: hoursAgo(startH).toISOString(), periodEnd: hoursAgo(endH).toISOString(), steps };
}

describe("cleanse a leg cramp — steps resume counting after cleanse", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("post-cleanse steps count; during-cramp steps stay frozen", async () => {
    const alice = await createUser("AliceCramper"); // applies the leg cramp
    const bob = await createUser("BobCleanser"); // is cramped, then cleanses
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // (1) Bob walks 2000 steps BEFORE the cramp (6h–5.5h ago).
    await recordSamples(bob.token, [sample(6, 5.5, 2000)]);

    // (2) Alice leg-cramps Bob (real API), then position the cramp window: it
    //     started 3h ago and — left alone — would keep freezing until now.
    const cramp = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901);
    const crampRes = await usePowerup(alice.token, raceId, cramp.id, bob.userId);
    assert.equal(crampRes.status, 200);

    const crampStart = hoursAgo(3);
    const crampOriginalEnd = new Date(Date.now() + 60 * 60 * 1000); // 1h in the FUTURE
    const effect = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP" } });
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { startsAt: crampStart, expiresAt: crampOriginalEnd, status: "ACTIVE" },
    });

    // (3) Bob walks 3000 steps DURING the cramp, before cleansing (2.5h–2h ago).
    await recordSamples(bob.token, [sample(2.5, 2, 3000)]);

    // (4) Bob uses Cleanse (real API). This must flip the cramp to EXPIRED and
    //     truncate its expiresAt to the cleanse moment (~now), well before the
    //     original future end.
    const cleanse = await giveHeldPowerup(raceId, bob.userId, "CLEANSE", 99902);
    const cleanseRes = await usePowerup(bob.token, raceId, cleanse.id);
    assert.equal(cleanseRes.status, 200);
    const cleanseBody = await cleanseRes.json();
    assert.equal(cleanseBody.result.cleared, 1, "exactly one opponent debuff cleared");

    // ROOT-CAUSE ASSERTION: cleanse truncated the cramp at the source.
    const afterCleanse = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(afterCleanse.status, "EXPIRED", "cleanse expires the cramp");
    assert.ok(
      afterCleanse.expiresAt.getTime() < crampOriginalEnd.getTime(),
      "cleanse must pull expiresAt back from the original (future) end to the cleanse moment"
    );

    // Relocate the truncated window into the past so post-cleanse samples can be
    // realistic past samples. The cleanse "happened" 1.5h ago; the real status
    // flip + truncation above already ran and was asserted.
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: hoursAgo(1.5) },
    });

    // (5) Bob walks 4000 steps AFTER the cleanse (1h–0.5h ago).
    await recordSamples(bob.token, [sample(1, 0.5, 4000)]);

    const progress = await getProgress(alice.token, raceId);
    const bobP = findUser(progress, bob.userId);

    // (3) pre-cramp steps count, (4) during-cramp steps frozen, (5) post-cleanse
    //     steps count → total = 2000 + 4000 = 6000 (the 3000 is frozen).
    // On the un-truncated bug this would be 2000 (post-cleanse 4000 also frozen).
    assert.equal(bobP.totalSteps, 6000, "pre-cramp + post-cleanse count; during-cramp stays frozen");
  });
});
