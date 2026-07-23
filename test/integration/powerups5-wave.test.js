const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

let server;
let nextAppleId = 0;
let earnCounter = 0;
const HOUR_MS = 60 * 60 * 1000;

// Wave-5 store catalog rows (cleanDatabase wipes them). Prices MUST match seed.js.
const WAVE5 = [
  { sku: "POWERUP_UPRISING", powerupType: "UPRISING", priceCoins: 300 },
  { sku: "POWERUP_GHOST_PEPPER", powerupType: "GHOST_PEPPER", priceCoins: 75 },
  { sku: "POWERUP_COIN_FLIP", powerupType: "COIN_FLIP", priceCoins: 40 },
  { sku: "POWERUP_MYSTERY_POTION", powerupType: "MYSTERY_POTION", priceCoins: 40 },
  { sku: "POWERUP_DECOY", powerupType: "DECOY", priceCoins: 150 },
  { sku: "POWERUP_POWER_OUTAGE", powerupType: "POWER_OUTAGE", priceCoins: 150 },
  { sku: "POWERUP_UMBRELLA", powerupType: "UMBRELLA", priceCoins: 75 },
  { sku: "POWERUP_RALLY_FLAG", powerupType: "RALLY_FLAG", priceCoins: 150 },
  { sku: "POWERUP_DRILL_SERGEANT", powerupType: "DRILL_SERGEANT", priceCoins: 150 },
  { sku: "POWERUP_PIGGY_BANK", powerupType: "PIGGY_BANK", priceCoins: 40 },
  { sku: "POWERUP_BOUNTY", powerupType: "BOUNTY", priceCoins: 75 },
];
const IMPOSTER_ROW = { sku: "POWERUP_IMPOSTER", powerupType: "IMPOSTER", priceCoins: 75 };

const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };
const OLD = { "X-Client-Features": "characters" };

async function seedCatalog() {
  for (const p of [...WAVE5, IMPOSTER_ROW]) {
    await prisma.powerupShopItem.upsert({
      where: { sku: p.sku },
      // testOnly:false in BOTH paths: another integration file may run the real
      // seed (which ships wave-5 rows testOnly:true), and this table is not
      // truncated between files — so force it visible on the prod channel here.
      update: { priceCoins: p.priceCoins, active: true, testOnly: false },
      create: { ...p, name: p.sku, description: `${p.sku} row`, active: true, testOnly: false },
    });
  }
}

