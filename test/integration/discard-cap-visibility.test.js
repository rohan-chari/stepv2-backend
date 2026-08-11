// Batch 2026-08-10 (part 2) — Item 2: the discard modal must know the daily
// coin cap BEFORE the first discard of a screen visit.
//
// `powerupData.discardCapRemaining` (additive, integer >= 0) is served from the
// same consumedToday + discardDailyCap() the award itself uses, so the dialog
// can never promise coins the server won't pay.
//
// Redis is a pure OPTIMIZATION here: this whole suite runs with REDIS_URL
// unset (test 4b), and every case must still pass.

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

const CAP = 40;
const P5 = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };
const DISCARD_REASON = "powerup_discard";

function localDateIn(instant, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

async function createUser(displayName, timezone = "UTC") {
  const appleId = `apple-dcap-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  await prisma.user.update({ where: { id: body.user.id }, data: { timezone } });
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
      name: "Discard Cap Test",
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: start } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: start },
  });
  return raceId;
}

async function seedHeldPowerup(raceId, user, overrides = {}) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId: user.userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId: user.userId,
      type: "PROTEIN_SHAKE",
      rarity: "COMMON",
      status: "HELD",
      earnedAtSteps: Math.floor(Math.random() * 1_000_000),
      ...overrides,
    },
  });
}

// A prior discard payout on the user's ledger. `createdAt` controls which LOCAL
// day it lands on.
async function seedDiscardCoins(userId, amount, createdAt = new Date()) {
  return prisma.coinTransaction.create({
    data: {
      userId,
      amount,
      reason: DISCARD_REASON,
      refId: `seed-${Math.random()}`,
      createdAt,
    },
  });
}

async function progress(token, raceId, headers = P5) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers,
  });
  return { status: res.status, body: await res.json() };
}

async function capRemainingOf(token, raceId, headers) {
  const { body } = await progress(token, raceId, headers);
  return body.progress.powerupData.discardCapRemaining;
}

async function discard(token, raceId, powerupId) {
  const res = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/discard`,
    { token, headers: P5 }
  );
  return { status: res.status, body: await res.json() };
}

