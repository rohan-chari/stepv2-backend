const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");
const IORedis = require("ioredis");

const ENV_PREFIX = "completed-summary:";
process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
delete process.env.REDIS_URL;

const { startTestRedis, TEST_DB } = require("./redisTestServer");
const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");
const redisCache = require("../../src/shared/cache/redisCache");
const derivedCache = require("../../src/shared/cache/derivedCache");
const {
  completedRaceSummaryCache,
} = require("../../src/modules/races/services/completedRaceSummaryCache");
const {
  buildCompleteRace,
} = require("../../src/modules/races/commands/completeRace");
const { Race } = require("../../src/modules/races/models/race");
const {
  RaceParticipant,
} = require("../../src/modules/races/models/raceParticipant");
const { appSettings } = require("../../src/shared/config/appSettings");

const HEADERS = {
  "X-Client-Features":
    "characters,remote_assets,api_payload_compact_v1,race_participants_paging," +
    "team_races,tournaments,powerups3,powerups4,powerups5",
};

let server;
let live;
let probe;
let skipReason;
let completedRankingLoads = 0;

async function enableRedis() {
  process.env.REDIS_URL = live.url;
  process.env.CACHE_ENV_PREFIX = ENV_PREFIX;
  await redisCache.close();
  derivedCache.reset();
  probe ||= new IORedis(live.url);
  await probe.flushdb();
}

async function disableRedis() {
  delete process.env.REDIS_URL;
  await redisCache.close();
  derivedCache.reset();
}

before(async () => {
  server = await startServer({
    completedRaceSummaryCache: {
      getMany(args) {
        return completedRaceSummaryCache.getMany({
          ...args,
          load: async (ids) => {
            completedRankingLoads += 1;
            return args.load(ids);
          },
        });
      },
    },
  });
  live = await startTestRedis();
  if (!live) skipReason = "no local Redis available";
});

beforeEach(async () => {
  await cleanDatabase();
  completedRankingLoads = 0;
  await appSettings.setFlag("redisCacheRaceListEnabled", true);
  await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
  await appSettings.setFlag("apiRaceListCompactV1Enabled", true);
});

after(async () => {
  await disableRedis();
  if (probe) await probe.quit().catch(() => {});
  if (live) await live.close();
  if (server) await server.close();
});

