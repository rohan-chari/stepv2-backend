const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// Position-aware mystery-box drops (docs/position-aware-drops-requirements.md).
//
// Everything here goes through the real HTTP endpoints — box opens through
// POST /races/:id/powerups/:id/open, the odds disclosure through
// GET /races/:id/progress, the Second Wind rejection through
// POST /races/:id/powerups/:id/use — because the whole risk in this change is
// that the roll path and the disclosure path drift apart. Asserting a helper
// twice would not catch that.

let server;
let nextAppleId = 0;

const TEAM_HEADERS = { "X-Client-Features": "characters,team_races" };

async function createUser(displayName, headers = undefined) {
  const appleId = `apple-posdrops-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token,
      headers,
    });
  }
  if (headers) {
    await request(server.baseUrl, "GET", "/auth/me", { token, headers });
  }
  return { userId: body.user.id, token };
}

async function makeFriends(a, b, headers = undefined) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
    headers,
  });
  const sendBody = await sendRes.json();
  if (!sendBody.friendship) {
    throw new Error(`friend request failed: ${sendRes.status} ${JSON.stringify(sendBody)}`);
  }
  await request(server.baseUrl, "PUT", `/friends/request/${sendBody.friendship.id}`, {
    body: { accept: true },
    token: b.token,
    headers,
  });
}

// A started solo race with `others` invited alongside the creator.
async function createActiveRace(creator, others) {
  for (const other of others) await makeFriends(creator, other);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Position Drops",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
    },
    token: creator.token,
  });
  const createBody = await createRes.json();
  if (!createBody.race) {
    throw new Error(`race create failed: ${createRes.status} ${JSON.stringify(createBody)}`);
  }
  const raceId = createBody.race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
  });
  for (const other of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: other.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: creator.token,
  });

  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
  return raceId;
}

async function recordSteps(token, steps) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  await request(server.baseUrl, "POST", "/steps/samples", {
    body: {
      samples: [
        { periodStart: oneHourAgo.toISOString(), periodEnd: now.toISOString(), steps },
      ],
    },
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, { token });
  return (await res.json()).progress;
}

// Real steps through the sampler, then a progress read so resolveRaceState
// persists RaceParticipant.totalSteps — which is what the roller ranks on.
async function walk(user, raceId, steps) {
  await recordSteps(user.token, steps);
  await getProgress(user.token, raceId);
}

async function assertTotals(raceId, expected) {
  for (const [userId, steps] of Object.entries(expected)) {
    const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
    assert.equal(p.totalSteps, steps, `participant ${userId} should be on ${steps} steps`);
  }
}

// (participant_id, earned_at_steps) is unique, and real milestone boxes occupy
// the low multiples — mint test boxes from a private high range.
let nextEarnedAtSteps = 1_000_000;

async function giveBox(raceId, userId) {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: p.id,
      userId,
      type: null,
      rarity: null,
      status: "MYSTERY_BOX",
      earnedAtSteps: ++nextEarnedAtSteps,
    },
  });
}

async function giveHeld(raceId, userId, type, rarity = "RARE") {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD" },
  });
}

// Open `count` boxes for a user through the endpoint and return the rolled
// types. Each opened row is retired straight afterwards so slot accounting can
// never interfere with a long sampling run.
async function openBoxes(user, raceId, count) {
  const types = [];
  for (let i = 0; i < count; i++) {
    const box = await giveBox(raceId, user.userId);
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: user.token }
    );
    assert.equal(res.status, 200, `open ${i} failed: ${res.status}`);
    const body = await res.json();
    types.push(body.result.type);
    await prisma.racePowerup.update({
      where: { id: box.id },
      data: { status: "USED", usedAt: new Date() },
    });
  }
  return types;
}

async function activateConfig(config, version = 1) {
  await prisma.balanceConfig.updateMany({ where: { active: true }, data: { active: false } });
  const row = await prisma.balanceConfig.create({
    data: { version, config, active: true, note: "position-aware-drops test" },
  });
  balanceConfig.bustCache();
  return row;
}

// Force every roll into ONE tier holding ONE named pool. This makes the
// exclusion assertions deterministic instead of relying on a rare tail: the
// tier probabilities are what the change must NOT touch, so pinning them is
// safe and removes all sampling flake from the exclusion tests.
function pinnedConfig(rarity, pool, { weightsFlat = true } = {}) {
  const config = defaultConfig();
  const row = { COMMON: [1, 0, 0], UNCOMMON: [0, 1, 0], RARE: [0, 0, 1] }[rarity];
  config.positionOdds = { first: [...row], last: [...row] };
  config.dropPool = { COMMON: [], UNCOMMON: [], RARE: [] };
  config.dropPool[rarity] = [...pool];
  if (weightsFlat) config.typeWeights = {};
  return config;
}

describe("position-aware mystery-box drops", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
    balanceConfig.bustCache();
  });

  // Test 1
  it("a clear step leader is never dealt Red Card or Second Wind", async () => {
    await activateConfig(
      pinnedConfig("RARE", ["RED_CARD", "SECOND_WIND", "TRAIL_MINE", "COMPRESSION_SOCKS"])
    );
    const alice = await createUser("LeaderA");
    const bob = await createUser("TrailerB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);
    await assertTotals(raceId, { [alice.userId]: 20000, [bob.userId]: 1000 });

    const rolled = await openBoxes(alice, raceId, 40);
    assert.ok(!rolled.includes("RED_CARD"), `leader rolled RED_CARD: ${rolled.join(",")}`);
    assert.ok(!rolled.includes("SECOND_WIND"), `leader rolled SECOND_WIND: ${rolled.join(",")}`);
    // The tier is still reachable and the freed mass went to the survivors.
    assert.ok(rolled.includes("COMPRESSION_SOCKS") || rolled.includes("TRAIL_MINE"));
  });

  // Test 2 — the case a normalizedPosition implementation gets wrong.
  it("both players tied for the step lead are protected", async () => {
    await activateConfig(
      pinnedConfig("RARE", ["RED_CARD", "SECOND_WIND", "COMPRESSION_SOCKS"])
    );
    const alice = await createUser("TiedA");
    const bob = await createUser("TiedB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 5000);
    await walk(bob, raceId, 5000);
    await assertTotals(raceId, { [alice.userId]: 5000, [bob.userId]: 5000 });

    for (const user of [alice, bob]) {
      const rolled = await openBoxes(user, raceId, 25);
      assert.deepEqual(
        [...new Set(rolled)],
        ["COMPRESSION_SOCKS"],
        `a tied leader must only roll the survivor, got ${[...new Set(rolled)].join(",")}`
      );
    }
  });

  // Test 3
  it("the player with nobody behind them is never dealt Trail Mine", async () => {
    await activateConfig(
      pinnedConfig("RARE", ["TRAIL_MINE", "COMPRESSION_SOCKS", "SHORTCUT"])
    );
    const alice = await createUser("LeaderA");
    const bob = await createUser("LastB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    const rolled = await openBoxes(bob, raceId, 40);
    assert.ok(!rolled.includes("TRAIL_MINE"), `last place rolled TRAIL_MINE: ${rolled.join(",")}`);
    assert.ok(rolled.length === 40);
  });

  // Test 4
  it("a mid-pack player can still roll every type in the tier", async () => {
    await activateConfig(
      pinnedConfig("RARE", ["RED_CARD", "SECOND_WIND", "TRAIL_MINE", "COMPRESSION_SOCKS"])
    );
    const alice = await createUser("LeaderA");
    const bob = await createUser("MidB");
    const carol = await createUser("LastC");
    const raceId = await createActiveRace(alice, [bob, carol]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 10000);
    await walk(carol, raceId, 1000);
    await assertTotals(raceId, {
      [alice.userId]: 20000,
      [bob.userId]: 10000,
      [carol.userId]: 1000,
    });

    const rolled = await openBoxes(bob, raceId, 60);
    for (const type of ["RED_CARD", "SECOND_WIND", "TRAIL_MINE", "COMPRESSION_SOCKS"]) {
      assert.ok(rolled.includes(type), `mid-pack must still roll ${type}: ${rolled.join(",")}`);
    }
  });

  // Test 5 — the regression a collapsed team rank would cause.
  it("a member of the leading TEAM who is not the individual step leader still rolls Red Card", async () => {
    await activateConfig(pinnedConfig("RARE", ["RED_CARD", "COMPRESSION_SOCKS"]));
    const alice = await createUser("TeamAliceLead", TEAM_HEADERS);
    const bob = await createUser("TeamBobQuiet", TEAM_HEADERS);
    const carol = await createUser("TeamCarol", TEAM_HEADERS);
    const dave = await createUser("TeamDave", TEAM_HEADERS);

    for (const other of [bob, carol, dave]) await makeFriends(alice, other, TEAM_HEADERS);
    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: { name: "Team Drops", maxDurationDays: 7, isTeamRace: true, teamSize: 2 },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    const race = (await createRes.json()).race;
    assert.ok(race, "team race created");
    await request(server.baseUrl, "POST", `/races/${race.id}/invite`, {
      body: { inviteeIds: [bob.userId, carol.userId, dave.userId] },
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    for (const [user, team] of [[bob, "TEAM_A"], [carol, "TEAM_B"], [dave, "TEAM_B"]]) {
      const res = await request(server.baseUrl, "PUT", `/races/${race.id}/respond`, {
        body: { accept: true, team },
        token: user.token,
        headers: TEAM_HEADERS,
      });
      assert.equal(res.status, 200);
    }
    const startRes = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
      token: alice.token,
      headers: TEAM_HEADERS,
    });
    assert.equal(startRes.status, 200);
    const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await prisma.race.update({ where: { id: race.id }, data: { startedAt } });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt, baselineSteps: 0 },
    });

    // TEAM_A leads on combined steps (30100 vs 900) but bob is NOT the
    // individual step leader — alice is.
    await walk(alice, race.id, 30000);
    await walk(bob, race.id, 100);
    await walk(carol, race.id, 500);
    await walk(dave, race.id, 400);

    const rolled = await openBoxes(bob, race.id, 40);
    assert.ok(
      rolled.includes("RED_CARD"),
      `a non-leading member of the leading team must keep Red Card: ${rolled.join(",")}`
    );
    // And the actual individual leader on the same team is still excluded.
    const aliceRolled = await openBoxes(alice, race.id, 25);
    assert.deepEqual([...new Set(aliceRolled)], ["COMPRESSION_SOCKS"]);
  });

  // Test 6
  it("the odds disclosure zeroes what the roll excludes, and rarity still sums to 1", async () => {
    await activateConfig(defaultConfig());
    const alice = await createUser("DiscloseA");
    const bob = await createUser("DiscloseB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    const leader = await getProgress(alice.token, raceId);
    const trailer = await getProgress(bob.token, raceId);

    for (const progress of [leader, trailer]) {
      const { rarity } = progress.powerupData.dropOdds;
      const sum = rarity.COMMON + rarity.UNCOMMON + rarity.RARE;
      assert.ok(
        Math.abs(sum - 1) < 0.001,
        `the rarity block must stay a valid distribution (the shipped odds sheet hides itself otherwise), got ${sum}`
      );
    }

    const leaderByType = leader.powerupData.dropOdds.byType;
    assert.equal(leaderByType.RED_CARD ?? 0, 0, "leader is quoted zero Red Card");
    assert.equal(leaderByType.SECOND_WIND ?? 0, 0, "leader is quoted zero Second Wind");
    assert.ok(leaderByType.TRAIL_MINE > 0, "leader can still roll Trail Mine");

    const trailerByType = trailer.powerupData.dropOdds.byType;
    assert.equal(trailerByType.TRAIL_MINE ?? 0, 0, "last place is quoted zero Trail Mine");
    assert.ok(trailerByType.RED_CARD > 0, "last place can still roll Red Card");

    // Tier probabilities are untouched by this feature: the byType slices still
    // account for the whole distribution.
    for (const progress of [leader, trailer]) {
      const byTypeSum = Object.values(progress.powerupData.dropOdds.byType).reduce(
        (a, b) => a + b,
        0
      );
      assert.ok(Math.abs(byTypeSum - 1) < 1e-9, `byType should still sum to 1, got ${byTypeSum}`);
    }
  });

  // Test 7 — the Lucky Horseshoe minimum-rarity path.
  it("a leader forced to RARE by a max Lucky Horseshoe is never handed Red Card", async () => {
    // COMMON-pinned odds, so every roll would be COMMON without the horseshoe;
    // the horseshoe is what promotes it into the RARE tier, which is where the
    // leader-excluded items live.
    const config = pinnedConfig("COMMON", ["PROTEIN_SHAKE"]);
    config.dropPool.RARE = ["RED_CARD", "SECOND_WIND", "COMPRESSION_SOCKS"];
    await activateConfig(config);

    const alice = await createUser("HorseshoeA");
    const bob = await createUser("HorseshoeB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    const p = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });

    const rolled = [];
    for (let i = 0; i < 20; i++) {
      const backing = await giveHeld(raceId, alice.userId, "LUCKY_HORSESHOE");
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: p.id,
          targetUserId: alice.userId,
          sourceUserId: alice.userId,
          powerupId: backing.id,
          type: "LUCKY_HORSESHOE",
          status: "ACTIVE",
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 3600_000),
          metadata: { minRarity: "RARE" },
        },
      });
      const [type] = await openBoxes(alice, raceId, 1);
      rolled.push(type);
    }

    assert.ok(
      rolled.every((t) => t === "COMPRESSION_SOCKS"),
      `a max horseshoe must hand the leader a USABLE rare, got ${[...new Set(rolled)].join(",")}`
    );
  });

  // Test 8 — the kill switch.
  it("clearing positionRules restores the pre-change behaviour with no deploy", async () => {
    const config = pinnedConfig("RARE", ["RED_CARD", "SECOND_WIND", "COMPRESSION_SOCKS"]);
    config.positionRules = {
      leaderExcluded: [],
      lastPlaceExcluded: [],
      leadingDownweight: {},
      trailingDownweight: {},
      leadingDownweightFrom: 0.4,
      trailingDownweightFrom: 0.6,
    };
    await activateConfig(config);

    const alice = await createUser("SwitchA");
    const bob = await createUser("SwitchB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    const rolled = await openBoxes(alice, raceId, 60);
    assert.ok(
      rolled.includes("RED_CARD"),
      `with the rules cleared the leader must be able to roll Red Card again: ${rolled.join(",")}`
    );

    // And the disclosure agrees — the kill switch has to move both paths.
    const leader = await getProgress(alice.token, raceId);
    assert.ok(leader.powerupData.dropOdds.byType.RED_CARD > 0);
  });

  // Test 9a — Runner's High is damped at the front, never removed (D1).
  it("a leader still rolls Runner's High, at a lower quoted rate than mid-pack", async () => {
    await activateConfig(pinnedConfig("COMMON", ["RUNNERS_HIGH", "PROTEIN_SHAKE"]));
    const alice = await createUser("RHLeader");
    const bob = await createUser("RHMid");
    const carol = await createUser("RHLast");
    const raceId = await createActiveRace(alice, [bob, carol]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 10000);
    await walk(carol, raceId, 1000);

    const rolled = await openBoxes(alice, raceId, 60);
    assert.ok(
      rolled.includes("RUNNERS_HIGH"),
      "a down-weight is a tilt, not a removal — the leader must still draw it"
    );

    const leader = await getProgress(alice.token, raceId);
    const mid = await getProgress(bob.token, raceId);
    const leaderP = leader.powerupData.dropOdds.byType.RUNNERS_HIGH;
    const midP = mid.powerupData.dropOdds.byType.RUNNERS_HIGH;
    assert.ok(leaderP > 0, "still reachable at the front");
    assert.ok(leaderP < midP - 0.01, `leader ${leaderP} should be visibly below mid ${midP}`);
  });

  // Test 9b — Cleanse / Mirror / Stealth are damped at the back, never removed
  // (D2, D3).
  it("last place still rolls Cleanse, Mirror and Stealth Mode, at lower quoted rates", async () => {
    await activateConfig(
      pinnedConfig("RARE", ["CLEANSE", "MIRROR", "STEALTH_MODE", "COMPRESSION_SOCKS"])
    );
    const alice = await createUser("DWLeader");
    const bob = await createUser("DWMid");
    const carol = await createUser("DWLast");
    const raceId = await createActiveRace(alice, [bob, carol]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 10000);
    await walk(carol, raceId, 1000);

    const rolled = await openBoxes(carol, raceId, 80);
    for (const type of ["CLEANSE", "MIRROR", "STEALTH_MODE"]) {
      assert.ok(
        rolled.includes(type),
        `${type} must remain reachable at the back: ${[...new Set(rolled)].join(",")}`
      );
    }

    const last = await getProgress(carol.token, raceId);
    const mid = await getProgress(bob.token, raceId);
    for (const type of ["CLEANSE", "MIRROR", "STEALTH_MODE"]) {
      const lastP = last.powerupData.dropOdds.byType[type];
      const midP = mid.powerupData.dropOdds.byType[type];
      assert.ok(lastP > 0, `${type} still quoted at the back`);
      assert.ok(lastP < midP - 0.01, `${type}: last ${lastP} should be visibly below mid ${midP}`);
    }
  });

  // Test 10 (§3.5a / D4) — the Second Wind rejection must not consume the item.
  it("a leader rejected on Second Wind keeps the powerup and their coins", async () => {
    await activateConfig(defaultConfig());
    const alice = await createUser("SWLeader");
    const bob = await createUser("SWTrailer");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 500 } });
    const held = await giveHeld(raceId, alice.userId, "SECOND_WIND");

    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${held.id}/use`,
      { token: alice.token }
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "You cannot use Second Wind while you are in the lead");

    const invRes = await request(server.baseUrl, "GET", `/races/${raceId}/inventory`, {
      token: alice.token,
    });
    assert.equal(invRes.status, 200);
    const inv = await invRes.json();
    // GET /inventory lists HELD rows only, so presence here IS the proof the
    // rejection did not consume the item.
    const stillHeld = (inv.inventory || []).find((p) => p.id === held.id);
    assert.ok(stillHeld, "the rejected Second Wind must still be in the inventory");
    assert.equal(stillHeld.type, "SECOND_WIND");

    const row = await prisma.racePowerup.findUnique({ where: { id: held.id } });
    assert.equal(row.status, "HELD");
    assert.equal(row.usedAt, null);

    const user = await prisma.user.findUnique({ where: { id: alice.userId } });
    assert.equal(user.coins, 500, "a rejected use must not cost coins");
  });

  // §5 — the config round trip. The block only survives because it is in
  // DEFAULT_CONFIG (mergeOverDefaults recurses only into keys present in base).
  it("positionRules survives a save round trip through the admin endpoint", async () => {
    await activateConfig(defaultConfig(), 1);
    const admin = await createUser("AdminRT");
    await prisma.user.update({
      where: { id: admin.userId },
      data: { email: process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com" },
    });

    const readRes = await request(server.baseUrl, "GET", "/admin/balance-config", {
      token: admin.token,
    });
    assert.equal(readRes.status, 200);
    const read = await readRes.json();
    assert.ok(read.config.positionRules, "GET must expose positionRules to the admin screen");
    assert.deepEqual(
      read.config.positionRules.leaderExcluded,
      ["RED_CARD", "SECOND_WIND"]
    );

    const edited = JSON.parse(JSON.stringify(read.config));
    edited.positionRules.trailingDownweight.CLEANSE = 0.25;
    const writeRes = await request(server.baseUrl, "PUT", "/admin/balance-config", {
      token: admin.token,
      body: { config: edited, expectedVersion: read.version, acknowledgeBoundWarnings: true },
    });
    assert.equal(writeRes.status, 201, `save failed: ${JSON.stringify(await writeRes.json())}`);

    const afterRes = await request(server.baseUrl, "GET", "/admin/balance-config", {
      token: admin.token,
    });
    const after = await afterRes.json();
    assert.equal(after.config.positionRules.trailingDownweight.CLEANSE, 0.25);
    assert.deepEqual(after.config.positionRules.leaderExcluded, ["RED_CARD", "SECOND_WIND"]);
  });

  // A config stored BEFORE this deploy carries no positionRules; the code
  // default must fill it in, so a deploy alone is sufficient.
  it("a stored config written before this change still gets the shipped rules", async () => {
    const legacy = defaultConfig();
    delete legacy.positionRules;
    await activateConfig(legacy, 1);

    const alice = await createUser("LegacyA");
    const bob = await createUser("LegacyB");
    const raceId = await createActiveRace(alice, [bob]);
    await walk(alice, raceId, 20000);
    await walk(bob, raceId, 1000);

    const leader = await getProgress(alice.token, raceId);
    assert.equal(leader.powerupData.dropOdds.byType.RED_CARD ?? 0, 0);
  });
});
