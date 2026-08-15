const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
  startServer,
} = require("./setup");
const {
  appSettings,
  KNOWN_FLAGS,
} = require("../../src/shared/config/appSettings");

const CLEANUP_FLAGS = [
  "apiRaceBootstrapV1Enabled",
  "apiRaceProgressCompactV1Enabled",
  "apiRaceMessageStreamsV1Enabled",
  "apiFriendsSummaryV1Enabled",
  "apiAuthShellV1Enabled",
  "apiHomeShellV1Enabled",
  "apiGetCoinsV1Enabled",
  "apiPublicRaceBrowserV1Enabled",
  "apiRankedV2CompactV1Enabled",
  "apiProfileStatsV1Enabled",
  "apiShopBootstrapV1Enabled",
  "apiStaticEtagsV1Enabled",
  "apiTournamentDetailV1Enabled",
  "apiRaceChatWatermarkCacheV1Enabled",
  "raceResolutionDisplayArtifactReuseV1Enabled",
  "raceResolutionReasonAwareV1Enabled",
  "raceResolutionBurstCoalescingV1Enabled",
  "raceResolutionBulkWriteV1Enabled",
  "raceResolutionPostTasksV1Enabled",
];

const CAPABLE_HEADERS = {
  "X-App-Version": "99.0.0",
  "X-Client-Features": [
    "ads",
    "characters",
    "home_active_races",
    "home_persisted_totals",
    "hitchhike_effective_steps",
    "powerups2",
    "powerups3",
    "powerups4",
    "powerups5",
    "remote_assets",
    "team_races",
    "tournaments",
  ].join(","),
  "X-Release-Channel": "prod",
  "X-Timezone": "UTC",
};

let server;

async function setCleanupFlags(value) {
  for (const key of CLEANUP_FLAGS) {
    await appSettings.setFlag(key, value);
  }
}

async function json(response) {
  return response.json();
}

async function get(path, token, headers = CAPABLE_HEADERS) {
  return request(server.baseUrl, "GET", path, { token, headers });
}

async function createRace(token, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token,
    headers: CAPABLE_HEADERS,
    body: {
      name: "Contract Lock Race",
      targetSteps: 50000,
      maxDurationDays: 7,
      powerupsEnabled: false,
      isPublic: true,
      ...overrides,
    },
  });
  assert.equal(response.status, 201);
  return (await json(response)).race;
}

