const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

// The store powerup catalog rows the seed ships. Duplicated here (cleanDatabase
// wipes them) so the catalog/price/gating cases run against a known catalog.
// Prices MUST match prisma/seed.js — all store powerups are 75 coins.
const STORE_POWERUPS = [
  { sku: "POWERUP_IMPOSTER", name: "Imposter", powerupType: "IMPOSTER", priceCoins: 75, sortOrder: 0 },
  { sku: "POWERUP_RAINSTORM", name: "Rainstorm", powerupType: "RAINSTORM", priceCoins: 75, sortOrder: 1 },
  { sku: "POWERUP_SIGNAL_JAMMER", name: "Signal Jammer", powerupType: "SIGNAL_JAMMER", priceCoins: 75, sortOrder: 2 },
];

const JAMMER_FEATURE = { "X-Client-Features": "characters,jammer" };
const OLD_CLIENT = { "X-Client-Features": "characters" };

async function seedStoreCatalog() {
  for (const p of STORE_POWERUPS) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      update: { priceCoins: p.priceCoins, active: true },
      create: { ...p, description: `${p.name} test row`, active: true },
    });
  }
}

async function createUser(displayName, coins = 0) {
  const appleId = `apple-jam-${++nextAppleId}`;
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
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
    body: { accept: true },
    token: b.token,
  });
}

// Create an ACTIVE race with `alice` (creator) + the supplied opponents, all
// ACCEPTED. Returns the raceId. Backdates the start so step samples land inside.
async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Jammer Test",
      targetSteps: opts.targetSteps || 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: opponents.map((o) => o.userId) },
    token: alice.token,
  });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 7 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeldPowerup(raceId, userId, type, earnedAtSteps, rarity = "UNCOMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps },
  });
}

async function giveActiveEffect(raceId, targetUserId, sourceUserId, type, powerupId, expiresAt) {
  const p = await participant(raceId, targetUserId);
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId,
      sourceUserId,
      powerupId,
      type,
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt,
    },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body,
    token,
  });
}

async function purchase(token, sku, key, headers = JAMMER_FEATURE) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", {
    body: { sku },
    token,
    headers: { "Idempotency-Key": key, ...headers },
  });
}

async function redeem(token, raceId, powerupType) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
    body: { powerupType },
    token,
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

function findEffect(progress, type) {
  return (progress.powerupData?.activeEffects || []).find((e) => e.type === type);
}

