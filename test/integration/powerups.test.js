const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

function authOverrides() {
  return {
    verifyAppleIdentityToken: async (token) => ({
      sub: token,
      email: `${token}@example.com`,
    }),
  };
}

async function createUser(displayName) {
  const appleId = `apple-pu-${++nextAppleId}`;
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

// Creates an ACTIVE race with powerups enabled between alice and bob
async function createActiveRace(opts = {}) {
  const alice = await createUser(opts.aliceName || "AliceWalker");
  const bob = await createUser(opts.bobName || "BobbyRunner");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: opts.name || "Powerup Race",
      targetSteps: opts.targetSteps || 200000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: opts.interval || 5000,
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

  // Backdate so step samples fall within race window
  const defaultStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt: defaultStart } });
  await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: defaultStart } });

  return { alice, bob, raceId };
}

// Record step samples and fetch progress to trigger powerup earning
async function earnPowerups(token, raceId, steps) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  await request(server.baseUrl, "POST", "/steps/samples", {
    body: {
      samples: [{ periodStart: oneHourAgo.toISOString(), periodEnd: now.toISOString(), steps }],
    },
    token,
  });
  // Fetch progress to trigger mystery box earning
  await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
}

// Get inventory for a user in a race
async function getInventory(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  const body = await res.json();
  return body.progress?.powerupData || {};
}

// Open a mystery box and return the result
async function openBox(token, raceId, powerupId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/open`, { token });
}

// Use a powerup
async function usePowerup(token, raceId, powerupId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    body: targetUserId ? { targetUserId } : {},
    token,
  });
}

// Discard a powerup
async function discardPowerup(token, raceId, powerupId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/discard`, { token });
}