describe("Batch 2026-08-10b item 2 — powerupData.discardCapRemaining", () => {
  let alice;
  let bob;
  let raceId;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    process.env.POWERUP_DISCARD_DAILY_COIN_CAP = String(CAP);
    nextAppleId = 0;
    alice = await createUser("Alice");
    bob = await createUser("Bob");
    await makeFriends(alice, bob);
    raceId = await createActiveRace(alice, bob);
  });

  afterEach(() => {
    delete process.env.POWERUP_DISCARD_DAILY_COIN_CAP;
  });

  // ── 4b. Redis is an optimization, never a precondition ───────────────────
  it("the whole feature works with REDIS_URL unset", async () => {
    assert.equal(
      process.env.REDIS_URL,
      undefined,
      "this suite must run without Redis — that is the point of the case"
    );
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), CAP);
  });

  // ── 1. Fresh user ────────────────────────────────────────────────────────
  it("nothing discarded today -> the full configured cap", async () => {
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), CAP);
  });

  it("tracks a non-default configured cap", async () => {
    process.env.POWERUP_DISCARD_DAILY_COIN_CAP = "12";
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), 12);
  });

  // ── 2. Exhausted ─────────────────────────────────────────────────────────
  it("after discarding to exactly the cap -> 0", async () => {
    await seedDiscardCoins(alice.userId, CAP);
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), 0);
  });

  it("never goes negative if the ledger overshot the cap", async () => {
    await seedDiscardCoins(alice.userId, CAP + 9);
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), 0);
  });

  it("a real discard moves the served value on the NEXT progress read", async () => {
    const p = await seedHeldPowerup(raceId, alice, { rarity: "RARE" });
    await seedHeldPowerup(raceId, alice); // keep a HELD row so the key survives
    assert.equal(await capRemainingOf(alice.token, raceId), CAP);

    const res = await discard(alice.token, raceId, p.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.coinsAwarded, 10, "RARE pays 10");
    assert.equal(res.body.capRemaining, CAP - 10);

    assert.equal(await capRemainingOf(alice.token, raceId), CAP - 10);
  });

  // ── 3. Partial headroom + the clamped award ──────────────────────────────
  it("partial headroom (cap - 2) -> 2, and a RARE discard then pays exactly 2", async () => {
    await seedDiscardCoins(alice.userId, CAP - 2);
    const p = await seedHeldPowerup(raceId, alice, { rarity: "RARE" });
    await seedHeldPowerup(raceId, alice);

    assert.equal(
      await capRemainingOf(alice.token, raceId),
      2,
      "the dialog can quote the CLAMPED amount before any discard"
    );

    const res = await discard(alice.token, raceId, p.id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.coinsAwarded, 2, "min(price=10, capRemaining=2)");
    assert.equal(res.body.capRemaining, 0);
    assert.equal(await capRemainingOf(alice.token, raceId), 0);
  });

  // ── 4. The cost guard ────────────────────────────────────────────────────
  it("a viewer with NO HELD powerups -> the key is omitted entirely", async () => {
    const { body } = await progress(alice.token, raceId);
    const pd = body.progress.powerupData;
    assert.ok(pd, "powerupData still present");
    assert.equal(
      "discardCapRemaining" in pd,
      false,
      "no discardable row => no query, no key"
    );
  });

  it("an UNOPENED MYSTERY_BOX alone does not trigger the query", async () => {
    await seedHeldPowerup(raceId, alice, {
      type: "MYSTERY_BOX",
      status: "MYSTERY_BOX",
      rarity: null,
    });
    const { body } = await progress(alice.token, raceId);
    assert.equal("discardCapRemaining" in body.progress.powerupData, false);
  });

  it("FROZEN CLIENT: no X-Client-Features -> the key is still additive-safe", async () => {
    await seedHeldPowerup(raceId, alice);
    const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
      token: alice.token,
    });
    const body = await res.json();
    const pd = body.progress.powerupData;
    // Additive: present for everyone, ignored by frozen binaries. The shape a
    // frozen binary already reads must be intact.
    assert.equal(pd.discardCapRemaining, CAP);
    for (const key of [
      "enabled",
      "newMysteryBoxes",
      "powerupStepInterval",
      "upgradeCosts",
      "rarityByType",
      "powerupSlots",
      "inventory",
      "queuedBoxCount",
      "activeEffects",
      "discardPrices",
    ]) {
      assert.ok(key in pd, `powerupData.${key} still present`);
    }
  });

  // ── 5. Timezone: the STORED zone, never the spoofable header ─────────────
  it("the day boundary comes from the user's STORED zone, not X-Timezone", async () => {
    // An instant 13h ago is "today" in some zones and "yesterday" in others.
    // Pick one of each so the two answers are genuinely different.
    const now = new Date();
    const then = new Date(now.getTime() - 13 * 60 * 60 * 1000);
    const candidates = [
      "Pacific/Kiritimati",
      "Asia/Tokyo",
      "Europe/London",
      "UTC",
      "America/New_York",
      "Pacific/Honolulu",
      "Etc/GMT+12",
    ];
    const sameDayZone = candidates.find(
      (z) => localDateIn(then, z) === localDateIn(now, z)
    );
    const rolledOverZone = candidates.find(
      (z) => localDateIn(then, z) !== localDateIn(now, z)
    );
    assert.ok(sameDayZone, "expected a zone where the 13h-old row is still today");
    assert.ok(rolledOverZone, "expected a zone where the day has rolled over");

    await seedDiscardCoins(alice.userId, 30, then);
    await seedHeldPowerup(raceId, alice);

    // Stored zone = the zone that has ROLLED OVER: the old row is yesterday's,
    // so today's cap is untouched — even though the header claims otherwise.
    await prisma.user.update({
      where: { id: alice.userId },
      data: { timezone: rolledOverZone },
    });
    assert.equal(
      await capRemainingOf(alice.token, raceId, {
        ...P5,
        "X-Timezone": sameDayZone,
      }),
      CAP,
      "a spoofed X-Timezone must not shrink the cap"
    );

    // Stored zone = the same-day zone: the row counts, header notwithstanding.
    await prisma.user.update({
      where: { id: alice.userId },
      data: { timezone: sameDayZone },
    });
    assert.equal(
      await capRemainingOf(alice.token, raceId, {
        ...P5,
        "X-Timezone": rolledOverZone,
      }),
      CAP - 30,
      "a spoofed X-Timezone must not widen the cap either"
    );
  });

  // ── Isolation ────────────────────────────────────────────────────────────
  it("another user's discards do not consume this viewer's cap", async () => {
    await seedDiscardCoins(bob.userId, CAP);
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), CAP);
  });

  it("non-discard coin reasons do not consume the cap", async () => {
    await prisma.coinTransaction.create({
      data: {
        userId: alice.userId,
        amount: CAP,
        reason: "daily_reward",
        refId: `other-${Math.random()}`,
      },
    });
    await seedHeldPowerup(raceId, alice);
    assert.equal(await capRemainingOf(alice.token, raceId), CAP);
  });
});
