const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// STEALTH MODE + RED CARD
//
// A player is the leader AND has Stealth Mode active (their progress is hidden
// on the leaderboard). Another player uses Red Card — which auto-targets the
// leader. Behavior under test:
//
// Red Card resolves the leader by TRUE server-side steps (usePowerup.js:236),
// while Stealth Mode only masks the leaderboard/feed VIEW at read time. So:
//   * the Red Card still lands on the stealthed leader (5% of their steps),
//   * Stealth Mode is NOT consumed (it is a timed buff, not a shield),
//   * the leader stays hidden on the leaderboard afterward, and
//   * the feed event hides the leader's name (??? to the attacker, real name to
//     the stealthed player themselves).
//
// In short: stealth hides WHO got hit, it does not grant damage immunity.
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-stealth-${++nextAppleId}`;
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
      name: "Stealth + Red Card Test",
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
  const defaultStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const rareTypes = ["COMPRESSION_SOCKS", "MIRROR", "RED_CARD", "STEALTH_MODE", "SECOND_WIND"];
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: rareTypes.includes(type) ? "RARE" : "COMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveBonusSteps(raceId, userId, amount) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  await prisma.raceParticipant.update({
    where: { id: participant.id },
    data: { bonusSteps: { increment: amount }, totalSteps: amount },
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

async function getFeed(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token });
  return (await res.json()).events;
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

async function stealthStatus(raceId, userId) {
  const effect = await prisma.raceActiveEffect.findFirst({
    where: { raceId, type: "STEALTH_MODE", targetUserId: userId },
    orderBy: { startsAt: "desc" },
  });
  return effect ? effect.status : "(none)";
}

describe("stealth mode + red card", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {});

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("RED CARD lands on a stealthed leader; stealth survives and masks the feed", async () => {
    const alice = await createUser("AliceAtk"); // behind; uses Red Card
    const bob = await createUser("BobStealth"); // leader; goes stealth
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    // Bob leads with 8000, Alice trails with 5000.
    await giveBonusSteps(raceId, alice.userId, 5000);
    await giveBonusSteps(raceId, bob.userId, 8000);

    // Bob activates Stealth Mode (self-only, no target).
    const stealth = await giveHeldPowerup(raceId, bob.userId, "STEALTH_MODE", 99901);
    const stealthRes = await usePowerup(bob.token, raceId, stealth.id);
    assert.equal(stealthRes.status, 200, "stealth should activate");

    // Alice uses Red Card — auto-targets the leader (Bob) by true steps.
    const redCard = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99902);
    const res = await usePowerup(alice.token, raceId, redCard.id);
    const body = await res.json();

    // Bob's own view shows his true steps (stealth never hides self).
    const bobView = await getProgress(bob.token, raceId);
    const bobSelf = findUser(bobView, bob.userId);

    // Alice's view of Bob (should be stealth-masked).
    const aliceView = await getProgress(alice.token, raceId);
    const bobAsSeenByAlice = findUser(aliceView, bob.userId);

    // Feed descriptions for the Red Card event from each viewer's POV.
    const aliceFeed = await getFeed(alice.token, raceId);
    const bobFeed = await getFeed(bob.token, raceId);
    const redCardEventForAlice = aliceFeed.find((e) => e.powerupType === "RED_CARD");
    const redCardEventForBob = bobFeed.find((e) => e.powerupType === "RED_CARD");

    // The Red Card lands normally — not blocked, not reflected.
    assert.equal(res.status, 200);
    assert.equal(body.result.outcome, "APPLIED");
    assert.ok(!body.result.blocked);
    assert.equal(body.result.penalty, 800, "10% of the stealthed leader's 8000 steps");

    // The penalty hits the stealthed leader's true total.
    assert.equal(bobSelf.totalSteps, 7200, "leader loses 800 despite being stealthed");

    // Stealth Mode is untouched — it is a timed buff, not a shield.
    assert.equal(await stealthStatus(raceId, bob.userId), "ACTIVE");

    // The leader stays hidden on the leaderboard to the attacker after the hit.
    assert.ok(bobAsSeenByAlice, "Bob is still listed for Alice");
    assert.equal(bobAsSeenByAlice.stealthed, true, "Bob is still stealthed to Alice");
    assert.equal(bobAsSeenByAlice.totalSteps, null, "Bob's steps stay hidden from Alice");

    // Feed redaction survives the hit: the attacker sees who did it but not who
    // got hit (??? for the stealthed target); the stealthed player sees their
    // own real name.
    assert.ok(redCardEventForAlice, "Red Card event is in Alice's feed");
    assert.ok(
      redCardEventForAlice.description.includes("???"),
      "the stealthed target's name is masked in the attacker's feed"
    );
    assert.ok(
      !redCardEventForAlice.description.includes("BobStealth"),
      "the stealthed target's real name must not leak to the attacker"
    );
    assert.ok(redCardEventForBob, "Red Card event is in Bob's feed");
    assert.ok(
      redCardEventForBob.description.includes("BobStealth"),
      "the stealthed player sees their own real name in their feed"
    );
  });
});