async function createUser(displayName, coins = 0) {
  const appleId = `apple-p5-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: appleId } });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", { body: { displayName }, token: body.sessionToken });
  if (coins > 0) await prisma.user.update({ where: { id: body.user.id }, data: { coins } });
  return { userId: body.user.id, token: body.sessionToken };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", { body: { addresseeId: b.userId }, token: a.token });
  const friendshipId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, { body: { accept: true }, token: b.token });
}

async function createActiveRace(alice, opponents, opts = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: opts.name || "P5 Race", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
    token: alice.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { body: { inviteeIds: opponents.map((o) => o.userId) }, token: alice.token });
  for (const o of opponents) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { body: { accept: true }, token: o.token });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: alice.token });
  const start = new Date(Date.now() - 8 * HOUR_MS);
  const ends = opts.endsAt !== undefined ? opts.endsAt : new Date(Date.now() + 24 * HOUR_MS);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start, endsAt: ends } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: start } });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function setSteps(raceId, userId, totalSteps) {
  const p = await participant(raceId, userId);
  await prisma.raceParticipant.update({ where: { id: p.id }, data: { totalSteps } });
}

async function giveHeld(raceId, userId, type, rarity = "UNCOMMON") {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({ data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps: ++earnCounter } });
}

async function giveEffect(raceId, targetUserId, sourceUserId, type, { expiresAt, startsAt, metadata } = {}) {
  const p = await participant(raceId, targetUserId);
  const src = await participant(raceId, sourceUserId);
  const pw = await prisma.racePowerup.create({
    data: { raceId, participantId: src.id, userId: sourceUserId, type, rarity: "UNCOMMON", status: "USED", earnedAtSteps: ++earnCounter },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId, targetParticipantId: p.id, targetUserId, sourceUserId, powerupId: pw.id, type, status: "ACTIVE",
      startsAt: startsAt || new Date(Date.now() - 2 * HOUR_MS),
      expiresAt: expiresAt === undefined ? new Date(Date.now() + HOUR_MS) : expiresAt,
      metadata: metadata || {},
    },
  });
}

async function giveHourlySamples(userId, hoursAgoStart, hourCount, stepsPerHour) {
  const now = Date.now();
  for (let i = 0; i < hourCount; i++) {
    const periodStart = new Date(Math.floor((now - (hoursAgoStart - i) * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.upsert({
      where: { userId_periodStart: { userId, periodStart } },
      update: { steps: stepsPerHour, periodEnd },
      create: { userId, periodStart, periodEnd, steps: stepsPerHour, sourceName: "healthkit" },
    });
  }
}

async function usePU(token, raceId, powerupId, body = {}, headers = P5) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, { body, token, headers });
}
async function getProgress(token, raceId, headers = P5) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token, headers });
  return (await res.json()).progress;
}
async function purchase(token, body, key, headers = P5) {
  return request(server.baseUrl, "POST", "/shop/powerups/purchase", { body, token, headers: { "Idempotency-Key": key, ...headers } });
}
function findEffect(progress, type, userId) {
  return (progress.powerupData?.activeEffects || []).find((e) => e.type === type && (!userId || e.targetUserId === userId));
}
function boardSteps(progress, userId) {
  return (progress.participants || []).find((p) => p.userId === userId)?.totalSteps;
}

describe("powerups5 wave — integration", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); nextAppleId = 0; });

  // ── 1. Gating matrix ────────────────────────────────────────────────────
  describe("gating", () => {
    it("catalog exposes the 11 only with powerups5; identical without it", async () => {
      await seedCatalog();
      const u = await createUser("Cat", 1000);
      const withP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: P5 })).json();
      const types = withP5.items.map((i) => i.powerupType);
      for (const w of WAVE5) assert.ok(types.includes(w.powerupType), `${w.powerupType} visible with powerups5`);
      const byType = Object.fromEntries(withP5.items.map((i) => [i.powerupType, i]));
      assert.equal(byType.UPRISING.priceCoins, 300);
      assert.equal(byType.PIGGY_BANK.priceCoins, 40);
      assert.equal(byType.BOUNTY.priceCoins, 75);

      const withoutP5 = await (await request(server.baseUrl, "GET", "/shop/powerups", { token: u.token, headers: OLD })).json();
      const oldTypes = withoutP5.items.map((i) => i.powerupType);
      for (const w of WAVE5) assert.ok(!oldTypes.includes(w.powerupType), `${w.powerupType} hidden from old client`);
      assert.ok(oldTypes.includes("IMPOSTER"), "base catalog unchanged");
    });

    it("purchase guard: wave-5 purchase from old client → 404", async () => {
      await seedCatalog();
      const u = await createUser("Buyer", 1000);
      const res = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-old-1", OLD);
      assert.equal(res.status, 404);
      const ok = await purchase(u.token, { sku: "POWERUP_PIGGY_BANK" }, "p5-new-1", P5);
      assert.equal(ok.status, 200);
    });

    it("use of a wave-5 held item from an old client → UPDATE_REQUIRED, stays HELD", async () => {
      await seedCatalog();
      const alice = await createUser("A"); const bob = await createUser("B");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      const pw = await giveHeld(raceId, alice.userId, "UMBRELLA");
      const res = await usePU(alice.token, raceId, pw.id, {}, OLD);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "UPDATE_REQUIRED");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "HELD");
    });

    it("activeEffects downcast for old clients: POWER_OUTAGE→SIGNAL_JAMMER, UPRISING→RUNNERS_HIGH; DECOY withheld", async () => {
      const alice = await createUser("A"); const bob = await createUser("B");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      await giveEffect(raceId, bob.userId, alice.userId, "POWER_OUTAGE");
      await giveEffect(raceId, bob.userId, bob.userId, "UPRISING", { metadata: { multiplier: 2 } });
      await giveEffect(raceId, bob.userId, bob.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });

      const p5 = await getProgress(bob.token, raceId, P5);
      assert.ok(findEffect(p5, "POWER_OUTAGE"), "power outage rendered natively for p5");
      assert.ok(findEffect(p5, "UPRISING"), "uprising rendered natively for p5");
      assert.ok(findEffect(p5, "DECOY"), "decoy visible to its owner");

      const old = await getProgress(bob.token, raceId, OLD);
      assert.ok(!findEffect(old, "POWER_OUTAGE"), "power outage not raw for old client");
      assert.ok(findEffect(old, "SIGNAL_JAMMER"), "downcast to signal jammer");
      assert.ok(findEffect(old, "RUNNERS_HIGH"), "uprising downcast to runners high");
      assert.ok(!findEffect(old, "DECOY"), "decoy withheld from old client");
    });
  });

  // ── 2. Uprising ─────────────────────────────────────────────────────────
  describe("uprising", () => {
    it("top-half caster is rejected 400; bottom-half caster fans out to the bottom half", async () => {
      await seedCatalog();
      const a = await createUser("Leader"); const b = await createUser("Mid"); const c = await createUser("Last");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await setSteps(raceId, a.userId, 9000);
      await setSteps(raceId, b.userId, 5000);
      await setSteps(raceId, c.userId, 1000);

      // Leader (top) cannot use it.
      const leaderPw = await giveHeld(raceId, a.userId, "UPRISING");
      const bad = await usePU(a.token, raceId, leaderPw.id, {});
      assert.equal(bad.status, 400);
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: leaderPw.id } })).status, "HELD");

      // Last place (bottom half, n=3 → ceil(3/2)=2 → only index 2) can use it.
      const lastPw = await giveHeld(raceId, c.userId, "UPRISING");
      const ok = await usePU(c.token, raceId, lastPw.id, {});
      assert.equal(ok.status, 200);
      const body = (await ok.json()).result;
      assert.equal(body.outcome, "APPLIED");
      assert.ok(body.affected >= 1);
      const rows = await prisma.raceActiveEffect.findMany({ where: { raceId, type: "UPRISING", status: "ACTIVE" } });
      assert.equal(rows.length, body.affected);
      assert.ok(rows.some((r) => r.targetUserId === c.userId), "caster is a beneficiary");
    });
  });

  // ── 3/4. Coin Flip + settlement parity ──────────────────────────────────
  describe("coin flip", () => {
    it("use returns flip WIN|LOSE and multiplier; effect created", async () => {
      await seedCatalog();
      const a = await createUser("Flipper");
      const b = await createUser("Other");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "COIN_FLIP");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(["WIN", "LOSE"].includes(r.flip));
      assert.equal(r.multiplier, r.flip === "WIN" ? 2 : 0.5);
      assert.ok(r.effect);
    });

    it("seeded COIN_FLIP lose halves in-window steps (settlement matches live)", async () => {
      const a = await createUser("LoserFlip");
      const b = await createUser("Ctrl");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples (hours 6..3 ago), 1000 steps each = 4000.
      await giveHourlySamples(a.userId, 6, 4, 1000);
      await giveHourlySamples(b.userId, 6, 4, 1000);
      // Coin-flip lose covering hours 6..2 ago (already expired window, closed).
      await giveEffect(raceId, a.userId, a.userId, "COIN_FLIP", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { multiplier: 0.5, stepsAtStart: 0 },
      });
      const live = await getProgress(a.token, raceId);
      const aLive = boardSteps(live, a.userId);
      const bLive = boardSteps(live, b.userId);
      assert.ok(aLive < bLive, `coin-flip lose should reduce steps: ${aLive} < ${bLive}`);

      // Settlement parity: move endsAt to just-now and settle.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const settled = await participant(raceId, a.userId);
      assert.equal(settled.totalSteps, aLive, "settled total equals live total (parity)");
    });
  });

  // ── 6. Decoy ────────────────────────────────────────────────────────────
  describe("decoy", () => {
    it("redirects a single-target attack to a third party; REDIRECTED response", async () => {
      const a = await createUser("Attacker"); const b = await createUser("DecoyHolder"); const c = await createUser("Bystander");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const legCramp = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, legCramp.id, { targetUserId: b.userId });
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedBy, "DECOY");
      assert.equal(r.redirectedToUserId, c.userId);
      // The cramp landed on c, not b; decoy consumed.
      const cP = await participant(raceId, c.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: cP.id, status: "ACTIVE" } });
      assert.ok(cramp, "redirected cramp on bystander");
      const decoyRow = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "DECOY" } });
      assert.equal(decoyRow.status, "EXPIRED", "decoy consumed");
    });

    it("2-player race: Decoy fizzles as a block (no third party)", async () => {
      const a = await createUser("Attacker2"); const b = await createUser("Solo");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const pw = await giveHeld(raceId, a.userId, "LEG_CRAMP");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.blocked, true);
      assert.equal(r.blockedBy, "DECOY");
      const bP = await participant(raceId, b.userId);
      const cramp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "LEG_CRAMP", targetParticipantId: bP.id } });
      assert.equal(cramp, null, "no cramp landed");
    });

    it("shop-type attack (does not reflect) is still redirected by Decoy", async () => {
      await seedCatalog();
      const a = await createUser("ShopAtt"); const b = await createUser("DHolder"); const c = await createUser("Third");
      await makeFriends(a, b); await makeFriends(a, c);
      const raceId = await createActiveRace(a, [b, c]);
      await giveEffect(raceId, b.userId, b.userId, "DECOY", { expiresAt: new Date(Date.now() + 24 * HOUR_MS) });
      const jam = await giveHeld(raceId, a.userId, "SIGNAL_JAMMER");
      const res = await usePU(a.token, raceId, jam.id, { targetUserId: b.userId });
      const r = (await res.json()).result;
      assert.equal(r.outcome, "REDIRECTED");
      assert.equal(r.redirectedToUserId, c.userId);
    });
  });

  // ── 7. Power Outage ─────────────────────────────────────────────────────
  describe("power outage", () => {
    it("jams all enemies; a jammed enemy can't use powerups; Socks exempt; Umbrella skipped", async () => {
      await seedCatalog();
      const a = await createUser("Outage"); const b = await createUser("Jammed"); const c = await createUser("Socked"); const d = await createUser("Umbrellaed");
      for (const x of [b, c, d]) await makeFriends(a, x);
      const raceId = await createActiveRace(a, [b, c, d]);
      await giveEffect(raceId, c.userId, c.userId, "COMPRESSION_SOCKS", { expiresAt: new Date(Date.now() + HOUR_MS) });
      await giveEffect(raceId, d.userId, d.userId, "UMBRELLA", { expiresAt: new Date(Date.now() + 12 * HOUR_MS) });

      const pw = await giveHeld(raceId, a.userId, "POWER_OUTAGE");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.equal(r.affected, 1, "only b is jammed (c socks, d umbrella)");
      assert.equal(r.blockedCount, 1, "c's socks blocked");

      const bJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, b.userId)).id, status: "ACTIVE" } });
      assert.ok(bJam);
      const dJam = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "POWER_OUTAGE", targetParticipantId: (await participant(raceId, d.userId)).id } });
      assert.equal(dJam, null, "umbrella holder not jammed");
      const umbrella = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "UMBRELLA" } });
      assert.equal(umbrella.status, "ACTIVE", "umbrella not consumed");

      // b (jammed by power outage) cannot use a powerup.
      const shake = await giveHeld(raceId, b.userId, "PROTEIN_SHAKE");
      const blocked = await usePU(b.token, raceId, shake.id, {});
      assert.equal(blocked.status, 409);
    });
  });

  // ── 8. Rally Flag ───────────────────────────────────────────────────────
  describe("rally flag", () => {
    it("rejected 400 outside a team race", async () => {
      await seedCatalog();
      const a = await createUser("Flagger"); const b = await createUser("X");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      const pw = await giveHeld(raceId, a.userId, "RALLY_FLAG");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /team race/i);
    });
  });

  // ── 10. Drill Sergeant ──────────────────────────────────────────────────
  describe("drill sergeant", () => {
    it("penalizes the target at expiry when the goal is missed", async () => {
      const a = await createUser("Sarge"); const b = await createUser("Recruit");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, b.userId, 5000);
      // Dare that already expired, target walked 0 in-window (no samples) → fail.
      await giveEffect(raceId, b.userId, a.userId, "DRILL_SERGEANT", {
        startsAt: new Date(Date.now() - 3 * HOUR_MS),
        expiresAt: new Date(Date.now() - 60 * 1000),
        metadata: { goalSteps: 3000, penaltySteps: 1500, stepsAtStart: 5000 },
      });
      // Lazy expiry via progress.
      await getProgress(a.token, raceId);
      const bP = await participant(raceId, b.userId);
      assert.equal(bP.bonusSteps, -1500, "penalty applied at expiry");
      const feed = (await (await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token: a.token })).json()).events;
      assert.ok(feed.some((e) => e.powerupType === "DRILL_SERGEANT" && /failed/i.test(e.description)));
    });

    it("void (no penalty) when the race ended before the dare's expiry", async () => {
      const a = await createUser("Sarge2"); const b = await createUser("Recruit2");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b], { endsAt: new Date(Date.now() - 2 * HOUR_MS) });
      await giveEffect(raceId, b.userId, a.userId, "DRILL_SERGEANT", {
        startsAt: new Date(Date.now() - 4 * HOUR_MS),
        expiresAt: new Date(Date.now() - 60 * 1000),
        metadata: { goalSteps: 3000, penaltySteps: 1500, stepsAtStart: 0 },
      });
      const { evaluateDrillSergeant, mintPiggyBank } = require("../../src/modules/powerups/commands/expireEffects");
      // Expire via the command directly.
      const { expireEffects } = require("../../src/modules/powerups/commands/expireEffects");
      await expireEffects({ raceId });
      const bP = await participant(raceId, b.userId);
      assert.equal(bP.bonusSteps, 0, "no penalty — race ended first");
    });
  });

  // ── 11. Piggy Bank ──────────────────────────────────────────────────────
  describe("piggy bank", () => {
    it("mints coins at expiry (rate/cap), exactly once", async () => {
      const a = await createUser("Saver");
      const b = await createUser("Z");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps in window → floor(6000/300)=20 coins.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      const eff = await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: new Date(Math.floor((Date.now() - 6 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        expiresAt: new Date(Math.floor((Date.now() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const { expireEffects } = require("../../src/modules/powerups/commands/expireEffects");
      await expireEffects({ raceId });
      const afterOne = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterOne - coinsBefore, 20, "20 coins minted");
      // Second run (settlement) is idempotent via refId.
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const afterTwo = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(afterTwo, afterOne, "no double mint");
      const txns = await prisma.coinTransaction.findMany({ where: { userId: a.userId, reason: "piggy_bank" } });
      assert.equal(txns.length, 1);
    });

    it("only one ACTIVE piggy per user globally (cross-race 409)", async () => {
      await seedCatalog();
      const a = await createUser("MultiSaver"); const b = await createUser("Y"); const c = await createUser("W");
      await makeFriends(a, b); await makeFriends(a, c);
      const race1 = await createActiveRace(a, [b], { name: "Race One" });
      const race2 = await createActiveRace(a, [c], { name: "Race Two" });
      const pw1 = await giveHeld(race1, a.userId, "PIGGY_BANK");
      assert.equal((await usePU(a.token, race1, pw1.id, {})).status, 200);
      const pw2 = await giveHeld(race2, a.userId, "PIGGY_BANK");
      const res = await usePU(a.token, race2, pw2.id, {});
      assert.equal(res.status, 409, "second piggy in another race blocked");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw2.id } })).status, "HELD");
    });
  });

  // ── 11b. Piggy Bank live "banked so far" counter (display-only) ──────────
  // The viewer's OWN active PIGGY_BANK entry in progress carries an additive
  // piggyBank:{bankedCoins,coinCap,windowSteps} computed with the SAME
  // sumStepsInWindow the mint uses over [startsAt, min(expiresAt, now)]. No coin
  // writes, no mint-timing change. See piggy-bank-live-counter-requirements.md.
  describe("piggy bank live counter", () => {
    // hour-aligned start N hours ago (matches giveHourlySamples bucketing).
    const alignedHoursAgo = (h) =>
      new Date(Math.floor((Date.now() - h * HOUR_MS) / HOUR_MS) * HOUR_MS);

    it("owner sees bankedCoins = floor(windowSteps/rate), coinCap, windowSteps", async () => {
      const a = await createUser("LiveSaver");
      const b = await createUser("LZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 4 closed hourly samples of 1500 = 6000 steps inside the window.
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS), // future → endCap = now
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "owner sees their piggy entry");
      assert.ok(eff.piggyBank, "piggyBank field present");
      assert.equal(eff.piggyBank.bankedCoins, 20, "floor(6000/300)=20");
      assert.equal(eff.piggyBank.coinCap, 80, "cap from snapshot");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 6000) <= 100,
        `windowSteps ≈ 6000 (got ${eff.piggyBank.windowSteps})`
      );
      assert.equal(Number.isInteger(eff.piggyBank.windowSteps), true, "windowSteps is int");
    });

    it("clamps bankedCoins to coinCap when steps exceed cap*rate", async () => {
      const a = await createUser("CapSaver");
      const b = await createUser("CZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // 5 × 6000 = 30000 steps → floor(30000/300)=100, clamped to cap 80.
      await giveHourlySamples(a.userId, 6, 5, 6000);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 80, "clamped to coinCap");
      assert.equal(eff.piggyBank.coinCap, 80);
    });

    it("excludes steps taken before startsAt", async () => {
      const a = await createUser("EarlySaver");
      const b = await createUser("EZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      // Pre-activation sample (now-6h, 9000 steps) must NOT count.
      await giveHourlySamples(a.userId, 6, 1, 9000);
      // In-window samples: now-3h and now-2h, 1500 each = 3000.
      await giveHourlySamples(a.userId, 3, 2, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(3),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.equal(eff.piggyBank.bankedCoins, 10, "floor(3000/300)=10, pre-start excluded");
      assert.ok(
        Math.abs(eff.piggyBank.windowSteps - 3000) <= 100,
        `windowSteps ≈ 3000 (got ${eff.piggyBank.windowSteps})`
      );
    });

    it("kill-switch snapshot (coinCap:0) → entry present, piggyBank absent", async () => {
      const a = await createUser("DeadSaver");
      const b = await createUser("DZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 0, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId);
      const eff = findEffect(prog, "PIGGY_BANK", a.userId);
      assert.ok(eff, "entry still present");
      assert.equal(eff.piggyBank, undefined, "no piggyBank field when nothing will mint");
    });

    it("opponent never sees the owner's piggy entry (HIDDEN_FROM_OPPONENTS holds)", async () => {
      const a = await createUser("HiddenSaver");
      const b = await createUser("HZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const bProg = await getProgress(b.token, raceId);
      assert.equal(findEffect(bProg, "PIGGY_BANK"), undefined, "no piggy entry for opponent");
    });

    it("non-powerups5 client sees no PIGGY_BANK entry at all", async () => {
      const a = await createUser("OldSaver");
      const b = await createUser("OZ");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveHourlySamples(a.userId, 6, 4, 1500);
      await giveEffect(raceId, a.userId, a.userId, "PIGGY_BANK", {
        startsAt: alignedHoursAgo(6),
        expiresAt: new Date(Date.now() + HOUR_MS),
        metadata: { stepsPerCoin: 300, coinCap: 80, stepsAtStart: 0 },
      });
      const prog = await getProgress(a.token, raceId, OLD);
      assert.equal(findEffect(prog, "PIGGY_BANK"), undefined, "withheld without powerups5");
    });
  });

  // ── 12. Bounty ──────────────────────────────────────────────────────────
  describe("bounty", () => {
    it("must target a rival ahead; pays out when the caster out-places the target; publicly visible", async () => {
      await seedCatalog();
      const a = await createUser("Hunter"); const b = await createUser("Prey");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000); // b ahead of a

      // a can't target someone behind: try targeting nobody-ahead is enforced by ahead check.
      const behindPw = await giveHeld(raceId, b.userId, "BOUNTY");
      const behindRes = await usePU(b.token, raceId, behindPw.id, { targetUserId: a.userId });
      assert.equal(behindRes.status, 400, "cannot bounty a rival behind you");

      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const ok = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).result.payoutCoins, 150);

      // Bounty is publicly visible to the target.
      const bProg = await getProgress(b.token, raceId);
      assert.ok(findEffect(bProg, "BOUNTY"), "bounty visible to opponent");

      // Now a out-places b. Settlement recomputes totals from step samples, so
      // seed a >> b to make the final placement deterministic.
      await giveHourlySamples(a.userId, 6, 5, 4000); // 20000
      await giveHourlySamples(b.userId, 6, 1, 500);  // 500
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter - coinsBefore, 150, "bounty paid on out-place");
      // Idempotent second settle.
      await resolveExpiredRaces();
      const coinsAfter2 = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter2, coinsAfter, "no double bounty payout");
    });

    it("no payout when the caster does NOT out-place the target", async () => {
      await seedCatalog();
      const a = await createUser("Hunter2"); const b = await createUser("Prey2");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, a.userId, 3000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      // b stays ahead at settlement (seed b >> a) → no payout.
      await giveHourlySamples(a.userId, 6, 1, 500);
      await giveHourlySamples(b.userId, 6, 5, 4000);
      const coinsBefore = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      await prisma.race.update({ where: { id: raceId }, data: { endsAt: new Date(Date.now() - 60 * 1000) } });
      await resolveExpiredRaces();
      const coinsAfter = (await prisma.user.findUnique({ where: { id: a.userId } })).coins;
      assert.equal(coinsAfter, coinsBefore, "no payout when not out-placed");
    });

    it("rejected 400 on a target-step race (no fixed end)", async () => {
      await seedCatalog();
      const a = await createUser("Hunter3"); const b = await createUser("Prey3");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b], { endsAt: null });
      await setSteps(raceId, a.userId, 1000);
      await setSteps(raceId, b.userId, 9000);
      const pw = await giveHeld(raceId, a.userId, "BOUNTY");
      const res = await usePU(a.token, raceId, pw.id, { targetUserId: b.userId });
      assert.equal(res.status, 400);
    });
  });

  // ── 3. Ghost Pepper (not cleansable) ────────────────────────────────────
  describe("ghost pepper", () => {
    it("self-inflicted freeze is not removable by Cleanse", async () => {
      const a = await createUser("Spicy");
      const b = await createUser("Q");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await giveEffect(raceId, a.userId, a.userId, "GHOST_PEPPER", {
        startsAt: new Date(Date.now() - 10 * 60 * 1000),
        expiresAt: new Date(Date.now() + 50 * 60 * 1000),
        metadata: { boostMs: 30 * 60 * 1000, multiplier: 3, freezeMs: 30 * 60 * 1000, stepsAtBoostStart: 0 },
      });
      const cleanse = await giveHeld(raceId, a.userId, "CLEANSE");
      const res = await usePU(a.token, raceId, cleanse.id, {});
      // Cleanse rejects (no opponent debuffs) — ghost pepper is self-sourced.
      assert.equal(res.status, 400);
      const gp = await prisma.raceActiveEffect.findFirst({ where: { raceId, type: "GHOST_PEPPER" } });
      assert.equal(gp.status, "ACTIVE", "ghost pepper survives cleanse");
    });
  });

  // ── 5. Mystery Potion ───────────────────────────────────────────────────
  describe("mystery potion", () => {
    it("resolves to a valid rolled outcome and never fails after consumption", async () => {
      await seedCatalog();
      const a = await createUser("Alchemist", 100); const b = await createUser("Rival");
      await makeFriends(a, b);
      const raceId = await createActiveRace(a, [b]);
      await setSteps(raceId, b.userId, 5000);
      const pw = await giveHeld(raceId, a.userId, "MYSTERY_POTION");
      const res = await usePU(a.token, raceId, pw.id, {});
      assert.equal(res.status, 200);
      const r = (await res.json()).result;
      assert.ok(r.rolled, "a rolled outcome is reported");
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: pw.id } })).status, "USED");
    });
  });
});
