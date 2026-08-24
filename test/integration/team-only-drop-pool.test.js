const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// Team-only drop pool (docs/team-only-drop-pool-requirements.md), tests §9.1–§9.7.
//
// Everything here runs through the real HTTP endpoints. The whole risk in this
// change is that ONE of the four roll/disclosure paths (single open, batch open,
// odds sheet, purchase) forgets a gate the others apply, so asserting the roller
// directly would prove nothing — the divergence IS the bug.
//
// The two gates under test:
//   * teamOnlyTypes — RALLY_FLAG may only drop in a TEAM race;
//   * powerups5     — RALLY_FLAG may only drop for a client advertising the
//                     `powerups5` X-Client-Features token (compat gate: a frozen
//                     binary that rolls one gets UPDATE_REQUIRED at use time).

let server;
let nextAppleId = 0;

// A modern 2.0.x-style client. `characters`/`team_races` are what the race
// surfaces need; `powerups5` is the token under test.
const P5_HEADERS = { "X-Client-Features": "characters,team_races,powerups5" };
// An App-Store-frozen client (1.6.x–1.7.x): team races, but NO powerups5.
const OLD_HEADERS = { "X-Client-Features": "characters,team_races" };

async function createUser(displayName, headers = undefined) {
  const appleId = `apple-teamonly-${++nextAppleId}-${Date.now()}`;
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

async function backdate(raceId) {
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0 },
  });
}

// A started SOLO race with `others` invited alongside the creator.
async function createSoloRace(creator, others) {
  for (const other of others) await makeFriends(creator, other);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Solo Drops",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      // Public keeps the race out of private-race auto-start so this suite
      // still exercises the manual start path. Privacy is irrelevant to the
      // drop-pool behavior asserted here.
      isPublic: true,
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
  await backdate(raceId);
  return raceId;
}

// A started 2v2 TEAM race: creator + `teamA` on TEAM_A, `teamB` on TEAM_B.
async function createTeamRace(creator, teamA, teamB) {
  const others = [...teamA, ...teamB];
  for (const other of others) await makeFriends(creator, other, P5_HEADERS);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Team Drops",
      maxDurationDays: 7,
      isTeamRace: true,
      teamSize: 1 + teamA.length,
      powerupsEnabled: true,
      powerupStepInterval: 5000,
      // See createSoloRace: public == ineligible for private auto-start.
      isPublic: true,
    },
    token: creator.token,
    headers: P5_HEADERS,
  });
  const createBody = await createRes.json();
  if (!createBody.race) {
    throw new Error(`team race create failed: ${createRes.status} ${JSON.stringify(createBody)}`);
  }
  const raceId = createBody.race.id;

  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: creator.token,
    headers: P5_HEADERS,
  });
  for (const [user, team] of [
    ...teamA.map((u) => [u, "TEAM_A"]),
    ...teamB.map((u) => [u, "TEAM_B"]),
  ]) {
    const res = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true, team },
      token: user.token,
      headers: P5_HEADERS,
    });
    assert.equal(res.status, 200, `respond failed: ${res.status}`);
  }
  const detail = await request(server.baseUrl, "GET", `/races/${raceId}`, {
    token: creator.token,
    headers: P5_HEADERS,
  });
  assert.equal(detail.status, 200);
  const current = await detail.json();
  if (current.status === "PENDING") {
    const startRes = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: creator.token,
      headers: P5_HEADERS,
    });
    assert.equal(startRes.status, 200, `team race start failed: ${startRes.status}`);
  } else {
    assert.equal(current.status, "ACTIVE");
  }
  await backdate(raceId);
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

async function getProgress(token, raceId, headers = undefined) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers,
  });
  return (await res.json()).progress;
}

async function walk(user, raceId, steps, headers = undefined) {
  await recordSteps(user.token, steps);
  await getProgress(user.token, raceId, headers);
}

let nextEarnedAtSteps = 2_000_000;

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

async function giveHeld(raceId, userId, type, rarity = "UNCOMMON") {
  const p = await prisma.raceParticipant.findFirst({ where: { raceId, userId } });
  return prisma.racePowerup.create({
    data: { raceId, participantId: p.id, userId, type, rarity, status: "HELD" },
  });
}

