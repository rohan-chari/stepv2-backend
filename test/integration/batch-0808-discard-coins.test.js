const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// Batch 2026-08-08 item 1 — discarding an in-race powerup pays coins by rarity,
// capped per user per LOCAL day.
//
// Every assertion here is on the HTTP response a client actually receives, or
// on the coin ledger row the server actually wrote. Nothing reaches past the
// endpoint into the pricing/cap helpers.

let server;
let nextAppleId = 0;

async function createUser({ timezone } = {}) {
  const appleId = `apple-d0808-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (timezone) {
    await prisma.user.update({ where: { id: body.user.id }, data: { timezone } });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function createActiveRace(alice, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Discard 0808",
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
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: alice.token,
  });
  return raceId;
}

// A box-earned powerup in the state the discard endpoint accepts.
async function givePowerup(raceId, userId, { type, rarity, status, earnedAtSteps }) {
  const participant = await prisma.raceParticipant.findFirst({
    where: { raceId, userId },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity,
      status,
      earnedAtSteps,
    },
  });
}

function discard(raceId, powerupId, token) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/discard`,
    { token }
  );
}

async function discardLedger(userId) {
  return prisma.coinTransaction.findMany({
    where: { userId, reason: "powerup_discard" },
    orderBy: { createdAt: "asc" },
  });
}

async function coinBalance(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return u.coins;
}

