const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Backend batch 2026-07-24 — items 5 (stealth-target guard for all TARGETED
// powerups) and 12 (rejected REDEEMED powerup refunds to general inventory).

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-fb724-${++nextAppleId}`;
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

async function createActiveRace(alice, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "FB724 Test",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: twoHoursAgo } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: twoHoursAgo } });
  return raceId;
}

// Box-earned HELD powerup (rarity set, earnedAtSteps set) — NOT redeemed.
async function giveBoxHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function seedInventory(userId, powerupType, quantity) {
  return prisma.userPowerupItem.upsert({
    where: { userId_powerupType: { userId, powerupType } },
    create: { userId, powerupType, quantity },
    update: { quantity },
  });
}

async function redeem(token, raceId, powerupType) {
  const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType },
    token,
  });
  return res;
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function giveBonusSteps(raceId, userId, amount) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  await prisma.raceParticipant.update({
    where: { id: p.id },
    data: { bonusSteps: amount, totalSteps: amount },
  });
}

async function goStealth(token, raceId, userId) {
  const stealth = await giveBoxHeldPowerup(raceId, userId, "STEALTH_MODE", 99901);
  await usePowerup(token, raceId, stealth.id);
}

describe("feature batch 2026-07-24 — powerups", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ── Item 5: stealthed players can't be hit by manually-aimed powerups ──────
  describe("item 5 — stealth-target guard for all TARGETED powerups", () => {
    it("rejects LEG_CRAMP against a stealthed target with 400 TARGET_STEALTHED and does not consume it", async () => {
      const alice = await createUser("AliceFB724A");
      const bob = await createUser("BobFB724AAA");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await goStealth(bob.token, raceId, bob.userId);

      const cramp = await giveBoxHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99902);
      const res = await usePowerup(alice.token, raceId, cramp.id, { targetUserId: bob.userId });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "TARGET_STEALTHED");

      // Bob has no LEG_CRAMP effect.
      const bobP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const crampEffect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, targetParticipantId: bobP.id, type: "LEG_CRAMP" },
      });
      assert.equal(crampEffect, null);

      // Alice's powerup is still HELD (not consumed).
      const stillHeld = await prisma.racePowerup.findUnique({ where: { id: cramp.id } });
      assert.equal(stillHeld.status, "HELD");
    });

    it("rejects WRONG_TURN against a stealthed target with 400 TARGET_STEALTHED", async () => {
      const alice = await createUser("AliceFB724B");
      const bob = await createUser("BobFB724BBB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await goStealth(bob.token, raceId, bob.userId);

      const wt = await giveBoxHeldPowerup(raceId, alice.userId, "WRONG_TURN", 99903);
      const res = await usePowerup(alice.token, raceId, wt.id, { targetUserId: bob.userId });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "TARGET_STEALTHED");

      const stillHeld = await prisma.racePowerup.findUnique({ where: { id: wt.id } });
      assert.equal(stillHeld.status, "HELD");
    });
  });

  // ── Item 12: rejected REDEEMED powerup refunds to general inventory ────────
  describe("item 12 — rejected redeemed powerup refunds to inventory", () => {
    it("returns a rejected redeemed powerup to the general inventory (usable in another race)", async () => {
      const alice = await createUser("AliceFB724C");
      const bob = await createUser("BobFB724CCC");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await goStealth(bob.token, raceId, bob.userId);

      // Alice owns one LEG_CRAMP in her GLOBAL inventory and redeems it in.
      await seedInventory(alice.userId, "LEG_CRAMP", 1);
      const redeemRes = await redeem(alice.token, raceId, "LEG_CRAMP");
      assert.equal(redeemRes.status, 200);
      const redeemedId = (await redeemRes.json()).result.powerup.id;

      // Inventory decremented to 0 by the redeem.
      let inv = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: alice.userId, powerupType: "LEG_CRAMP" } },
      });
      assert.equal(inv.quantity, 0);

      // Using it on the stealthed target is rejected (item 5) …
      const useRes = await usePowerup(alice.token, raceId, redeemedId, { targetUserId: bob.userId });
      assert.equal(useRes.status, 400);
      assert.equal((await useRes.json()).code, "TARGET_STEALTHED");

      // … and item 12 hands it back: inventory restored, no HELD row left bound
      // to this race.
      inv = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: alice.userId, powerupType: "LEG_CRAMP" } },
      });
      assert.equal(inv.quantity, 1);

      const held = await prisma.racePowerup.findFirst({
        where: { raceId, userId: alice.userId, type: "LEG_CRAMP", status: "HELD" },
      });
      assert.equal(held, null);

      const refunded = await prisma.racePowerup.findUnique({ where: { id: redeemedId } });
      assert.equal(refunded.status, "DISCARDED");

      // Proof it is usable elsewhere: redeem the same powerup into a second race.
      const raceId2 = await createActiveRace(alice, [bob]);
      const redeem2 = await redeem(alice.token, raceId2, "LEG_CRAMP");
      assert.equal(redeem2.status, 200);
    });

    it("does NOT refund a rejected box-earned powerup (stays HELD, no inventory change)", async () => {
      const alice = await createUser("AliceFB724D");
      const bob = await createUser("BobFB724DDD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await goStealth(bob.token, raceId, bob.userId);

      // Box-earned HELD LEG_CRAMP (rarity set, earnedAtSteps set) — race-bound.
      const boxCramp = await giveBoxHeldPowerup(raceId, alice.userId, "LEG_CRAMP", 99904);

      const useRes = await usePowerup(alice.token, raceId, boxCramp.id, { targetUserId: bob.userId });
      assert.equal(useRes.status, 400);
      assert.equal((await useRes.json()).code, "TARGET_STEALTHED");

      // Stays HELD; no inventory row created.
      const stillHeld = await prisma.racePowerup.findUnique({ where: { id: boxCramp.id } });
      assert.equal(stillHeld.status, "HELD");
      const inv = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: alice.userId, powerupType: "LEG_CRAMP" } },
      });
      assert.equal(inv, null);
    });
  });

  // ── Item 7: stealth durations nerfed to 60/75/90/120 min for ALL clients ───
  describe("item 7 — stealth durations", () => {
    async function castStealthDuration({ raceId, user, upgradeLevel, features }) {
      const stealth = await giveBoxHeldPowerup(raceId, user.userId, "STEALTH_MODE", 90000 + upgradeLevel);
      const headers = features ? { "X-Client-Features": features } : undefined;
      const res = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${stealth.id}/use`,
        { body: { upgradeLevel }, token: user.token, headers }
      );
      assert.equal(res.status, 200, `stealth cast L${upgradeLevel} should succeed`);
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "STEALTH_MODE", sourceUserId: user.userId },
        orderBy: { createdAt: "desc" },
      });
      return new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
    }

    const MIN = 60 * 1000;

    it("base stealth is 60 min for BOTH a modern (stealth_runner_duration) and an old client", async () => {
      const alice = await createUser("AliceFB724E");
      const bob = await createUser("BobFB724EEE");
      await makeFriends(alice, bob);

      // Old client (no features).
      const raceOld = await createActiveRace(alice, [bob]);
      const oldDur = await castStealthDuration({ raceId: raceOld, user: alice, upgradeLevel: 0 });
      assert.equal(oldDur, 60 * MIN);

      // Modern client (advertises stealth_runner_duration).
      const raceNew = await createActiveRace(alice, [bob]);
      const newDur = await castStealthDuration({
        raceId: raceNew,
        user: alice,
        upgradeLevel: 0,
        features: "stealth_runner_duration",
      });
      assert.equal(newDur, 60 * MIN);
    });

    // §3.4 (2026-07-25): stealth adopts the standard 1/2/3/4h ladder
    // (§9-authorized existing-test DURATION literal update).
    it("upgraded stealth follows the 1/2/3/4h ladder for a modern client", async () => {
      const alice = await createUser("AliceFB724F");
      const bob = await createUser("BobFB724FFF");
      await makeFriends(alice, bob);
      // Fund upgrades generously so cost never blocks the cast.
      await prisma.user.update({ where: { id: alice.userId }, data: { coins: 1000000 } });

      const expected = [60 * MIN, 120 * MIN, 180 * MIN, 240 * MIN];
      for (let level = 0; level <= 3; level++) {
        const raceId = await createActiveRace(alice, [bob]);
        const dur = await castStealthDuration({
          raceId,
          user: alice,
          upgradeLevel: level,
          features: "stealth_runner_duration",
        });
        assert.equal(dur, expected[level], `L${level} stealth duration`);
      }
    });
  });
});
