const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// ---------------------------------------------------------------------------
// Base-character (corgi) visibility on social surfaces.
//
// Contract: a user's equipped CHARACTER travels as the sibling `animal` field.
// Clients declare support via `X-Client-Features: characters`. For viewers
// WITHOUT that capability, a character-equipped user must be presented as a
// NAKED default capybara — `animal` null AND accessories stripped — because an
// old binary can't draw the character and must not show its gear floating on
// the wrong body. Capable viewers get the full presentation. Users with no
// character equipped are unaffected either way.
// ---------------------------------------------------------------------------

const CAPABLE = { "X-Client-Features": "characters" };

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-char-${++nextAppleId}`;
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

async function seedItem({ sku, slot, assetKey, testOnly = false }) {
  return prisma.shopItem.create({
    data: {
      sku,
      name: sku,
      description: `${sku} (test)`,
      slot,
      priceCoins: 0,
      assetKey,
      testOnly,
      renderMetadata: { offsetX: 0, offsetY: 0 },
    },
  });
}

async function equip(user, item) {
  await prisma.userShopItem.create({
    data: { userId: user.userId, shopItemId: item.id },
  });
  await prisma.userEquippedAccessory.create({
    data: { userId: user.userId, slot: item.slot, shopItemId: item.id },
  });
}

// Bob equips a live (non-test) corgi character plus a normal hat.
async function seedCorgiBob() {
  const bob = await createUser("BobbyRunner");
  const corgi = await seedItem({
    sku: "test_corgi",
    slot: "CHARACTER",
    assetKey: "corgi_puppy",
  });
  const hat = await seedItem({
    sku: "test_hat",
    slot: "HEAD",
    assetKey: "cowboy_hat",
  });
  await equip(bob, corgi);
  await equip(bob, hat);
  return bob;
}

async function setupRaceWith(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: { name: "Corgi Cup", targetSteps: 50000, maxDurationDays: 7 },
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
  return raceId;
}

describe("character visibility (naked-capy compat)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("race details: capable viewer sees corgi + gear; incapable viewer sees naked capy", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await seedCorgiBob();
    await makeFriends(alice, bob);
    const raceId = await setupRaceWith(alice, bob);

    const capableRes = await request(server.baseUrl, "GET", `/races/${raceId}`, {
      token: alice.token,
      headers: CAPABLE,
    });
    const capable = await capableRes.json();
    const bobCapable = capable.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobCapable.animal, "corgi_puppy");
    assert.deepEqual(
      bobCapable.accessories.map((a) => a.sku),
      ["test_hat"],
      "capable viewer gets the accessories (CHARACTER never rides the array)"
    );

    const legacyRes = await request(server.baseUrl, "GET", `/races/${raceId}`, {
      token: alice.token,
    });
    const legacy = await legacyRes.json();
    const bobLegacy = legacy.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobLegacy.animal, null, "no character info for old clients");
    assert.deepEqual(
      bobLegacy.accessories,
      [],
      "old clients render a NAKED capy for character-equipped users"
    );
  });

  it("race progress: same gating once the race is running", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await seedCorgiBob();
    await makeFriends(alice, bob);
    const raceId = await setupRaceWith(alice, bob);
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
    });

    const capable = (
      await (
        await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
          token: alice.token,
          headers: CAPABLE,
        })
      ).json()
    ).progress;
    const bobCapable = capable.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobCapable.animal, "corgi_puppy");
    assert.equal(bobCapable.accessories.length, 1);

    const legacy = (
      await (
        await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
          token: alice.token,
        })
      ).json()
    ).progress;
    const bobLegacy = legacy.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobLegacy.animal, null);
    assert.deepEqual(bobLegacy.accessories, []);
  });

  it("friends list: character gated by viewer capability", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await seedCorgiBob();
    await makeFriends(alice, bob);

    const capable = await (
      await request(server.baseUrl, "GET", "/friends", {
        token: alice.token,
        headers: CAPABLE,
      })
    ).json();
    const bobCapable = capable.friends.find((f) => f.id === bob.userId);
    assert.equal(bobCapable.animal, "corgi_puppy");
    assert.equal(bobCapable.accessories.length, 1);

    const legacy = await (
      await request(server.baseUrl, "GET", "/friends", { token: alice.token })
    ).json();
    const bobLegacy = legacy.friends.find((f) => f.id === bob.userId);
    assert.equal(bobLegacy.animal, null);
    assert.deepEqual(bobLegacy.accessories, []);
  });

  it("test-only character never leaks, even to capable viewers", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobbyRunner");
    const testCorgi = await seedItem({
      sku: "test_corgi_beta",
      slot: "CHARACTER",
      assetKey: "corgi_puppy",
      testOnly: true,
    });
    const hat = await seedItem({
      sku: "test_hat",
      slot: "HEAD",
      assetKey: "cowboy_hat",
    });
    await equip(bob, testCorgi);
    await equip(bob, hat);
    await makeFriends(alice, bob);
    const raceId = await setupRaceWith(alice, bob);

    const capable = await (
      await request(server.baseUrl, "GET", `/races/${raceId}`, {
        token: alice.token,
        headers: CAPABLE,
      })
    ).json();
    const bobRow = capable.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobRow.animal, null, "test-only character stays hidden");
    // A hidden test character does not cost the user their normal accessories.
    assert.deepEqual(bobRow.accessories.map((a) => a.sku), ["test_hat"]);
  });

  it("users without a character keep their accessories for old clients", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobbyRunner");
    const hat = await seedItem({
      sku: "test_hat",
      slot: "HEAD",
      assetKey: "cowboy_hat",
    });
    await equip(bob, hat);
    await makeFriends(alice, bob);
    const raceId = await setupRaceWith(alice, bob);

    const legacy = await (
      await request(server.baseUrl, "GET", `/races/${raceId}`, {
        token: alice.token,
      })
    ).json();
    const bobRow = legacy.participants.find((p) => p.userId === bob.userId);
    assert.equal(bobRow.animal, null);
    assert.deepEqual(
      bobRow.accessories.map((a) => a.sku),
      ["test_hat"],
      "capy users are untouched by the character gating"
    );
  });
});