describe("signal jammer — integration", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ── 1. Catalog & price + old-client gating ─────────────────────────────
  describe("catalog & price gating", () => {
    it("returns all store powerups at 75 coins; jammer only for jammer-capable clients", async () => {
      await seedStoreCatalog();
      const user = await createUser("CatViewer", 500);

      const jammerRes = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
        headers: JAMMER_FEATURE,
      });
      assert.equal(jammerRes.status, 200);
      const jammerBody = await jammerRes.json();
      const byType = Object.fromEntries(jammerBody.items.map((i) => [i.powerupType, i]));
      assert.equal(byType.IMPOSTER, undefined);
      assert.equal(byType.RAINSTORM.priceCoins, 75);
      assert.ok(byType.SIGNAL_JAMMER, "jammer visible to jammer-capable client");
      assert.equal(byType.SIGNAL_JAMMER.priceCoins, 75);

      const oldRes = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
        headers: OLD_CLIENT,
      });
      const oldBody = await oldRes.json();
      const oldTypes = oldBody.items.map((i) => i.powerupType);
      assert.equal(oldTypes.includes("IMPOSTER"), false, "retired imposter omitted");
      assert.ok(oldTypes.includes("RAINSTORM"), "rainstorm visible to all");
      assert.ok(!oldTypes.includes("SIGNAL_JAMMER"), "jammer hidden from old client");

      // Absolutely no header (oldest binaries) also hides the jammer.
      const noHeaderRes = await request(server.baseUrl, "GET", "/shop/powerups", {
        token: user.token,
      });
      const noHeaderTypes = (await noHeaderRes.json()).items.map((i) => i.powerupType);
      assert.ok(!noHeaderTypes.includes("SIGNAL_JAMMER"));
    });
  });

  // ── 2. Purchase ────────────────────────────────────────────────────────
  describe("purchase", () => {
    it("debits exactly 75 coins, increments inventory, writes a transaction, idempotent", async () => {
      await seedStoreCatalog();
      const user = await createUser("Buyer", 200);

      const first = await purchase(user.token, "POWERUP_SIGNAL_JAMMER", "jam-buy-1");
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.equal(firstBody.coins, 125);
      assert.equal(firstBody.purchase.idempotent, false);
      assert.equal(firstBody.inventory.quantity, 1);

      // Replay with same key: no double debit.
      const second = await purchase(user.token, "POWERUP_SIGNAL_JAMMER", "jam-buy-1");
      assert.equal(second.status, 200);
      const secondBody = await second.json();
      assert.equal(secondBody.coins, 125);
      assert.equal(secondBody.purchase.idempotent, true);

      const fresh = await prisma.user.findUnique({ where: { id: user.userId } });
      assert.equal(fresh.coins, 125);
      const inv = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: user.userId, powerupType: "SIGNAL_JAMMER" } },
      });
      assert.equal(inv.quantity, 1);
      const txns = await prisma.coinTransaction.findMany({
        where: { userId: user.userId, reason: "powerup_purchase" },
      });
      assert.equal(txns.length, 1);
      assert.equal(txns[0].amount, -75);
    });

    it("rejects purchase with insufficient coins and does not debit", async () => {
      await seedStoreCatalog();
      const user = await createUser("Broke", 20);
      const res = await purchase(user.token, "POWERUP_SIGNAL_JAMMER", "jam-broke-1");
      assert.equal(res.status, 400);
      const fresh = await prisma.user.findUnique({ where: { id: user.userId } });
      assert.equal(fresh.coins, 20);
    });
  });

  // ── 3. Redeem + use on target ──────────────────────────────────────────
  describe("redeem + use", () => {
    it("creates an ACTIVE SIGNAL_JAMMER effect (~+1h), marks powerup USED, feeds event, appears in progress", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Attacker", 200);
      const bob = await createUser("Victim");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "jam-redeem-1");
      const redeemRes = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      assert.equal(redeemRes.status, 200);
      const powerupId = (await redeemRes.json()).result.powerup.id;

      const before = Date.now();
      const useRes = await usePowerup(alice.token, raceId, powerupId, { targetUserId: bob.userId });
      assert.equal(useRes.status, 200);

      const bobP = await participant(raceId, bob.userId);
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "SIGNAL_JAMMER" },
      });
      assert.ok(effect, "effect created");
      assert.equal(effect.status, "ACTIVE");
      assert.equal(effect.targetParticipantId, bobP.id);
      assert.equal(effect.targetUserId, bob.userId);
      assert.equal(effect.sourceUserId, alice.userId);
      const remaining = new Date(effect.expiresAt).getTime() - before;
      assert.ok(remaining > 55 * 60 * 1000 && remaining < 65 * 60 * 1000, "≈1 hour");

      const used = await prisma.racePowerup.findUnique({ where: { id: powerupId } });
      assert.equal(used.status, "USED");

      const feed = await getFeed(alice.token, raceId);
      assert.ok(
        feed.some((e) => e.eventType === "POWERUP_USED" && e.powerupType === "SIGNAL_JAMMER"),
        "feed has POWERUP_USED for jammer"
      );

      // The target's own progress shows the jam with an expiresAt for the countdown.
      const progress = await getProgress(bob.token, raceId);
      const shown = findEffect(progress, "SIGNAL_JAMMER");
      assert.ok(shown, "jammer effect visible in target progress");
      assert.ok(shown.expiresAt, "carries expiresAt for countdown");
    });
  });

  // ── 4. Jam blocks USE (earned + store types) ──────────────────────────
  describe("jam blocks using powerups", () => {
    it("a jammed target cannot use any held powerup (earned or store), and it stays HELD", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Jammer1", 200);
      const bob = await createUser("Jammed1", 200);
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      // Bob holds an EARNED powerup and a STORE-redeemed powerup.
      const earned = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 5000, "COMMON");
      await purchase(bob.token, "POWERUP_RAINSTORM", "bob-rain-1");
      const storeRedeem = await redeem(bob.token, raceId, "RAINSTORM");
      const storePowerupId = (await storeRedeem.json()).result.powerup.id;

      // Alice jams Bob.
      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-1");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      const jamRes = await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });
      assert.equal(jamRes.status, 200);

      // Bob tries earned powerup → 409, stays HELD, no bonus applied.
      const earnedRes = await usePowerup(bob.token, raceId, earned.id);
      assert.equal(earnedRes.status, 409);
      assert.match((await earnedRes.json()).error, /jam/i);
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: earned.id } })).status, "HELD");

      // Bob tries store powerup → 409, stays HELD.
      const storeRes = await usePowerup(bob.token, raceId, storePowerupId, {
        targetUserId: alice.userId,
      });
      assert.equal(storeRes.status, 409);
      assert.equal(
        (await prisma.racePowerup.findUnique({ where: { id: storePowerupId } })).status,
        "HELD"
      );

      // No IMPOSTER/effects were created by the blocked attempts.
      const bobP = await participant(raceId, bob.userId);
      assert.equal(bobP.bonusSteps, 0, "protein shake never applied");
    });
  });

  // ── 5. Jam blocks redeeming but not buying ─────────────────────────────
  // Bug batch 2026-07-21 (B3, owner-confirmed): redeeming while jammed is now
  // rejected BEFORE inventory is spent, so the item stays in the global stash
  // and remains usable in other races. Buying is still allowed.
  describe("jam blocks redeeming but not buying", () => {
    it("a jammed target can purchase but not redeem powerups", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Jammer2", 200);
      const bob = await createUser("Jammed2", 200);
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-2");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });

      // Bob (jammed) buys — succeeds.
      const buyRes = await purchase(bob.token, "POWERUP_RAINSTORM", "bob-buy-while-jammed");
      assert.equal(buyRes.status, 200);

      // Bob (jammed) redeems — rejected pre-flight; stash untouched, no tray row.
      const redeemRes = await redeem(bob.token, raceId, "RAINSTORM");
      assert.equal(redeemRes.status, 409);
      const redeemBody = await redeemRes.json();
      assert.equal(redeemBody.code, "SIGNAL_JAMMED");
      assert.match(redeemBody.error, /jam/i);
      const held = await prisma.racePowerup.findFirst({
        where: { raceId, userId: bob.userId, type: "RAINSTORM", status: "HELD" },
      });
      assert.equal(held, null, "no race-scoped row minted while jammed");
      const stash = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: bob.userId, powerupType: "RAINSTORM" } },
      });
      assert.equal(stash?.quantity, 1, "inventory not spent");
    });
  });

  // ── 6. Jammed can't jam ────────────────────────────────────────────────
  describe("jammed player cannot jam", () => {
    it("a jammed player using their own Signal Jammer is rejected by the same guard", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Jammer3", 200);
      const bob = await createUser("Jammed3", 200);
      const carol = await createUser("Bystander3");
      await makeFriends(alice, bob);
      await makeFriends(alice, carol);
      const raceId = await createActiveRace(alice, [bob, carol]);

      // Bob holds a jammer of his own.
      await purchase(bob.token, "POWERUP_SIGNAL_JAMMER", "bob-jam-3");
      const bobRedeem = await redeem(bob.token, raceId, "SIGNAL_JAMMER");
      const bobJammerId = (await bobRedeem.json()).result.powerup.id;

      // Alice jams Bob first.
      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-3");
      const aliceRedeem = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const aliceJammerId = (await aliceRedeem.json()).result.powerup.id;
      await usePowerup(alice.token, raceId, aliceJammerId, { targetUserId: bob.userId });

      // Bob (jammed) tries to jam Carol → 409, his jammer stays HELD.
      const res = await usePowerup(bob.token, raceId, bobJammerId, { targetUserId: carol.userId });
      assert.equal(res.status, 409);
      assert.equal(
        (await prisma.racePowerup.findUnique({ where: { id: bobJammerId } })).status,
        "HELD"
      );
    });
  });

  // ── 7. No stacking ─────────────────────────────────────────────────────
  describe("no stacking", () => {
    it("a second jammer on an already-jammed target is rejected and stays HELD", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Jammer4", 300);
      const bob = await createUser("Jammed4");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-4a");
      const r1 = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jam1 = (await r1.json()).result.powerup.id;
      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-4b");
      const r2 = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jam2 = (await r2.json()).result.powerup.id;

      const first = await usePowerup(alice.token, raceId, jam1, { targetUserId: bob.userId });
      assert.equal(first.status, 200);

      const second = await usePowerup(alice.token, raceId, jam2, { targetUserId: bob.userId });
      assert.equal(second.status, 409);
      assert.match((await second.json()).error, /already jammed/i);
      // Attacker's second jammer NOT consumed.
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: jam2 } })).status, "HELD");

      // Only one active jammer effect exists.
      const effects = await prisma.raceActiveEffect.findMany({
        where: { raceId, type: "SIGNAL_JAMMER", status: "ACTIVE" },
      });
      assert.equal(effects.length, 1);
    });
  });

  // ── 8. Lazy expiry ─────────────────────────────────────────────────────
  describe("expiry", () => {
    it("lazily expires via progress, writes EFFECT_EXPIRED with the Signal Jammer name, unblocks the target", async () => {
      await seedStoreCatalog();
      const alice = await createUser("Jammer5", 200);
      const bob = await createUser("Jammed5");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-5");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });

      // Force expiry into the past.
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "SIGNAL_JAMMER" },
      });
      await prisma.raceActiveEffect.update({
        where: { id: effect.id },
        data: { expiresAt: new Date(Date.now() - 60 * 1000) },
      });

      // Hit progress → lazy expiry.
      await getProgress(alice.token, raceId);

      const expired = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
      assert.equal(expired.status, "EXPIRED");

      const feed = await getFeed(alice.token, raceId);
      const expiredEvent = feed.find(
        (e) => e.eventType === "EFFECT_EXPIRED" && e.powerupType === "SIGNAL_JAMMER"
      );
      assert.ok(expiredEvent, "EFFECT_EXPIRED feed row exists");
      assert.match(expiredEvent.description, /Signal Jammer/);
      assert.doesNotMatch(expiredEvent.description, /undefined/);

      // Target can now use a powerup again.
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 6000, "COMMON");
      const useRes = await usePowerup(bob.token, raceId, shake.id);
      assert.equal(useRes.status, 200);
    });
  });

  // ── 9. Defenses ────────────────────────────────────────────────────────
  describe("defenses", () => {
    it("MIRROR does NOT reflect the jam — target is jammed and the Mirror stays intact", async () => {
      await seedStoreCatalog();
      const alice = await createUser("JamAttacker6", 200);
      const bob = await createUser("JamMirror6");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      // Bob has an active Mirror — but the jammer is a shop powerup and can't
      // be reflected, so it must NOT protect him.
      const mirrorPw = await giveHeldPowerup(raceId, bob.userId, "MIRROR", 3000, "RARE");
      const mirrorEffect = await giveActiveEffect(
        raceId, bob.userId, bob.userId, "MIRROR", mirrorPw.id,
        new Date(Date.now() + 60 * 60 * 1000)
      );

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-6");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      const res = await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.notEqual(body.result.reflected, true);
      assert.notEqual(body.result.blocked, true);
      assert.equal(body.result.outcome, "APPLIED");

      // The jam landed on the TARGET (bob), not the attacker.
      const aliceP = await participant(raceId, alice.userId);
      const bobP = await participant(raceId, bob.userId);
      const onBob = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "SIGNAL_JAMMER", targetParticipantId: bobP.id, status: "ACTIVE" },
      });
      assert.ok(onBob, "target is jammed");
      const onAlice = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "SIGNAL_JAMMER", targetParticipantId: aliceP.id, status: "ACTIVE" },
      });
      assert.equal(onAlice, null, "attacker is not jammed");

      // The Mirror is NOT consumed — still ACTIVE, banked for a reflectable hit.
      const mirrorNow = await prisma.raceActiveEffect.findUnique({ where: { id: mirrorEffect.id } });
      assert.equal(mirrorNow.status, "ACTIVE", "mirror is not consumed by the jam");

      // And the jam actually jams bob: he can't use a powerup.
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 7000, "COMMON");
      const blocked = await usePowerup(bob.token, raceId, shake.id);
      assert.equal(blocked.status, 409);
    });

    it("COMPRESSION_SOCKS blocks the jam: no effect on target, jammer consumed", async () => {
      await seedStoreCatalog();
      const alice = await createUser("JamAttacker7", 200);
      const bob = await createUser("JamSocks7");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      const socksPw = await giveHeldPowerup(raceId, bob.userId, "COMPRESSION_SOCKS", 3000, "RARE");
      const shield = await giveActiveEffect(
        raceId, bob.userId, bob.userId, "COMPRESSION_SOCKS", socksPw.id,
        new Date(Date.now() + 60 * 60 * 1000)
      );

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-7");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      const res = await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.result.blocked, true);
      assert.equal(body.result.blockedBy, "COMPRESSION_SOCKS");

      // Shield consumed; no jammer effect on the target; jammer consumed (USED).
      assert.equal(
        (await prisma.raceActiveEffect.findUnique({ where: { id: shield.id } })).status,
        "BLOCKED"
      );
      const bobP = await participant(raceId, bob.userId);
      const jamOnBob = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "SIGNAL_JAMMER", targetParticipantId: bobP.id },
      });
      assert.equal(jamOnBob, null, "no jam effect on shielded target");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: jammerId } })).status, "USED");

      // Bob (shielded, not jammed) can still use a powerup.
      const shake = await giveHeldPowerup(raceId, bob.userId, "PROTEIN_SHAKE", 8000, "COMMON");
      assert.equal((await usePowerup(bob.token, raceId, shake.id)).status, 200);
    });
  });

  // ── 10. Validation ─────────────────────────────────────────────────────
  describe("validation", () => {
    async function setup() {
      await seedStoreCatalog();
      const alice = await createUser("JamVal", 300);
      const bob = await createUser("JamValTarget");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob], { targetSteps: 1000 });
      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", `val-${nextAppleId}-${Date.now()}`);
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      return { alice, bob, raceId, jammerId };
    }

    it("requires a target", async () => {
      const { alice, raceId, jammerId } = await setup();
      const res = await usePowerup(alice.token, raceId, jammerId, {});
      assert.equal(res.status, 400);
    });

    it("cannot target yourself", async () => {
      const { alice, raceId, jammerId } = await setup();
      const res = await usePowerup(alice.token, raceId, jammerId, { targetUserId: alice.userId });
      assert.equal(res.status, 400);
    });

    it("rejects upgradeLevel > 0 (not upgradeable)", async () => {
      const { alice, bob, raceId, jammerId } = await setup();
      const res = await usePowerup(alice.token, raceId, jammerId, {
        targetUserId: bob.userId,
        upgradeLevel: 1,
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /not upgradeable/i);
    });

    it("rejects use when the race is not ACTIVE", async () => {
      const { alice, bob, raceId, jammerId } = await setup();
      await prisma.race.update({ where: { id: raceId }, data: { status: "COMPLETED" } });
      const res = await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });
      assert.equal(res.status, 400);
    });
  });

  // ── 11. Push emit shape ────────────────────────────────────────────────
  describe("push emit", () => {
    it("emits POWERUP_USED carrying targetUserId for the jam (drives the attack push)", async () => {
      await seedStoreCatalog();
      const alice = await createUser("JamPush", 200);
      const bob = await createUser("JamPushTarget");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);

      await purchase(alice.token, "POWERUP_SIGNAL_JAMMER", "alice-jam-push");
      const r = await redeem(alice.token, raceId, "SIGNAL_JAMMER");
      const jammerId = (await r.json()).result.powerup.id;
      const res = await usePowerup(alice.token, raceId, jammerId, { targetUserId: bob.userId });
      assert.equal(res.status, 200);

      // The POWERUP_USED feed row records the target — the same seam the push
      // handler reads (targetUserId + SIGNAL_JAMMER type). See the unit test in
      // test/handlers/notificationHandlers.test.js for the push assertion.
      const feed = await getFeed(alice.token, raceId);
      const usedEvent = feed.find(
        (e) => e.eventType === "POWERUP_USED" && e.powerupType === "SIGNAL_JAMMER"
      );
      assert.ok(usedEvent, "POWERUP_USED feed row for jammer");
      assert.equal(usedEvent.targetUserId, bob.userId);
    });
  });
});
