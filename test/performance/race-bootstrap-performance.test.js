const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { before, beforeEach, after, describe, it } = require("node:test");
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase, createTestUser, getSharedServer, request } = require("./setup");

const FEATURES = "characters,powerups3,powerups4,powerups5,remote_assets,race_participants_paging,api_payload_compact_v1,race_leave,team_races";
const HEADERS = { "X-Client-Features": FEATURES, "X-Timezone": "UTC", "X-Release-Channel": "prod" };
const MONEY = ["prizePool", "buyInAmount", "payouts", "payoutTiers", "potCoins", "heldPotCoins", "projectedPotCoins", "finishReward", "acceptedCount", "teamAAcceptedCount", "teamBAcceptedCount"];
const pick = (body, keys) => Object.fromEntries(keys.map((key) => [key, body[key]]));

describe("race bootstrap avoids redundant projection work", () => {
  let baseUrl, capturing = null, previousSettings;
  const createdSeedIds = [];
  const settings = ["apiRaceBootstrapV1Enabled", "apiRaceBootstrapCompactV1Enabled", "raceResolutionReasonAwareV1Enabled", "raceResolutionQueuedGenerationMergeV1Enabled", "raceResolutionBurstCoalescingV1Enabled"];
  before(async () => {
    // cleanDatabase refuses non-disposable DB names before touching rows. Run
    // that guard before even seeding settings (not merely before fixtures).
    await cleanDatabase();
    previousSettings = await prisma.appSetting.findMany({ where: { key: { in: settings } } });
    for (const key of settings) await prisma.appSetting.upsert({ where: { key }, create: { key, value: true }, update: { value: true } });
    baseUrl = (await getSharedServer()).baseUrl;
    prisma.$on("query", (event) => { if (capturing) capturing.push(event); });
  });
  after(async () => {
    await cleanDatabase();
    if (createdSeedIds.length) await prisma.raceSeed.deleteMany({ where: { id: { in: createdSeedIds } } });
    await prisma.appSetting.deleteMany({ where: { key: { in: settings } } });
    if (previousSettings?.length) await prisma.appSetting.createMany({ data: previousSettings });
  });
  beforeEach(cleanDatabase);

  async function fixture({ size = 30, raceData = {}, rows = [] } = {}) {
    const owner = await createTestUser();
    if (raceData.seedId && !(await prisma.raceSeed.findUnique({ where: { id: raceData.seedId } }))) {
      await prisma.raceSeed.create({ data: {
        id: raceData.seedId, kind: `bootstrap-${randomUUID()}`, name: "Legacy seeded prize",
        targetSteps: 10000, cadence: "DAILY", active: false,
      } });
      createdSeedIds.push(raceData.seedId);
    }
    const startedAt = new Date(Date.now() - 3_600_000);
    const race = await prisma.race.create({ data: {
      id: randomUUID(), creatorId: owner.user.id, name: "Bootstrap performance",
      status: "ACTIVE", startedAt, endsAt: new Date(Date.now() + 86_400_000),
      maxParticipants: 10_000, maxDurationDays: 7, targetSteps: 0,
      timeBased: true, timezone: "UTC", powerupsEnabled: false, isPublic: true,
      ...raceData,
    } });
    const ids = [owner.user.id, ...Array.from({ length: size - 1 }, () => randomUUID())];
    await prisma.user.createMany({ data: ids.slice(1).map((id) => ({ id, appleId: id, displayName: `Runner ${id}` })) });
    await prisma.raceParticipant.createMany({ data: ids.map((userId, i) => ({
      id: randomUUID(), raceId: race.id, userId, status: "ACCEPTED",
      joinedAt: new Date(startedAt.getTime() + i), totalSteps: 3000 - i,
      rawSteps: 3000 - i, ...rows[i],
    })) });
    return { ...owner, race, ids };
  }

  async function get(path, token, headers = HEADERS) {
    const response = await request(baseUrl, "GET", path, { token, headers });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  }
  const bootstrapPath = (race, compact = true) => `/races/${race.id}/bootstrap?view=participants-v1&limit=15${compact ? "&shape=compact-v1" : ""}`;
  const detailsPageQueries = (queries) => queries.filter(({ query }) =>
    query.includes('FROM "public"."race_participants"') &&
    query.includes('"buy_in_status"') && query.includes('ORDER BY') &&
    query.includes('"joined_at" ASC') && query.includes('LIMIT') &&
    !query.includes('"user_id" ='));
  async function measured(path, token) {
    capturing = [];
    try { const body = await get(path, token); return { body, queries: [...capturing] }; }
    finally { capturing = null; }
  }

  it("does not hydrate the details participant page discarded by compact bootstrap", async () => {
    const { race, token, ids } = await fixture();
    const { body, queries } = await measured(bootstrapPath(race), token);
    assert.equal(body.contract, "race-bootstrap-compact-v1");
    assert.equal(body.race.participants, undefined);
    assert.equal(body.progress.participants.length, 15);
    assert.deepEqual(body.race.participantUserIds, ids);
    const discarded = detailsPageQueries(queries);
    assert.equal(discarded.length, 0, `compact bootstrap must not fetch its omitted details page: ${discarded.map(({ query }) => query).join("\n")}`);
  });

  it("loads core/viewer metadata and aggregate once instead of hydrating the full roster twice", async () => {
    const { race, token } = await fixture({ size: 100 });
    const { body, queries } = await measured(bootstrapPath(race), token);
    assert.equal(body.contract, "race-bootstrap-compact-v1");
    assert.equal(body.progress.participants.length, 15);
    assert.equal(body.race.acceptedCount, 100);
    const aggregates = queries.filter(({ query }) => query.includes('AS "activeFundedPlayerCount"'));
    assert.equal(aggregates.length, 1, "progress and details share one money/count aggregate");
    const core = queries.filter(({ query }) => query.includes('FROM "public"."races"') && query.includes('"name"'));
    assert.equal(core.length, 1, "one request-local race core should serve access, progress, and details");
    const unbounded = queries.filter(({ query }) => query.includes('FROM "public"."race_participants"') &&
      !query.includes('LIMIT') && !query.includes('"user_id" =') &&
      !/count\(|sum\(|jsonb_agg\(/i.test(query));
    assert.equal(unbounded.length, 0, "paged bootstrap must not transfer full scalar participant rosters");
  });

  it("preserves full legacy bootstrap participants and noncompact paged details", async () => {
    const { race, token, ids } = await fixture();
    const { body: paged, queries } = await measured(bootstrapPath(race, false), token);
    assert.equal(detailsPageQueries(queries).length, 1, "noncompact bootstrap still loads its visible details page");
    assert.equal(paged.contract, "race-bootstrap-v1");
    assert.equal(paged.race.participants.length, 15);
    assert.deepEqual(paged.race.participantUserIds, ids);
    const old = await get(`/races/${race.id}/bootstrap`, token, { "X-Timezone": "UTC" });
    assert.equal(old.contract, "race-bootstrap-v1");
    assert.equal(old.race.participants.length, 30);
    assert.deepEqual(pick(paged.race, MONEY), pick(old.race, MONEY));
  });

  it("keeps the details page when a real progress database read fails", async () => {
    const { race, token, ids } = await fixture();
    // Fault only the progress count dependency in this isolated test database.
    // The request still traverses the actual HTTP route and Prisma handlers.
    await prisma.$executeRawUnsafe('ALTER TABLE race_accepted_participant_counts RENAME TO bootstrap_test_unavailable_counts');
    try {
      const body = await get(bootstrapPath(race), token);
      assert.equal(body.contract, "race-bootstrap-v1");
      assert.equal(body.progress, null);
      assert.deepEqual(body.progressError, { code: "PROGRESS_UNAVAILABLE" });
      assert.equal(body.race.participants.length, 15);
      assert.deepEqual(body.race.participantUserIds, ids);
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE bootstrap_test_unavailable_counts RENAME TO race_accepted_participant_counts');
    }
  });

  it("keeps viewer context isolated between consecutive users and denied reads", async () => {
    const { race, token, ids } = await fixture();
    const outsider = await createTestUser();
    const first = await get(bootstrapPath(race), token);
    assert.equal(first.race.myStatus, "ACCEPTED");
    const denied = await request(baseUrl, "GET", bootstrapPath(race), { token: outsider.token, headers: HEADERS });
    assert.equal(denied.status, 403);
    await prisma.raceParticipant.update({ where: { raceId_userId: { raceId: race.id, userId: ids[0] } }, data: { forfeitedAt: new Date() } });
    const forfeited = await request(baseUrl, "GET", bootstrapPath(race), { token, headers: HEADERS });
    assert.equal(forfeited.status, 404);
  });

  it("preserves the different legacy held-stake fields on progress and details", async () => {
    const { race, token } = await fixture({ size: 2, raceData: { fundedPrize: false, potCoins: 31 }, rows: [
      { buyInStatus: "HELD", buyInAmount: 11 }, { buyInStatus: "HELD", buyInAmount: 23 },
    ] });
    const body = await get(bootstrapPath(race), token);
    assert.equal(body.progress.heldPotCoins, undefined, "progress never exposes a heldPotCoins field");
    assert.equal(body.progress.projectedPotCoins, 31);
    assert.equal(body.race.heldPotCoins, 34);
    assert.equal(body.race.projectedPotCoins, 65);
  });

  const variants = [
    { name: "legacy seeded finish reward", raceData: { fundedPrize: false, seedId: "seed-daily-10k", potCoins: 19 }, rows: [
      { buyInStatus: "HELD", buyInAmount: 17 }, { status: "DECLINED" },
    ] },
    { name: "pending funded solo", raceData: { status: "PENDING", fundedPrize: true, exitActionsEnabled: true }, rows: [
      {}, { status: "INVITED" }, { status: "DECLINED" },
    ] },
    { name: "cancelled legacy solo", raceData: { status: "CANCELLED", fundedPrize: false, potCoins: 41, buyInAmount: 13 }, rows: [
      { buyInStatus: "HELD", buyInAmount: 13 }, { status: "DECLINED" },
    ] },
    { name: "active fixed team winner stamp", raceData: { fundedPrize: true, isTeamRace: true, teamSize: 5, teamPayoutVersion: 1, teamWinnerRewardCoins: 37, payoutRoundingVersion: 1 }, rows: [
      { team: "TEAM_A" }, { team: "TEAM_A" }, { team: "TEAM_B" },
      { team: "TEAM_B", forfeitedAt: new Date() }, { team: null },
    ] },
    { name: "completed fixed team stamp", raceData: { status: "COMPLETED", fundedPrize: true, isTeamRace: true, teamSize: 5, teamPayoutVersion: 1, teamWinnerRewardCoins: 37, payoutRoundingVersion: 1 }, rows: [
      { team: "TEAM_A", payoutCoins: 37 }, { team: "TEAM_A", payoutCoins: 37 }, { team: "TEAM_B" },
    ] },
    { name: "legacy held stakes", raceData: { fundedPrize: false, potCoins: 31 }, rows: [
      { buyInStatus: "HELD", buyInAmount: 11 }, { status: "INVITED", buyInStatus: "HELD", buyInAmount: 23 },
      { status: "DECLINED", buyInStatus: "HELD", buyInAmount: 7 },
    ] },
    { name: "active funded forfeits", raceData: { fundedPrize: true, exitActionsEnabled: true, payoutRoundingVersion: 1 }, rows: [
      {}, { totalSteps: 0, rawSteps: 0, forfeitedAt: new Date() },
      { totalSteps: 1000, forfeitedAt: new Date() }, { totalSteps: 0 }, { status: "DECLINED" },
    ] },
    { name: "completed stamped solo", raceData: { fundedPrize: true, status: "COMPLETED", prizePoolCoins: 317, payoutRoundingVersion: 1, exitActionsEnabled: true }, rows: [
      { placement: 1, payoutCoins: 151 }, { placement: 2, payoutCoins: 101, forfeitedAt: new Date() },
      { placement: 2, payoutCoins: 65, status: "DECLINED" }, { totalSteps: 0, placement: 3 },
    ] },
    { name: "active team forfeits", raceData: { fundedPrize: true, isTeamRace: true, teamSize: 5, payoutRoundingVersion: 1 }, rows: [
      { team: "TEAM_A" }, { team: "TEAM_A", totalSteps: 0 }, { team: "TEAM_B" },
      { team: "TEAM_B", forfeitedAt: new Date() }, { team: null },
    ] },
    { name: "completed team awards", raceData: { fundedPrize: true, status: "COMPLETED", isTeamRace: true, teamSize: 5, prizePoolCoins: 301, payoutRoundingVersion: 1 }, rows: [
      { team: "TEAM_A", payoutCoins: 101 }, { team: "TEAM_A", payoutCoins: 100, placement: null },
      { team: "TEAM_B", payoutCoins: 100, status: "DECLINED" }, { totalSteps: 0 },
    ] },
    ...[0, 1, 2, 3].map((qualifiers) => ({ name: `completed quick ${qualifiers} qualifiers`,
      raceData: { fundedPrize: true, status: "COMPLETED", creationSource: "QUICK_CREATE", startPolicy: "ON_MINIMUM_PARTICIPANTS", exitActionsEnabled: true, prizePoolCoins: 87 },
      rows: Array.from({ length: 6 }, (_, i) => ({ placement: i + 1, rawSteps: i < qualifiers ? 2000 : 1999,
        totalSteps: i === 1 ? 0 : 2500, ...(i === 2 ? { forfeitedAt: new Date() } : {}) })),
    })),
  ];
  for (const variant of variants) {
    it(`preserves all money/count fields across pages: ${variant.name}`, async () => {
      const { race, token, ids } = await fixture({ size: 6, ...variant });
      const full = await get(`/races/${race.id}`, token);
      const baseline = full.race || full;
      if (variant.name === "legacy seeded finish reward") assert.ok(baseline.finishReward?.pool > 0);
      for (const offset of [0, 4, 50]) {
        const page = await get(`/races/${race.id}?view=participants-v1&offset=${offset}&limit=2`, token);
        const details = page.race || page;
        assert.deepEqual(pick(details, MONEY), pick(baseline, MONEY));
        assert.deepEqual(details.participantUserIds, ids);
        assert.equal(details.participantsPagination.total, 6);
      }
    });
  }
});
