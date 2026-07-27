// Backend batch 2026-07-25 (§3): Drill Sergeant sleep blocker, powerup duration
// standardization, tournament 2-day round minimum, and the powerups-disabled
// hard gate. (The character-powers sections were removed with the feature.)
// Real HTTP + real DB (local integration DB only).
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;
const FEATS = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };
const TOURN_FEATS = { "X-Client-Features": "tournaments" };

async function createUser(displayName) {
  const appleId = `apple-pcb-${++nextAppleId}`;
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

async function createActiveRace(alice, others, { powerupsEnabled = true } = {}) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Batch Race",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? 5000 : undefined,
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
  // POST /races now pins every powerup race to 2,000 steps per box, so this
  // suite's 5,000 fixture is applied directly. Still a real production state:
  // races created before that change keep their interval (spec §4.3).
  if (powerupsEnabled) {
    await prisma.race.update({
      where: { id: raceId },
      data: { powerupStepInterval: 5000 },
    });
    // nextBoxAtSteps was seeded from the pinned 2,000 at accept time
    // (respondToRaceInvite.js), so re-seed it to match.
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { nextBoxAtSteps: 5000 },
    });
  }
  return raceId;
}

async function backdate(raceId, startTime) {
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: startTime } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: startTime } });
}

async function giveHeld(raceId, userId, type, earnedAtSteps = 4000) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity: "COMMON", status: "HELD", earnedAtSteps },
  });
}

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body, token, headers: FEATS,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token, headers: FEATS,
  });
  return (await res.json()).progress;
}

function findP(progress, userId) {
  return progress.participants.find((p) => p.userId === userId);
}

async function recordSamples(token, samples) {
  return request(server.baseUrl, "POST", "/steps/samples", { body: { samples }, token });
}

function hoursAgo(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000);
}

