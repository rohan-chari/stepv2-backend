// Turtle character — "Shell" block (docs/turtle-character-requirements.md §5).
//
// Every incoming attack whose TYPE is obtainable from an in-race mystery-box
// roll has a 30% chance to bounce off a turtle-equipped defender's shell. The
// roll sits AFTER Mirror/Decoy and IMMEDIATELY BEFORE the Compression Socks
// lookup, so a successful Shell saves the defender's paid shield.
//
// Real HTTP + real DB (local integration DB only). The Shell's RNG is
// controlled by stubbing the global Math.random for the duration of the
// request: with no injected `dependencies.random`, usePowerup resolves
// Math.random at CALL time for the Shell roll, and the server runs in-process,
// so the stub is observed by the real handler chain.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

let server;
let nextAppleId = 0;
const FEATS = { "X-Client-Features": "characters,powerups3,powerups4,powerups5" };

async function createUser(displayName) {
  const appleId = `apple-turtle-${++nextAppleId}`;
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
      name: "Shell Race",
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
  return raceId;
}

// A box-earned copy (rarity + earnedAtSteps set) — the ordinary in-race drop.
async function giveHeld(raceId, userId, type, { rarity = "UNCOMMON", earnedAtSteps = 4000 } = {}) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD", earnedAtSteps },
  });
}

// A REDEEMED copy — bought with coins or won on the daily spin, then spent into
// the race. redeemPowerupToRace.js writes rarity == null && earnedAtSteps == null.
async function giveRedeemed(raceId, userId, type) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity: null, status: "HELD", earnedAtSteps: null },
  });
}

async function giveEffect(raceId, userId, type, extra = {}) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  const source = await prisma.racePowerup.create({
    data: {
      raceId, participantId: p.id, userId, type, rarity: "RARE",
      status: "USED", usedAt: new Date(), earnedAtSteps: 1000,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: p.id,
      targetUserId: userId,
      sourceUserId: userId,
      powerupId: source.id,
      type,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60 * 1000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      ...extra,
    },
  });
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

async function usePowerup(token, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body, token, headers: FEATS,
  });
}

