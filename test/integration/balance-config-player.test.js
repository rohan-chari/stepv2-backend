const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { defaultConfig } = require("../../src/services/balanceConfig.defaults");
const { balanceConfig } = require("../../src/services/balanceConfig");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-bcp-${++nextAppleId}-${Date.now()}`;
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
  const sendBody = await sendRes.json();
  if (!sendBody.friendship) {
    throw new Error(`friend request failed: ${sendRes.status} ${JSON.stringify(sendBody)}`);
  }
  const fId = sendBody.friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace({ powerupsEnabled = true } = {}) {
  const alice = await createUser("AliceOdds");
  const bob = await createUser("BobOdds");
  await makeFriends(alice, bob);

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Odds Race",
      targetSteps: 200000,
      maxDurationDays: 7,
      powerupsEnabled,
      ...(powerupsEnabled ? { powerupStepInterval: 5000 } : {}),
    },
    token: alice.token,
  });
  const createBody = await createRes.json();
  if (!createBody.race) {
    throw new Error(`race create failed: ${createRes.status} ${JSON.stringify(createBody)}`);
  }
  const raceId = createBody.race.id;

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

  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await prisma.race.update({ where: { id: raceId }, data: { startedAt } });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt },
  });

  return { alice, bob, raceId };
}

async function recordSteps(token, steps) {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  await request(server.baseUrl, "POST", "/steps/samples", {
    body: {
      samples: [
        {
          periodStart: oneHourAgo.toISOString(),
          periodEnd: now.toISOString(),
          steps,
        },
      ],
    },
    token,
  });
}

async function getProgress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
  });
  return (await res.json()).progress;
}

// Write a config row directly and clear the process cache, so the test controls
// exactly which version is active.
async function activateConfig(config, version) {
  await prisma.balanceConfig.updateMany({
    where: { active: true },
    data: { active: false },
  });
  const row = await prisma.balanceConfig.create({
    data: { version, config, active: true, note: "test" },
  });
  balanceConfig.bustCache();
  return row;
}

describe("balance config — player-facing (§5.3)", () => {
  before(async () => {
    server = await getSharedServer();
    // The config-outage test below renames balance_config and renames it back.
    // If a previous run was killed mid-test the rename survives, and because
    // the migration is already recorded as applied, `migrate deploy` will not
    // recreate the table — every later run would then fail confusingly. Repair
    // it here so the suite is self-healing.
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_name = 'balance_config_hidden')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                           WHERE table_name = 'balance_config') THEN
          ALTER TABLE balance_config_hidden RENAME TO balance_config;
        END IF;
      END $$;
    `);
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
    balanceConfig.bustCache();
  });

  // Test #10
  it("getRaceProgress includes powerupData.dropOdds whose rarity sums to 1.0", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);

    const progress = await getProgress(alice.token, raceId);
    const dropOdds = progress.powerupData?.dropOdds;
    assert.ok(dropOdds, "dropOdds should be present on an active powerup race");

    assert.equal(dropOdds.configVersion, 1);
    assert.equal(dropOdds.totalParticipants, 2);
    assert.ok([1, 2].includes(dropOdds.position));

    const sum =
      dropOdds.rarity.COMMON + dropOdds.rarity.UNCOMMON + dropOdds.rarity.RARE;
    assert.ok(Math.abs(sum - 1) < 1e-9, `rarity should sum to 1, got ${sum}`);

    // byType is present and consistent with the rarity tiers it was derived from.
    assert.ok(dropOdds.byType, "byType should be present when the pool is non-empty");
    const byTypeSum = Object.values(dropOdds.byType).reduce((a, b) => a + b, 0);
    assert.ok(
      Math.abs(byTypeSum - 1) < 1e-9,
      `byType should sum to 1, got ${byTypeSum}`
    );
    // A store-only type must never be quoted odds.
    assert.equal(dropOdds.byType.LEECH, undefined);
    assert.equal(dropOdds.byType.RAINSTORM, undefined);
    // upgradeCosts keeps its exact existing shape (old-client compat).
    assert.ok(progress.powerupData.upgradeCosts.byRarity.RARE);
    assert.deepEqual(
      progress.powerupData.upgradeCosts.byRarity.COMMON,
      [0, 5, 15, 45]
    );
  });

  // Contract amendment: powerupData.rarityByType (additive sibling of
  // upgradeCosts). This is what lets a NEW client stop mislabelling SHORTCUT as
  // COMMON — without it, §5.4's "self-heals on update" promise would be false.
  it("getRaceProgress serves powerupData.rarityByType verbatim from the active config", async () => {
    const config = defaultConfig();
    await activateConfig(config, 1);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);

    const progress = await getProgress(alice.token, raceId);
    const rarityByType = progress.powerupData?.rarityByType;
    assert.ok(rarityByType, "rarityByType should sit beside upgradeCosts");
    assert.deepEqual(rarityByType, config.rarityByType);

    // The two corrections a client must pick up.
    assert.equal(rarityByType.SHORTCUT, "RARE");
    assert.equal(rarityByType.RUNNERS_HIGH, "COMMON");
    // Full enum coverage: nothing silently defaults to COMMON on the client.
    for (const type of ["LEECH", "DEFENSE_SCAN", "HITCHHIKE", "QUICK_RINSE",
                        "RED_CARD", "SECOND_WIND", "FANNY_PACK"]) {
      assert.ok(rarityByType[type], `${type} must carry a rarity`);
    }
  });

  it("rarityByType tracks a config edit", async () => {
    const config = defaultConfig();
    config.rarityByType.PINECONE_TOSS = "UNCOMMON";
    await activateConfig(config, 3);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(progress.powerupData.rarityByType.PINECONE_TOSS, "UNCOMMON");
  });

  it("rarityByType is absent when powerups are disabled for the race", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, raceId } = await createActiveRace({ powerupsEnabled: false });
    await recordSteps(alice.token, 6000);

    const progress = await getProgress(alice.token, raceId);
    // powerupData is omitted entirely, so rarityByType goes with it — the same
    // rule as every other key in the block.
    assert.equal(progress.powerupData, undefined);
  });

  it("dropOdds is absent when powerups are disabled for the race", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, raceId } = await createActiveRace({ powerupsEnabled: false });
    await recordSteps(alice.token, 6000);

    const progress = await getProgress(alice.token, raceId);
    assert.equal(progress.powerupData, undefined);
  });

  it("the trailing racer is quoted better RARE odds than the leader", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, bob, raceId } = await createActiveRace();
    await recordSteps(alice.token, 20000);
    await recordSteps(bob.token, 1000);

    const leader = await getProgress(alice.token, raceId);
    const trailer = await getProgress(bob.token, raceId);

    assert.equal(leader.powerupData.dropOdds.position, 1);
    assert.equal(trailer.powerupData.dropOdds.position, 2);
    assert.ok(
      trailer.powerupData.dropOdds.rarity.RARE >
        leader.powerupData.dropOdds.rarity.RARE,
      "the catch-up mechanic must favour the trailer"
    );
  });

  // Test #11
  it("getDailyRewardStatus includes box.itemOdds with a COINS slice, and still sends rarePrizeMix unchanged", async () => {
    const config = defaultConfig();
    config.dailyBox.rareCoinsShare = 0.4;
    await activateConfig(config, 1);

    // A powerup must be purchasable for the RARE tier to have a powerup slice.
    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_RAINSTORM" },
      update: { active: true, testOnly: false },
      create: {
        sku: "POWERUP_RAINSTORM",
        name: "Rainstorm",
        description: "d",
        priceCoins: 75,
        powerupType: "RAINSTORM",
        active: true,
        sortOrder: 5,
      },
    });

    const user = await createUser("DailyOdds");
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(server.baseUrl, "GET", `/daily-reward/status?localDate=${today}`, {
      token: user.token,
      headers: { "X-Client-Features": "spinpowerups,jammer" },
    });
    assert.equal(res.status, 200);
    const { box } = await res.json();

    assert.ok(box.itemOdds, "itemOdds should be present");
    assert.equal(box.itemOdds.configVersion, 1);

    const raritySum =
      box.itemOdds.rarity.COMMON +
      box.itemOdds.rarity.UNCOMMON +
      box.itemOdds.rarity.RARE;
    assert.ok(Math.abs(raritySum - 1) < 1e-9);

    const mix = box.itemOdds.rareMix;
    assert.ok("COINS" in mix, "rareMix must include the COINS slice");
    const mixSum = mix.ACCESSORY + mix.POWERUP + mix.COINS;
    assert.ok(Math.abs(mixSum - 1) < 1e-9, `rareMix should sum to 1, got ${mixSum}`);

    // Old-client compat: rarePrizeMix is still sent and still has its old shape
    // (ACCESSORY + POWERUP only, no COINS key).
    assert.ok(box.rarePrizeMix, "rarePrizeMix must still be sent");
    assert.deepEqual(Object.keys(box.rarePrizeMix).sort(), ["ACCESSORY", "POWERUP"]);
  });

  // Test #12
  it("an opened box records the configVersion that produced it", async () => {
    await activateConfig(defaultConfig(), 7);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);
    await getProgress(alice.token, raceId);

    const box = await prisma.racePowerup.findFirst({
      where: { raceId, userId: alice.userId, status: "MYSTERY_BOX" },
    });
    assert.ok(box, "a mystery box should have been earned");
    // Unopened boxes are NOT stamped — rollPowerup mints them without rolling
    // rarity, so a version there would record a config that decided nothing.
    assert.equal(box.configVersion, null);

    const openRes = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${box.id}/open`,
      { token: alice.token }
    );
    assert.equal(openRes.status, 200);

    const opened = await prisma.racePowerup.findUnique({ where: { id: box.id } });
    assert.equal(
      opened.configVersion,
      7,
      "the opened row must record the config version that rolled it"
    );
  });

  // Test #14
  it("a config change is picked up within the TTL without a restart", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);

    const before = await getProgress(alice.token, raceId);
    assert.equal(before.powerupData.dropOdds.configVersion, 1);
    assert.deepEqual(
      before.powerupData.upgradeCosts.byRarity.COMMON,
      [0, 5, 15, 45]
    );

    // Change the config out from under the running process. bustCache() stands
    // in for "the TTL lapsed" — it is the same code path, minus a 5s sleep that
    // would make this test slow and flaky.
    const changed = defaultConfig();
    changed.upgradeCosts.byRarity.COMMON = [0, 7, 21, 63];
    await activateConfig(changed, 2);

    const after = await getProgress(alice.token, raceId);
    assert.equal(after.powerupData.dropOdds.configVersion, 2);
    assert.deepEqual(after.powerupData.upgradeCosts.byRarity.COMMON, [0, 7, 21, 63]);
  });

  // Test #15 (a) — storeOnlyTypes governs the IN-RACE mystery box.
  it("a storeOnlyTypes entry is never quoted in drop odds", async () => {
    const config = defaultConfig();
    // Promote a normally-droppable type to store-only and confirm it disappears
    // from the odds a player is quoted.
    config.storeOnlyTypes = [...config.storeOnlyTypes, "MIRROR"];
    config.dropPool.RARE = config.dropPool.RARE.filter((t) => t !== "MIRROR");
    await activateConfig(config, 1);

    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);
    const progress = await getProgress(alice.token, raceId);

    assert.equal(progress.powerupData.dropOdds.byType.MIRROR, undefined);
    for (const type of config.storeOnlyTypes) {
      assert.equal(
        progress.powerupData.dropOdds.byType[type],
        undefined,
        `${type} is store-only and must not be quoted drop odds`
      );
    }
  });

  // Test #15 (b) — dailyBoxExcludedTypes governs the DAILY box, and is the only
  // authority doing so (the hardcoded POWERUPS2/3 lists are no longer consulted).
  //
  // These are deliberately SEPARATE keys. storeOnlyTypes is the larger set:
  // Imposter / Rainstorm / Signal Jammer never roll from a mystery box but are
  // legitimate daily-box prizes — §5.3's own example quotes Signal Jammer odds.
  it("dailyBoxExcludedTypes is the single authority over the daily-box pool", async () => {
    for (const sku of ["POWERUP_RAINSTORM", "POWERUP_IMPOSTER"]) {
      await prisma.powerupShopItem.upsert({
        where: { sku },
        update: { active: true, testOnly: false },
        create: {
          sku,
          name: sku,
          description: "d",
          priceCoins: 75,
          powerupType: sku === "POWERUP_RAINSTORM" ? "RAINSTORM" : "IMPOSTER",
          active: true,
          sortOrder: 5,
        },
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const user = await createUser("PoolAuthority");

    // Baseline: Rainstorm is winnable.
    await activateConfig(defaultConfig(), 1);
    let res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${today}`,
      { token: user.token, headers: { "X-Client-Features": "spinpowerups,jammer" } }
    );
    let { box } = await res.json();
    let types = box.powerupPool.map((p) => p.powerupType);
    assert.ok(
      types.includes("RAINSTORM"),
      "Rainstorm is store-only but IS a daily-box prize — it must stay winnable"
    );

    // Excluding it in config removes it, with no code change.
    const config = defaultConfig();
    config.dailyBoxExcludedTypes = [...config.dailyBoxExcludedTypes, "RAINSTORM"];
    await activateConfig(config, 2);
    res = await request(
      server.baseUrl,
      "GET",
      `/daily-reward/status?localDate=${today}`,
      { token: user.token, headers: { "X-Client-Features": "spinpowerups,jammer" } }
    );
    ({ box } = await res.json());
    types = box.powerupPool.map((p) => p.powerupType);
    assert.ok(!types.includes("RAINSTORM"), "config must be able to exclude it");
    // And the four historically-excluded types are still excluded.
    for (const type of ["DEFENSE_SCAN", "LEECH", "HITCHHIKE", "QUICK_RINSE"]) {
      assert.ok(!types.includes(type), `${type} must never be a daily-box prize`);
    }
  });

  // Test #13 — a config read failure must never take the game down.
  it("drops still roll from code defaults when the config table is unreadable", async () => {
    await activateConfig(defaultConfig(), 1);
    const { alice, raceId } = await createActiveRace();
    await recordSteps(alice.token, 6000);

    // Simulate the table being gone (rolled-back migration / DB blip). The
    // service must swallow this and serve code defaults, not 500.
    await prisma.$executeRawUnsafe(`ALTER TABLE balance_config RENAME TO balance_config_hidden`);
    balanceConfig.bustCache();
    try {
      const res = await request(
        server.baseUrl,
        "GET",
        `/races/${raceId}/progress`,
        { token: alice.token }
      );
      assert.equal(res.status, 200, "a config read failure must not 500");
      const progress = (await res.json()).progress;
      // Odds are still served. A process that HAS read successfully keeps
      // serving its last-good snapshot rather than swinging everyone's odds
      // back to defaults and then back again over a brief blip; a process that
      // has never read successfully serves code defaults with configVersion
      // null (covered by the balanceConfig unit test). Either way: no throw,
      // no 500, and the numbers are coherent.
      assert.ok(progress.powerupData.dropOdds);
      const raritySum =
        progress.powerupData.dropOdds.rarity.COMMON +
        progress.powerupData.dropOdds.rarity.UNCOMMON +
        progress.powerupData.dropOdds.rarity.RARE;
      assert.ok(Math.abs(raritySum - 1) < 1e-9);
      assert.deepEqual(
        progress.powerupData.upgradeCosts.byRarity.COMMON,
        [0, 5, 15, 45]
      );

      // And a box can still actually be opened.
      const box = await prisma.racePowerup.findFirst({
        where: { raceId, userId: alice.userId, status: "MYSTERY_BOX" },
      });
      assert.ok(box);
      const openRes = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${box.id}/open`,
        { token: alice.token }
      );
      assert.equal(openRes.status, 200, "box rolls must survive a config outage");
      const opened = await prisma.racePowerup.findUnique({ where: { id: box.id } });
      assert.ok(opened.type, "a type should have been rolled from code defaults");
      assert.ok(["COMMON", "UNCOMMON", "RARE"].includes(opened.rarity));
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE balance_config_hidden RENAME TO balance_config`);
      balanceConfig.bustCache();
    }
  });
});
