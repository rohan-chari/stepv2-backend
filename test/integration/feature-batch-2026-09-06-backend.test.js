const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");
const { Client } = require("pg");
const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  getSharedServer,
} = require("./setup");
const {
  processRaceSeriesRenewals,
} = require("../../src/modules/races/jobs/raceSeriesRenewal");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const { appSettings } = require("../../src/shared/config/appSettings");

let server;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function holdFundedExposureGuard(userId) {
  await prisma.fundedExposureGuard.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("BEGIN");
  await client.query(
    "SELECT user_id FROM funded_exposure_guards WHERE user_id = $1 FOR UPDATE",
    [userId],
  );
  return async () => {
    await client.query("ROLLBACK");
    await client.end();
  };
}

async function waitForSeriesRowLock(seriesId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = new Client({ connectionString: process.env.DATABASE_URL });
    await probe.connect();
    try {
      await probe.query("BEGIN");
      await probe.query(
        "SELECT id FROM race_series WHERE id = $1 FOR UPDATE NOWAIT",
        [seriesId],
      );
      await probe.query("ROLLBACK");
    } catch (error) {
      await probe.query("ROLLBACK").catch(() => {});
      if (error.code === "55P03") return;
      throw error;
    } finally {
      await probe.end();
    }
    await delay(10);
  }
  assert.fail("renewal worker did not acquire the race-series row lock");
}

async function createRace(user, overrides = {}, headers = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: user.token,
    headers,
    body: {
      name: "September feature race",
      targetSteps: 50_000,
      maxDurationDays: 3,
      powerupsEnabled: true,
      maxParticipants: 10,
      ...overrides,
    },
  });
  return { response, body: await response.json() };
}

