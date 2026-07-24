// §5.4 — herd-bonus race-feed line.
//
// The Bara herd bonus is otherwise invisible to every frozen binary (it only
// surfaces as the additive `characterBonus` block on the progress payload).
// Feed lines are server-rendered strings, so one feed event per participant per
// race-local calendar day explains the inflated total on EVERY client ever
// shipped. Emitted from the character-effect scheduler (a write path), never
// from getRaceProgress (a read path), and deduped with an atomic insert-first
// claim — never an advisory lock across the callback (3e6c827).
//
// Jobs have no HTTP surface, so the job builder is driven directly against the
// real DB (as character-effect-scheduler.test.js does), but every assertion is
// made through the real GET /races/:raceId/feed response a client receives.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildEmitHerdBonusFeed,
} = require("../../src/modules/races/jobs/characterEffectScheduler");

let server;
let nextAppleId = 0;
const quietLogger = { log: () => {}, error: () => {} };

async function createUser(displayName) {
  const appleId = `apple-herd-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken, displayName };
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
      name: "Herd Race",
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

async function herdFeedLines(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, { token });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.events.filter((e) => e.eventType === "HERD_BONUS");
}

describe("Herd bonus race-feed line", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    process.env.CHARACTER_POWERS_ENABLED = "true";
  });
  after(() => {
    delete process.env.CHARACTER_POWERS_ENABLED;
  });

  async function setupFourCapybaras() {
    const alice = await createUser("HerdA");
    const others = [];
    for (const name of ["HerdB", "HerdC", "HerdD"]) {
      const u = await createUser(name);
      await makeFriends(alice, u);
      others.push(u);
    }
    const raceId = await createActiveRace(alice, others);
    return { alice, others, raceId };
  }

  it("writes one line per participant per race-local day, and none on a second tick", async () => {
    const { alice, raceId } = await setupFourCapybaras();
    const run = buildEmitHerdBonusFeed({ logger: quietLogger });

    await run();
    let lines = await herdFeedLines(alice.token, raceId);
    assert.equal(lines.length, 4, "one line per capybara participant");

    const mine = lines.find((l) => l.actorUserId === alice.userId);
    assert.ok(mine, "the viewer gets their own line");
    assert.match(mine.description, /Herd Bonus/);
    assert.match(mine.description, /HerdA/);
    assert.match(mine.description, /\+400 steps/, "100 x 4 capybaras");
    assert.match(mine.description, /4 capybaras/);

    // Dedup: a second tick in the same race-local day writes nothing more.
    await run();
    lines = await herdFeedLines(alice.token, raceId);
    assert.equal(lines.length, 4, "insert-first dedup held");
  });

  it("emits again on the next race-local day", async () => {
    const { alice, raceId } = await setupFourCapybaras();
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);

    await buildEmitHerdBonusFeed({ logger: quietLogger, now: () => today })();
    await buildEmitHerdBonusFeed({ logger: quietLogger, now: () => tomorrow })();

    const lines = await herdFeedLines(alice.token, raceId);
    assert.equal(lines.length, 8, "one per participant per day");
  });

  it("writes nothing when CHARACTER_POWERS_ENABLED is off", async () => {
    process.env.CHARACTER_POWERS_ENABLED = "false";
    const { alice, raceId } = await setupFourCapybaras();

    await buildEmitHerdBonusFeed({ logger: quietLogger })();

    assert.equal((await herdFeedLines(alice.token, raceId)).length, 0);
  });

  it("writes nothing in a powerups-disabled race (the bonus does not apply there)", async () => {
    const alice = await createUser("HerdOffA");
    const bob = await createUser("HerdOffB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, [bob], { powerupsEnabled: false });

    await buildEmitHerdBonusFeed({ logger: quietLogger })();

    assert.equal((await herdFeedLines(alice.token, raceId)).length, 0);
  });

  it("skips non-capybara participants and counts only capybaras", async () => {
    const alice = await createUser("HerdMixA");
    const bob = await createUser("HerdMixB");
    const carl = await createUser("HerdMixC");
    await makeFriends(alice, bob);
    await makeFriends(alice, carl);
    await equipCharacter(carl, "turtle");
    const raceId = await createActiveRace(alice, [bob, carl]);

    await buildEmitHerdBonusFeed({ logger: quietLogger })();

    const lines = await herdFeedLines(alice.token, raceId);
    assert.equal(lines.length, 2, "only the two capybaras get a line");
    assert.equal(
      lines.find((l) => l.actorUserId === carl.userId),
      undefined,
      "the turtle earns no herd bonus"
    );
    assert.match(lines[0].description, /\+200 steps/, "100 x 2 capybaras");
  });
});