// Open `count` boxes one at a time through POST .../open and return the rolled
// types. Each opened row is retired immediately so slot accounting never
// interferes with a long sampling run.
async function openBoxes(user, raceId, count, headers) {
  const types = [];
  for (let i = 0; i < count; i++) {
    const box = await giveBox(raceId, user.userId);
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: user.token, headers }
    );
    assert.equal(res.status, 200, `open ${i} failed: ${res.status}`);
    const body = await res.json();
    assert.ok(body.result.type, `open ${i} returned a null type — a tapped box must always pay out`);
    types.push(body.result.type);
    await prisma.racePowerup.update({
      where: { id: box.id },
      data: { status: "USED", usedAt: new Date() },
    });
  }
  return types;
}

// Same sampling, but through POST .../powerups/open-batch. The batch endpoint is
// the likeliest partial implementation (gate `open`, forget `open-batch`).
async function openBoxesBatch(user, raceId, count, headers) {
  const types = [];
  let remaining = count;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 10);
    const boxes = [];
    for (let i = 0; i < chunk; i++) boxes.push(await giveBox(raceId, user.userId));
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/open-batch`,
      { token: user.token, headers, body: { powerupIds: boxes.map((b) => b.id) } }
    );
    assert.equal(res.status, 200, `open-batch failed: ${res.status}`);
    const body = await res.json();
    assert.equal(body.results.length, chunk, "batch must open every box it was handed");
    for (const r of body.results) {
      assert.ok(r.type, "open-batch returned a null type");
      types.push(r.type);
    }
    await prisma.racePowerup.updateMany({
      where: { id: { in: boxes.map((b) => b.id) } },
      data: { status: "USED", usedAt: new Date() },
    });
    remaining -= chunk;
  }
  return types;
}

async function activateConfig(config, version = 1) {
  await prisma.balanceConfig.updateMany({ where: { active: true }, data: { active: false } });
  const row = await prisma.balanceConfig.create({
    data: { version, config, active: true, note: "team-only-drop-pool test" },
  });
  balanceConfig.bustCache();
  return row;
}

// Force every roll into the UNCOMMON tier holding exactly the named pool, so a
// "RALLY_FLAG never appears" assertion is deterministic rather than a rare tail.
// Tier probabilities are precisely what this change must NOT touch, so pinning
// them is safe.
function pinnedUncommon(pool) {
  const config = defaultConfig();
  config.positionOdds = { first: [0, 1, 0], last: [0, 1, 0] };
  config.dropPool = { COMMON: [], UNCOMMON: [...pool], RARE: [] };
  config.typeWeights = {};
  return config;
}

const SAMPLES = 40;

describe("team-only drop pool", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
    await prisma.powerupShopItem.deleteMany({});
    balanceConfig.bustCache();
  });

  // §9.1
  it("a powerups5 client in a TEAM race can roll Rally Flag", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("TeamAliceP5", P5_HEADERS);
    const bob = await createUser("TeamBobP5", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      rolled.includes("RALLY_FLAG"),
      `a powerups5 client in a team race must be able to roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
  });

  // §9.2
  it("a powerups5 client in a SOLO race never rolls Rally Flag", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("SoloAliceP5", P5_HEADERS);
    const bob = await createUser("SoloBobP5", P5_HEADERS);
    const raceId = await createSoloRace(alice, [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      !rolled.includes("RALLY_FLAG"),
      `a solo race must never roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
    assert.deepEqual([...new Set(rolled)], ["STEALTH_MODE"]);
  });

  // §9.3 — the compat gate. This is the one that makes the change shippable
  // before the 2.0.x App Store rollout.
  it("a client without powerups5 never rolls Rally Flag, even in a team race", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("TeamAliceOld", P5_HEADERS);
    const bob = await createUser("TeamBobOld", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, OLD_HEADERS);
    await walk(bob, raceId, 4000, OLD_HEADERS);

    const rolled = await openBoxes(alice, raceId, SAMPLES, OLD_HEADERS);
    assert.ok(
      !rolled.includes("RALLY_FLAG"),
      `a pre-powerups5 binary must never roll RALLY_FLAG, got ${[...new Set(rolled)].join(",")}`
    );
    assert.deepEqual([...new Set(rolled)], ["STEALTH_MODE"]);
  });

  // §9.4 — both roll paths. Gating `open` and forgetting `open-batch` is the
  // most plausible partial implementation of this spec.
  it("open-batch applies the same two gates as the single open", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));
    const alice = await createUser("BatchAlice", P5_HEADERS);
    const bob = await createUser("BatchBob", P5_HEADERS);
    const raceId = await createTeamRace(alice, [], [bob]);
    await walk(alice, raceId, 8000, P5_HEADERS);
    await walk(bob, raceId, 4000, P5_HEADERS);

    const modern = await openBoxesBatch(alice, raceId, SAMPLES, P5_HEADERS);
    assert.ok(
      modern.includes("RALLY_FLAG"),
      `open-batch must reach RALLY_FLAG for a powerups5 team client, got ${[...new Set(modern)].join(",")}`
    );

    const frozen = await openBoxesBatch(alice, raceId, SAMPLES, OLD_HEADERS);
    assert.ok(
      !frozen.includes("RALLY_FLAG"),
      `open-batch must gate a pre-powerups5 client, got ${[...new Set(frozen)].join(",")}`
    );

    // …and the solo half of the gate, through the batch path too.
    const carol = await createUser("BatchCarol", P5_HEADERS);
    const dave = await createUser("BatchDave", P5_HEADERS);
    const soloId = await createSoloRace(carol, [dave]);
    await walk(carol, soloId, 8000, P5_HEADERS);
    await walk(dave, soloId, 4000, P5_HEADERS);
    const solo = await openBoxesBatch(carol, soloId, SAMPLES, P5_HEADERS);
    assert.ok(
      !solo.includes("RALLY_FLAG"),
      `open-batch must gate a solo race, got ${[...new Set(solo)].join(",")}`
    );
  });

  // §9.5 — the odds sheet must not advertise what the roll cannot produce. The
  // roll and the disclosure read the same seam; if they diverge the sheet lies.
  it("the odds sheet lists Rally Flag in exactly the one case it can drop", async () => {
    await activateConfig(pinnedUncommon(["RALLY_FLAG", "STEALTH_MODE"]));

    const alice = await createUser("OddsAlice", P5_HEADERS);
    const bob = await createUser("OddsBob", P5_HEADERS);
    const teamId = await createTeamRace(alice, [], [bob]);
    await walk(alice, teamId, 8000, P5_HEADERS);
    await walk(bob, teamId, 4000, P5_HEADERS);

    const carol = await createUser("OddsCarol", P5_HEADERS);
    const dave = await createUser("OddsDave", P5_HEADERS);
    const soloId = await createSoloRace(carol, [dave]);
    await walk(carol, soloId, 8000, P5_HEADERS);
    await walk(dave, soloId, 4000, P5_HEADERS);

    const teamP5 = await getProgress(alice.token, teamId, P5_HEADERS);
    const teamOld = await getProgress(alice.token, teamId, OLD_HEADERS);
    const soloP5 = await getProgress(carol.token, soloId, P5_HEADERS);
    const soloOld = await getProgress(carol.token, soloId, OLD_HEADERS);

    assert.ok(
      teamP5.powerupData.dropOdds.byType.RALLY_FLAG > 0,
      "team + powerups5 is the one combination that must quote RALLY_FLAG"
    );
    for (const [label, progress] of [
      ["team without powerups5", teamOld],
      ["solo with powerups5", soloP5],
      ["solo without powerups5", soloOld],
    ]) {
      assert.equal(
        progress.powerupData.dropOdds.byType.RALLY_FLAG ?? 0,
        0,
        `${label} must be quoted zero RALLY_FLAG`
      );
    }

    // The tier block is untouched by this feature — the shipped odds sheet hides
    // itself entirely if it stops summing to 1.
    for (const progress of [teamP5, teamOld, soloP5, soloOld]) {
      const { rarity } = progress.powerupData.dropOdds;
      const sum = rarity.COMMON + rarity.UNCOMMON + rarity.RARE;
      assert.ok(Math.abs(sum - 1) < 0.001, `rarity must still sum to 1, got ${sum}`);
    }
  });

  // §9.6 — §5.7 hides the store row; a purchase must 404.
  it("Rally Flag cannot be purchased once the store row is hidden", async () => {
    await activateConfig(defaultConfig());
    const alice = await createUser("ShopAlice", P5_HEADERS);
    await prisma.user.update({ where: { id: alice.userId }, data: { coins: 5000 } });

    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_RALLY_FLAG" },
      update: { active: false, testOnly: true },
      create: {
        sku: "POWERUP_RALLY_FLAG",
        name: "Rally Flag",
        description: "Team races only",
        priceCoins: 150,
        powerupType: "RALLY_FLAG",
        active: false,
        testOnly: true,
        sortOrder: 16,
      },
    });

    const catalogRes = await request(server.baseUrl, "GET", "/shop/powerups", {
      token: alice.token,
      headers: { ...P5_HEADERS, "X-Release-Channel": "testflight" },
    });
    assert.equal(catalogRes.status, 200);
    const catalog = await catalogRes.json();
    assert.ok(
      !(catalog.items || []).some((i) => i.sku === "POWERUP_RALLY_FLAG"),
      "a hidden row must not appear in the catalog on any channel"
    );

    const buyRes = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
      token: alice.token,
      headers: {
        ...P5_HEADERS,
        "X-Release-Channel": "testflight",
        "Idempotency-Key": "team-only-rally-flag-1",
      },
      body: { sku: "POWERUP_RALLY_FLAG" },
    });
    assert.equal(buyRes.status, 404, `purchase should 404, got ${buyRes.status}`);

    const user = await prisma.user.findUnique({ where: { id: alice.userId } });
    assert.equal(user.coins, 5000, "a 404'd purchase must not spend coins");
  });

  // §9.7 — the effect itself is byte-identical to today.
  it("a held Rally Flag still buffs the whole team, and still 400s in a solo race", async () => {
    await activateConfig(defaultConfig());

    const alice = await createUser("EffectAlice", P5_HEADERS);
    const bob = await createUser("EffectBob", P5_HEADERS);
    const carol = await createUser("EffectCarol", P5_HEADERS);
    const dave = await createUser("EffectDave", P5_HEADERS);
    const teamId = await createTeamRace(alice, [bob], [carol, dave]);
    for (const u of [alice, bob, carol, dave]) await walk(u, teamId, 3000, P5_HEADERS);

    const flag = await giveHeld(teamId, alice.userId, "RALLY_FLAG");
    const useRes = await request(
      server.baseUrl,
      "POST",
      `/races/${teamId}/powerups/${flag.id}/use`,
      { token: alice.token, headers: P5_HEADERS, body: {} }
    );
    const useBody = await useRes.json();
    assert.equal(useRes.status, 200, `use failed: ${useRes.status} ${JSON.stringify(useBody)}`);
    assert.equal(useBody.result.outcome, "APPLIED");
    assert.equal(useBody.result.affected, 2, "both TEAM_A members are buffed");
    assert.equal(useBody.result.durationMs, 60 * 60 * 1000);

    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId: teamId, type: "RALLY_FLAG", status: "ACTIVE" },
    });
    assert.equal(effects.length, 2);
    assert.deepEqual(
      effects.map((e) => e.targetUserId).sort(),
      [alice.userId, bob.userId].sort()
    );
    for (const e of effects) assert.equal(e.metadata.multiplier, 1.25);

    // Solo half — unchanged 400 INVALID_TARGET, item not consumed.
    const erin = await createUser("EffectErin", P5_HEADERS);
    const frank = await createUser("EffectFrank", P5_HEADERS);
    const soloId = await createSoloRace(erin, [frank]);
    await walk(erin, soloId, 3000, P5_HEADERS);
    const soloFlag = await giveHeld(soloId, erin.userId, "RALLY_FLAG");
    const soloRes = await request(
      server.baseUrl,
      "POST",
      `/races/${soloId}/powerups/${soloFlag.id}/use`,
      { token: erin.token, headers: P5_HEADERS, body: {} }
    );
    assert.equal(soloRes.status, 400);
    const soloBody = await soloRes.json();
    assert.equal(soloBody.error, "Rally Flag needs a team race");
    assert.equal(soloBody.code, "INVALID_TARGET");
    const stillHeld = await prisma.racePowerup.findUnique({ where: { id: soloFlag.id } });
    assert.equal(stillHeld.status, "HELD", "a rejected use must not consume the item");
  });
});
