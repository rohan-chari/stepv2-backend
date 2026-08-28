const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const CACHE_ENV_PREFIX = "feature-batch-0828b:";
process.env.CACHE_ENV_PREFIX = CACHE_ENV_PREFIX;
delete process.env.REDIS_URL;

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const { startTestRedis, TEST_DB } = require("./redisTestServer");

let server;

async function createAcceptedRace(users, { status = "ACTIVE", powerupsEnabled = true } = {}) {
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: "August 28 B contract race",
      targetSteps: 100000,
      status,
      startedAt: status === "ACTIVE" ? new Date(Date.now() - 3600000) : null,
      endsAt: status === "ACTIVE" ? new Date(Date.now() + 3600000) : null,
      powerupsEnabled,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map(({ user }, index) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
      totalSteps: (users.length - index) * 1000,
      joinedAt: new Date(Date.now() - 60000 + index),
    })),
  });
  return race;
}

describe("feature batch 2026-08-28 B backend contracts", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["apiActiveImpactNoticesV1Enabled", true],
      ["apiImpactNoticesEnabled", true],
      ["apiRacePowerupTargetContextV1Enabled", true],
    ]);
  });

  it("PUT favorite is validated, idempotent, membership-scoped, and projected by GET /races", async () => {
    const owner = await createTestUser({ displayName: "Favorite Owner" });
    const stranger = await createTestUser({ displayName: "Favorite Stranger" });
    const race = await createAcceptedRace([owner]);

    const malformed = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: owner.token,
      body: { favorite: "yes" },
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_FAVORITE");

    const foreign = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: stranger.token,
      body: { favorite: true },
    });
    assert.equal(foreign.status, 404);
    assert.equal((await foreign.json()).code, "RACE_NOT_FOUND");

    const first = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: owner.token,
      body: { favorite: true },
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.isFavorite, true);
    assert.ok(Date.parse(firstBody.favoritedAt));

    const repeat = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: owner.token,
      body: { favorite: true },
    });
    assert.equal(repeat.status, 200);
    assert.equal((await repeat.json()).favoritedAt, firstBody.favoritedAt);

    const listed = await request(server.baseUrl, "GET", "/races", { token: owner.token });
    assert.equal(listed.status, 200);
    const listedRace = (await listed.json()).active.find((row) => row.id === race.id);
    assert.equal(listedRace.isFavorite, true);
    assert.equal(listedRace.favoritedAt, firstBody.favoritedAt);

    const cleared = await request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
      token: owner.token,
      body: { favorite: false },
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), {
      raceId: race.id,
      isFavorite: false,
      favoritedAt: null,
    });
  });

  it("keeps favorites isolated across users and rejects unauthenticated or invited-only writes", async () => {
    const owner = await createTestUser({ displayName: "Favorite Owner" });
    const teammate = await createTestUser({ displayName: "Favorite Teammate" });
    const invited = await createTestUser({ displayName: "Favorite Invitee" });
    const race = await createAcceptedRace([owner, teammate]);
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: invited.user.id, status: "INVITED" },
    });

    const unauthenticated = await request(
      server.baseUrl,
      "PUT",
      `/races/${race.id}/favorite`,
      { body: { favorite: true } },
    );
    assert.equal(unauthenticated.status, 401);

    const invitedOnly = await request(
      server.baseUrl,
      "PUT",
      `/races/${race.id}/favorite`,
      { token: invited.token, body: { favorite: true } },
    );
    assert.equal(invitedOnly.status, 404);
    assert.equal((await invitedOnly.json()).code, "RACE_NOT_FOUND");

    const concurrent = await Promise.all([
      request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
        token: owner.token,
        body: { favorite: true },
      }),
      request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
        token: owner.token,
        body: { favorite: true },
      }),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);

    const [ownerList, teammateList] = await Promise.all([
      request(server.baseUrl, "GET", "/races", { token: owner.token }),
      request(server.baseUrl, "GET", "/races", { token: teammate.token }),
    ]);
    const ownerRace = (await ownerList.json()).active.find(
      (row) => row.id === race.id,
    );
    const teammateRace = (await teammateList.json()).active.find(
      (row) => row.id === race.id,
    );
    assert.equal(ownerRace.isFavorite, true);
    assert.ok(Date.parse(ownerRace.favoritedAt));
    assert.equal(teammateRace.isFavorite, false);
    assert.equal(teammateRace.favoritedAt, null);
  });

  it("keeps conflicting favorite writes and cached viewer variants isolated with Redis fail-open", async (t) => {
    const live = await startTestRedis();
    if (!live) return t.skip("no local Redis available");
    const probe = new IORedis(live.url);
    const configureRedis = async (url) => {
      if (url) process.env.REDIS_URL = url;
      else delete process.env.REDIS_URL;
      await redisCache.close();
      derivedCache.reset();
    };

    try {
      await configureRedis(live.url);
      await probe.flushdb();
      assert.equal(Number(probe.options.db), TEST_DB);
      await appSettings.setFlag("redisCacheRaceListEnabled", true);
      await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
      await appSettings.setFlag("apiRaceListCompactV1Enabled", true);

      const owner = await createTestUser({ displayName: "Cached Owner" });
      const teammate = await createTestUser({ displayName: "Cached Teammate" });
      const race = await createAcceptedRace([owner, teammate]);
      const variants = [
        { path: "/races", headers: {} },
        {
          path: "/races?view=compact-v1",
          headers: { "X-Client-Features": "api_payload_compact_v1" },
        },
      ];

      for (const viewer of [owner, teammate]) {
        for (const variant of variants) {
          const warm = await request(server.baseUrl, "GET", variant.path, {
            token: viewer.token,
            headers: variant.headers,
          });
          assert.equal(warm.status, 200);
        }
      }
      const warmKeys = await probe.keys(`${CACHE_ENV_PREFIX}v1:user:races:*`);
      assert.ok(warmKeys.length >= 6, "both viewer variants install cache fragments");

      const conflicting = await Promise.all([
        request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
          token: owner.token,
          body: { favorite: true },
        }),
        request(server.baseUrl, "PUT", `/races/${race.id}/favorite`, {
          token: owner.token,
          body: { favorite: false },
        }),
      ]);
      assert.deepEqual(conflicting.map((response) => response.status), [200, 200]);
      const conflictingBodies = await Promise.all(
        conflicting.map((response) => response.json()),
      );
      assert.equal(conflictingBodies[0].isFavorite, true);
      assert.ok(Date.parse(conflictingBodies[0].favoritedAt));
      assert.deepEqual(conflictingBodies[1], {
        raceId: race.id,
        isFavorite: false,
        favoritedAt: null,
      });
      const settledRows = await prisma.raceParticipant.findMany({
        where: { raceId: race.id, userId: owner.user.id },
        select: { favoritedAt: true },
      });
      assert.equal(settledRows.length, 1);
      assert.equal(
        settledRows[0].favoritedAt == null ||
          Number.isFinite(settledRows[0].favoritedAt.getTime()),
        true,
      );

      const ownerGenerationKey =
        `${CACHE_ENV_PREFIX}v1:user:races:generation:${owner.user.id}`;
      const teammateGenerationKey =
        `${CACHE_ENV_PREFIX}v1:user:races:generation:${teammate.user.id}`;
      const generationNumber = async (key) => Number((await probe.get(key)) || 0);
      const ownerGenerationBeforeFinal = await generationNumber(
        ownerGenerationKey,
      );
      const teammateGenerationBeforeFinal = await generationNumber(
        teammateGenerationKey,
      );
      const teammateKeysBeforeFinal = (
        await probe.keys(`${CACHE_ENV_PREFIX}v1:user:races:*:${teammate.user.id}*`)
      ).sort();
      assert.ok(teammateKeysBeforeFinal.length >= 2);

      const setFavorite = await request(
        server.baseUrl,
        "PUT",
        `/races/${race.id}/favorite`,
        { token: owner.token, body: { favorite: true } },
      );
      assert.equal(setFavorite.status, 200);
      assert.equal((await setFavorite.json()).isFavorite, true);
      assert.equal(
        await generationNumber(ownerGenerationKey),
        ownerGenerationBeforeFinal + 1,
      );
      assert.equal(
        await generationNumber(teammateGenerationKey),
        teammateGenerationBeforeFinal,
      );
      assert.deepEqual(
        (
          await probe.keys(
            `${CACHE_ENV_PREFIX}v1:user:races:*:${teammate.user.id}*`,
          )
        ).sort(),
        teammateKeysBeforeFinal,
      );

      for (const variant of variants) {
        const [ownerList, teammateList] = await Promise.all([
          request(server.baseUrl, "GET", variant.path, {
            token: owner.token,
            headers: variant.headers,
          }),
          request(server.baseUrl, "GET", variant.path, {
            token: teammate.token,
            headers: variant.headers,
          }),
        ]);
        const ownerRace = (await ownerList.json()).active.find(
          (row) => row.id === race.id,
        );
        const teammateRace = (await teammateList.json()).active.find(
          (row) => row.id === race.id,
        );
        assert.equal(ownerRace.isFavorite, true);
        assert.ok(Date.parse(ownerRace.favoritedAt));
        assert.equal(teammateRace.isFavorite, false);
        assert.equal(teammateRace.favoritedAt, null);
      }

      await configureRedis(null);
      const unset = await request(server.baseUrl, "GET", "/races", {
        token: owner.token,
      });
      assert.equal(unset.status, 200);
      assert.equal(
        (await unset.json()).active.find((row) => row.id === race.id).isFavorite,
        true,
      );

      await configureRedis("redis://127.0.0.1:6399/15");
      const unavailable = await request(server.baseUrl, "GET", "/races", {
        token: owner.token,
      });
      assert.equal(unavailable.status, 200);
      assert.equal(
        (await unavailable.json()).active.find((row) => row.id === race.id)
          .isFavorite,
        true,
      );
    } finally {
      await configureRedis(null);
      await probe.quit().catch(() => {});
      await live.close();
    }
  });

  it("privacy-capable progress keeps canonical rank separate from contiguous display rank", async () => {
    const leader = await createTestUser({ displayName: "Visible Leader" });
    const hidden = await createTestUser({ displayName: "Hidden Middle" });
    const viewer = await createTestUser({ displayName: "Visible Viewer" });
    const race = await createAcceptedRace([leader, hidden, viewer]);
    const hiddenParticipant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: hidden.user.id } },
    });
    const held = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: hiddenParticipant.id,
      userId: hidden.user.id,
      type: "STEALTH_MODE",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: 1,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: hiddenParticipant.id,
      targetUserId: hidden.user.id,
      sourceUserId: hidden.user.id,
      powerupId: held.id,
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 3600000),
    } });

    const response = await request(server.baseUrl, "GET", `/races/${race.id}/progress`, {
      token: viewer.token,
      headers: { "X-Client-Features": "privacy_safe_display_ranks" },
    });
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.placementPrivacyActive, true);
    const hiddenRow = progress.participants.find((row) => row.userId === hidden.user.id);
    const viewerRow = progress.participants.find((row) => row.userId === viewer.user.id);
    assert.equal(hiddenRow.placement, null);
    assert.equal(hiddenRow.displayPlacement, null);
    assert.equal(viewerRow.placement, 3);
    assert.equal(viewerRow.displayPlacement, 2);
    assert.equal(progress.myPlacement, 3);
    assert.equal(progress.myDisplayPlacement, 2);

    const listed = await request(server.baseUrl, "GET", "/races", {
      token: viewer.token,
      headers: { "X-Client-Features": "privacy_safe_display_ranks" },
    });
    assert.equal(listed.status, 200);
    const listedRace = (await listed.json()).active.find((row) => row.id === race.id);
    assert.equal(listedRace.placementPrivacyActive, true);
    assert.equal(listedRace.myPlacement, 3);
    assert.equal(listedRace.myDisplayPlacement, 2);

    const frozenList = await request(server.baseUrl, "GET", "/races", {
      token: viewer.token,
    });
    assert.equal(frozenList.status, 200);
    const frozenRace = (await frozenList.json()).active.find((row) => row.id === race.id);
    assert.equal(frozenRace.myPlacement, null);
    assert.equal(frozenRace.myDisplayPlacement, undefined);

    const home = await request(
      server.baseUrl,
      "GET",
      "/home/race-card?homeActiveRaces=1&homePersistedTotals=1",
      {
        token: viewer.token,
        headers: { "X-Client-Features": "privacy_safe_display_ranks" },
      },
    );
    assert.equal(home.status, 200);
    const homeRace = (await home.json()).data.races.find((row) => row.raceId === race.id);
    assert.equal(homeRace.placementPrivacyActive, true);
    assert.equal(homeRace.userPlacement, 3);
    assert.equal(homeRace.userDisplayPlacement, 2);
    const hiddenHome = homeRace.top3.find((row) => row.userId === hidden.user.id);
    assert.equal(hiddenHome.rank, null);
    assert.equal(hiddenHome.displayPlacement, null);
    assert.deepEqual(
      homeRace.top3
        .filter((row) => row.isStealthed !== true)
        .map((row) => row.displayPlacement),
      [1, 2],
    );

    const frozenHome = await request(
      server.baseUrl,
      "GET",
      "/home/race-card?homeActiveRaces=1&homePersistedTotals=1",
      { token: viewer.token },
    );
    assert.equal(frozenHome.status, 200);
    const frozenHomeRace = (await frozenHome.json()).data.races.find(
      (row) => row.raceId === race.id,
    );
    assert.equal(frozenHomeRace.userPlacement, null);
    assert.equal(frozenHomeRace.top3.every((row) => row.rank == null), true);

    const targetContext = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/powerups/use-context?view=targets-v1&powerupType=BOUNTY`,
      {
        token: viewer.token,
        headers: {
          "X-Client-Features":
            "api_payload_compact_v1,privacy_safe_display_ranks",
        },
      },
    );
    assert.equal(targetContext.status, 200);
    const targetBody = await targetContext.json();
    assert.equal(targetBody.placementPrivacyActive, true);
    const hiddenTarget = targetBody.participants.find(
      (row) => row.userId === hidden.user.id,
    );
    const viewerTarget = targetBody.participants.find(
      (row) => row.userId === viewer.user.id,
    );
    assert.equal(hiddenTarget.placement, null);
    assert.equal(hiddenTarget.displayPlacement, null);
    assert.equal(viewerTarget.placement, 3);
    assert.equal(viewerTarget.displayPlacement, 2);
    assert.equal(targetBody.powerupData.myPlacement, 3);
    assert.equal(targetBody.powerupData.myDisplayPlacement, 2);

    const frozenTargetContext = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/powerups/use-context?view=targets-v1&powerupType=BOUNTY`,
      {
        token: viewer.token,
        headers: { "X-Client-Features": "api_payload_compact_v1" },
      },
    );
    assert.equal(frozenTargetContext.status, 200);
    const frozenTargetBody = await frozenTargetContext.json();
    assert.equal(
      frozenTargetBody.participants.every((row) => row.placement == null),
      true,
    );
    assert.equal(frozenTargetBody.powerupData.myPlacement, null);
  });

  it("keeps display ranks global on a later paged progress response", async () => {
    const users = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createTestUser({ displayName: `Paged Racer ${index + 1}` }),
      ),
    );
    const race = await createAcceptedRace(users);
    const hiddenParticipant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: users[1].user.id } },
    });
    const stealth = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: hiddenParticipant.id,
      userId: users[1].user.id,
      type: "STEALTH_MODE",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: 1,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: hiddenParticipant.id,
      targetUserId: users[1].user.id,
      sourceUserId: users[1].user.id,
      powerupId: stealth.id,
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 3600000),
    } });

    const response = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress?view=participants-v1&offset=3&limit=2`,
      {
        token: users[3].token,
        headers: {
          "X-Client-Features":
            "race_participants_paging,privacy_safe_display_ranks",
        },
      },
    );
    assert.equal(response.status, 200);
    const progress = (await response.json()).progress;
    assert.equal(progress.placementPrivacyActive, true);
    assert.deepEqual(
      progress.participants.map((row) => [row.placement, row.displayPlacement]),
      [[4, 3], [5, 4]],
    );
    assert.equal(progress.myPlacement, 4);
    assert.equal(progress.myDisplayPlacement, 3);
  });

  it("active impact HTTP projections include the immutable nullable attacker snapshot", async () => {
    const attacker = await createTestUser({ displayName: "TrailRunner" });
    const recipient = await createTestUser({ displayName: "Recipient" });
    const race = await createAcceptedRace([attacker, recipient]);
    const impact = await prisma.raceImpactEvent.create({ data: {
      raceId: race.id,
      recipientUserId: recipient.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: "red-card-contract-source",
      powerupType: "RED_CARD",
      deltaSteps: -1200,
      description: "You lost 1,200 synced steps to Red Card.",
      attackerDisplayName: "TrailRunner",
      resolvedAt: new Date(),
    } });

    const response = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: recipient.token, headers: { "X-Client-Features": "resolved_impact_events_v2" } },
    );
    assert.equal(response.status, 200);
    const notice = (await response.json()).notices.find((row) => row.id === `impact:${impact.id}`);
    assert.equal(notice.attackerDisplayName, "TrailRunner");
  });

  it("a real Red Card commits the direct attacker's privacy-safe snapshot", async () => {
    const recipient = await createTestUser({ displayName: "Red Card Leader" });
    const attacker = await createTestUser({ displayName: "Red Card Actor" });
    const race = await createAcceptedRace([recipient, attacker]);
    const attackerParticipant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
    });
    const card = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "RED_CARD",
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps: 1,
    } });
    const stealth = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "STEALTH_MODE",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: 2,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: attackerParticipant.id,
      targetUserId: attacker.user.id,
      sourceUserId: attacker.user.id,
      powerupId: stealth.id,
      type: "STEALTH_MODE",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 3600000),
    } });

    const used = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${card.id}/use`,
      {
        token: attacker.token,
        headers: { "X-Client-Features": "resolved_impact_events_v2" },
        body: {},
      },
    );
    assert.equal(used.status, 200, await used.text());

    const notices = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: recipient.token, headers: { "X-Client-Features": "resolved_impact_events_v2" } },
    );
    assert.equal(notices.status, 200);
    assert.equal((await notices.json()).notices[0].attackerDisplayName, "???");
  });
});