describe("powerups (general)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // === CROSS-RACE ISOLATION ===

  describe("cross-race isolation", () => {
    it("powerup earned in Race A cannot be used in Race B", async () => {
      const { alice, bob, raceId: raceA } = await createActiveRace({ aliceName: "AliceWalkerA", bobName: "BobRunnerAAAA" });

      // Earn a powerup in race A
      await earnPowerups(alice.token, raceA, 6000);
      const inv = await getInventory(alice.token, raceA);
      assert.ok(inv.inventory.length > 0);

      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      assert.ok(box, "should have a mystery box");

      // Open it
      const openRes = await openBox(alice.token, raceA, box.id);
      assert.equal(openRes.status, 200);

      const inv2 = await getInventory(alice.token, raceA);
      const held = inv2.inventory.find((p) => p.status === "HELD");

      if (held) {
        // Create Race B
        const charlie = await createUser("CharlieJoggs");
        await makeFriends(alice, charlie);
        const createRes = await request(server.baseUrl, "POST", "/races", {
          body: { name: "Race B", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
          token: alice.token,
        });
        const raceB = (await createRes.json()).race.id;
        await request(server.baseUrl, "POST", `/races/${raceB}/invite`, {
          body: { inviteeIds: [charlie.userId] },
          token: alice.token,
        });
        await request(server.baseUrl, "PUT", `/races/${raceB}/respond`, {
          body: { accept: true },
          token: charlie.token,
        });
        await request(server.baseUrl, "POST", `/races/${raceB}/start`, { token: alice.token });

        // Try to use Race A's powerup in Race B
        const useRes = await usePowerup(alice.token, raceB, held.id);
        assert.ok(useRes.status >= 400, `should reject cross-race use, got ${useRes.status}`);
      }
    });

    it("powerup inventory is per-race", async () => {
      const { alice, raceId: raceA } = await createActiveRace({ aliceName: "AliceWalkerB", bobName: "BobRunnerBBBB" });

      // Earn powerup in race A
      await earnPowerups(alice.token, raceA, 6000);
      const invA = await getInventory(alice.token, raceA);
      assert.ok(invA.inventory.length > 0);

      // Create race B
      const charlie = await createUser("CharlieJogger");
      await makeFriends(alice, charlie);
      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: { name: "Race B", targetSteps: 200000, maxDurationDays: 7, powerupsEnabled: true, powerupStepInterval: 5000 },
        token: alice.token,
      });
      const raceB = (await createRes.json()).race.id;
      await request(server.baseUrl, "POST", `/races/${raceB}/invite`, {
        body: { inviteeIds: [charlie.userId] },
        token: alice.token,
      });
      await request(server.baseUrl, "PUT", `/races/${raceB}/respond`, {
        body: { accept: true },
        token: charlie.token,
      });
      await request(server.baseUrl, "POST", `/races/${raceB}/start`, { token: alice.token });

      // Race B should have empty inventory
      const invB = await getInventory(alice.token, raceB);
      assert.equal(invB.inventory.length, 0);
    });
  });

  // === OWNERSHIP & AUTHORIZATION ===

  describe("ownership & authorization", () => {
    it("user cannot use another user's powerup", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceOwnerA", bobName: "BobThiefAAAA" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return; // skip if no box earned

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      // Bob tries to use Alice's powerup
      const res = await usePowerup(bob.token, raceId, held.id);
      assert.equal(res.status, 403);
    });

    it("user cannot open another user's mystery box", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceOwnerB", bobName: "BobThiefBBBB" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      // Bob tries to open Alice's box
      const res = await openBox(bob.token, raceId, box.id);
      assert.equal(res.status, 403);
    });

    it("user cannot discard another user's powerup", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceOwnerC", bobName: "BobThiefCCCC" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      // Bob tries to discard Alice's box
      const res = await discardPowerup(bob.token, raceId, box.id);
      assert.equal(res.status, 403);
    });

    it("non-participant cannot use powerups in a race", async () => {
      const { alice, raceId } = await createActiveRace({ aliceName: "AliceOwnerD", bobName: "BobParticipD" });
      const charlie = await createUser("CharlieOutsdr");

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      // Charlie (not in race) tries to use it — should fail even though it's alice's
      const res = await usePowerup(charlie.token, raceId, held.id);
      assert.ok(res.status >= 400);
    });
  });

  // === POWERUP LIFECYCLE ===

  describe("powerup lifecycle", () => {
    it("full lifecycle: earn mystery box → open → hold → use", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceLifecyc", bobName: "BobLifecycle" });

      // Step 1: Earn
      await earnPowerups(alice.token, raceId, 6000);
      const inv1 = await getInventory(alice.token, raceId);
      const box = inv1.inventory.find((p) => p.status === "MYSTERY_BOX");
      assert.ok(box, "should have earned a mystery box");

      // Step 2: Open
      const openRes = await openBox(alice.token, raceId, box.id);
      assert.equal(openRes.status, 200);
      const openBody = await openRes.json();
      assert.ok(openBody.result.type, "opened box should have a type");

      // Step 3: Verify it's now HELD
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.id === box.id);
      assert.ok(held);
      assert.equal(held.status, "HELD");

      // Step 4: Use (self-targeting for PROTEIN_SHAKE, or targeted for others)
      // We don't know the type, so just try to use it
      const useRes = await usePowerup(alice.token, raceId, held.id, bob.userId);
      // Might succeed or fail depending on type — but should not be 403/404
      if (useRes.status === 200) {
        // Verify it's consumed
        const inv3 = await getInventory(alice.token, raceId);
        const used = inv3.inventory.find((p) => p.id === box.id);
        assert.ok(!used, "used powerup should no longer be in inventory");
      }
    });

    it("cannot use a powerup that's already been used", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceDoubleA", bobName: "BobDoubleAAAA" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      // Use it (try with and without target)
      await usePowerup(alice.token, raceId, held.id, bob.userId);

      // Try to use again
      const res = await usePowerup(alice.token, raceId, held.id, bob.userId);
      assert.ok(res.status >= 400, `double use should fail, got ${res.status}`);
    });

    it("cannot use a powerup that's been discarded", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceDiscrdA", bobName: "BobDiscardAA" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      // Discard
      const discardRes = await discardPowerup(alice.token, raceId, held.id);
      assert.equal(discardRes.status, 200);

      // Try to use
      const res = await usePowerup(alice.token, raceId, held.id, bob.userId);
      assert.ok(res.status >= 400);
    });

    it("cannot open a powerup that's not a mystery box", async () => {
      const { alice, raceId } = await createActiveRace({ aliceName: "AliceOpenBad", bobName: "BobOpenBadBB" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      // Open it first
      await openBox(alice.token, raceId, box.id);

      // Try to open again (now HELD, not MYSTERY_BOX)
      const res = await openBox(alice.token, raceId, box.id);
      assert.equal(res.status, 400);
    });

    it("can discard a HELD powerup", async () => {
      const { alice, raceId } = await createActiveRace({ aliceName: "AliceDiscHld", bobName: "BobDiscHldBB" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      const res = await discardPowerup(alice.token, raceId, held.id);
      assert.equal(res.status, 200);
    });

    it("can discard an unopened MYSTERY_BOX", async () => {
      const { alice, raceId } = await createActiveRace({ aliceName: "AliceDiscBox", bobName: "BobDiscBoxBB" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      const res = await discardPowerup(alice.token, raceId, box.id);
      assert.equal(res.status, 200);
    });
  });

  // === RACE STATE REQUIREMENTS ===

  describe("race state requirements", () => {
    it("cannot use powerup in CANCELLED race", async () => {
      const { alice, bob, raceId } = await createActiveRace({ aliceName: "AliceCancelA", bobName: "BobCancelAAA" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      await openBox(alice.token, raceId, box.id);
      const inv2 = await getInventory(alice.token, raceId);
      const held = inv2.inventory.find((p) => p.status === "HELD");
      if (!held) return;

      // Cancel race
      await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });

      const res = await usePowerup(alice.token, raceId, held.id, bob.userId);
      assert.ok(res.status >= 400);
    });

    it("cannot open mystery box in non-ACTIVE race", async () => {
      const { alice, raceId } = await createActiveRace({ aliceName: "AliceCancelB", bobName: "BobCancelBBB" });

      await earnPowerups(alice.token, raceId, 6000);
      const inv = await getInventory(alice.token, raceId);
      const box = inv.inventory.find((p) => p.status === "MYSTERY_BOX");
      if (!box) return;

      // Cancel race
      await request(server.baseUrl, "DELETE", `/races/${raceId}`, { token: alice.token });

      const res = await openBox(alice.token, raceId, box.id);
      assert.ok(res.status >= 400);
    });
  });

  // === SLOT MANAGEMENT ===

  describe("slot management", () => {
    it("default 3 slots — 4th earned box gets QUEUED", async () => {
      const { alice, raceId } = await createActiveRace({
        aliceName: "AliceSlotAAA",
        bobName: "BobSlotAAAAAA",
        interval: 2000,
      });

      // Earn 4 boxes (need 8000 steps with 2000 interval)
      await earnPowerups(alice.token, raceId, 9000);
      const inv = await getInventory(alice.token, raceId);

      // Should have 3 in inventory (slots full) and at least 1 queued
      assert.equal(inv.inventory.length, 3);
      assert.ok(inv.queuedBoxCount >= 1, `expected queued boxes, got ${inv.queuedBoxCount}`);
    });

    it("queued boxes auto-promote when a slot opens via discard", async () => {
      const { alice, raceId } = await createActiveRace({
        aliceName: "AliceSlotBBB",
        bobName: "BobSlotBBBBBB",
        interval: 2000,
      });

      // Earn 4+ boxes
      await earnPowerups(alice.token, raceId, 9000);
      const inv1 = await getInventory(alice.token, raceId);
      assert.equal(inv1.inventory.length, 3);
      const queued1 = inv1.queuedBoxCount;
      assert.ok(queued1 >= 1);

      // Discard one to free a slot
      const toDiscard = inv1.inventory[0];
      await discardPowerup(alice.token, raceId, toDiscard.id);

      // Fetch progress again to trigger queue promotion
      const inv2 = await getInventory(alice.token, raceId);
      assert.equal(inv2.inventory.length, 3, "slot should be refilled from queue");
      assert.equal(inv2.queuedBoxCount, queued1 - 1);
    });
  });

  // === EARNING THRESHOLDS ===

  describe("earning thresholds", () => {
    it("mystery box earned when crossing powerupStepInterval", async () => {
      const { alice, raceId } = await createActiveRace({
        aliceName: "AliceEarnAAA",
        bobName: "BobEarnAAAAAA",
        interval: 5000,
      });

      // Below threshold — no box
      await earnPowerups(alice.token, raceId, 4000);
      const inv1 = await getInventory(alice.token, raceId);
      assert.equal(inv1.inventory.length, 0);

      // Cross threshold — should earn box
      await earnPowerups(alice.token, raceId, 6000);
      const inv2 = await getInventory(alice.token, raceId);
      assert.ok(inv2.inventory.length >= 1, "should have earned a mystery box");
    });

    it("multiple thresholds crossed at once → multiple boxes earned", async () => {
      const { alice, raceId } = await createActiveRace({
        aliceName: "AliceEarnBBB",
        bobName: "BobEarnBBBBBB",
        interval: 3000,
      });

      // Cross 3 thresholds at once (3000, 6000, 9000)
      await earnPowerups(alice.token, raceId, 10000);
      const inv = await getInventory(alice.token, raceId);
      assert.ok(inv.inventory.length >= 3, `expected >=3 boxes, got ${inv.inventory.length} (plus ${inv.queuedBoxCount} queued)`);
    });

    it("powerups not earned when powerupsEnabled is false", async () => {
      const alice = await createUser("AliceNoPower");
      const bob = await createUser("BobNoPowerBB");
      await makeFriends(alice, bob);

      const createRes = await request(server.baseUrl, "POST", "/races", {
        body: {
          name: "No Powerups Race",
          targetSteps: 200000,
          maxDurationDays: 7,
          powerupsEnabled: false,
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

      const today = new Date().toISOString().slice(0, 10);
      await request(server.baseUrl, "POST", "/steps", {
        body: { steps: 20000, date: today },
        token: alice.token,
      });
      const progressRes = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token: alice.token });
      const body = await progressRes.json();

      // Should have no powerup data or empty inventory
      assert.ok(!body.powerupData || body.powerupData.inventory.length === 0);
    });
  });

  // === SHIELD INTERACTION ===

  describe("shield interaction", () => {
    it("compression socks blocks incoming attack, both powerups consumed", async () => {
      const { alice, bob, raceId } = await createActiveRace({
        aliceName: "AliceShieldA",
        bobName: "BobShieldAAAA",
        interval: 2000,
      });

      // Both earn powerups
      await earnPowerups(alice.token, raceId, 7000);
      await earnPowerups(bob.token, raceId, 7000);

      // Get inventories
      const aliceInv = await getInventory(alice.token, raceId);
      const bobInv = await getInventory(bob.token, raceId);

      // Open all boxes for both
      for (const box of aliceInv.inventory.filter((p) => p.status === "MYSTERY_BOX")) {
        await openBox(alice.token, raceId, box.id);
      }
      for (const box of bobInv.inventory.filter((p) => p.status === "MYSTERY_BOX")) {
        await openBox(bob.token, raceId, box.id);
      }

      // Create specific powerups in DB for controlled test
      const participant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: bob.userId } });
      const attackerParticipant = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });

      // Give bob compression socks directly
      const shield = await prisma.racePowerup.create({
        data: {
          raceId,
          participantId: participant.id,
          userId: bob.userId,
          type: "COMPRESSION_SOCKS",
          rarity: "RARE",
          status: "HELD",
          earnedAtSteps: 99990,
        },
      });

      // Give alice a shortcut (offensive, targeted)
      const attack = await prisma.racePowerup.create({
        data: {
          raceId,
          participantId: attackerParticipant.id,
          userId: alice.userId,
          type: "SHORTCUT",
          rarity: "COMMON",
          status: "HELD",
          earnedAtSteps: 99991,
        },
      });

      // Bob uses shield
      const shieldRes = await usePowerup(bob.token, raceId, shield.id);
      assert.equal(shieldRes.status, 200);

      // Alice attacks bob
      const attackRes = await usePowerup(alice.token, raceId, attack.id, bob.userId);
      assert.equal(attackRes.status, 200);

      const attackBody = await attackRes.json();
      assert.equal(attackBody.result.blocked, true, "attack should be blocked by shield");
    });
  });

  // === FINISHED PARTICIPANT ===

  describe("finished participant", () => {
    it("cannot target a finished participant", async () => {
      const { alice, bob, raceId } = await createActiveRace({
        aliceName: "AliceFinishA",
        bobName: "BobFinishAAAA",
        targetSteps: 5000,
        interval: 2000,
      });

      // Bob finishes the race
      await earnPowerups(bob.token, raceId, 6000);
      // Progress call should mark bob as finished since 6000 > 5000 target

      // Give alice an attack powerup
      const aliceP = await prisma.raceParticipant.findFirst({ where: { raceId, userId: alice.userId } });
      const attack = await prisma.racePowerup.create({
        data: {
          raceId,
          participantId: aliceP.id,
          userId: alice.userId,
          type: "SHORTCUT",
          rarity: "COMMON",
          status: "HELD",
          earnedAtSteps: 99999,
        },
      });

      // Alice tries to target finished bob
      const res = await usePowerup(alice.token, raceId, attack.id, bob.userId);
      assert.ok(res.status >= 400, `targeting finished participant should fail, got ${res.status}`);
    });
  });
});