describe("2026-09-06 backend feature batch", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  it("publishes permanent capabilities and persists shop tutorial completion idempotently", async () => {
    const user = await createTestUser({ displayName: "TutorialRunner" });
    const me = await request(server.baseUrl, "GET", "/auth/me", {
      token: user.token,
    });
    assert.equal(me.status, 200);
    const before = await me.json();
    assert.equal(before.user.shopTutorialCompletedAt, null);
    assert.equal(before.user.capabilities.recurringRacesV1, true);
    assert.equal(before.user.capabilities.teamChatV1, true);

    const first = await request(server.baseUrl, "POST", "/shop/tutorial/complete", {
      token: user.token,
      body: {},
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.tutorialKey, "shop_v1");
    assert.ok(Date.parse(firstBody.completedAt));

    const replay = await request(server.baseUrl, "POST", "/shop/tutorial/complete", {
      token: user.token,
      body: {},
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), firstBody);
  });

  it("rejects separator and leetspeak profanity and marks only profane stored names for rename", async () => {
    const user = await createTestUser({ displayName: "CleanRunner" });
    const viewer = await createTestUser({ displayName: "CleanViewer" });

    for (const displayName of ["FuckRunner", "f_u_c_k_runner", "FvckRunner"] ) {
      const response = await request(server.baseUrl, "PUT", "/auth/me/display-name", {
        token: user.token,
        body: { displayName },
      });
      assert.equal(response.status, 400, displayName);
      assert.deepEqual(await response.json(), {
        error: "Choose a name without profanity.",
        code: "DISPLAY_NAME_PROFANE",
      });
    }

    const availability = await request(
      server.baseUrl,
      "GET",
      "/auth/check-display-name?name=GiulioGuiFuckUBish",
      { token: user.token },
    );
    assert.equal(availability.status, 200);
    assert.deepEqual(await availability.json(), {
      available: false,
      reason: "Choose a name without profanity.",
      code: "DISPLAY_NAME_PROFANE",
    });

    await prisma.user.update({
      where: { id: user.user.id },
      data: { displayName: "GiulioGuiFuckUBish" },
    });
    const me = await request(server.baseUrl, "GET", "/auth/me", {
      token: user.token,
    });
    assert.equal((await me.json()).user.displayNameRequiresRename, true);

    const publicProfile = await request(
      server.baseUrl,
      "GET",
      `/friends/${user.user.id}/profile`,
      { token: viewer.token },
    );
    assert.equal(publicProfile.status, 200);
    assert.equal((await publicProfile.json()).user.displayName, "Name unavailable");

    // Historical SYSTEM rows snapshot the actor's old display name inside a
    // sentence. Frozen clients render that sentence directly, so remediation
    // must cover both the structured user fields and those durable snapshots.
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "Legacy name feed",
        targetSteps: 50_000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
        powerupsEnabled: true,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [user, viewer].map((entry) => ({
        raceId: race.id,
        userId: entry.user.id,
        status: "ACCEPTED",
      })),
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: race.id,
        actorUserId: user.user.id,
        eventType: "POWERUP_USED",
        powerupType: "PROTEIN_SHAKE",
        description: "GiulioGuiFuckUBish used a Protein Shake!",
      },
    });

    const feed = await request(server.baseUrl, "GET", `/races/${race.id}/feed`, {
      token: viewer.token,
    });
    assert.equal(feed.status, 200);
    assert.equal((await feed.json()).events[0].description, "Name unavailable used a Protein Shake!");

    const activity = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=SYSTEM`,
      { token: viewer.token },
    );
    assert.equal(activity.status, 200);
    assert.equal((await activity.json()).messages[0].body, "Name unavailable used a Protein Shake!");
  });

  it("keeps team chat private in storage, reads, and notification audiences", async () => {
    await appSettings.setFlag("apiRaceMessageStreamsV1Enabled", true);
    const sender = await createTestUser({ displayName: "TeamSender" });
    const teammate = await createTestUser({ displayName: "TeamMate" });
    const opponent = await createTestUser({ displayName: "TeamOpponent" });
    const outsider = await createTestUser({ displayName: "TeamOutsider" });
    const configuredAdmin = await createTestUser({
      displayName: "TeamAdmin",
      email: "team-admin@example.com",
    });
    const forfeited = await createTestUser({ displayName: "TeamForfeited" });
    const race = await prisma.race.create({
      data: {
        creatorId: opponent.user.id,
        name: "Private team chat",
        targetSteps: 50_000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
        isTeamRace: true,
        teamSize: 2,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [
        { raceId: race.id, userId: sender.user.id, status: "ACCEPTED", team: "TEAM_A" },
        { raceId: race.id, userId: teammate.user.id, status: "ACCEPTED", team: "TEAM_A" },
        { raceId: race.id, userId: opponent.user.id, status: "ACCEPTED", team: "TEAM_B" },
        {
          raceId: race.id,
          userId: forfeited.user.id,
          status: "ACCEPTED",
          team: "TEAM_A",
          forfeitedAt: new Date(),
        },
      ],
    });

    const unsupportedSend = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/messages`,
      { token: sender.token, body: { body: "must not persist", audience: "TEAM" } },
    );
    assert.equal(unsupportedSend.status, 400);
    assert.equal((await unsupportedSend.json()).code, "UPDATE_REQUIRED");
    assert.equal(await prisma.raceMessage.count({ where: { raceId: race.id } }), 0);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "RACE_MESSAGE_SENT_V1" },
    }), 0);

    const unsupportedRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER&audience=TEAM`,
      { token: sender.token },
    );
    assert.equal(unsupportedRead.status, 400);
    assert.equal((await unsupportedRead.json()).code, "UPDATE_REQUIRED");

    const outsiderRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER&audience=TEAM`,
      { token: outsider.token, headers: { "X-Client-Features": "team_chat_v1" } },
    );
    assert.equal(outsiderRead.status, 403);
    assert.equal((await outsiderRead.json()).code, "TEAM_CHAT_UNAVAILABLE");

    const sent = await request(server.baseUrl, "POST", `/races/${race.id}/messages`, {
      token: sender.token,
      headers: { "X-Client-Features": "team_chat_v1" },
      body: { body: "team secret", audience: "TEAM" },
    });
    assert.equal(sent.status, 201);
    const sentBody = await sent.json();
    assert.equal(sentBody.message.audience, "TEAM");
    assert.equal(sentBody.message.team, "TEAM_A");

    const teammateRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER&audience=TEAM`,
      { token: teammate.token, headers: { "X-Client-Features": "team_chat_v1" } },
    );
    assert.equal(teammateRead.status, 200);
    assert.deepEqual((await teammateRead.json()).messages.map((row) => row.body), ["team secret"]);

    const opponentRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER&audience=TEAM`,
      { token: opponent.token, headers: { "X-Client-Features": "team_chat_v1" } },
    );
    assert.equal(opponentRead.status, 200);
    assert.deepEqual((await opponentRead.json()).messages, []);

    const frozenClientRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/messages?kind=USER`,
      { token: teammate.token },
    );
    assert.equal(frozenClientRead.status, 200);
    assert.deepEqual(
      (await frozenClientRead.json()).messages,
      [],
      "omitting audience keeps frozen clients on the ALL-only stream",
    );

    const event = await prisma.domainEventOutbox.findFirst({
      where: { eventType: "RACE_MESSAGE_SENT_V1", aggregateId: sentBody.message.id },
      include: { audience: true },
    });
    assert.deepEqual(event.audience.map((row) => row.recipientId), [teammate.user.id]);
    assert.equal(event.payload.audience, "TEAM");
    assert.equal(event.payload.team, "TEAM_A");

    const previousAdminEmails = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = configuredAdmin.user.email;
    try {
      for (const denied of [outsider, configuredAdmin, forfeited]) {
        const compactPrivate = await request(
          server.baseUrl,
          "GET",
          `/races/${race.id}/message-streams?audience=TEAM&includeUser=false`,
          {
            token: denied.token,
            headers: { "X-Client-Features": "team_chat_v1,api_payload_compact_v1" },
          },
        );
        assert.equal(compactPrivate.status, 403, denied.user.displayName);
        assert.deepEqual(await compactPrivate.json(), {
          error: "Team chat is unavailable.",
          code: "TEAM_CHAT_UNAVAILABLE",
        });
      }
    } finally {
      if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = previousAdminEmails;
    }

    const creatorDelete = await request(
      server.baseUrl,
      "DELETE",
      `/races/${race.id}/messages/${sentBody.message.id}`,
      { token: opponent.token },
    );
    assert.equal(creatorDelete.status, 403);
    assert.equal(
      (await prisma.raceMessage.findUnique({ where: { id: sentBody.message.id } })).deletedAt,
      null,
    );

    const pending = await prisma.race.create({
      data: {
        creatorId: sender.user.id,
        name: "Pending team chat",
        targetSteps: 50_000,
        status: "PENDING",
        isTeamRace: true,
        teamSize: 2,
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: pending.id,
        userId: sender.user.id,
        status: "ACCEPTED",
        team: "TEAM_A",
      },
    });
    const pendingSend = await request(
      server.baseUrl,
      "POST",
      `/races/${pending.id}/messages`,
      {
        token: sender.token,
        headers: { "X-Client-Features": "team_chat_v1" },
        body: { body: "too early", audience: "TEAM" },
      },
    );
    assert.equal(pendingSend.status, 403);
    assert.equal((await pendingSend.json()).code, "TEAM_CHAT_UNAVAILABLE");
    assert.equal(await prisma.raceMessage.count({ where: { raceId: pending.id } }), 0);
  });

  it("rejects a second live Rally Flag without consuming it", async () => {
    const sender = await createTestUser({ displayName: "FlagSender" });
    const teammate = await createTestUser({ displayName: "FlagMate" });
    const race = await prisma.race.create({
      data: {
        creatorId: sender.user.id,
        name: "One rally at a time",
        targetSteps: 50_000,
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 60 * 60_000),
        isTeamRace: true,
        teamSize: 2,
        powerupsEnabled: true,
      },
    });
    const participants = await Promise.all([sender, teammate].map((entry) =>
      prisma.raceParticipant.create({
        data: { raceId: race.id, userId: entry.user.id, status: "ACCEPTED", team: "TEAM_A" },
      })));
    const [first, second] = await Promise.all([0, 1].map(() =>
      prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participants[0].id,
          userId: sender.user.id,
          type: "RALLY_FLAG",
          rarity: "UNCOMMON",
          status: "HELD",
        },
      })));
    const use = (powerupId) => request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${powerupId}/use`,
      { token: sender.token, headers: { "X-Client-Features": "powerups5" }, body: {} },
    );
    const casts = await Promise.all([use(first.id), use(second.id)]);
    assert.deepEqual(casts.map((response) => response.status).sort(), [200, 409]);
    const blockedIndex = casts.findIndex((response) => response.status === 409);
    assert.equal((await casts[blockedIndex].json()).code, "RALLY_FLAG_ACTIVE");
    const rows = await prisma.racePowerup.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { status: true },
    });
    assert.deepEqual(rows.map((row) => row.status).sort(), ["HELD", "USED"]);
    const effects = await prisma.raceActiveEffect.findMany({
      where: { raceId: race.id, type: "RALLY_FLAG", status: "ACTIVE" },
      select: { powerupId: true },
    });
    assert.equal(new Set(effects.map((row) => row.powerupId)).size, 1);
    assert.equal(await prisma.racePowerupEvent.count({
      where: { raceId: race.id, eventType: "POWERUP_USED", powerupType: "RALLY_FLAG" },
    }), 1);
  });

  it("keeps Decoy out of sale surfaces while preserving existing inventory", async () => {
    const user = await createTestUser({ displayName: "DecoyOwner", coins: 1_000 });
    const catalog = await request(server.baseUrl, "GET", "/shop/powerups", {
      token: user.token,
      headers: { "X-Client-Features": "powerups5" },
    });
    assert.equal(catalog.status, 200);
    assert.equal((await catalog.json()).items.some((row) => row.powerupType === "DECOY"), false);

    const purchase = await request(server.baseUrl, "POST", "/shop/powerups/purchase", {
      token: user.token,
      headers: { "Idempotency-Key": "decoy-coin-denial" },
      body: { sku: "POWERUP_DECOY", powerupType: "DECOY" },
    });
    assert.equal(purchase.status, 409);
    assert.equal((await purchase.json()).code, "POWERUP_NOT_FOR_SALE");

    const unlock = await request(server.baseUrl, "POST", "/shop/powerups/unlock-with-ads", {
      token: user.token,
      headers: { "Idempotency-Key": "decoy-ad-denial" },
      body: { sku: "POWERUP_DECOY" },
    });
    assert.equal(unlock.status, 409);
    assert.equal((await unlock.json()).code, "POWERUP_NOT_FOR_SALE");
    assert.equal(await prisma.powerupPurchaseRequest.count({ where: { userId: user.user.id } }), 0);
    assert.equal((await prisma.user.findUnique({ where: { id: user.user.id } })).coins, 1_000);
  });

  it("honors one grandfathered verified Decoy ad grant but accepts no new purchase", async () => {
    const user = await createTestUser({ displayName: "GrandfatheredDecoy", coins: 140 });
    await prisma.powerupShopItem.upsert({
      where: { sku: "POWERUP_DECOY" },
      update: {
        name: "Decoy",
        description: "Historical Decoy listing",
        powerupType: "DECOY",
        priceCoins: 150,
        sortOrder: 99,
        active: false,
        testOnly: false,
      },
      create: {
        sku: "POWERUP_DECOY",
        name: "Decoy",
        description: "Historical Decoy listing",
        powerupType: "DECOY",
        priceCoins: 150,
        sortOrder: 99,
        active: false,
        testOnly: false,
      },
    });
    const grant = await prisma.adRewardGrant.create({
      data: {
        userId: user.user.id,
        transactionId: "grandfathered-decoy-watch",
        rewardKind: "powerup_unlock",
        shopItemId: "POWERUP_DECOY",
        grantedDate: new Date().toISOString().slice(0, 10),
      },
    });
    const key = "grandfathered-decoy-unlock";
    const unlock = () => request(
      server.baseUrl,
      "POST",
      "/shop/powerups/unlock-with-ads",
      {
        token: user.token,
        headers: { "Idempotency-Key": key },
        body: { sku: "POWERUP_DECOY" },
      },
    );
    const first = await unlock();
    assert.equal(first.status, 200);
    const result = await first.json();
    assert.equal(result.inventory.powerupType, "DECOY");
    assert.equal(result.inventory.quantity, 1);
    assert.ok((await prisma.adRewardGrant.findUniqueOrThrow({
      where: { id: grant.id },
    })).consumedAt instanceof Date);
    assert.equal((await prisma.user.findUniqueOrThrow({
      where: { id: user.user.id },
    })).coins, 0);

    const replay = await unlock();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).idempotent, true);
    assert.equal((await prisma.userPowerupItem.findUniqueOrThrow({
      where: {
        userId_powerupType: { userId: user.user.id, powerupType: "DECOY" },
      },
    })).quantity, 1);

    const blocked = await request(
      server.baseUrl,
      "POST",
      "/shop/powerups/unlock-with-ads",
      {
        token: user.token,
        headers: { "Idempotency-Key": "new-decoy-unlock" },
        body: { sku: "POWERUP_DECOY" },
      },
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).code, "POWERUP_NOT_FOR_SALE");
    assert.equal(await prisma.powerupPurchaseRequest.count({
      where: { userId: user.user.id },
    }), 1);
  });

  it("adds exact race aggregates to self and public profile stats", async () => {
    const viewer = await createTestUser({ displayName: "StatsViewer" });
    const target = await createTestUser({ displayName: "StatsTarget" });

    for (const [placement, rawSteps, forfeitedAt] of [
      [1, 3_000, null],
      [2, 2_500, null],
      [3, 2_000, new Date()],
      [1, 0, null],
    ]) {
      const race = await prisma.race.create({
        data: {
          name: `Stats race ${placement}-${rawSteps}`,
          targetSteps: 50_000,
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });
      await prisma.raceParticipant.createMany({
        data: [
          {
            raceId: race.id,
            userId: target.user.id,
            status: "ACCEPTED",
            rawSteps,
            totalSteps: rawSteps,
            placement,
            forfeitedAt,
          },
          {
            raceId: race.id,
            userId: viewer.user.id,
            status: "ACCEPTED",
            rawSteps: 1_000,
            totalSteps: 1_000,
            placement: placement === 1 ? 2 : 1,
          },
        ],
      });
    }

    const own = await request(server.baseUrl, "GET", "/steps/stats?view=profile-v1", {
      token: target.token,
    });
    assert.equal(own.status, 200);
    const ownStats = await own.json();
    assert.equal(ownStats.racesCompeted, 3);
    assert.equal(ownStats.firstPlaceWins, 1);
    assert.equal(ownStats.podiumFinishes, 2);
    assert.equal(ownStats.winRate, 0.3333);

    const profile = await request(
      server.baseUrl,
      "GET",
      `/friends/${target.user.id}/profile`,
      { token: viewer.token },
    );
    assert.equal(profile.status, 200);
    const stats = (await profile.json()).stats;
    assert.equal(stats.racesCompeted, 3);
    assert.equal(stats.firstPlaceWins, 1);
    assert.equal(stats.podiumFinishes, 2);
    assert.equal(stats.winRate, 0.3333);
  });

  it("creates recurring races only for capable valid requests and lets creators stop future renewal", async () => {
    const creator = await createTestUser({ displayName: "SeriesCreator" });
    const malformed = await createRace(
      creator,
      { recurringSeries: "true" },
      { "X-Client-Features": "recurring_races_v1" },
    );
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.body.code, "INVALID_REQUEST");

    const missingCapability = await createRace(creator, { recurringSeries: true });
    assert.equal(missingCapability.response.status, 400);
    assert.equal(missingCapability.body.code, "UPDATE_REQUIRED");

    const key = "10000000-0000-4000-8000-000000000001";
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      headers: {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": key,
      },
      body: {
        name: "Recurring walkers",
        maxDurationDays: 2,
        maxParticipants: 10,
        powerupsEnabled: false,
        recurringSeries: true,
      },
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.equal(body.race.status, "PENDING");
    assert.deepEqual(body.series, {
      id: body.series.id,
      enabled: true,
      subscribed: true,
      canManage: true,
    });

    const stopped = await request(
      server.baseUrl,
      "PUT",
      `/race-series/${body.series.id}`,
      { token: creator.token, body: { enabled: false } },
    );
    assert.equal(stopped.status, 200);
    assert.deepEqual(await stopped.json(), {
      seriesId: body.series.id,
      enabled: false,
      effectiveAfterRaceId: body.race.id,
    });
  });

  it("subscribes a capable invitee and renews exactly once without coin holds", async () => {
    const creator = await createTestUser({ displayName: "SeriesRenewCreator" });
    const invitee = await createTestUser({ displayName: "SeriesRenewInvitee" });
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      headers: {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": "30000000-0000-4000-8000-000000000003",
      },
      body: {
        name: "Recurring renewal",
        maxDurationDays: 2,
        maxParticipants: 10,
        powerupsEnabled: false,
        recurringSeries: true,
      },
    });
    assert.equal(created.status, 201);
    const first = await created.json();
    await prisma.raceParticipant.create({
      data: {
        raceId: first.race.id,
        userId: invitee.user.id,
        status: "INVITED",
        inviteExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const accepted = await request(
      server.baseUrl,
      "PUT",
      `/races/${first.race.id}/respond`,
      {
        token: invitee.token,
        headers: { "X-Client-Features": "recurring_races_v1" },
        body: { accept: true, subscribeToSeries: true },
      },
    );
    assert.equal(accepted.status, 200);
    assert.equal(await prisma.raceSeriesSubscription.count({
      where: { seriesId: first.series.id, active: true },
    }), 2);

    const settledAt = new Date();
    await prisma.race.update({
      where: { id: first.race.id },
      data: { status: "COMPLETED", completedAt: settledAt, settlementCompletedAt: settledAt },
    });
    await prisma.raceSeriesRenewalJob.create({
      data: { predecessor: { connect: { id: first.race.id } } },
    });
    await appSettings.setFlag("redisCacheRaceListEnabled", true);
    const cachedBeforeRenewal = await request(server.baseUrl, "GET", "/races", {
      token: invitee.token,
    });
    assert.equal(cachedBeforeRenewal.status, 200);
    assert.equal(
      (await cachedBeforeRenewal.json()).completed.some(
        (row) => row.id === first.race.id,
      ),
      true,
    );
    await Promise.all([processRaceSeriesRenewals(), processRaceSeriesRenewals()]);

    const series = await prisma.raceSeries.findUnique({
      where: { id: first.series.id },
      include: { currentRace: { include: { participants: true } } },
    });
    assert.equal(series.generation, 1);
    assert.notEqual(series.currentRaceId, first.race.id);
    assert.equal(series.currentRace.status, "PENDING");
    assert.deepEqual(
      series.currentRace.participants
        .filter((row) => row.status === "ACCEPTED")
        .map((row) => row.userId)
        .sort(),
      [creator.user.id, invitee.user.id].sort(),
    );
    assert.equal(series.currentRace.participants.some((row) => row.buyInStatus === "HELD"), false);
    assert.equal(await prisma.raceSeriesRenewalJob.count({
      where: { predecessorId: first.race.id, state: "SUCCEEDED" },
    }), 1);

    const invalidatedAfterRenewal = await request(
      server.baseUrl,
      "GET",
      "/races",
      { token: invitee.token },
    );
    assert.equal(invalidatedAfterRenewal.status, 200);
    assert.equal(
      (await invalidatedAfterRenewal.json()).pending.some(
        (row) => row.id === series.currentRaceId && row.myStatus === "ACCEPTED",
      ),
      true,
      "renewal must invalidate the subscriber's prewarmed race-list cache",
    );
  });

  it("fills recurring capacity past skipped subscribers and lets a skipped subscriber opt out", async () => {
    await prisma.appSetting.upsert({
      where: { key: "activeCompetitionLimit" },
      update: { value: 1 },
      create: { key: "activeCompetitionLimit", value: 1 },
    });
    appSettings.bustCache();
    try {
      const creator = await createTestUser({ displayName: "CapacitySeriesCreator" });
      const skipped = await createTestUser({ displayName: "CapacitySeriesSkipped" });
      const eligibleOne = await createTestUser({ displayName: "CapacitySeriesOne" });
      const eligibleTwo = await createTestUser({ displayName: "CapacitySeriesTwo" });
      const created = await createRace(
        creator,
        {
          name: "Capacity series",
          maxParticipants: 3,
          recurringSeries: true,
          powerupsEnabled: false,
        },
        {
          "X-Client-Features": "recurring_races_v1",
          "Idempotency-Key": "80000000-0000-4000-8000-000000000008",
        },
      );
      assert.equal(created.response.status, 201);
      const first = created.body;

      await prisma.raceParticipant.createMany({
        data: [skipped, eligibleOne, eligibleTwo].map((entry) => ({
          raceId: first.race.id,
          userId: entry.user.id,
          status: "ACCEPTED",
        })),
      });
      const base = Date.now() - 10_000;
      await prisma.raceSeriesSubscription.createMany({
        data: [skipped, eligibleOne, eligibleTwo].map((entry, index) => ({
          seriesId: first.series.id,
          userId: entry.user.id,
          active: true,
          subscribedAt: new Date(base + index),
        })),
      });

      const blockingRace = await prisma.race.create({
        data: {
          creatorId: skipped.user.id,
          name: "Admission blocker",
          targetSteps: 1_000,
          status: "ACTIVE",
          startedAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60 * 60_000),
          fundedPrize: true,
          maxDurationDays: 1,
        },
      });
      await prisma.raceParticipant.create({
        data: {
          raceId: blockingRace.id,
          userId: skipped.user.id,
          status: "ACCEPTED",
        },
      });

      const settledAt = new Date();
      await prisma.race.update({
        where: { id: first.race.id },
        data: {
          status: "COMPLETED",
          completedAt: settledAt,
          settlementCompletedAt: settledAt,
        },
      });
      await prisma.raceSeriesRenewalJob.create({
        data: { predecessorId: first.race.id },
      });
      await processRaceSeriesRenewals();

      const series = await prisma.raceSeries.findUniqueOrThrow({
        where: { id: first.series.id },
      });
      const targetMembers = await prisma.raceParticipant.findMany({
        where: { raceId: series.currentRaceId, status: "ACCEPTED" },
        orderBy: { userId: "asc" },
        select: { userId: true },
      });
      assert.deepEqual(
        targetMembers.map((row) => row.userId).sort(),
        [creator.user.id, eligibleOne.user.id, eligibleTwo.user.id].sort(),
        "later eligible subscribers must fill capacity left by an admission skip",
      );

      const optOut = await request(
        server.baseUrl,
        "PUT",
        `/race-series/${first.series.id}/subscription`,
        { token: skipped.token, body: { active: false } },
      );
      assert.equal(optOut.status, 200);
      assert.deepEqual(await optOut.json(), {
        seriesId: first.series.id,
        active: false,
        effectiveAfterRaceId: series.currentRaceId,
      });
      assert.equal((await prisma.raceSeriesSubscription.findUniqueOrThrow({
        where: {
          seriesId_userId: { seriesId: first.series.id, userId: skipped.user.id },
        },
      })).active, false);
    } finally {
      await prisma.appSetting.upsert({
        where: { key: "activeCompetitionLimit" },
        update: { value: 20 },
        create: { key: "activeCompetitionLimit", value: 20 },
      });
      appSettings.bustCache();
    }
  });

  it("pays recurring racers only at the immutable 2,000 raw-step threshold", async () => {
    const creator = await createTestUser({ displayName: "ThresholdCreator" });
    const boundary = await createTestUser({ displayName: "ThresholdBoundary" });
    const below = await createTestUser({ displayName: "ThresholdBelow" });
    const created = await createRace(
      creator,
      {
        name: "Threshold series",
        maxParticipants: 10,
        recurringSeries: true,
        payoutPreset: "TOP3_70_20_10",
        powerupsEnabled: false,
      },
      {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": "90000000-0000-4000-8000-000000000009",
      },
    );
    assert.equal(created.response.status, 201);
    const first = created.body;
    const participantRows = await prisma.raceParticipant.findMany({
      where: { raceId: first.race.id },
    });
    await prisma.raceParticipant.update({
      where: { id: participantRows[0].id },
      data: { rawSteps: 3_000, totalSteps: 3_000, placement: 1 },
    });
    await prisma.raceParticipant.createMany({
      data: [
        {
          raceId: first.race.id,
          userId: boundary.user.id,
          status: "ACCEPTED",
          rawSteps: 2_000,
          totalSteps: 2_000,
          placement: 2,
        },
        {
          raceId: first.race.id,
          userId: below.user.id,
          status: "ACCEPTED",
          rawSteps: 1_999,
          totalSteps: 1_999,
          placement: 3,
        },
      ],
    });
    await prisma.race.update({
      where: { id: first.race.id },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60 * 60_000),
        endsAt: new Date(Date.now() - 1_000),
      },
    });

    await completeRace({
      raceId: first.race.id,
      winnerUserId: creator.user.id,
      participantUserIds: [creator.user.id, boundary.user.id, below.user.id],
    });

    const balances = await prisma.user.findMany({
      where: { id: { in: [creator.user.id, boundary.user.id, below.user.id] } },
      select: { id: true, coins: true },
    });
    const coins = new Map(balances.map((row) => [row.id, row.coins]));
    assert.ok(coins.get(creator.user.id) > 0);
    assert.ok(coins.get(boundary.user.id) > 0, "exactly 2,000 raw steps qualifies");
    assert.equal(coins.get(below.user.id), 0, "1,999 raw steps receives no payout");
    const settled = await prisma.race.findUniqueOrThrow({
      where: { id: first.race.id },
    });
    assert.ok(settled.settlementCompletedAt instanceof Date);
    assert.equal(settled.recurringPayoutMinRawSteps, 2_000);
    assert.equal(settled.recurringPayoutPolicyVersion, 1);
    assert.equal(await prisma.raceSeriesRenewalJob.count({
      where: { predecessorId: first.race.id, state: "QUEUED" },
    }), 1);
  });

  it("terminalizes a creator's recurring series when the account is deleted", async () => {
    const creator = await createTestUser({ displayName: "DeletingSeriesCreator" });
    const member = await createTestUser({ displayName: "RemainingSeriesMember" });
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      headers: {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": "40000000-0000-4000-8000-000000000004",
      },
      body: {
        name: "Series creator deletion",
        maxDurationDays: 2,
        maxParticipants: 10,
        powerupsEnabled: false,
        recurringSeries: true,
      },
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    await prisma.raceSeriesSubscription.create({
      data: { seriesId: body.series.id, userId: member.user.id, active: true },
    });

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: creator.token,
    });
    assert.equal(deleted.status, 204);
    const series = await prisma.raceSeries.findUnique({
      where: { id: body.series.id },
    });
    assert.equal(series.enabled, false);
    assert.equal(series.terminalReason, "CREATOR_ACCOUNT_DELETED");
    assert.notEqual(series.creatorId, creator.user.id);
    assert.equal(await prisma.raceSeriesSubscription.count({
      where: { seriesId: body.series.id, active: true },
    }), 0);
    assert.ok(await prisma.user.findUnique({ where: { id: member.user.id } }));
  });

  it("terminalizes renewal when the creator is no longer admission-eligible", async () => {
    await prisma.appSetting.upsert({
      where: { key: "activeCompetitionLimit" },
      update: { value: 1 },
      create: { key: "activeCompetitionLimit", value: 1 },
    });
    appSettings.bustCache();
    try {
      const creator = await createTestUser({ displayName: "TerminalSeriesCreator" });
      const member = await createTestUser({ displayName: "TerminalSeriesMember" });
      const created = await createRace(
        creator,
        {
          name: "Terminal admission series",
          recurringSeries: true,
          powerupsEnabled: false,
        },
        {
          "X-Client-Features": "recurring_races_v1",
          "Idempotency-Key": "a0000000-0000-4000-8000-00000000000a",
        },
      );
      assert.equal(created.response.status, 201);
      const first = created.body;
      await prisma.raceParticipant.create({
        data: {
          raceId: first.race.id,
          userId: member.user.id,
          status: "ACCEPTED",
        },
      });
      await prisma.raceSeriesSubscription.create({
        data: { seriesId: first.series.id, userId: member.user.id, active: true },
      });
      const settledAt = new Date();
      await prisma.race.update({
        where: { id: first.race.id },
        data: {
          status: "COMPLETED",
          completedAt: settledAt,
          settlementCompletedAt: settledAt,
        },
      });
      const blocker = await prisma.race.create({
        data: {
          creatorId: creator.user.id,
          name: "Creator admission blocker",
          targetSteps: 1_000,
          status: "ACTIVE",
          startedAt: new Date(Date.now() - 60_000),
          endsAt: new Date(Date.now() + 60 * 60_000),
          fundedPrize: true,
          maxDurationDays: 1,
        },
      });
      await prisma.raceParticipant.create({
        data: {
          raceId: blocker.id,
          userId: creator.user.id,
          status: "ACCEPTED",
        },
      });
      await prisma.raceSeriesRenewalJob.create({
        data: { predecessorId: first.race.id },
      });

      await processRaceSeriesRenewals();

      const series = await prisma.raceSeries.findUniqueOrThrow({
        where: { id: first.series.id },
      });
      assert.equal(series.enabled, false);
      assert.equal(series.terminalReason, "CREATOR_INELIGIBLE");
      assert.equal(series.currentRaceId, first.race.id);
      assert.equal(await prisma.raceSeriesSubscription.count({
        where: { seriesId: first.series.id, active: true },
      }), 0);
      assert.deepEqual(
        await prisma.raceSeriesRenewalJob.findMany({
          where: { predecessorId: first.race.id },
          select: { state: true, lastErrorCode: true, targetRaceId: true },
        }),
        [{
          state: "FAILED_TERMINAL",
          lastErrorCode: "CREATOR_INELIGIBLE",
          targetRaceId: null,
        }],
      );
      assert.equal(await prisma.race.count({
        where: { seriesPredecessorRaceId: first.race.id },
      }), 0);
    } finally {
      await prisma.appSetting.upsert({
        where: { key: "activeCompetitionLimit" },
        update: { value: 20 },
        create: { key: "activeCompetitionLimit", value: 20 },
      });
      appSettings.bustCache();
    }
  });

  it("creates an idempotent rematch and invites the former accepted roster", async () => {
    const creator = await createTestUser({ displayName: "RematchCreator" });
    const participant = await createTestUser({ displayName: "RematchPlayer" });
    const source = await prisma.race.create({
      data: {
        creatorId: creator.user.id,
        name: "Completed custom",
        targetSteps: 50_000,
        maxDurationDays: 2,
        status: "COMPLETED",
        completedAt: new Date(),
        maxParticipants: 10,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [creator, participant].map((entry) => ({
        raceId: source.id,
        userId: entry.user.id,
        status: "ACCEPTED",
      })),
    });

    const eligibleDetail = await request(
      server.baseUrl,
      "GET",
      `/races/${source.id}`,
      { token: participant.token },
    );
    assert.equal(eligibleDetail.status, 200);
    assert.equal((await eligibleDetail.json()).rematchEligible, true);

    await appSettings.setFlag("redisCacheRaceListEnabled", true);
    const prewarmedList = await request(server.baseUrl, "GET", "/races", {
      token: creator.token,
    });
    assert.equal(prewarmedList.status, 200);
    assert.equal(
      (await prewarmedList.json()).pending.some((row) => row.id !== source.id),
      false,
    );

    const key = "20000000-0000-4000-8000-000000000002";
    const call = () => request(server.baseUrl, "POST", `/races/${source.id}/rematch`, {
      token: participant.token,
      headers: { "Idempotency-Key": key },
      body: {},
    });
    const duplicates = await Promise.all([call(), call()]);
    assert.deepEqual(duplicates.map((response) => response.status).sort(), [200, 201]);
    const duplicateBodies = await Promise.all(duplicates.map((response) => response.json()));
    assert.deepEqual(duplicateBodies[0], duplicateBodies[1]);
    const result = duplicateBodies[0];
    assert.equal(result.sourceRaceId, source.id);
    assert.deepEqual(result.invitedUserIds, [creator.user.id]);
    assert.deepEqual(result.skipped, []);
    assert.equal(await prisma.race.count({
      where: { rematchRootRaceId: source.id },
    }), 1);
    assert.equal(await prisma.raceRematchReceipt.count({
      where: { requesterId: participant.user.id, idempotencyKey: key },
    }), 1);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "RACE_INVITE_SENT_V1", aggregateId: result.race.id },
    }), 1);

    const c0 = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: result.race.id },
    });
    assert.equal(c0.generation, 0);
    assert.equal(c0.state, "SUCCEEDED");
    assert.equal(c0.attempts, 0);
    assert.deepEqual(c0.triggeredByUserIds, []);
    assert.deepEqual(c0.processingTriggeredByUserIds, []);
    assert.deepEqual(c0.dirtyReasons, []);
    assert.deepEqual(c0.dirtyParticipantIds, []);
    assert.deepEqual(c0.dirtyPowerupTypes, []);
    assert.deepEqual(c0.processingDirtyReasons, []);
    assert.deepEqual(c0.processingDirtyParticipantIds, []);
    assert.deepEqual(c0.processingDirtyPowerupTypes, []);

    const invalidatedList = await request(server.baseUrl, "GET", "/races", {
      token: creator.token,
    });
    assert.equal(invalidatedList.status, 200);
    const invitedCard = (await invalidatedList.json()).pending.find(
      (row) => row.id === result.race.id,
    );
    assert.equal(invitedCard?.myStatus, "INVITED");

    const firstEpisode = await prisma.raceRematchNotificationEpisode.findFirst({
      where: { recipientId: creator.user.id, rootRaceId: source.id, closedAt: null },
    });
    assert.equal(firstEpisode.latestRaceId, result.race.id);
    assert.equal(firstEpisode.revision, 1);
    const firstEvent = await prisma.domainEventOutbox.findFirst({
      where: { eventType: "RACE_INVITE_SENT_V1", aggregateId: result.race.id },
    });
    assert.equal(firstEvent.payload.rematchEpisodeId, firstEpisode.id);
    assert.equal(firstEvent.payload.rematchEpisodeRevision, 1);

    const blockedDetail = await request(
      server.baseUrl,
      "GET",
      `/races/${source.id}`,
      { token: participant.token },
    );
    assert.equal(blockedDetail.status, 200);
    assert.equal((await blockedDetail.json()).rematchEligible, false);

    const replay = await call();
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), result);

    const anotherSource = await prisma.race.create({
      data: {
        creatorId: participant.user.id,
        name: "Different completed custom",
        targetSteps: 10_000,
        maxDurationDays: 1,
        status: "COMPLETED",
        completedAt: new Date(),
        maxParticipants: 10,
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: anotherSource.id,
        userId: participant.user.id,
        status: "ACCEPTED",
      },
    });
    const conflictingReuse = await request(
      server.baseUrl,
      "POST",
      `/races/${anotherSource.id}/rematch`,
      { token: participant.token, body: { idempotencyKey: key } },
    );
    assert.equal(conflictingReuse.status, 409);
    assert.equal((await conflictingReuse.json()).code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(await prisma.race.count({
      where: { rematchRootRaceId: anotherSource.id },
    }), 0);

    await prisma.race.update({ where: { id: result.race.id }, data: { status: "CANCELLED" } });
    const next = await request(server.baseUrl, "POST", `/races/${source.id}/rematch`, {
      token: participant.token,
      headers: { "Idempotency-Key": "20000000-0000-4000-8000-000000000003" },
      body: {},
    });
    assert.equal(next.status, 201);
    const nextBody = await next.json();
    const episodes = await prisma.raceRematchNotificationEpisode.findMany({
      where: { recipientId: creator.user.id, rootRaceId: source.id, closedAt: null },
    });
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].id, firstEpisode.id);
    assert.equal(episodes[0].revision, 2);
    assert.equal(episodes[0].latestRaceId, nextBody.race.id);

    // Accept the invite, then complete through the canonical settlement seam:
    // completion closes the notification episode transactionally.
    await prisma.raceParticipant.update({
      where: {
        raceId_userId: { raceId: nextBody.race.id, userId: creator.user.id },
      },
      data: { status: "ACCEPTED", joinedAt: new Date(), rawSteps: 1_000, totalSteps: 1_000, placement: 2 },
    });
    await prisma.raceParticipant.update({
      where: {
        raceId_userId: { raceId: nextBody.race.id, userId: participant.user.id },
      },
      data: { rawSteps: 2_000, totalSteps: 2_000, placement: 1 },
    });
    await prisma.race.update({
      where: { id: nextBody.race.id },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() - 1_000),
      },
    });
    await completeRace({
      raceId: nextBody.race.id,
      winnerUserId: participant.user.id,
      participantUserIds: [participant.user.id, creator.user.id],
    });
    assert.ok((await prisma.raceRematchNotificationEpisode.findUniqueOrThrow({
      where: { id: firstEpisode.id },
    })).closedAt instanceof Date);

    // A completed descendant becomes the only valid tip. Older completed
    // ancestors must not fork the lineage or copy stale settings.
    const ancestorDetail = await request(
      server.baseUrl,
      "GET",
      `/races/${source.id}`,
      { token: participant.token },
    );
    assert.equal((await ancestorDetail.json()).rematchEligible, false);
    const staleFork = await request(
      server.baseUrl,
      "POST",
      `/races/${source.id}/rematch`,
      {
        token: participant.token,
        headers: { "Idempotency-Key": "20000000-0000-4000-8000-000000000004" },
        body: {},
      },
    );
    assert.equal(staleFork.status, 409);
    assert.equal((await staleFork.json()).code, "SOURCE_NOT_REMATCHABLE");

    const afterCompletion = await request(
      server.baseUrl,
      "POST",
      `/races/${nextBody.race.id}/rematch`,
      {
        token: participant.token,
        headers: { "Idempotency-Key": "20000000-0000-4000-8000-000000000005" },
        body: {},
      },
    );
    assert.equal(afterCompletion.status, 201);
    const afterCompletionBody = await afterCompletion.json();
    const newEpisode = await prisma.raceRematchNotificationEpisode.findFirstOrThrow({
      where: {
        recipientId: creator.user.id,
        rootRaceId: source.id,
        closedAt: null,
      },
    });
    assert.notEqual(newEpisode.id, firstEpisode.id);
    assert.equal(newEpisode.generation, 1);
    assert.equal(newEpisode.revision, 1);
    assert.equal(newEpisode.latestRaceId, afterCompletionBody.race.id);
  });

  it("recomputes current rematch economy instead of copying a historical paid race", async () => {
    const caller = await createTestUser({ displayName: "FreshEconomyCaller", coins: 500 });
    const invitee = await createTestUser({ displayName: "FreshEconomyInvitee", coins: 500 });
    const source = await prisma.race.create({
      data: {
        creatorId: invitee.user.id,
        name: "Historical paid custom",
        targetSteps: 50_000,
        maxDurationDays: 2,
        status: "COMPLETED",
        completedAt: new Date(),
        maxParticipants: 10,
        buyInAmount: 50,
        payoutPreset: "WINNER_TAKES_ALL",
        fundedPrize: false,
        prizeCalculationVersion: 1,
        payoutRoundingVersion: 0,
      },
    });
    await prisma.raceParticipant.createMany({
      data: [caller, invitee].map((entry) => ({
        raceId: source.id,
        userId: entry.user.id,
        status: "ACCEPTED",
        buyInAmount: 50,
        buyInStatus: "COMMITTED",
      })),
    });

    const key = "a0000000-0000-4000-8000-00000000000a";
    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${source.id}/rematch`,
      {
        token: caller.token,
        headers: { "Idempotency-Key": key },
        // Header wins, so a stale/invalid body key cannot redirect identity.
        body: { idempotencyKey: "not-a-uuid" },
      },
    );
    assert.equal(response.status, 201);
    const body = await response.json();
    const fresh = await prisma.race.findUniqueOrThrow({
      where: { id: body.race.id },
      include: { participants: true },
    });
    assert.equal(fresh.buyInAmount, 0);
    assert.equal(fresh.fundedPrize, true);
    assert.equal(fresh.prizeCalculationVersion, 2);
    assert.equal(fresh.prizeCoinUnit, 10);
    assert.equal(fresh.prizePoolMaxCoins, 8_000);
    assert.equal(fresh.payoutRoundingVersion, 1);
    assert.equal(
      fresh.participants.find((row) => row.userId === caller.user.id)?.buyInStatus,
      "NONE",
    );
    assert.equal(
      fresh.participants.find((row) => row.userId === invitee.user.id)?.status,
      "INVITED",
    );
    const users = await prisma.user.findMany({
      where: { id: { in: [caller.user.id, invitee.user.id] } },
      select: { id: true, coins: true },
    });
    assert.deepEqual(users.map((row) => row.coins), [500, 500]);
    assert.equal(await prisma.coinTransaction.count({
      where: { userId: caller.user.id },
    }), 0);
  });

  it("accepts 100-person rematches and rolls back every write for a 101-person cohort", async () => {
    const requester = await createTestUser({ displayName: "BoundedRematchCaller" });
    async function seedSource(name, count) {
      const race = await prisma.race.create({
        data: {
          creatorId: requester.user.id,
          name,
          targetSteps: 50_000,
          maxDurationDays: 2,
          status: "COMPLETED",
          completedAt: new Date(),
          maxParticipants: null,
        },
      });
      const others = Array.from({ length: count - 1 }, (_, index) => ({
        id: randomUUID(),
        appleId: `${name}-apple-${index}`,
        email: `${name}-${index}@example.com`,
        displayName: `${name}${index}`,
      }));
      await prisma.user.createMany({ data: others });
      await prisma.raceParticipant.createMany({
        data: [requester.user.id, ...others.map((row) => row.id)].map((userId) => ({
          raceId: race.id,
          userId,
          status: "ACCEPTED",
        })),
      });
      return race;
    }

    const boundary = await seedSource("BoundaryRoster", 100);
    const accepted = await request(
      server.baseUrl,
      "POST",
      `/races/${boundary.id}/rematch`,
      {
        token: requester.token,
        headers: { "Idempotency-Key": "b0000000-0000-4000-8000-00000000000b" },
        body: {},
      },
    );
    assert.equal(accepted.status, 201);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.invitedUserIds.length, 99);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { eventType: "RACE_INVITE_SENT_V1", aggregateId: acceptedBody.race.id },
    }), 99);
    await prisma.race.update({
      where: { id: acceptedBody.race.id },
      data: { status: "CANCELLED" },
    });

    const oversized = await seedSource("OversizedRoster", 101);
    const receiptsBefore = await prisma.raceRematchReceipt.count();
    const racesBefore = await prisma.race.count();
    const eventsBefore = await prisma.domainEventOutbox.count();
    const rejected = await request(
      server.baseUrl,
      "POST",
      `/races/${oversized.id}/rematch`,
      {
        token: requester.token,
        headers: { "Idempotency-Key": "c0000000-0000-4000-8000-00000000000c" },
        body: {},
      },
    );
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "REMATCH_COHORT_TOO_LARGE");
    assert.equal(await prisma.raceRematchReceipt.count(), receiptsBefore);
    assert.equal(await prisma.race.count(), racesBefore);
    assert.equal(await prisma.domainEventOutbox.count(), eventsBefore);
  });

  it("rejects completed quick races as non-custom rematch sources", async () => {
    const participant = await createTestUser({ displayName: "QuickRaceWalker" });
    const source = await prisma.race.create({
      data: {
        creatorId: participant.user.id,
        name: "Completed quick race",
        targetSteps: 50_000,
        maxDurationDays: 2,
        status: "COMPLETED",
        completedAt: new Date(),
        maxParticipants: 10,
        creationSource: "NEXT_RACE_CTA",
        startPolicy: "AUTO_WHEN_READY",
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: source.id,
        userId: participant.user.id,
        status: "ACCEPTED",
      },
    });

    const detail = await request(
      server.baseUrl,
      "GET",
      `/races/${source.id}`,
      { token: participant.token },
    );
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).rematchEligible, false);

    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${source.id}/rematch`,
      {
        token: participant.token,
        headers: { "Idempotency-Key": "50000000-0000-4000-8000-000000000005" },
        body: {},
      },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "SOURCE_NOT_REMATCHABLE");
  });

  it("serializes participant opt-out behind renewal and excludes them from the following occurrence", async () => {
    const creator = await createTestUser({ displayName: "OptOutRaceCreator" });
    const member = await createTestUser({ displayName: "OptOutRaceMember" });
    const created = await createRace(
      creator,
      { recurringSeries: true, powerupsEnabled: false },
      {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": "60000000-0000-4000-8000-000000000006",
      },
    );
    assert.equal(created.response.status, 201);
    const first = created.body;
    await prisma.raceParticipant.create({
      data: {
        raceId: first.race.id,
        userId: member.user.id,
        status: "ACCEPTED",
      },
    });
    await prisma.raceSeriesSubscription.create({
      data: { seriesId: first.series.id, userId: member.user.id, active: true },
    });
    const settledAt = new Date();
    await prisma.race.update({
      where: { id: first.race.id },
      data: { status: "COMPLETED", completedAt: settledAt, settlementCompletedAt: settledAt },
    });
    await prisma.raceSeriesRenewalJob.create({ data: { predecessorId: first.race.id } });

    const releaseGuard = await holdFundedExposureGuard(creator.user.id);
    const renewal = processRaceSeriesRenewals();
    await waitForSeriesRowLock(first.series.id);
    const optOutResponse = request(
      server.baseUrl,
      "PUT",
      `/race-series/${first.series.id}/subscription`,
      { token: member.token, body: { active: false } },
    );
    const optOutStateWhileRenewalLocked = await Promise.race([
      optOutResponse.then(() => "settled"),
      delay(100).then(() => "pending"),
    ]);
    await releaseGuard();
    await renewal;
    const response = await optOutResponse;
    assert.equal(
      optOutStateWhileRenewalLocked,
      "pending",
      "opt-out must wait for the renewal's canonical series lock",
    );
    assert.equal(response.status, 200);
    const seriesAfterFirstRenewal = await prisma.raceSeries.findUnique({
      where: { id: first.series.id },
    });
    assert.equal((await response.json()).effectiveAfterRaceId, seriesAfterFirstRenewal.currentRaceId);

    const secondSettledAt = new Date();
    await prisma.race.update({
      where: { id: seriesAfterFirstRenewal.currentRaceId },
      data: {
        status: "COMPLETED",
        completedAt: secondSettledAt,
        settlementCompletedAt: secondSettledAt,
      },
    });
    await prisma.raceSeriesRenewalJob.create({
      data: { predecessorId: seriesAfterFirstRenewal.currentRaceId },
    });
    await processRaceSeriesRenewals();
    const finalSeries = await prisma.raceSeries.findUnique({
      where: { id: first.series.id },
    });
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId: finalSeries.currentRaceId, userId: member.user.id },
      }),
      0,
    );
  });

  it("serializes creator stop behind renewal and reports the actual final occurrence", async () => {
    const creator = await createTestUser({ displayName: "StoppingRaceCreator" });
    const created = await createRace(
      creator,
      { recurringSeries: true, powerupsEnabled: false },
      {
        "X-Client-Features": "recurring_races_v1",
        "Idempotency-Key": "70000000-0000-4000-8000-000000000007",
      },
    );
    assert.equal(created.response.status, 201);
    const first = created.body;
    const settledAt = new Date();
    await prisma.race.update({
      where: { id: first.race.id },
      data: { status: "COMPLETED", completedAt: settledAt, settlementCompletedAt: settledAt },
    });
    await prisma.raceSeriesRenewalJob.create({ data: { predecessorId: first.race.id } });

    const releaseGuard = await holdFundedExposureGuard(creator.user.id);
    const renewal = processRaceSeriesRenewals();
    await waitForSeriesRowLock(first.series.id);
    const stopResponse = request(
      server.baseUrl,
      "PUT",
      `/race-series/${first.series.id}`,
      { token: creator.token, body: { enabled: false } },
    );
    const stopStateWhileRenewalLocked = await Promise.race([
      stopResponse.then(() => "settled"),
      delay(100).then(() => "pending"),
    ]);
    await releaseGuard();
    await renewal;
    const response = await stopResponse;
    assert.equal(
      stopStateWhileRenewalLocked,
      "pending",
      "creator stop must wait for the renewal's canonical series lock",
    );
    assert.equal(response.status, 200);
    const stopped = await response.json();
    const series = await prisma.raceSeries.findUnique({ where: { id: first.series.id } });
    assert.equal(stopped.effectiveAfterRaceId, series.currentRaceId);
    assert.equal(series.enabled, false);
    assert.equal(
      await prisma.raceSeriesSubscription.count({
        where: { seriesId: series.id, active: true },
      }),
      0,
    );
  });
});