// A fixed-offset Etc/GMT zone whose current local hour equals `targetHour`.
// Etc/GMT sign is inverted (Etc/GMT-5 == UTC+5), and these zones never observe
// DST, so the target's wall-clock is deterministic regardless of when the test runs.
function zoneForLocalHour(targetHour) {
  const utcHour = new Date().getUTCHours();
  let offset = (((targetHour - utcHour) % 24) + 24) % 24; // 0..23
  if (offset > 12) offset -= 24; // -11..12
  if (offset === 0) return "UTC";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

async function setTimezone(userId, tz) {
  await prisma.user.update({ where: { id: userId }, data: { timezone: tz } });
}

async function equipCharacter(user, assetKey) {
  const item = await prisma.shopItem.create({
    data: {
      sku: `char-${assetKey}-${user.userId}`,
      name: assetKey,
      description: assetKey,
      slot: "CHARACTER",
      priceCoins: 0,
      assetKey,
      active: true,
      testOnly: false,
    },
  });
  await prisma.userShopItem.create({ data: { userId: user.userId, shopItemId: item.id } });
  await prisma.userEquippedAccessory.create({
    data: { userId: user.userId, shopItemId: item.id, slot: "CHARACTER" },
  });
}

describe("Powerup & Character batch 2026-07-25", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ── §3.7 powerups-disabled hard gate ───────────────────────────────────────
  describe("§3.7 powerups-disabled hard gate", () => {
    it("rejects redeem with 400 POWERUPS_DISABLED and does not spend inventory", async () => {
      const alice = await createUser("DisA");
      const bob = await createUser("DisB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob], { powerupsEnabled: false });

      await prisma.userPowerupItem.create({
        data: { userId: alice.userId, powerupType: "RAINSTORM", quantity: 2 },
      });

      const res = await request(server.baseUrl, "POST", `/races/${raceId}/powerups/redeem`, {
        body: { powerupType: "RAINSTORM" }, token: alice.token,
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "POWERUPS_DISABLED");

      const inv = await prisma.userPowerupItem.findUnique({
        where: { userId_powerupType: { userId: alice.userId, powerupType: "RAINSTORM" } },
      });
      assert.equal(inv.quantity, 2, "inventory untouched");
    });

    it("rejects use with 400 POWERUPS_DISABLED and leaves the powerup HELD", async () => {
      const alice = await createUser("DisC");
      const bob = await createUser("DisD");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob], { powerupsEnabled: false });
      const pw = await giveHeld(raceId, alice.userId, "RUNNERS_HIGH");

      const res = await usePowerup(alice.token, raceId, pw.id);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "POWERUPS_DISABLED");

      const still = await prisma.racePowerup.findUnique({ where: { id: pw.id } });
      assert.equal(still.status, "HELD");
    });
  });

  // ── §3.1 Drill Sergeant sleep blocker ──────────────────────────────────────
  describe("§3.1 Drill Sergeant sleep blocker", () => {
    async function setup() {
      const alice = await createUser("DrillA");
      const bob = await createUser("DrillB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      const drill = await giveHeld(raceId, alice.userId, "DRILL_SERGEANT");
      return { alice, bob, raceId, drill };
    }

    it("blocks the dare at target-local 02:00 with 400 TARGET_ASLEEP and does not consume it", async () => {
      const { alice, bob, raceId, drill } = await setup();
      await setTimezone(bob.userId, zoneForLocalHour(2));

      const res = await usePowerup(alice.token, raceId, drill.id, { targetUserId: bob.userId });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "TARGET_ASLEEP");

      const still = await prisma.racePowerup.findUnique({ where: { id: drill.id } });
      assert.equal(still.status, "HELD", "drill sergeant not consumed");
    });

    it("allows the dare at target-local 13:00", async () => {
      const { alice, bob, raceId, drill } = await setup();
      await setTimezone(bob.userId, zoneForLocalHour(13));

      const res = await usePowerup(alice.token, raceId, drill.id, { targetUserId: bob.userId });
      assert.equal(res.status, 200);
    });

    it("falls back to the RACE timezone when the target has none (blocked)", async () => {
      const { alice, bob, raceId, drill } = await setup();
      await setTimezone(bob.userId, null);
      await prisma.race.update({ where: { id: raceId }, data: { timezone: zoneForLocalHour(2) } });

      const res = await usePowerup(alice.token, raceId, drill.id, { targetUserId: bob.userId });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "TARGET_ASLEEP");
    });

    it("fails OPEN (allows) when neither the target nor the race has a timezone", async () => {
      const { alice, bob, raceId, drill } = await setup();
      await setTimezone(bob.userId, null);
      await prisma.race.update({ where: { id: raceId }, data: { timezone: null } });

      const res = await usePowerup(alice.token, raceId, drill.id, { targetUserId: bob.userId });
      assert.equal(res.status, 200);
    });
  });

  // ── §3.4 duration standardization ──────────────────────────────────────────
  describe("§3.4 duration standardization", () => {
    const HOUR = 60 * 60 * 1000;

    it("stamps the new 1h base window for ladder + fixed-window powerups", async () => {
      const alice = await createUser("DurA");
      const bob = await createUser("DurB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      // Backdate + give bob a lead so the caster (alice) is in the bottom half —
      // UPRISING only fires for a racer below the midpoint.
      await backdate(raceId, hoursAgo(2));
      await recordSamples(bob.token, [
        { periodStart: hoursAgo(1.5).toISOString(), periodEnd: hoursAgo(1).toISOString(), steps: 10000 },
      ]);

      const cases = [
        { type: "LEG_CRAMP", target: bob.userId, expectMs: 1 * HOUR },
        { type: "RUNNERS_HIGH", target: null, expectMs: 1 * HOUR },
        { type: "DETOUR_SIGN", target: bob.userId, expectMs: 1 * HOUR },
        { type: "STEALTH_MODE", target: null, expectMs: 1 * HOUR },
        { type: "UPRISING", target: null, expectMs: 1 * HOUR },
        { type: "DRILL_SERGEANT", target: bob.userId, expectMs: 1 * HOUR },
      ];
      // Keep bob awake so DRILL_SERGEANT isn't sleep-blocked.
      await setTimezone(bob.userId, zoneForLocalHour(13));

      for (const c of cases) {
        const pw = await giveHeld(raceId, alice.userId, c.type, 4000 + Math.floor(Math.random() * 1000));
        const body = c.target ? { targetUserId: c.target } : {};
        const res = await usePowerup(alice.token, raceId, pw.id, body);
        assert.equal(res.status, 200, `${c.type} cast should succeed`);
        const effect = await prisma.raceActiveEffect.findFirst({
          where: { raceId, type: c.type === "UPRISING" ? "UPRISING" : c.type, sourceUserId: alice.userId },
          orderBy: { createdAt: "desc" },
        });
        assert.ok(effect, `${c.type} effect row exists`);
        const dur = new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
        assert.equal(dur, c.expectMs, `${c.type} duration should be 1h`);
      }
    });

    it("Quicksand freezes for 1h", async () => {
      const alice = await createUser("QsA");
      const bob = await createUser("QsB");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, [bob]);
      const qs = await giveHeld(raceId, alice.userId, "QUICKSAND");
      const res = await usePowerup(alice.token, raceId, qs.id, { targetUserIds: [bob.userId] });
      assert.equal(res.status, 200);
      const effect = await prisma.raceActiveEffect.findFirst({
        where: { raceId, type: "QUICKSAND" }, orderBy: { createdAt: "desc" },
      });
      const dur = new Date(effect.expiresAt).getTime() - new Date(effect.startsAt).getTime();
      assert.equal(dur, 1 * HOUR);
    });
  });

  // ── §3.5 tournament round minimum (clamp 1 -> 2) ───────────────────────────
  describe("§3.5 tournament 2-day round minimum", () => {
    async function createTournament(token, matchupDurationDays) {
      return request(server.baseUrl, "POST", "/tournaments", {
        body: { name: "Clamp T", bracketSize: 4, matchupDurationDays, buyInAmount: 0 },
        token, headers: TOURN_FEATS,
      });
    }

    it("clamps matchupDurationDays 1 -> 2 in the create response", async () => {
      const alice = await createUser("TourA");
      const res = await createTournament(alice.token, 1);
      assert.equal(res.status, 201);
      assert.equal((await res.json()).tournament.matchupDurationDays, 2);
    });

    it("leaves 2 and 3 unchanged", async () => {
      const alice = await createUser("TourB");
      const two = await createTournament(alice.token, 2);
      assert.equal((await two.json()).tournament.matchupDurationDays, 2);
      const three = await createTournament(alice.token, 3);
      assert.equal((await three.json()).tournament.matchupDurationDays, 3);
    });
  });

});
