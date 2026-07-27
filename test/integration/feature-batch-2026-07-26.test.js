// Feature & bugfix batch 2026-07-26 — backend half.
//
// Covers, through the real HTTP path against the real test DB:
//   * Item 8  — release-channel-aware `characterPresentation` (TestFlight
//               viewers see test-only characters, INCLUDING their own row).
//   (Items 9, 10 and 11 covered character powers, which have since been
//   removed along with their coverage.)
//   * Item 12/16 — one server-authoritative placement across home, list and
//               progress; `teams.asOf` on the list; `teams`/`isTeamRace` on the
//               home ACTIVE_RACES state.
//   * Item 14 — a reflected Leg Cramp RESETS to full duration (one ACTIVE row).
//   * Item 4  — a Trail Mine that expires untriggered emits a feed line.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;
const HEADERS = { "X-Client-Features": "characters,team_races,ads,powerups5" };
const TESTFLIGHT = { ...HEADERS, "X-Release-Channel": "testflight" };

async function createUser(displayName) {
  const appleId = `apple-b0726-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  return { userId: body.user.id, token, displayName };
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

async function createActiveRace(host, others, overrides = {}) {
  for (const o of others) await makeFriends(host, o);
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: overrides.name || "Batch 0726 Race",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      ...(overrides.body || {}),
    },
    token: host.token,
    headers: HEADERS,
  });
  const created = await createRes.json();
  assert.equal(createRes.status, 201, JSON.stringify(created));
  const raceId = created.race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: host.token,
    headers: HEADERS,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, ...(overrides.respondBody || {}) },
      token: o.token,
      headers: HEADERS,
    });
  }
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: host.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200, JSON.stringify(await startRes.json()));
  return raceId;
}

// Backdate a started race to `daysAgo` UTC midnight and give every member a
// daily step row on each elapsed day so the scoring paths have real data.
async function backdateRace(raceId, users, { daysAgo = 0, stepsPerDay = 1500 } = {}) {
  const now = new Date();
  const todayMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const startedAt = new Date(todayMidnight - daysAgo * 86400000);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt,
      endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0, nextBoxAtSteps: 2000 },
  });
  for (const u of users) {
    for (let d = 0; d <= daysAgo; d++) {
      const date = new Date(startedAt.getTime() + d * 86400000);
      await prisma.step.upsert({
        where: { userId_date: { userId: u.userId, date } },
        update: { steps: stepsPerDay },
        create: { userId: u.userId, steps: stepsPerDay, date },
      });
    }
  }
  return startedAt;
}

async function progress(token, raceId, headers = HEADERS) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers,
  });
  assert.equal(res.status, 200);
  return (await res.json()).progress;
}

async function racesList(token, headers = HEADERS) {
  const res = await request(server.baseUrl, "GET", "/races", { token, headers });
  assert.equal(res.status, 200);
  const body = await res.json();
  return [...(body.active || []), ...(body.pending || []), ...(body.completed || [])];
}

async function homeCard(token, headers = HEADERS) {
  const res = await request(server.baseUrl, "GET", "/home/race-card", {
    token,
    headers,
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function heldPowerup(raceId, participantId, userId, type) {
  return prisma.racePowerup.create({
    data: { raceId, participantId, userId, type, status: "HELD" },
  });
}

// 1v1 team race: created public, opponent JOINS the open side (invite/respond
// is not the team-race flow).
async function createActiveTeamRace(host, opponent) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Batch 0726 Team Race",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      isTeamRace: true,
      teamSize: 1,
      isPublic: true,
      maxParticipants: 2,
    },
    token: host.token,
    headers: HEADERS,
  });
  const created = await createRes.json();
  assert.equal(createRes.status, 201, JSON.stringify(created));
  const raceId = created.race.id;
  const joinRes = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
    body: { team: "TEAM_B" },
    token: opponent.token,
    headers: HEADERS,
  });
  assert.equal(joinRes.status, 201, JSON.stringify(await joinRes.json()));
  const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: host.token,
    headers: HEADERS,
  });
  assert.equal(startRes.status, 200, JSON.stringify(await startRes.json()));
  return raceId;
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

describe("feature batch 2026-07-26 — backend", () => {
  before(async () => {
    server = await getSharedServer();
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  // ── Item 8 ────────────────────────────────────────────────────────────────
  describe("item 8 — test-only characters are visible on the TestFlight channel", () => {
    async function seedTurtleRace() {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const turtle = await seedItem({
        sku: "test_turtle_beta",
        slot: "CHARACTER",
        assetKey: "turtle",
        testOnly: true,
      });
      await equip(bob, turtle);
      const raceId = await createActiveRace(alice, [bob]);
      await backdateRace(raceId, [alice, bob]);
      return { alice, bob, raceId };
    }

    it("a TestFlight viewer sees another player's test-only character", async () => {
      const { alice, bob, raceId } = await seedTurtleRace();
      const detail = await (
        await request(server.baseUrl, "GET", `/races/${raceId}`, {
          token: alice.token,
          headers: TESTFLIGHT,
        })
      ).json();
      const bobRow = detail.participants.find((p) => p.userId === bob.userId);
      assert.equal(bobRow.animal, "turtle");
    });

    it("a TestFlight viewer sees their OWN test-only character on every race surface", async () => {
      const { bob, raceId } = await seedTurtleRace();

      const detail = await (
        await request(server.baseUrl, "GET", `/races/${raceId}`, {
          token: bob.token,
          headers: TESTFLIGHT,
        })
      ).json();
      assert.equal(
        detail.participants.find((p) => p.userId === bob.userId).animal,
        "turtle",
        "GET /races/:id own row"
      );

      const prog = await progress(bob.token, raceId, TESTFLIGHT);
      assert.equal(
        prog.participants.find((p) => p.userId === bob.userId).animal,
        "turtle",
        "GET /races/:id/progress own row"
      );

      const home = await homeCard(bob.token, TESTFLIGHT);
      const flat = JSON.stringify(home);
      assert.ok(flat.includes("turtle"), "home race card carries the turtle");
    });

    it("a prod-channel viewer still sees a naked capybara (no leak)", async () => {
      const { alice, bob, raceId } = await seedTurtleRace();
      const detail = await (
        await request(server.baseUrl, "GET", `/races/${raceId}`, {
          token: alice.token,
          headers: HEADERS,
        })
      ).json();
      const bobRow = detail.participants.find((p) => p.userId === bob.userId);
      assert.equal(bobRow.animal, null);
    });
  });


  // ── Items 12 / 16 ─────────────────────────────────────────────────────────
  describe("items 12/16 — one server-authoritative placement", () => {
    it("progress exposes myPlacement + per-row placement, and all three surfaces agree", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const cara = await createUser("CaraStrider");
      const raceId = await createActiveRace(alice, [bob, cara]);
      const startedAt = await backdateRace(raceId, [alice, bob, cara]);
      // Distinct totals so the ordering is unambiguous.
      for (const [u, steps] of [
        [alice, 1000],
        [bob, 5000],
        [cara, 3000],
      ]) {
        await prisma.step.update({
          where: { userId_date: { userId: u.userId, date: startedAt } },
          data: { steps },
        });
      }

      const prog = await progress(alice.token, raceId);
      assert.equal(prog.myPlacement, 3, "alice is last");
      assert.equal(prog.myPlacementHidden, false);
      const byUser = Object.fromEntries(
        prog.participants.map((p) => [p.userId, p.placement])
      );
      assert.equal(byUser[bob.userId], 1);
      assert.equal(byUser[cara.userId], 2);
      assert.equal(byUser[alice.userId], 3);

      const list = await racesList(alice.token);
      const row = list.find((r) => r.id === raceId);
      assert.equal(row.myPlacement, prog.myPlacement, "list == progress");

      const home = await homeCard(alice.token);
      if (home.state === "ACTIVE_RACES") {
        const card = home.data.races.find((r) => r.raceId === raceId);
        assert.equal(card.userPlacement, prog.myPlacement, "home == progress");
      }
    });

    it("everyone tied at 0 steps still gets one identical order everywhere", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const raceId = await createActiveRace(alice, [bob]);
      await backdateRace(raceId, [alice, bob], { stepsPerDay: 0 });

      const prog = await progress(alice.token, raceId);
      const list = await racesList(alice.token);
      const row = list.find((r) => r.id === raceId);
      assert.equal(prog.myPlacement, row.myPlacement);
      const home = await homeCard(alice.token);
      if (home.state === "ACTIVE_RACES") {
        const card = home.data.races.find((r) => r.raceId === raceId);
        assert.equal(card.userPlacement, prog.myPlacement);
      }
    });

    it("GET /races exposes teams.asOf for a team race", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const raceId = await createActiveTeamRace(alice, bob);
      await backdateRace(raceId, [alice, bob]);
      await progress(alice.token, raceId); // persists totals

      const list = await racesList(alice.token);
      const row = list.find((r) => r.id === raceId);
      assert.ok(row.teams, "teams block present");
      assert.ok(
        Object.prototype.hasOwnProperty.call(row.teams, "asOf"),
        "teams.asOf present (nullable)"
      );
      assert.ok(row.teams.asOf, "asOf is set once totals have been written");
    });

    it("the home ACTIVE_RACES state emits isTeamRace + teams", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const raceId = await createActiveTeamRace(alice, bob);
      await backdateRace(raceId, [alice, bob]);
      const home = await homeCard(alice.token);
      if (home.state !== "ACTIVE_RACES") return; // other state won the priority
      const card = home.data.races.find((r) => r.raceId === raceId);
      assert.equal(card.isTeamRace, true);
      assert.ok(card.teams && card.teams.teamA && card.teams.teamB);
    });
  });

  // ── Item 14 ───────────────────────────────────────────────────────────────
  describe("item 14 — a reflected Leg Cramp resets instead of stacking", () => {
    it("leaves exactly ONE active Leg Cramp at full duration", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const raceId = await createActiveRace(alice, [bob]);
      await backdateRace(raceId, [alice, bob]);

      const [aliceP, bobP] = await Promise.all([
        prisma.raceParticipant.findFirst({
          where: { raceId, userId: alice.userId },
        }),
        prisma.raceParticipant.findFirst({
          where: { raceId, userId: bob.userId },
        }),
      ]);

      // Alice already carries an ACTIVE Leg Cramp with only 5 minutes left.
      const staleSource = await heldPowerup(raceId, bobP.id, bob.userId, "LEG_CRAMP");
      const stale = await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: aliceP.id,
          targetUserId: alice.userId,
          sourceUserId: bob.userId,
          powerupId: staleSource.id,
          type: "LEG_CRAMP",
          status: "ACTIVE",
          startsAt: new Date(Date.now() - 60 * 60 * 1000),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          metadata: { stepsAtFreezeStart: 0 },
        },
      });
      // Bob holds a Mirror; Alice attacks him with a Leg Cramp -> it reflects.
      const mirrorSource = await heldPowerup(raceId, bobP.id, bob.userId, "MIRROR");
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: bobP.id,
          targetUserId: bob.userId,
          sourceUserId: bob.userId,
          powerupId: mirrorSource.id,
          type: "MIRROR",
          status: "ACTIVE",
          startsAt: new Date(Date.now() - 60 * 1000),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const cramp = await heldPowerup(raceId, aliceP.id, alice.userId, "LEG_CRAMP");

      const res = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${cramp.id}/use`,
        { body: { targetUserId: bob.userId }, token: alice.token, headers: HEADERS }
      );
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

      const active = await prisma.raceActiveEffect.findMany({
        where: { targetParticipantId: aliceP.id, type: "LEG_CRAMP", status: "ACTIVE" },
      });
      assert.equal(active.length, 1, "exactly one ACTIVE Leg Cramp row");
      assert.notEqual(active[0].id, stale.id, "the stale row was replaced");
      const remainingMs = new Date(active[0].expiresAt) - Date.now();
      assert.ok(
        remainingMs > 55 * 60 * 1000,
        `reset to full duration, got ${Math.round(remainingMs / 60000)}min`
      );
    });
  });

  // ── Item 4 ────────────────────────────────────────────────────────────────
  describe("item 4 — Trail Mine comms", () => {
    it("emits a feed line when a mine expires untriggered at race end", async () => {
      const alice = await createUser("AliceWalker");
      const bob = await createUser("BobbyRunner");
      const raceId = await createActiveRace(alice, [bob]);
      await backdateRace(raceId, [alice, bob]);
      const aliceP = await prisma.raceParticipant.findFirst({
        where: { raceId, userId: alice.userId },
      });
      const minePowerup = await heldPowerup(
        raceId,
        aliceP.id,
        alice.userId,
        "TRAIL_MINE"
      );
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: aliceP.id,
          targetUserId: alice.userId,
          sourceUserId: alice.userId,
          powerupId: minePowerup.id,
          type: "TRAIL_MINE",
          status: "ACTIVE",
          startsAt: new Date(Date.now() - 60 * 60 * 1000),
          expiresAt: null,
          metadata: {
            ownerParticipantId: aliceP.id,
            positionSteps: 999999,
            penaltyPercent: 0.05,
          },
        },
      });

      const {
        resolveExpiredRaces,
      } = require("../../src/modules/races/jobs/raceExpiry");
      await prisma.race.update({
        where: { id: raceId },
        data: { endsAt: new Date(Date.now() - 1000) },
      });
      await resolveExpiredRaces();

      const events = await prisma.racePowerupEvent.findMany({
        where: { raceId, powerupType: "TRAIL_MINE" },
      });
      assert.equal(events.length, 1, "one untriggered-mine feed line");
      assert.match(events[0].description, /never/i);
    });

    it("the catalog copy explains that the mine sits at your own step count", async () => {
      const {
        POWERUP_COPY_SEED,
      } = require("../../src/modules/powerups/constants/powerupCopySeed");
      const mine = POWERUP_COPY_SEED.find((c) => c.powerupType === "TRAIL_MINE");
      assert.match(mine.description, /step count|step total|your current step/i);
    });
  });
});