async function seedLargeActiveRace({ creator, size = 30, powerupsEnabled = false }) {
  // A race defaults to maxParticipants=10 (schema default, echoed by
  // createRace.js), so a paging fixture MUST ask for the capacity it seeds or
  // the 10th join answers 400 "This race is full". The create-time ceiling is
  // 100, which bounds how large a page fixture can legally get.
  const race = await createRace(creator.token, {
    maxParticipants: size,
    powerupsEnabled,
  });
  const joiners = [];
  for (let index = 0; index < size - 1; index += 1) {
    const user = await createTestUser({ displayName: `Race Joiner ${index + 1}` });
    const join = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/join`,
      { token: user.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(join.status, 201);
    joiners.push(user.user);
  }

  const start = await request(
    server.baseUrl,
    "POST",
    `/races/${race.id}/start`,
    { token: creator.token, headers: CAPABLE_HEADERS }
  );
  assert.equal(start.status, 200);
  return { race, joiners };
}

describe("API page-payload cleanup — locked additive contracts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.appSetting.deleteMany({
      where: { key: { in: CLEANUP_FLAGS } },
    });
    appSettings.bustCache();
  });

  after(async () => {
    await setCleanupFlags(false);
  });

  it("declares all nineteen rollout flags with strict false defaults", async () => {
    assert.equal(CLEANUP_FLAGS.length, 19);
    for (const key of CLEANUP_FLAGS) {
      assert.equal(KNOWN_FLAGS[key], false, `${key} must be declared default-false`);
      assert.equal(await appSettings.getFlag(key), false, `${key} missing-row default`);
    }
  });

  it("keeps frozen-client responses legacy and returns 404 only for disabled new endpoints", async () => {
    const { token } = await createTestUser({ displayName: "Frozen Client" });
    const race = await createRace(token);

    const legacyRace = await get(`/races/${race.id}`, token, {});
    assert.equal(legacyRace.status, 200);
    assert.equal(Object.hasOwn(await json(legacyRace), "contract"), false);

    const unknownProgress = await get(
      `/races/${race.id}/progress?view=unknown-v1`,
      token,
      {}
    );
    assert.equal(unknownProgress.status, 200);
    assert.equal(Object.hasOwn(await json(unknownProgress), "contract"), false);

    const legacyFriends = await get("/friends", token, {});
    assert.equal(legacyFriends.status, 200);
    assert.deepEqual(Object.keys(await json(legacyFriends)).sort(), ["friends", "pending"]);

    const bootstrap = await get(`/races/${race.id}/bootstrap`, token);
    assert.equal(bootstrap.status, 404);
    const streams = await get(`/races/${race.id}/message-streams`, token);
    assert.equal(streams.status, 404);
    const shop = await get("/shop/bootstrap", token);
    assert.equal(shop.status, 404);
  });

  it("serves exact compact auth, friends, ranked, profile, daily-reward and static contracts", async () => {
    const { user, token } = await createTestUser({
      displayName: "Compact Client",
      email: "compact@example.com",
      coins: 123,
    });
    await setCleanupFlags(true);

    const meLegacyResponse = await get("/auth/me", token);
    assert.equal(meLegacyResponse.status, 200);
    const meLegacy = await json(meLegacyResponse);
    assert.equal(Object.hasOwn(meLegacy, "contract"), false);

    const meResponse = await get("/auth/me?view=shell-v1", token);
    assert.equal(meResponse.status, 200);
    const me = await json(meResponse);
    assert.equal(me.contract, "auth-shell-v1");
    assert.deepEqual(Object.keys(me).sort(), ["contract", "user"]);
    assert.deepEqual(Object.keys(me.user).sort(), [
      "autoJoinFeaturedRaces",
      "characterPowersEnabled",
      "coins",
      "displayName",
      "email",
      "featureFlags",
      "firstName",
      "firstRaceOnboardingSeen",
      "heldCoins",
      "hiddenFromLeaderboard",
      "id",
      "incomingFriendRequests",
      "isAdmin",
      "lastName",
      "nameSetupCompletedAt",
      "nameSetupOnboardingRequired",
      "profilePhotoPromptDismissedAt",
      "profilePhotoUrl",
      "referredByCode",
      "renameChipDismissedAt",
      "renameChipShownCount",
      "tutorialOnboardingSeen",
    ]);
    assert.equal(me.user.id, user.id);
    assert.equal(me.user.email, "compact@example.com");
    assert.equal(me.user.coins, 123);

    const sessionResponse = await get("/auth/session?view=shell-v1", token);
    assert.equal(sessionResponse.status, 200);
    const session = await json(sessionResponse);
    assert.equal(session.contract, "auth-shell-v1");
    assert.equal(typeof session.sessionToken, "string");
    assert.deepEqual(session.user, me.user);

    const friendsResponse = await get("/friends?view=summary-v1", token);
    assert.equal(friendsResponse.status, 200);
    assert.deepEqual(await json(friendsResponse), {
      contract: "friends-summary-v1",
      incomingFriendRequests: 0,
      friends: [],
      pending: { incoming: [], outgoing: [] },
    });

    const rankedResponse = await get("/ranked/v2?view=compact-v1", token);
    assert.equal(rankedResponse.status, 200);
    const ranked = await json(rankedResponse);
    assert.equal(ranked.contract, "ranked-v2-compact-v1");
    for (const cohort of ranked.cohorts || []) {
      for (const member of cohort.members || []) {
        assert.equal(Object.hasOwn(member, "equippedAccessories"), false);
      }
    }

    const statsResponse = await get("/steps/stats?view=profile-v1", token);
    assert.equal(statsResponse.status, 200);
    assert.deepEqual(Object.keys(await json(statsResponse)).sort(), [
      "allTime",
      "avgPerDayMonth",
      "avgPerDayWeek",
      "avgPerDayYear",
      "contract",
      "streak",
      "thisMonth",
      "thisWeek",
      "thisYear",
    ]);

    const rewardResponse = await get(
      "/daily-reward/status?view=get-coins-v1&localDate=2026-08-13",
      token
    );
    assert.equal(rewardResponse.status, 200);
    const reward = await json(rewardResponse);
    assert.equal(reward.contract, "get-coins-v1");
    assert.deepEqual(Object.keys(reward.referralRewards).sort(), [
      "refereeCoins",
      "referrerCoins",
    ]);

    for (const [path, vary] of [
      ["/app-version/policy", "X-App-Version"],
      ["/powerups/catalog", "X-Client-Features"],
    ]) {
      const first = await get(path, null);
      assert.equal(first.status, 200);
      const etag = first.headers.get("etag");
      assert.match(etag, /^"[a-f0-9]{64}"$/);
      assert.match(first.headers.get("vary") || "", new RegExp(vary, "i"));
      const second = await get(path, null, {
        ...CAPABLE_HEADERS,
        "If-None-Match": `W/${etag}, "not-a-match"`,
      });
      assert.equal(second.status, 304);
      assert.equal(await second.text(), "");
    }
  });

  it("serves exact race bootstrap, compact progress and message-stream contracts", async () => {
    const { token } = await createTestUser({ displayName: "Race Contract" });
    const race = await createRace(token);
    await setCleanupFlags(true);

    const detailResponse = await get(`/races/${race.id}`, token);
    const detail = await json(detailResponse);
    const bootstrapResponse = await get(`/races/${race.id}/bootstrap`, token);
    assert.equal(bootstrapResponse.status, 200);
    assert.deepEqual(await json(bootstrapResponse), {
      contract: "race-bootstrap-v1",
      race: detail,
      progress: null,
      progressError: null,
      globalPowerupInventory: null,
    });

    const streamsResponse = await get(
      `/races/${race.id}/message-streams?limit=0&includeUser=false&cursor=ignored`,
      token
    );
    assert.equal(streamsResponse.status, 200);
    const streams = await json(streamsResponse);
    assert.deepEqual(streams.requested, { USER: false, SYSTEM: true });
    assert.deepEqual(streams.resolved, { USER: false, SYSTEM: true });
    assert.equal(streams.streams.USER, null);
    assert.deepEqual(streams.streams.SYSTEM, { messages: [], nextCursor: null });
    assert.deepEqual(streams.chatWatermark, {
      latestId: null,
      latestAt: null,
      recentIds: [],
    });
    assert.deepEqual(streams.errors, { USER: null, SYSTEM: null });
    assert.equal(streams.watermarkError, null);

    const second = await createTestUser({ displayName: "Race Contract Two" });
    const join = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/join`,
      { token: second.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(join.status, 201);
    await prisma.raceResolutionJobV2.deleteMany({ where: { raceId: race.id } });
    const start = await request(server.baseUrl, "POST", `/races/${race.id}/start`, {
      token,
      headers: CAPABLE_HEADERS,
    });
    assert.equal(start.status, 200);
    const startJob = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.deepEqual(startJob.dirtyReasons, ["RACE_START"]);
    assert.equal(startJob.generation, 1);
    const legacyProgressResponse = await get(`/races/${race.id}/progress`, token);
    const legacyProgress = await json(legacyProgressResponse);
    const compactResponse = await get(
      `/races/${race.id}/progress?view=compact-v1`,
      token
    );
    assert.equal(compactResponse.status, 200);
    const compact = await json(compactResponse);
    assert.equal(compact.contract, "race-progress-compact-v1");
    assert.deepEqual(compact.progress, legacyProgress.progress);
    assert.ok(
      compact.globalPowerupInventory === null ||
        Array.isArray(compact.globalPowerupInventory.items)
    );
  });

  it("supports participants-v1 paged progress on large ACTIVE races", async () => {
    const creator = await createTestUser({ displayName: "Paged Viewer" });
    const { race } = await seedLargeActiveRace({
      creator,
      size: 24,
    });

    const firstPageResponse = await get(
      `/races/${race.id}/progress?view=participants-v1`,
      creator.token
    );
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await json(firstPageResponse);
    const firstProgress = firstPage.progress;
    assert.equal(Array.isArray(firstProgress?.participants), true);
    assert.equal(firstProgress.participants.length, 10);
    assert.equal(firstProgress.pagination?.offset, 0);
    assert.equal(firstProgress.pagination?.limit, 10);
    assert.equal(firstProgress.pagination?.hasMore, true);
    assert.equal(firstProgress.pagination?.nextOffset, 10);
    assert.equal(firstProgress.pagination?.total, 24);
    assert.equal(firstProgress.powerupData, null);
    assert.equal(firstProgress.globalEvent, null);

    const secondPageResponse = await get(
      `/races/${race.id}/progress?view=participants-v1&offset=10&limit=8`,
      creator.token
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await json(secondPageResponse);
    const secondProgress = secondPage.progress;
    assert.equal(secondProgress.participants.length, 8);
    assert.equal(secondProgress.pagination.offset, 10);
    assert.equal(secondProgress.pagination.limit, 8);
    assert.equal(secondProgress.pagination.hasMore, true);
    assert.equal(secondProgress.pagination.nextOffset, 18);

    const fullResponse = await get(`/races/${race.id}/progress`, creator.token);
    const fullProgress = await json(fullResponse);
    const expected = (fullProgress.progress.participants || []).map(
      (participant) => participant.userId
    );
    const first = firstProgress.participants.map((participant) => participant.userId);
    assert.deepEqual(first, expected.slice(0, 10));
    const second = secondProgress.participants.map((participant) => participant.userId);
    assert.deepEqual(second, expected.slice(10, 18));
  });

  it("pages the race-open bootstrap packet while keeping powerupData", async () => {
    // The bootstrap route 404s unless its capable-client flag is on; the
    // default in beforeEach is off so the legacy path stays covered.
    await setCleanupFlags(true);
    const creator = await createTestUser({ displayName: "Bootstrap Pager" });
    const { race } = await seedLargeActiveRace({
      creator,
      size: 24,
      powerupsEnabled: true,
    });

    // No paging query => the whole field, exactly as every shipped build sees.
    const fullResponse = await get(
      `/races/${race.id}/bootstrap`,
      creator.token
    );
    assert.equal(fullResponse.status, 200);
    const full = await json(fullResponse);
    assert.equal(full.contract, "race-bootstrap-v1");
    assert.equal(full.progress.participants.length, 24);
    assert.equal(full.progress.pagination, undefined);

    // Paging query => first page only, but powerupData/globalEvent SURVIVE.
    // That is the whole difference from participants-v1: this payload is what
    // renders the powerup rail on first paint, so blanking it would page the
    // list at the cost of the powerup UI.
    const pagedResponse = await get(
      `/races/${race.id}/bootstrap?view=participants-v1&offset=0&limit=10`,
      creator.token
    );
    assert.equal(pagedResponse.status, 200);
    const paged = await json(pagedResponse);
    assert.equal(paged.contract, "race-bootstrap-v1");
    assert.equal(paged.progress.participants.length, 10);
    assert.equal(paged.progress.pagination.total, 24);
    assert.equal(paged.progress.pagination.hasMore, true);
    assert.equal(paged.progress.pagination.nextOffset, 10);
    assert.notEqual(paged.progress.powerupData, null);
    assert.equal(paged.progress.powerupData.enabled, true);

    // The paged page is the same leaderboard prefix, not a different ordering.
    const expected = full.progress.participants
      .slice(0, 10)
      .map((p) => p.userId);
    assert.deepEqual(
      paged.progress.participants.map((p) => p.userId),
      expected
    );
  });

  it("returns full participant context for powerup use actions", async () => {
    const creator = await createTestUser({
      displayName: "Use-Context Creator",
    });
    const { race } = await seedLargeActiveRace({
      creator,
      size: 12,
      // use-context is a POWERUP endpoint: its gate reads `powerupData.enabled`,
      // which a powerups-disabled race legitimately reports false, answering 403.
      // The targeting contract only means anything on a powerup-enabled race.
      powerupsEnabled: true,
    });
    const contextResponse = await get(
      `/races/${race.id}/powerups/use-context`,
      creator.token
    );
    assert.equal(contextResponse.status, 200);
    const context = await json(contextResponse);
    assert.equal(context.contract, "race-powerup-use-context-v1");
    assert.equal(Array.isArray(context.participants), true);
    assert.equal(context.participants.length, 12);
    // Every seeded participant has zero steps, so which of them lands in slot 1
    // is a tie-break detail, not part of this contract. What §5.3 promises is
    // that the picker receives the viewer's placement at all — pin that.
    assert.equal(Number.isInteger(context.powerupData?.myPlacement), true);
    assert.equal(
      context.powerupData.myPlacement >= 1 &&
        context.powerupData.myPlacement <= 12,
      true
    );
    assert.equal(context.powerupData?.powerupSlots >= 3, true);
    assert.equal(context.powerupData?.queuedBoxCount >= 0, true);
    assert.equal(Array.isArray(context.powerupData?.inventory), true);

    const nonParticipant = await createTestUser({
      displayName: "Use-Context Spectator",
    });
    const denied = await get(
      `/races/${race.id}/powerups/use-context`,
      nonParticipant.token
    );
    assert.equal(denied.status, 403);
  });

  it("builds bootstrap detail after active progress reconciliation completes the race", async () => {
    const { token } = await createTestUser({ displayName: "Bootstrap Fence" });
    const race = await createRace(token);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        status: "ACTIVE",
        startedAt: new Date("2026-08-13T10:00:00.000Z"),
        endsAt: new Date("2026-08-14T10:00:00.000Z"),
      },
    });
    await setCleanupFlags(true);
    const reconciliationServer = await startServer({
      getRaceProgress: async (_userId, raceId) => {
        await prisma.race.update({
          where: { id: raceId },
          data: { status: "COMPLETED", completedAt: new Date("2026-08-14T12:00:00.000Z") },
        });
        return { raceId, status: "COMPLETED", participants: [] };
      },
    });
    try {
      const response = await request(
        reconciliationServer.baseUrl,
        "GET",
        `/races/${race.id}/bootstrap`,
        { token, headers: CAPABLE_HEADERS }
      );
      assert.equal(response.status, 200);
      const body = await json(response);
      assert.equal(body.race.status, "COMPLETED");
      assert.equal(body.progress.status, "COMPLETED");
    } finally {
      await reconciliationServer.close();
    }
  });

  it("serves compact Home, public browser, Shop bootstrap and tournament detail", async () => {
    const { token } = await createTestUser({ displayName: "Shell Contract" });
    await setCleanupFlags(true);

    const homeResponse = await get(
      "/home/race-card?view=shell-v1&homeActiveRaces=1&localDate=2026-08-13",
      token
    );
    assert.equal(homeResponse.status, 200);
    const home = await json(homeResponse);
    assert.equal(home.contract, "home-shell-v1");
    assert.deepEqual(Object.keys(home.resolved).sort(), ["friends", "presentation"]);

    const browserResponse = await get("/races/public?view=browser-v1", token);
    assert.equal(browserResponse.status, 200);
    const browser = await json(browserResponse);
    assert.equal(browser.contract, "public-race-browser-v1");
    assert.deepEqual(Object.keys(browser.resolved).sort(), [
      "featuredRaces",
      "mine",
      "tournaments",
    ]);
    assert.deepEqual(Object.keys(browser.tournaments).sort(), [
      "featured",
      "mine",
      "public",
    ]);

    const shopResponse = await get(
      "/shop/bootstrap?localDate=2026-08-13",
      token
    );
    assert.equal(shopResponse.status, 200);
    const shop = await json(shopResponse);
    assert.equal(shop.contract, "shop-bootstrap-v1");
    assert.deepEqual(Object.keys(shop.resolved).sort(), ["inventory", "powerups"]);

    const createResponse = await request(server.baseUrl, "POST", "/tournaments", {
      token,
      headers: CAPABLE_HEADERS,
      body: {
        name: "Contract Cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        powerupsEnabled: false,
        isPublic: true,
        inviteeIds: [],
      },
    });
    assert.equal(createResponse.status, 201);
    const tournamentId = (await json(createResponse)).tournament.id;
    const tournamentResponse = await get(
      `/tournaments/${tournamentId}?view=detail-v1`,
      token
    );
    assert.equal(tournamentResponse.status, 200);
    const tournament = await json(tournamentResponse);
    assert.deepEqual(Object.keys(tournament).sort(), ["contract", "tournament"]);
    assert.equal(tournament.contract, "tournament-detail-v1");
    for (const participant of tournament.tournament.participants) {
      assert.equal(Object.hasOwn(participant, "animal"), false);
      assert.equal(Object.hasOwn(participant, "accessories"), false);
    }
  });

  it("returns authoritative compact tournament action envelopes without follow-up deep payloads", async () => {
    const creator = await createTestUser({
      displayName: "Action Creator",
      clientFeatures: ["tournaments"],
    });
    const joiner = await createTestUser({
      displayName: "Action Joiner",
      clientFeatures: ["tournaments"],
    });
    const invitee = await createTestUser({
      displayName: "Action Invitee",
      clientFeatures: ["tournaments"],
    });
    await setCleanupFlags(true);

    const create = await request(server.baseUrl, "POST", "/tournaments", {
      token: creator.token,
      headers: CAPABLE_HEADERS,
      body: {
        name: "Action Contract Cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        powerupsEnabled: false,
        isPublic: true,
        inviteeIds: [],
      },
    });
    assert.equal(create.status, 201);
    const tournamentId = (await json(create)).tournament.id;

    const joined = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/join?view=detail-v1`,
      { token: joiner.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(joined.status, 201);
    const joinBody = await json(joined);
    assert.deepEqual(Object.keys(joinBody), [
      "contract",
      "tournament",
      "projectionError",
      "wallet",
      "walletError",
    ]);
    assert.equal(joinBody.contract, "tournament-action-v1");
    assert.deepEqual(joinBody.wallet, { coins: 0, heldCoins: 0 });
    assert.equal(joinBody.projectionError, null);
    assert.equal(joinBody.walletError, null);

    const kicked = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/kick?view=detail-v1`,
      {
        token: creator.token,
        headers: CAPABLE_HEADERS,
        body: { userId: joiner.user.id },
      }
    );
    assert.equal(kicked.status, 200);
    assert.deepEqual(Object.keys(await json(kicked)), [
      "contract",
      "tournament",
      "projectionError",
    ]);

    await prisma.friendship.create({
      data: {
        requesterId: creator.user.id,
        addresseeId: invitee.user.id,
        status: "ACCEPTED",
      },
    });
    const invited = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/invite?view=detail-v1`,
      {
        token: creator.token,
        headers: CAPABLE_HEADERS,
        body: { userIds: [invitee.user.id] },
      }
    );
    assert.equal(invited.status, 200);
    const inviteBody = await json(invited);
    assert.deepEqual(Object.keys(inviteBody), [
      "contract",
      "tournament",
      "projectionError",
      "invited",
      "needsUpdate",
    ]);
    assert.deepEqual(inviteBody.invited, [invitee.user.id]);

    const declined = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournamentId}/respond?view=detail-v1`,
      {
        token: invitee.token,
        headers: CAPABLE_HEADERS,
        body: { accept: false },
      }
    );
    assert.equal(declined.status, 200);
    assert.deepEqual(Object.keys(await json(declined)), [
      "contract",
      "wallet",
      "walletError",
    ]);

    const cancelled = await request(
      server.baseUrl,
      "DELETE",
      `/tournaments/${tournamentId}?view=detail-v1`,
      { token: creator.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(cancelled.status, 200);
    const cancelBody = await json(cancelled);
    assert.deepEqual(Object.keys(cancelBody), [
      "contract",
      "success",
      "wallet",
      "walletError",
    ]);
    assert.equal(cancelBody.success, true);
  });

  it("covers compact share-join, accept, leave, start, and forfeit action branches", async () => {
    const creator = await createTestUser({
      displayName: "Branch Creator",
      clientFeatures: ["tournaments"],
    });
    const racers = await Promise.all(
      ["One", "Two", "Three", "Four"].map((name) =>
        createTestUser({
          displayName: `Branch ${name}`,
          clientFeatures: ["tournaments"],
        })
      )
    );
    await setCleanupFlags(true);
    const create = await request(server.baseUrl, "POST", "/tournaments", {
      token: creator.token,
      headers: CAPABLE_HEADERS,
      body: {
        name: "Branch Contract Cup",
        bracketSize: 4,
        matchupDurationDays: 1,
        buyInAmount: 0,
        powerupsEnabled: false,
        isPublic: true,
        inviteeIds: [],
      },
    });
    const tournamentId = (await json(create)).tournament.id;

    const share = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/share-link`,
      { token: creator.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(share.status, 201);
    const shareToken = (await json(share)).shareToken;
    const shareJoin = await request(
      server.baseUrl,
      "POST",
      `/tournaments/share/${shareToken}/join?view=detail-v1`,
      { token: racers[0].token, headers: CAPABLE_HEADERS }
    );
    assert.equal(shareJoin.status, 201);
    assert.deepEqual(Object.keys(await json(shareJoin)), [
      "contract", "tournament", "projectionError", "wallet", "walletError",
    ]);

    const leave = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/leave?view=detail-v1`,
      { token: racers[0].token, headers: CAPABLE_HEADERS }
    );
    assert.equal(leave.status, 200);
    assert.deepEqual(Object.keys(await json(leave)), [
      "contract", "wallet", "walletError",
    ]);

    await prisma.friendship.create({
      data: {
        requesterId: creator.user.id,
        addresseeId: racers[0].user.id,
        status: "ACCEPTED",
      },
    });
    const invite = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/invite?view=detail-v1`,
      {
        token: creator.token,
        headers: CAPABLE_HEADERS,
        body: { userIds: [racers[0].user.id] },
      }
    );
    assert.equal(invite.status, 200);
    const accept = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${tournamentId}/respond?view=detail-v1`,
      {
        token: racers[0].token,
        headers: CAPABLE_HEADERS,
        body: { accept: true },
      }
    );
    assert.equal(accept.status, 200);
    assert.deepEqual(Object.keys(await json(accept)), [
      "contract", "tournament", "projectionError", "wallet", "walletError",
    ]);

    // Fixture the final two accepted slots directly so the manual-start branch
    // itself remains the behavior under test (normal public joining auto-starts
    // when it fills the bracket).
    await prisma.tournamentParticipant.createMany({
      data: racers.slice(1, 3).map((racer) => ({
        tournamentId,
        userId: racer.user.id,
        status: "ACCEPTED",
      })),
    });
    const start = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/start?view=detail-v1`,
      { token: creator.token, headers: CAPABLE_HEADERS }
    );
    assert.equal(start.status, 200);
    assert.deepEqual(Object.keys(await json(start)), [
      "contract", "tournament", "projectionError",
    ]);
    const matchupRaces = await prisma.race.findMany({
      where: { tournamentId, tournamentRound: 1 },
      select: { id: true },
    });
    const startJobs = await prisma.raceResolutionJobV2.findMany({
      where: { raceId: { in: matchupRaces.map((race) => race.id) } },
    });
    assert.equal(startJobs.length, matchupRaces.length);
    assert.ok(startJobs.every(
      (job) => job.generation === 1 &&
        JSON.stringify(job.dirtyReasons) === JSON.stringify(["RACE_START"])
    ));

    const forfeit = await request(
      server.baseUrl,
      "POST",
      `/tournaments/${tournamentId}/forfeit?view=detail-v1`,
      { token: racers[0].token, headers: CAPABLE_HEADERS }
    );
    assert.equal(forfeit.status, 200);
    assert.deepEqual(Object.keys(await json(forfeit)), [
      "contract", "tournament", "projectionError",
    ]);
  });
});
