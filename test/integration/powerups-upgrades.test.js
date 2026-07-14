const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-up-${++nextAppleId}`;
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
      name: "Upgrade Test",
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
  return raceId;
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "COMMON") {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity,
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function setUserCoins(userId, coins) {
  await prisma.user.update({ where: { id: userId }, data: { coins } });
}

async function getUserCoins(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user.coins;
}

async function usePowerup(token, raceId, powerupId, { targetUserId, upgradeLevel } = {}) {
  const body = {};
  if (targetUserId) body.targetUserId = targetUserId;
  if (upgradeLevel != null) body.upgradeLevel = upgradeLevel;
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

describe("powerup upgrades — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ---------------------------------------------------------------------
  // Back-compat: existing call shape without upgradeLevel still works
  // ---------------------------------------------------------------------

  it("base use (no upgradeLevel): existing behavior preserved, no coins deducted", async () => {
    const alice = await createUser("AliceUpAA");
    const bob = await createUser("BobUpAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id);
    assert.equal(res.status, 200);

    const aliceCoins = await getUserCoins(alice.userId);
    assert.equal(aliceCoins, 1000, "no coins deducted on base use");

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 1500, "base 1500 bonus applied");

    // Progress advertises the authoritative upgrade price ladders so clients
    // can display exactly what the server will charge (no stale bundled table).
    assert.deepEqual(progress.powerupData.upgradeCosts, {
      byRarity: {
        COMMON: [0, 5, 15, 45],
        UNCOMMON: [0, 10, 30, 90],
        RARE: [0, 15, 45, 135],
      },
      byType: {},
    });
  });

  // ---------------------------------------------------------------------
  // Lvl 2 Protein Shake
  // ---------------------------------------------------------------------

  it("Lvl 2 Protein Shake: 15 coins deducted, +3000 steps, feed shows 'Lvl 2'", async () => {
    const alice = await createUser("AliceUpBB");
    const bob = await createUser("BobUpBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 2 });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.upgradeLevel, 2);
    assert.equal(body.result.coinsSpent, 15);

    assert.equal(await getUserCoins(alice.userId), 485);

    const progress = await getProgress(alice.token, raceId);
    const aliceP = progress.participants.find((p) => p.userId === alice.userId);
    assert.equal(aliceP.totalSteps, 3000);

    // CoinTransaction row exists
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1);
    assert.equal(txs[0].amount, -15);
    assert.equal(txs[0].refId, powerup.id);

    // PowerupUpgradeEvent row exists
    const ues = await prisma.powerupUpgradeEvent.findMany({
      where: { powerupId: powerup.id },
    });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 15);
    assert.equal(ues[0].status, "APPLIED");
    assert.equal(ues[0].powerupType, "PROTEIN_SHAKE");

    // RacePowerup column updated
    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.upgradeLevel, 2);
    assert.equal(updated.status, "USED");

    // Feed event includes "Lvl 2" prefix
    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "PROTEIN_SHAKE");
    assert.match(ev.description, /Lvl 2/);
  });

  // ---------------------------------------------------------------------
  // Lvl 3 Leg Cramp on bob — duration becomes 6 hours
  // ---------------------------------------------------------------------

  it("Lvl 3 Leg Cramp: 90 coins, freezes target for 6h, feed shows 'Lvl 3'", async () => {
    const alice = await createUser("AliceUpCC");
    const bob = await createUser("BobUpCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99901, "UNCOMMON");
    const before = Date.now();
    const res = await usePowerup(alice.token, raceId, powerup.id, {
      targetUserId: bob.userId,
      upgradeLevel: 3,
    });
    assert.equal(res.status, 200);

    assert.equal(await getUserCoins(alice.userId), 410);

    const effect = await prisma.raceActiveEffect.findFirst({
      where: { powerupId: powerup.id },
    });
    assert.ok(effect);
    const durationMs = new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
    assert.equal(durationMs, 6 * 60 * 60 * 1000, "expires 6 hours after start");

    const feedRes = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: alice.token });
    const feed = (await feedRes.json()).events;
    const ev = feed.find((e) => e.eventType === "POWERUP_USED" && e.powerupType === "LEG_CRAMP");
    assert.match(ev.description, /Lvl 3/);
    assert.match(ev.description, /6 hours/);
  });

  // ---------------------------------------------------------------------
  // Insufficient coins
  // ---------------------------------------------------------------------

  it("Insufficient coins: Lvl 3 attempt → 400, no coin change, powerup stays HELD", async () => {
    const alice = await createUser("AliceUpDD");
    const bob = await createUser("BobUpDDDD");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 10);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 3 });
    assert.equal(res.status, 400);

    assert.equal(await getUserCoins(alice.userId), 10);

    const updated = await prisma.racePowerup.findUnique({ where: { id: powerup.id } });
    assert.equal(updated.status, "HELD");
    assert.equal(updated.upgradeLevel, 0);

    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: powerup.id } });
    assert.equal(ues.length, 0);
  });

  // ---------------------------------------------------------------------
  // Non-upgradeable powerup type
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel>0 on RED_CARD (non-upgradeable): 400, no coin change", async () => {
    const alice = await createUser("AliceUpEE");
    const bob = await createUser("BobUpEEEE");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // Give bob enough steps so red card has a clear leader
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { totalSteps: 50000 },
    });

    const powerup = await giveHeldPowerup(raceId, alice.userId, "RED_CARD", 99901, "RARE");
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 1 });
    assert.equal(res.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);
  });

  // ---------------------------------------------------------------------
  // Out-of-range level
  // ---------------------------------------------------------------------

  it("Reject upgradeLevel=4: 400", async () => {
    const alice = await createUser("AliceUpFF");
    const bob = await createUser("BobUpFFFF");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    const powerup = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const res = await usePowerup(alice.token, raceId, powerup.id, { upgradeLevel: 4 });
    assert.equal(res.status, 400);
  });

  // ---------------------------------------------------------------------
  // Block by Compression Socks: coins ARE deducted (Wave 2 rule)
  // ---------------------------------------------------------------------

  it("Lvl 2 Shortcut blocked by shield: coins deducted (15), no steps stolen, upgrade event = BLOCKED", async () => {
    const alice = await createUser("AliceUpGG");
    const bob = await createUser("BobUpGGGG");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 500);

    // Bob needs non-zero steps for Shortcut to clear validation (zero-step
    // targets are rejected with "nothing to steal" before reaching shield logic).
    // bonusSteps survives resolveRaceState recomputation; totalSteps would be overwritten.
    await prisma.raceParticipant.updateMany({
      where: { raceId, userId: bob.userId },
      data: { bonusSteps: 5000, totalSteps: 5000 },
    });

    // Give bob compression socks and activate
    const shield = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 99901, "RARE");
    await usePowerup(bob.token, raceId, shield.id);

    // Alice attempts upgraded shortcut against bob
    const sc = await giveHeldPowerup(raceId, alice.userId, "SHORTCUT", 99902);
    const res = await usePowerup(alice.token, raceId, sc.id, {
      targetUserId: bob.userId,
      upgradeLevel: 2,
    });
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.result.blocked, true);

    // Coins ARE deducted on block
    assert.equal(await getUserCoins(alice.userId), 485);

    // PowerupUpgradeEvent recorded with status BLOCKED
    const ues = await prisma.powerupUpgradeEvent.findMany({ where: { powerupId: sc.id } });
    assert.equal(ues.length, 1);
    assert.equal(ues[0].status, "BLOCKED");
    assert.equal(ues[0].tier, 2);
    assert.equal(ues[0].costCoins, 15);
  });

  // ---------------------------------------------------------------------
  // Stack rejection — coins not deducted
  // ---------------------------------------------------------------------

  it("Lvl 3 Runner's High rejected when one already active: 400, no coin change", async () => {
    const alice = await createUser("AliceUpHH");
    const bob = await createUser("BobUpHHHH");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 1000);

    // First Runner's High (base)
    const rh1 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99901, "UNCOMMON");
    const r1 = await usePowerup(alice.token, raceId, rh1.id);
    assert.equal(r1.status, 200);

    // Second Runner's High at Lvl 3 should reject without coin change
    const rh2 = await giveHeldPowerup(raceId, alice.userId, "RUNNERS_HIGH", 99902, "UNCOMMON");
    const r2 = await usePowerup(alice.token, raceId, rh2.id, { upgradeLevel: 3 });
    assert.equal(r2.status, 400);
    assert.equal(await getUserCoins(alice.userId), 1000);

    // Second powerup must still be HELD
    const after = await prisma.racePowerup.findUnique({ where: { id: rh2.id } });
    assert.equal(after.status, "HELD");
  });

  // ---------------------------------------------------------------------
  // Concurrent purchase race condition (atomic deduct guarantees one wins)
  // ---------------------------------------------------------------------

  it("Two simultaneous Lvl 3 Protein Shakes with only enough coins for one — exactly one succeeds", async () => {
    const alice = await createUser("AliceUpII");
    const bob = await createUser("BobUpIIII");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);
    await setUserCoins(alice.userId, 45); // exactly enough for ONE Lvl 3

    const p1 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99901);
    const p2 = await giveHeldPowerup(raceId, alice.userId, "PROTEIN_SHAKE", 99902);

    const [r1, r2] = await Promise.all([
      usePowerup(alice.token, raceId, p1.id, { upgradeLevel: 3 }),
      usePowerup(alice.token, raceId, p2.id, { upgradeLevel: 3 }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 400], "exactly one succeeds, one fails");

    assert.equal(await getUserCoins(alice.userId), 0);
    const txs = await prisma.coinTransaction.findMany({
      where: { userId: alice.userId, reason: "powerup_upgrade" },
    });
    assert.equal(txs.length, 1, "exactly one CoinTransaction recorded");
  });
});