async function races(token) {
  const response = await request(server.baseUrl, "GET", "/races?view=compact-v1", {
    token,
    headers: HEADERS,
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function seedCompletedRace() {
  const alice = await createTestUser({ displayName: "Summary Alice" });
  const bob = await createTestUser({ displayName: "Summary Bob" });
  const created = await request(server.baseUrl, "POST", "/races", {
    token: alice.token,
    body: { name: "Completed summary parity", targetSteps: 1000, maxDurationDays: 7 },
  });
  assert.equal(created.status, 201);
  const raceId = (await created.json()).race.id;
  await prisma.raceParticipant.create({
    data: {
      raceId,
      userId: bob.user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-09-01T00:01:00.000Z"),
      totalSteps: 800,
      placement: 2,
      finishedAt: new Date("2026-09-01T01:01:00.000Z"),
    },
  });
  await prisma.raceParticipant.update({
    where: { raceId_userId: { raceId, userId: alice.user.id } },
    data: {
      status: "ACCEPTED",
      totalSteps: 1000,
      placement: 1,
      finishedAt: new Date("2026-09-01T01:00:00.000Z"),
    },
  });
  await prisma.race.update({
    where: { id: raceId },
    data: {
      status: "COMPLETED",
      completedAt: new Date("2026-09-01T01:01:00.000Z"),
      winnerUserId: alice.user.id,
    },
  });
  return { alice, bob, raceId };
}

async function seedActiveRace({ name, isTeamRace = false, tournament = null,
  payoutRoundingVersion = 0 } = {}) {
  const alice = await createTestUser({ displayName: `${name} Alice` });
  const bob = await createTestUser({ displayName: `${name} Bob` });
  const created = await request(server.baseUrl, "POST", "/races", {
    token: alice.token,
    body: { name, targetSteps: 1000, maxDurationDays: 7 },
  });
  assert.equal(created.status, 201);
  const raceId = (await created.json()).race.id;
  await prisma.raceParticipant.create({
    data: {
      raceId,
      userId: bob.user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-09-01T00:01:00.000Z"),
      totalSteps: 800,
      team: isTeamRace ? "TEAM_B" : null,
    },
  });
  await prisma.raceParticipant.update({
    where: { raceId_userId: { raceId, userId: alice.user.id } },
    data: {
      status: "ACCEPTED",
      totalSteps: 1000,
      team: isTeamRace ? "TEAM_A" : null,
    },
  });
  await prisma.race.update({
    where: { id: raceId },
    data: {
      status: "ACTIVE",
      startedAt: new Date("2026-09-01T00:00:00.000Z"),
      isTeamRace,
      teamSize: isTeamRace ? 1 : null,
      teamAName: isTeamRace ? "Fast A" : null,
      teamBName: isTeamRace ? "Fast B" : null,
      payoutRoundingVersion,
      ...(tournament ? {
        tournamentId: tournament.id,
        tournamentRound: 1,
        tournamentMatchIndex: 0,
      } : {}),
    },
  });
  if (tournament) {
    await prisma.tournamentParticipant.createMany({
      data: [alice, bob].map(({ user }, index) => ({
        tournamentId: tournament.id,
        userId: user.id,
        status: "ACCEPTED",
        seed: index,
        joinedAt: new Date(`2026-09-01T00:0${index}:00.000Z`),
      })),
    });
  }
  return { alice, bob, raceId };
}

describe("completed race shared summary Redis cache", () => {
  it("shares one viewer-free result across participants and preserves HTTP parity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    assert.equal(Number(probe.options.db), TEST_DB);

    const { alice, bob, raceId } = await seedCompletedRace();

    const cold = await races(alice.token);
    assert.equal(completedRankingLoads, 1, "cold request executes completed ranking SQL");
    const warmSameViewer = await races(alice.token);
    const warmOtherViewer = await races(bob.token);
    assert.equal(completedRankingLoads, 1,
      "warm requests do not execute completed ranking SQL again");
    assert.deepEqual(warmSameViewer, cold);
    assert.equal(cold.completed[0].id, raceId);
    assert.equal(warmOtherViewer.completed[0].id, raceId);
    assert.equal(cold.completed[0].myPlacement, 1);
    assert.equal(warmOtherViewer.completed[0].myPlacement, 2);

    const keys = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${raceId}:*`,
    );
    assert.equal(keys.length, 1, "both viewers reuse one shared result key");
    const payload = JSON.parse(await probe.get(keys[0]));
    for (const forbidden of [
      "viewerUserId", "viewerParticipantId", "viewerStatus", "viewerPlacement",
      "viewerFavoritedAt", "viewerBuyInStatus", "viewerPayoutCoins",
      "viewerResultsSeenAt", "viewerInviteExpiresAt", "viewerTeam",
      "viewerForfeitedAt", "viewerPosition", "rankRoster",
    ]) {
      assert.equal(Object.hasOwn(payload, forbidden), false, forbidden);
    }

    await disableRedis();
    const fallback = await races(alice.token);
    assert.deepEqual(fallback, cold);
  });

  it("preserves active/completed partition, completed ordering, and specialized race parity", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const alice = await createTestUser({ displayName: "Parity Alice" });
    const bob = await createTestUser({ displayName: "Parity Bob" });

    async function createRace(name) {
      const created = await request(server.baseUrl, "POST", "/races", {
        token: alice.token,
        body: { name, targetSteps: 1000, maxDurationDays: 7 },
      });
      assert.equal(created.status, 201);
      const raceId = (await created.json()).race.id;
      await prisma.raceParticipant.create({
        data: {
          raceId,
          userId: bob.user.id,
          status: "ACCEPTED",
          joinedAt: new Date("2026-09-01T00:01:00.000Z"),
          totalSteps: 800,
          placement: 2,
          finishedAt: new Date("2026-09-01T01:01:00.000Z"),
        },
      });
      await prisma.raceParticipant.update({
        where: { raceId_userId: { raceId, userId: alice.user.id } },
        data: {
          status: "ACCEPTED",
          totalSteps: 1000,
          placement: 1,
          finishedAt: new Date("2026-09-01T01:00:00.000Z"),
        },
      });
      return raceId;
    }

    const activeId = await createRace("Active partition");
    await prisma.race.update({
      where: { id: activeId },
      data: {
        status: "ACTIVE",
        startedAt: new Date("2026-09-01T00:00:00.000Z"),
        updatedAt: new Date("2026-09-01T05:00:00.000Z"),
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: activeId },
      data: { finishedAt: null, placement: null },
    });

    const ordinaryId = await createRace("Ordinary completed");
    await prisma.race.update({
      where: { id: ordinaryId },
      data: {
        status: "COMPLETED",
        completedAt: new Date("2026-09-01T01:00:00.000Z"),
        winnerUserId: alice.user.id,
        updatedAt: new Date("2026-09-01T02:00:00.000Z"),
      },
    });

    const powerupId = await createRace("Powerup completed");
    await prisma.race.update({
      where: { id: powerupId },
      data: {
        status: "COMPLETED",
        completedAt: new Date("2026-09-01T02:00:00.000Z"),
        winnerUserId: alice.user.id,
        powerupsEnabled: true,
        powerupStepInterval: 500,
        updatedAt: new Date("2026-09-01T03:00:00.000Z"),
      },
    });

    const teamId = await createRace("Team completed");
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: teamId, userId: alice.user.id } },
      data: { team: "TEAM_A", payoutCoins: 40 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: teamId, userId: bob.user.id } },
      data: {
        team: "TEAM_B",
        payoutCoins: 0,
        // A completed team tie deliberately shares persisted placement 1.
        // Re-ranking the roster would incorrectly turn Bob into position 2.
        placement: 1,
      },
    });
    await prisma.race.update({
      where: { id: teamId },
      data: {
        status: "COMPLETED",
        completedAt: new Date("2026-09-01T03:00:00.000Z"),
        isTeamRace: true,
        teamSize: 1,
        teamAName: "Fast A",
        teamBName: "Fast B",
        winnerUserId: null,
        winnerTeam: null,
        updatedAt: new Date("2026-09-01T04:00:00.000Z"),
      },
    });

    const tournament = await prisma.tournament.create({
      data: {
        creatorId: alice.user.id,
        name: "Hidden matchup",
        status: "COMPLETED",
        bracketSize: 4,
        totalRounds: 2,
        matchupDurationDays: 1,
        completedAt: new Date("2026-09-01T04:00:00.000Z"),
      },
    });
    const tournamentRaceId = await createRace("Tournament matchup");
    await prisma.race.update({
      where: { id: tournamentRaceId },
      data: {
        status: "COMPLETED",
        completedAt: new Date("2026-09-01T04:00:00.000Z"),
        winnerUserId: alice.user.id,
        tournamentId: tournament.id,
        tournamentRound: 2,
        tournamentMatchIndex: 0,
        updatedAt: new Date("2026-09-01T05:00:00.000Z"),
      },
    });

    await disableRedis();
    const uncached = await races(alice.token);
    const uncachedBob = await races(bob.token);
    assert.deepEqual(uncached.active.map((race) => race.id), [activeId]);
    assert.deepEqual(
      uncached.completed.map((race) => race.id),
      [teamId, powerupId, ordinaryId],
      "completed cards retain newest-first ordering and omit tournament matchups",
    );

    await enableRedis();
    completedRankingLoads = 0;
    const cold = await races(alice.token);
    const warm = await races(alice.token);
    const warmBob = await races(bob.token);
    assert.deepEqual(cold, uncached);
    assert.deepEqual(warm, uncached);
    assert.deepEqual(warmBob, uncachedBob);
    assert.equal(completedRankingLoads, 1);
    for (const [raceId, expectedAlice, expectedBob] of [
      [ordinaryId, 1, 2],
      [powerupId, 1, 2],
      [teamId, 1, 1],
    ]) {
      assert.equal(cold.completed.find((race) => race.id === raceId).myPlacement,
        expectedAlice);
      assert.equal(warmBob.completed.find((race) => race.id === raceId).myPlacement,
        expectedBob);
    }

    const legacyTournament = (await Race.findSummariesForUser(bob.user.id))
      .find((race) => race.id === tournamentRaceId);
    const cachedTournament = (await Race.findSqlSummariesForUser(bob.user.id))
      .races.find((race) => race.id === tournamentRaceId);
    assert.equal(
      cachedTournament.participants.find((participant) =>
        participant.userId === bob.user.id).placement,
      legacyTournament.participants.find((participant) =>
        participant.userId === bob.user.id).placement,
      "hidden tournament matchup keeps the authoritative viewer placement",
    );
    for (const raceId of [ordinaryId, powerupId, teamId, tournamentRaceId]) {
      const keys = await probe.keys(
        `${ENV_PREFIX}v1:race:completed-summary:${raceId}:*`,
      );
      assert.equal(keys.length, 1, `${raceId} has one shared summary`);
      const payload = JSON.parse(await probe.get(keys[0]));
      assert.equal(Object.hasOwn(payload, "rankRoster"), false,
        `${raceId} cache payload stays compact`);
    }
  });

  it("preserves the legacy HTTP fallback for ambiguous completed finishers", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { alice, raceId } = await seedCompletedRace();
    const tiedAt = new Date("2026-09-01T01:00:00.000Z");
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { placement: 1, finishedAt: tiedAt },
    });

    await disableRedis();
    await appSettings.setFlag("redisCacheRaceListEnabled", false);
    await appSettings.setFlag("raceListSqlSummaryV1Enabled", false);
    const legacy = await races(alice.token);

    await enableRedis();
    await appSettings.setFlag("redisCacheRaceListEnabled", true);
    await appSettings.setFlag("raceListSqlSummaryV1Enabled", true);
    completedRankingLoads = 0;
    const cold = await races(alice.token);
    const warm = await races(alice.token);
    assert.deepEqual(cold, legacy);
    assert.deepEqual(warm, legacy);
    assert.equal(completedRankingLoads, 1,
      "the cached ambiguity marker avoids repeating the ranking query");

    const keys = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${raceId}:*`,
    );
    assert.equal(keys.length, 1);
    const payload = JSON.parse(await probe.get(keys[0]));
    assert.equal(payload.ambiguousFinisherOrder, true);
    assert.equal(Object.hasOwn(payload, "rankRoster"), false);
  });

  it("returns the same HTTP result when Redis throws", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const { alice } = await seedCompletedRace();
    await disableRedis();
    const expected = await races(alice.token);
    await enableRedis();

    const originalGetManyJSON = redisCache.getManyJSON;
    redisCache.getManyJSON = async () => { throw new Error("simulated Redis outage"); };
    try {
      const fallback = await races(alice.token);
      assert.deepEqual(fallback, expected);
    } finally {
      redisCache.getManyJSON = originalGetManyJSON;
    }
  });

  it("advances result versions after normal, team, tournament, and recovery completion", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    const tournament = await prisma.tournament.create({
      data: {
        name: "Completion tournament",
        status: "ACTIVE",
        bracketSize: 4,
        totalRounds: 2,
        matchupDurationDays: 1,
        currentRound: 1,
      },
    });
    const normal = await seedActiveRace({
      name: "Normal version",
      payoutRoundingVersion: 1,
    });
    const team = await seedActiveRace({ name: "Team version", isTeamRace: true });
    const matchup = await seedActiveRace({ name: "Tournament version", tournament });
    const completeRace = buildCompleteRace({
      prisma,
      Race,
      RaceParticipant,
      awardCoins: async () => ({ awarded: false }),
      grantReferralRewardsForRace: async () => [],
      appendDomainEvent: async () => null,
      createReviewOpportunity: async () => null,
      advanceTournament: async () => null,
    });

    async function version(raceId) {
      return (await prisma.race.findUnique({
        where: { id: raceId },
        select: { updatedAt: true },
      })).updatedAt;
    }

    const normalBefore = await version(normal.raceId);
    await completeRace({
      raceId: normal.raceId,
      winnerUserId: normal.alice.user.id,
      participantUserIds: [normal.alice.user.id, normal.bob.user.id],
    });
    const normalAfter = await version(normal.raceId);
    assert.ok(normalAfter > normalBefore, "normal completion advances the version");

    const teamBefore = await version(team.raceId);
    await completeRace({
      raceId: team.raceId,
      winnerTeam: "TEAM_A",
      participantUserIds: [team.alice.user.id, team.bob.user.id],
    });
    assert.ok(await version(team.raceId) > teamBefore,
      "team completion advances the version");

    const tournamentBefore = await version(matchup.raceId);
    await completeRace({
      raceId: matchup.raceId,
      winnerUserId: matchup.alice.user.id,
      participantUserIds: [matchup.alice.user.id, matchup.bob.user.id],
    });
    assert.ok(await version(matchup.raceId) > tournamentBefore,
      "tournament completion advances the version");

    await races(normal.alice.token);
    const keysBeforeRecovery = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${normal.raceId}:*`,
    );
    assert.equal(keysBeforeRecovery.length, 1);
    await completeRace({
      raceId: normal.raceId,
      winnerUserId: normal.alice.user.id,
      participantUserIds: [normal.alice.user.id, normal.bob.user.id],
    });
    const recoveryAfter = await version(normal.raceId);
    assert.ok(recoveryAfter > normalAfter, "recovery advances the version");
    const recoveredResponse = await races(normal.alice.token);
    assert.equal(recoveredResponse.completed[0].id, normal.raceId);
    const keysAfterRecovery = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${normal.raceId}:*`,
    );
    assert.equal(keysAfterRecovery.length, 2,
      "public read switches to the recovery version instead of reusing stale data");
  });

  it("account deletion advances the completed-result version transactionally", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await enableRedis();
    const { alice, bob, raceId } = await seedCompletedRace();
    await races(alice.token);
    const beforeKeys = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${raceId}:*`,
    );
    assert.equal(beforeKeys.length, 1);
    const before = await prisma.race.findUnique({
      where: { id: raceId }, select: { updatedAt: true },
    });

    const deleted = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: bob.token,
    });
    assert.equal(deleted.status, 204);
    const after = await prisma.race.findUnique({
      where: { id: raceId }, select: { updatedAt: true },
    });
    assert.ok(after.updatedAt > before.updatedAt);

    const refreshed = await races(alice.token);
    assert.equal(refreshed.completed[0].id, raceId);
    const afterKeys = await probe.keys(
      `${ENV_PREFIX}v1:race:completed-summary:${raceId}:*`,
    );
    assert.equal(afterKeys.length, 2,
      "the repaired result uses a new key while the old version expires naturally");
  });
});