// Run `fn` with Math.random replaced by a scripted sequence (last value repeats).
async function withRandom(sequence, fn) {
  const original = Math.random;
  let i = 0;
  Math.random = () => sequence[Math.min(i++, sequence.length - 1)];
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

// Force the Mystery Potion outcome pool through the real admin route (which
// busts the in-process config cache), so a potion deterministically rolls the
// given outcomes. `warmRaceId`/`warmToken` drive one real read that repopulates
// the cached snapshot (getConfigSync serves the last snapshot; only an async
// getSnapshot refreshes it). Pass outcomes=null to restore the code defaults —
// balance_config is NOT truncated between suites, so the pin must be undone.
async function pinPotionPool(outcomes, warmRaceId, warmToken) {
  const admin = await createUser("PotionAdmin");
  const adminEmail = process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
  await prisma.user.update({ where: { id: admin.userId }, data: { email: adminEmail } });
  const current = await request(server.baseUrl, "GET", "/admin/balance-config", {
    token: admin.token,
  });
  const expectedVersion = (await current.json()).version ?? null;
  const config = defaultConfig();
  if (outcomes) {
    config.mysteryPotion = { pool: outcomes.map((outcome) => ({ outcome, weight: 1 })) };
  }
  const res = await request(server.baseUrl, "PUT", "/admin/balance-config", {
    token: admin.token,
    body: { expectedVersion, config, note: "turtle shell potion pin" },
  });
  assert.equal(res.status, 201, `pinning the potion pool failed: ${await res.text()}`);
  if (warmRaceId) {
    await request(server.baseUrl, "GET", `/races/${warmRaceId}/progress`, {
      token: warmToken, headers: FEATS,
    });
  }
}

async function effectsFor(raceId, userId, type) {
  return prisma.raceActiveEffect.findMany({ where: { raceId, targetUserId: userId, type } });
}

describe("Turtle Shell (character power)", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    process.env.CHARACTER_POWERS_ENABLED = "true";
    delete process.env.TURTLE_SHELL_DISABLED;
  });
  after(async () => {
    delete process.env.CHARACTER_POWERS_ENABLED;
    delete process.env.TURTLE_SHELL_DISABLED;
    // balance_config is not truncated by cleanDatabase, so undo the potion pin
    // (an empty table = code defaults, the state of a freshly migrated DB).
    await prisma.balanceConfig.deleteMany({});
  });

  async function setup({ animal = "turtle" } = {}) {
    const alice = await createUser("ShellAtk");
    const bob = await createUser("ShellDef");
    await makeFriends(alice, bob);
    if (animal) await equipCharacter(bob, animal);
    const raceId = await createActiveRace(alice, [bob]);
    return { alice, bob, raceId };
  }

  // §10.1
  it("blocks a box-earned Leg Cramp with blockedBy SHELL and creates no effect", async () => {
    const { alice, bob, raceId } = await setup();
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.01], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, "SHELL");
    assert.equal(result.outcome, "BLOCKED");

    assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 0, "no effect row");
    const used = await prisma.racePowerup.findUnique({ where: { id: pw.id } });
    assert.equal(used.status, "USED");
    assert.equal(used.targetUserId, bob.userId);

    // Block plumbing: the standard POWERUP_BLOCKED feed row, actored by the defender.
    const events = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "POWERUP_BLOCKED" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].actorUserId, bob.userId);
    assert.match(events[0].description, /Shell/);
  });

  // §10.2
  it("applies the attack normally when the roll is above 30%", async () => {
    const { alice, bob, raceId } = await setup();
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.99], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.blocked, false);
    assert.equal(result.outcome, "APPLIED");
    assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 1);
  });

  // §10.3a — the per-TYPE rule: a redeemed (bought/spun) Leg Cramp is blockable.
  it("blocks a REDEEMED Leg Cramp (per-type rule, not per-instance)", async () => {
    const { alice, bob, raceId } = await setup();
    const pw = await giveRedeemed(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.01], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, "SHELL");
    assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 0);
  });

  // §10.3b — a store-exclusive type is never blockable, even at RNG 0.
  it("never blocks a store-exclusive Rainstorm", async () => {
    const { alice, bob, raceId } = await setup();
    const pw = await giveRedeemed(raceId, alice.userId, "RAINSTORM");

    const res = await withRandom([0.0], () => usePowerup(alice.token, raceId, pw.id));
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.blocked, false);
    assert.equal((await effectsFor(raceId, bob.userId, "RAINSTORM")).length, 1, "storm landed");
  });

  // §10.3c — Mystery Potion: the ROLLED type is what's tested.
  it("blocks a Mystery Potion that rolls a Leg Cramp", async () => {
    const { alice, bob, raceId } = await setup();
    // Pin the potion's outcome through the real admin balance-config route
    // (the potion pool is config, and its roll uses usePowerup's own build-time
    // RNG, which an HTTP-level test cannot stub).
    await pinPotionPool(["LEG_CRAMP"], raceId, alice.token);
    const pw = await giveRedeemed(raceId, alice.userId, "MYSTERY_POTION");

    const res = await withRandom([0.01], () => usePowerup(alice.token, raceId, pw.id));
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.rolled, "LEG_CRAMP");
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, "SHELL");
    assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 0);
  });

  // §10.4 — D1 ordering: a successful Shell saves the paid shield.
  it("does NOT consume the defender's Compression Socks on a Shell block", async () => {
    const { alice, bob, raceId } = await setup();
    await giveEffect(raceId, bob.userId, "COMPRESSION_SOCKS");
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.01], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    const { result } = await res.json();
    assert.equal(result.blockedBy, "SHELL");

    const socks = await effectsFor(raceId, bob.userId, "COMPRESSION_SOCKS");
    assert.equal(socks.length, 1);
    assert.equal(socks[0].status, "ACTIVE", "socks banked for later");
  });

  // §10.5 — regression guard on the existing Socks behaviour.
  it("falls through to Compression Socks when the Shell roll fails", async () => {
    const { alice, bob, raceId } = await setup();
    await giveEffect(raceId, bob.userId, "COMPRESSION_SOCKS");
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.9], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    const { result } = await res.json();
    assert.equal(result.blocked, true);
    assert.equal(result.blockedBy, "COMPRESSION_SOCKS");

    const socks = await effectsFor(raceId, bob.userId, "COMPRESSION_SOCKS");
    assert.equal(socks[0].status, "BLOCKED", "socks consumed");
  });

  // §10.6 — Mirror precedes the Shell.
  it("reflects through a Mirror without consulting the Shell", async () => {
    const { alice, bob, raceId } = await setup();
    await giveEffect(raceId, bob.userId, "MIRROR");
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.0], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
    );
    const { result } = await res.json();
    assert.equal(result.blocked, false);
    assert.equal(result.reflected, true);
    assert.equal(result.outcome, "REFLECTED");
    assert.equal((await effectsFor(raceId, alice.userId, "LEG_CRAMP")).length, 1, "landed on attacker");
    assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 0);
  });

  // §10.7 — upgrade coins are forfeit on a Shell block.
  it("forfeits upgrade coins and writes a BLOCKED PowerupUpgradeEvent", async () => {
    const { alice, bob, raceId } = await setup();
    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 500 } });
    const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");

    const res = await withRandom([0.01], () =>
      usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId, upgradeLevel: 1 })
    );
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.blockedBy, "SHELL");
    assert.equal(result.upgradeLevel, 1);
    assert.ok(result.coinsSpent > 0, "coins were spent");

    const after = await prisma.user.findUnique({ where: { id: alice.userId } });
    assert.equal(after.coins, 500 - result.coinsSpent, "no refund");

    const upgradeEvents = await prisma.powerupUpgradeEvent.findMany({ where: { raceId } });
    assert.equal(upgradeEvents.length, 1);
    assert.equal(upgradeEvents[0].status, "BLOCKED");
    assert.equal(upgradeEvents[0].tier, 1);
  });

  // §10.8
  it("never fires for a capybara (no character) or a corgi target", async () => {
    for (const animal of [null, "corgi_puppy"]) {
      await cleanDatabase();
      nextAppleId = 0;
      const { alice, bob, raceId } = await setup({ animal });
      const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");
      const res = await withRandom([0.0], () =>
        usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
      );
      const { result } = await res.json();
      assert.equal(result.blocked, false, `animal=${animal}`);
      assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 1);
    }
  });

  // §10.9 — both kill switches, read at call time.
  it("never fires with CHARACTER_POWERS_ENABLED off or TURTLE_SHELL_DISABLED on", async () => {
    for (const env of [
      { CHARACTER_POWERS_ENABLED: "false" },
      { CHARACTER_POWERS_ENABLED: "true", TURTLE_SHELL_DISABLED: "true" },
    ]) {
      await cleanDatabase();
      nextAppleId = 0;
      process.env.CHARACTER_POWERS_ENABLED = env.CHARACTER_POWERS_ENABLED;
      if (env.TURTLE_SHELL_DISABLED) process.env.TURTLE_SHELL_DISABLED = env.TURTLE_SHELL_DISABLED;
      else delete process.env.TURTLE_SHELL_DISABLED;

      const { alice, bob, raceId } = await setup();
      const pw = await giveHeld(raceId, alice.userId, "LEG_CRAMP");
      const res = await withRandom([0.0], () =>
        usePowerup(alice.token, raceId, pw.id, { targetUserId: bob.userId })
      );
      const { result } = await res.json();
      assert.equal(result.blocked, false, JSON.stringify(env));
      assert.equal((await effectsFor(raceId, bob.userId, "LEG_CRAMP")).length, 1);
    }
  });

  // §10.10 — catalog gating for the shipped cosmetics.json entry.
  describe("shop catalog", () => {
    async function seedTurtleFromCatalogFile() {
      const raw = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "..", "data", "cosmetics.json"), "utf8")
      );
      const items = Array.isArray(raw) ? raw : raw.items;
      const turtle = items.find((i) => i.sku === "turtle");
      assert.ok(turtle, "data/cosmetics.json must carry the turtle entry");
      assert.equal(turtle.slot, "CHARACTER");
      assert.equal(turtle.priceCoins, 1000);
      assert.equal(turtle.active, true);
      assert.equal(turtle.testOnly, true);
      assert.equal(turtle.renderMetadata.animationFrames, 8);
      await prisma.shopItem.create({
        data: {
          sku: turtle.sku,
          name: turtle.name,
          description: turtle.description,
          slot: turtle.slot,
          priceCoins: turtle.priceCoins,
          assetKey: turtle.assetKey,
          active: turtle.active,
          testOnly: turtle.testOnly,
          earnOnly: turtle.earnOnly,
          bobble: turtle.bobble,
          sortOrder: turtle.sortOrder,
          renderMetadata: turtle.renderMetadata,
        },
      });
      return turtle;
    }

    it("serves the turtle only to a characters-capable client", async () => {
      const user = await createUser("ShopT");
      await seedTurtleFromCatalogFile();

      const withChars = await request(server.baseUrl, "GET", "/shop/catalog", {
        token: user.token,
        headers: { "X-Client-Features": "characters", "X-Release-Channel": "testflight" },
      });
      const withBody = await withChars.json();
      const found = withBody.items.find((i) => i.sku === "turtle");
      assert.ok(found, "characters client sees the turtle");
      assert.equal(found.priceCoins, 1000);
      assert.equal(found.slot, "CHARACTER");
      // 8, not 5: the walk cycle is 8 slots over 5 drawings (the pass-through
      // frames repeat), so the sheet was re-cut to 704x88. data/cosmetics.json
      // and the frontend's animals.dart both carry 8; this assertion was the
      // last place still saying 5.
      assert.equal(found.renderMetadata.animationFrames, 8);

      const without = await request(server.baseUrl, "GET", "/shop/catalog", {
        token: user.token,
        headers: { "X-Release-Channel": "testflight" },
      });
      const withoutBody = await without.json();
      assert.equal(
        withoutBody.items.find((i) => i.sku === "turtle"),
        undefined,
        "old client never sees a CHARACTER item"
      );
      assert.equal(withoutBody.equipped.CHARACTER, undefined);
    });
  });
});