describe("batch 2026-08-08 item 1 — discard powerups for coins", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    delete process.env.POWERUP_DISCARD_DAILY_COIN_CAP;
  });

  // ── pricing by rarity ────────────────────────────────────────────────────

  for (const [rarity, price] of [
    ["COMMON", 2],
    ["UNCOMMON", 5],
    ["RARE", 10],
  ]) {
    it(`a HELD ${rarity} powerup pays ${price} coins and reports them on the wire`, async () => {
      const alice = await createUser();
      const bob = await createUser();
      const raceId = await createActiveRace(alice, [bob]);
      const before = await coinBalance(alice.userId);
      const p = await givePowerup(raceId, alice.userId, {
        type: "PROTEIN_SHAKE",
        rarity,
        status: "HELD",
        earnedAtSteps: 5000,
      });

      const res = await discard(raceId, p.id, alice.token);
      assert.equal(res.status, 200);
      const body = await res.json();

      assert.equal(body.coinsAwarded, price);
      assert.equal(body.coins, before + price);
      assert.equal(body.capRemaining, 40 - price);
      assert.equal(body.ok, true);

      // The ledger is the source of truth, not the response.
      const rows = await discardLedger(alice.userId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].amount, price);
      assert.equal(await coinBalance(alice.userId), before + price);

      const stored = await prisma.racePowerup.findUnique({ where: { id: p.id } });
      assert.equal(stored.status, "DISCARDED");
    });
  }

  it("an UNOPENED mystery box is still discardable but pays 0 (exploit S4)", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const before = await coinBalance(alice.userId);
    const p = await givePowerup(raceId, alice.userId, {
      type: null,
      rarity: null,
      status: "MYSTERY_BOX",
      earnedAtSteps: 5000,
    });

    const res = await discard(raceId, p.id, alice.token);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.coinsAwarded, 0);
    assert.equal(body.coins, before);
    assert.equal(body.capRemaining, 40);
    assert.equal((await discardLedger(alice.userId)).length, 0);

    const stored = await prisma.racePowerup.findUnique({ where: { id: p.id } });
    assert.equal(stored.status, "DISCARDED");
  });

  it("a HELD powerup with NULL rarity (stash-redeemed) floors to the COMMON price", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: null,
      status: "HELD",
      earnedAtSteps: 5000,
    });

    const body = await (await discard(raceId, p.id, alice.token)).json();
    assert.equal(body.coinsAwarded, 2);
  });

  // ── the daily cap ────────────────────────────────────────────────────────

  it("PARTIAL AWARD: at 38/40 a RARE discard pays only the 2 remaining", async () => {
    const alice = await createUser({ timezone: "America/New_York" });
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);

    // 38 coins already consumed today, written the way awardCoins writes them.
    await prisma.coinTransaction.create({
      data: {
        userId: alice.userId,
        amount: 38,
        reason: "powerup_discard",
        refId: "seed-38",
      },
    });
    const before = await coinBalance(alice.userId);

    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const body = await (await discard(raceId, p.id, alice.token)).json();

    assert.equal(body.coinsAwarded, 2, "min(price=10, capRemaining=2)");
    assert.equal(body.capRemaining, 0);
    assert.equal(body.coins, before + 2);
  });

  it("at 40/40 the discard still succeeds but pays 0 and writes no ledger row", async () => {
    const alice = await createUser({ timezone: "America/New_York" });
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    await prisma.coinTransaction.create({
      data: {
        userId: alice.userId,
        amount: 40,
        reason: "powerup_discard",
        refId: "seed-40",
      },
    });
    const before = await coinBalance(alice.userId);

    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const res = await discard(raceId, p.id, alice.token);
    assert.equal(res.status, 200, "cap reached must not fail the discard");
    const body = await res.json();

    assert.equal(body.coinsAwarded, 0);
    assert.equal(body.capRemaining, 0);
    assert.equal(body.coins, before);
    assert.equal((await discardLedger(alice.userId)).length, 1, "only the seed row");

    const stored = await prisma.racePowerup.findUnique({ where: { id: p.id } });
    assert.equal(stored.status, "DISCARDED");
  });

  it("the cap is per LOCAL day: yesterday's spend does not count against today", async () => {
    // Chosen so 'now' is unambiguously the same local date in this zone
    // regardless of when the suite runs: we place the old row 40h back, which
    // is >1 local day earlier in every zone.
    const alice = await createUser({ timezone: "America/New_York" });
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);

    await prisma.coinTransaction.create({
      data: {
        userId: alice.userId,
        amount: 40,
        reason: "powerup_discard",
        refId: "seed-yesterday",
        createdAt: new Date(Date.now() - 40 * 60 * 60 * 1000),
      },
    });

    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const body = await (await discard(raceId, p.id, alice.token)).json();

    assert.equal(body.coinsAwarded, 10, "a previous local day must not consume today's cap");
    assert.equal(body.capRemaining, 30);
  });

  it("the cap counts only powerup_discard, not other coin reasons", async () => {
    const alice = await createUser({ timezone: "America/New_York" });
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    await prisma.coinTransaction.create({
      data: {
        userId: alice.userId,
        amount: 500,
        reason: "ad_coin_reward",
        refId: "unrelated",
      },
    });

    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const body = await (await discard(raceId, p.id, alice.token)).json();
    assert.equal(body.coinsAwarded, 10);
    assert.equal(body.capRemaining, 30);
  });

  it("POWERUP_DISCARD_DAILY_COIN_CAP overrides the cap, and a malformed value falls back to 40", async () => {
    const alice = await createUser({ timezone: "America/New_York" });
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);

    process.env.POWERUP_DISCARD_DAILY_COIN_CAP = "6";
    const p1 = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const b1 = await (await discard(raceId, p1.id, alice.token)).json();
    assert.equal(b1.coinsAwarded, 6, "env cap must be read at call time");
    assert.equal(b1.capRemaining, 0);

    // A malformed override must NEVER read as "no cap" (Number("abc") is NaN).
    process.env.POWERUP_DISCARD_DAILY_COIN_CAP = "not-a-number";
    const carol = await createUser({ timezone: "America/New_York" });
    const raceId2 = await createActiveRace(carol, [bob]);
    await prisma.coinTransaction.create({
      data: {
        userId: carol.userId,
        amount: 40,
        reason: "powerup_discard",
        refId: "seed-carol",
      },
    });
    const p2 = await givePowerup(raceId2, carol.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });
    const b2 = await (await discard(raceId2, p2.id, carol.token)).json();
    assert.equal(b2.coinsAwarded, 0, "malformed cap must fall back to 40, not to unlimited");
  });

  // ── idempotency ──────────────────────────────────────────────────────────

  it("a double-tap discards once: one ledger row and one feed event", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const before = await coinBalance(alice.userId);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });

    const [r1, r2] = await Promise.all([
      discard(raceId, p.id, alice.token),
      discard(raceId, p.id, alice.token),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.equal(statuses[0], 200, "exactly one call must succeed");

    const rows = await discardLedger(alice.userId);
    assert.equal(rows.length, 1, "no double mint");
    assert.equal(rows[0].amount, 10);
    assert.equal(await coinBalance(alice.userId), before + 10);

    const events = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "POWERUP_DISCARDED" },
    });
    assert.equal(events.length, 1, "no duplicate feed row");
  });

  it("re-discarding an already DISCARDED powerup never mints a second time", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });

    const first = await discard(raceId, p.id, alice.token);
    assert.equal(first.status, 200);
    const second = await discard(raceId, p.id, alice.token);
    assert.notEqual(second.status, 200);

    assert.equal((await discardLedger(alice.userId)).length, 1);
  });

  // ── existing behaviour that must not regress ─────────────────────────────

  it("another user's powerup is still 403 and pays nobody", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });

    const res = await discard(raceId, p.id, bob.token);
    assert.equal(res.status, 403);
    assert.equal((await discardLedger(bob.userId)).length, 0);
    assert.equal((await discardLedger(alice.userId)).length, 0);
  });

  it("a USED powerup is still 400 and pays nothing", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 5000,
    });

    const res = await discard(raceId, p.id, alice.token);
    assert.equal(res.status, 400);
    assert.equal((await discardLedger(alice.userId)).length, 0);
  });

  // ── frozen-client contract ───────────────────────────────────────────────

  it("FROZEN CLIENT: the pre-existing `success: true` field is still present", async () => {
    // The shipped App Store build ignores the body entirely, but the wire
    // contract before this change was exactly {"success": true}. The new fields
    // are ADDITIVE — `success` is not renamed or removed.
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 5000,
    });

    const res = await discard(raceId, p.id, alice.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true, "old clients' success flag must survive");
  });

  it("FROZEN CLIENT: a request sending no X-Client-Features still succeeds and is paid", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const raceId = await createActiveRace(alice, [bob]);
    const p = await givePowerup(raceId, alice.userId, {
      type: "PROTEIN_SHAKE",
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps: 5000,
    });

    // No X-Client-Features, no X-App-Version, no X-Timezone — the oldest shape.
    const res = await discard(raceId, p.id, alice.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.coinsAwarded, 5);
  });
});
