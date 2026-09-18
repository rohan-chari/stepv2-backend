const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  startServer,
} = require("./setup");
const {
  buildOpenMysteryBox,
} = require("../../src/modules/powerups/commands/openMysteryBox");

// ---------------------------------------------------------------------------
// B1 — Mystery-box reveals must not surface in the race activity feed.
//
// The Activity tab reads GET /races/:id/messages (kind=SYSTEM / merged). The
// MYSTERY_BOX_OPENED audit rows written on every box open must be excluded at
// the DB-query level (Prisma notIn), so:
//   * no box-content reveal ever shows in the feed, and
//   * pagination stays full even across dense stretches of box opens.
// The fanny-pack auto-activate branch now writes MYSTERY_BOX_OPENED too (so it
// is hidden AND counted by the admin box-opener metric).
// ---------------------------------------------------------------------------

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-b1-${++nextAppleId}`;
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

async function createActiveRace(alice, bob) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "B1 Feed Test",
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

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveBox(raceId, userId) {
  const p = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type: "MYSTERY_BOX",
      status: "MYSTERY_BOX",
      earnedAtSteps: 5000 + Math.floor(Math.random() * 100000),
    },
  });
}

async function getMessages(token, raceId, { kind, limit, cursor } = {}) {
  const qs = new URLSearchParams();
  if (kind) qs.set("kind", kind);
  if (limit) qs.set("limit", String(limit));
  if (cursor) qs.set("cursor", cursor);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await request(
    server.baseUrl,
    "GET",
    `/races/${raceId}/messages${suffix}`,
    { token }
  );
  return res.json();
}

async function getFeed(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
    token,
  });
  return res.json();
}

describe("B1 — mystery-box reveals hidden from race messages feed", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("a normal box open writes an audit row but never appears in SYSTEM or merged feed", async () => {
    const alice = await createUser("AliceB1AAAA");
    const bob = await createUser("BobB1AAAAAA");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const box = await giveBox(raceId, alice.userId);
    const openRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: alice.token }
    );
    assert.equal(openRes.status, 200);

    // The audit row IS persisted (for the admin box-opener metric)...
    const auditRows = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: "MYSTERY_BOX_OPENED" },
    });
    assert.equal(auditRows.length, 1, "one MYSTERY_BOX_OPENED audit row written");

    // ...but it must NOT surface in the feed (SYSTEM or merged).
    for (const kind of [undefined, "SYSTEM"]) {
      const { messages } = await getMessages(alice.token, raceId, { kind });
      assert.ok(
        !messages.some((m) => m.eventType === "MYSTERY_BOX_OPENED"),
        `no MYSTERY_BOX_OPENED item in ${kind || "merged"} feed`
      );
      assert.ok(
        !messages.some((m) => (m.body || "").includes("opened a mystery box")),
        `no box-reveal text in ${kind || "merged"} feed`
      );
    }
  });

  it("legitimate POWERUP_EARNED milestone events still show in the feed", async () => {
    const alice = await createUser("AliceB1BBBB");
    const bob = await createUser("BobB1BBBBBB");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await prisma.racePowerupEvent.create({
      data: {
        raceId,
        actorUserId: alice.userId,
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: "AliceB1BBBB earned a mystery box!",
      },
    });
    const { messages } = await getMessages(alice.token, raceId, {
      kind: "SYSTEM",
    });
    assert.ok(
      messages.some((m) => m.eventType === "POWERUP_EARNED"),
      "milestone POWERUP_EARNED event still visible"
    );
  });

  it("welcome mystery-box grants never appear in the activity feed", async () => {
    const alice = await createUser("AliceB1Welcome");
    const bob = await createUser("BobB1WelcomeX");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    await prisma.racePowerupEvent.create({
      data: {
        raceId,
        actorUserId: alice.userId,
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: "Welcome gift. A mystery box!",
      },
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId,
        actorUserId: alice.userId,
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: "Welcome gift — a mystery box!",
      },
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId,
        actorUserId: alice.userId,
        eventType: "POWERUP_EARNED",
        powerupType: "MYSTERY_BOX",
        description: "AliceB1Welcome earned a mystery box!",
      },
    });

    const { messages } = await getMessages(alice.token, raceId, {
      kind: "SYSTEM",
    });
    assert.ok(
      !messages.some((m) => m.body === "Welcome gift. A mystery box!"),
      "welcome gift is hidden"
    );
    assert.ok(
      !messages.some((m) => m.body === "Welcome gift — a mystery box!"),
      "legacy welcome gift is hidden"
    );
    assert.ok(
      messages.some((m) => m.body === "AliceB1Welcome earned a mystery box!"),
      "earned mystery boxes remain visible"
    );

    const legacyFeed = await getFeed(alice.token, raceId);
    assert.ok(
      !legacyFeed.events.some((e) => e.description === "Welcome gift. A mystery box!" || e.description === "Welcome gift — a mystery box!"),
      "legacy activity endpoint also hides welcome gifts"
    );
  });

  it("pagination stays full and complete across a dense stretch of box opens", async () => {
    const alice = await createUser("AliceB1CCCC");
    const bob = await createUser("BobB1CCCCCC");
    await makeFriends(alice, bob);
    const raceId = await createActiveRace(alice, bob);

    const aliceP = await participant(raceId, alice.userId);
    const base = Date.now() - 60 * 60 * 1000;

    // 6 OLDER user messages (should all be reachable through pagination).
    const expectedBodies = [];
    for (let i = 0; i < 6; i++) {
      const body = `user-msg-${i}`;
      expectedBodies.push(body);
      await prisma.raceMessage.create({
        data: {
          raceId,
          senderId: alice.userId,
          body,
          createdAt: new Date(base + i * 1000),
        },
      });
    }

    // 10 NEWER box-open audit rows. Under the old JS post-filter these would
    // fill the first page(s), get filtered to empty, and prematurely null the
    // cursor — dropping the older user messages.
    for (let i = 0; i < 10; i++) {
      await prisma.racePowerupEvent.create({
        data: {
          raceId,
          actorUserId: alice.userId,
          eventType: "MYSTERY_BOX_OPENED",
          powerupType: "LEECH",
          description: `AliceB1CCCC opened a mystery box — Leech! (${i})`,
          createdAt: new Date(base + 100000 + i * 1000),
        },
      });
    }

    // Walk the merged feed with a small page size.
    const collected = [];
    let cursor;
    let guard = 0;
    do {
      const page = await getMessages(alice.token, raceId, { limit: 3, cursor });
      assert.ok(
        !page.messages.some((m) => m.eventType === "MYSTERY_BOX_OPENED"),
        "no box reveal on any page"
      );
      collected.push(...page.messages);
      cursor = page.nextCursor;
      guard++;
    } while (cursor && guard < 50);

    const collectedUserBodies = collected
      .filter((m) => m.kind === "USER")
      .map((m) => m.body)
      .sort();
    assert.deepEqual(
      collectedUserBodies,
      [...expectedBodies].sort(),
      "every user message is reachable despite the dense box-open stretch"
    );
  });
});

describe("B1 — fanny-pack auto-activate open is hidden and counted", () => {
  let fannyServer;

  before(async () => {
    // Force the roll to FANNY_PACK so the full-inventory auto-activate branch
    // fires deterministically. Only the RNG is seeded — the real HTTP handler,
    // DB, models and event writes are exercised.
    const forcedOpen = buildOpenMysteryBox({
      rollPowerupOdds: () => ({ type: "FANNY_PACK", rarity: "COMMON" }),
    });
    fannyServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      openMysteryBox: forcedOpen,
    });
  });

  after(async () => {
    if (fannyServer) await fannyServer.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("writes MYSTERY_BOX_OPENED (hidden from feed), increments the slot, and the metric counts it", async () => {
    // Point the shared helpers at the dedicated (forced-roll) server.
    const realServer = server;
    server = fannyServer;
    try {
      const alice = await createUser("AliceFanny");
      const bob = await createUser("BobFannyBob");
      await makeFriends(alice, bob);
      const raceId = await createActiveRace(alice, bob);

      const aliceP = await participant(raceId, alice.userId);

      // Fill inventory to the default cap (3 occupied HELD slots) so the box
      // open hits the auto-activate branch. maxSlots stays at the default, so
      // the "already expanded" re-roll loop does not spin on the forced roll.
      for (let i = 0; i < 3; i++) {
        await prisma.racePowerup.create({
          data: {
            raceId,
            participantId: aliceP.id,
            userId: alice.userId,
            type: "PROTEIN_SHAKE",
            status: "HELD",
            earnedAtSteps: 1000 + i,
          },
        });
      }
      const box = await giveBox(raceId, alice.userId);

      const openRes = await request(
        fannyServer.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${box.id}/open`,
        { token: alice.token }
      );
      assert.equal(openRes.status, 200);
      const openBody = await openRes.json();
      assert.equal(openBody.result.autoActivated, true, "auto-activated");

      // Slot increment still happened.
      const aliceAfter = await prisma.raceParticipant.findUnique({
        where: { id: aliceP.id },
      });
      assert.equal(aliceAfter.powerupSlots, 4, "extra slot unlocked");

      // The audit row is now MYSTERY_BOX_OPENED (not POWERUP_EARNED).
      const rows = await prisma.racePowerupEvent.findMany({
        where: { raceId, actorUserId: alice.userId },
      });
      const autoRow = rows.find((r) =>
        (r.description || "").includes("Auto-activated")
      );
      assert.ok(autoRow, "auto-activate audit row exists");
      assert.equal(
        autoRow.eventType,
        "MYSTERY_BOX_OPENED",
        "auto-activate row uses MYSTERY_BOX_OPENED so it is hidden AND metric-counted"
      );

      // Hidden from the feed.
      const { messages } = await getMessages(alice.token, raceId, {
        kind: "SYSTEM",
      });
      assert.ok(
        !messages.some((m) => m.eventType === "MYSTERY_BOX_OPENED"),
        "auto-activate reveal hidden from feed"
      );

      // Admin box-opener metric counts by eventType === MYSTERY_BOX_OPENED.
      const distinctOpeners = await prisma.racePowerupEvent.findMany({
        where: { eventType: "MYSTERY_BOX_OPENED" },
        distinct: ["actorUserId"],
      });
      assert.ok(
        distinctOpeners.some((r) => r.actorUserId === alice.userId),
        "auto-activate open is counted as a unique box opener"
      );
    } finally {
      server = realServer;
    }
  });
});
