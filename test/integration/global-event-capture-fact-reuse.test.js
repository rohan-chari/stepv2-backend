const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");
const { randomUUID } = require("node:crypto");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const {
  coordinatedOptimizationMetrics,
} = require("../../src/shared/observability/coordinatedOptimizationMetrics");
const globalEventSummaryCaptureService = require(
  "../../src/modules/steps/services/globalEventSummaryCapture",
);

const CAPABILITIES = "impact_summaries,impact_summary_expiry_v1";
const MUTABLE_ROWS_METRIC = "global_summary_capture_mutable_rows";
const SAMPLE_DB_ROWS_METRIC = "global_summary_capture_sample_db_rows";
const DAILY_DB_ROWS_METRIC = "global_summary_capture_daily_db_rows";
const GENERATION_ROWS_METRIC = "global_summary_capture_generation_validation_rows";
const FACT_CACHE_USERS_METRIC = "global_summary_capture_fact_cache_users_total";
let server;

function hydratedRows() {
  return coordinatedOptimizationMetrics.snapshot().histograms[MUTABLE_ROWS_METRIC]?.sum || 0;
}

function requiredHistogramSum(name) {
  const row = coordinatedOptimizationMetrics.snapshot().histograms[name];
  assert.ok(row, `${name} must be emitted at the physical SQL result boundary`);
  return row.sum;
}

function metricCounter(name, labels = "") {
  const key = labels ? `${name}{${labels}}` : name;
  return coordinatedOptimizationMetrics.snapshot().counters[key] || 0;
}

function artifactFactRowsForUsers(payload, userIds) {
  const included = new Set(userIds);
  return (payload.samples || []).filter((row) => included.has(row.userId)).length +
    (payload.dailySteps || []).filter((row) => included.has(row.userId)).length +
    (payload.dependencyInputGenerations || []).filter((row) => included.has(row.userId)).length;
}

function artifactMutableRowsForUsers(payload, userIds) {
  const included = new Set(userIds);
  return (payload.samples || []).filter((row) => included.has(row.userId)).length +
    (payload.dailySteps || []).filter((row) => included.has(row.userId)).length;
}

function physicalMutableRows() {
  return requiredHistogramSum(SAMPLE_DB_ROWS_METRIC) + requiredHistogramSum(DAILY_DB_ROWS_METRIC);
}

function optionalPhysicalMutableRows() {
  const histograms = coordinatedOptimizationMetrics.snapshot().histograms;
  return (histograms[SAMPLE_DB_ROWS_METRIC]?.sum || 0) +
    (histograms[DAILY_DB_ROWS_METRIC]?.sum || 0);
}

function artifactGenerationUserIds(artifact) {
  return new Set(artifact.payload.dependencyInputGenerations.map((row) => row.userId));
}

async function assertArtifactMatchesCommittedFacts(artifact, expectedUserIds) {
  const userIds = [...expectedUserIds].sort();
  const raceStartedAt = new Date(artifact.payload.race.startedAt);
  const cutoffAt = new Date(artifact.payload.cutoffAt);
  const dayBeforeRace = new Date(raceStartedAt.getTime() - 24 * 60 * 60 * 1000);
  const dayAfterCutoff = new Date(cutoffAt.getTime() + 24 * 60 * 60 * 1000);
  const [samples, dailySteps, generations] = await Promise.all([
    prisma.stepSample.findMany({
      where: {
        userId: { in: userIds },
        periodEnd: { gt: raceStartedAt },
        periodStart: { lt: cutoffAt },
      },
      select: { userId: true, periodStart: true, periodEnd: true, steps: true },
      orderBy: [{ userId: "asc" }, { periodStart: "asc" }, { id: "asc" }],
    }),
    prisma.step.findMany({
      where: {
        userId: { in: userIds },
        date: { gte: dayBeforeRace, lte: dayAfterCutoff },
      },
      select: { userId: true, date: true, steps: true },
      orderBy: [{ userId: "asc" }, { date: "asc" }],
    }),
    prisma.userScoringInputVersion.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, generation: true },
      orderBy: { userId: "asc" },
    }),
  ]);
  assert.deepEqual(artifact.payload.samples, samples.map((row) => ({
    ...row,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
  })), "the artifact must contain every committed in-range sample and no out-of-range samples");
  assert.deepEqual(artifact.payload.dailySteps, dailySteps.map((row) => ({
    ...row,
    date: row.date.toISOString(),
  })), "the artifact must contain every committed in-range daily row and no stale daily rows");
  assert.deepEqual(artifact.payload.dependencyInputGenerations, generations.map((row) => ({
    userId: row.userId,
    generation: row.generation.toString(),
  })), "the artifact must carry the exact committed generation witness for every dependency");
}

async function createConnectedCaptureFixture({
  participantCount = 6,
  workIndexes = [0, 1],
  fixturePrefix = randomUUID().slice(0, 8),
} = {}) {
  const accounts = await Promise.all(Array.from(
    { length: participantCount },
    (_, index) => createTestUser({ displayName: `Fact reuse ${fixturePrefix} ${index}` }),
  ));
  const now = new Date();
  const raceStartedAt = new Date(now.getTime() - 30 * 60_000);
  const startsAt = new Date(now.getTime() - 20 * 60_000);
  const endsAt = new Date(now.getTime() - 10 * 60_000);
  const race = await prisma.race.create({ data: {
    creatorId: accounts[0].user.id,
    name: "Connected capture fact reuse",
    targetSteps: 100_000,
    status: "ACTIVE",
    startedAt: raceStartedAt,
    endsAt: new Date(now.getTime() + 60 * 60_000),
    powerupsEnabled: true,
  } });
  const participants = [];
  for (const account of accounts) {
    participants.push(await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: raceStartedAt,
    } }));
  }
  const event = await prisma.globalStepEvent.create({ data: {
    startsAt,
    endsAt,
    multiplier: 2,
    summaryAttributionVersion: 2,
  } });
  const localDate = startsAt.toISOString().slice(0, 10);
  await prisma.globalStepEventEntitlement.createMany({
    data: accounts.map((account) => ({
      eventId: event.id,
      userId: account.user.id,
      timezone: "UTC",
      localDate,
      startsAt,
      endsAt,
      startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: startsAt,
    })),
  });
  for (const index of workIndexes) {
    await prisma.globalEventSummaryWork.create({ data: {
      eventId: event.id,
      userId: accounts[index].user.id,
      status: "WAITING_SYNC",
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      requiredRaceCount: 1,
    } });
    await prisma.globalEventRaceImpact.create({ data: {
      eventId: event.id,
      raceId: race.id,
      userId: accounts[index].user.id,
      status: "PENDING",
      attributionVersion: 2,
    } });
  }
  await prisma.userScoringInputVersion.createMany({
    data: accounts.map((account) => ({ userId: account.user.id, generation: 1n })),
  });
  await prisma.stepSample.createMany({
    data: accounts.flatMap((account, index) => [0, 1, 2].map((part) => ({
      userId: account.user.id,
      periodStart: new Date(startsAt.getTime() + part * 2 * 60_000),
      periodEnd: new Date(startsAt.getTime() + (part + 1) * 2 * 60_000),
      steps: 100 + index * 10 + part,
    }))),
  });
  await prisma.step.createMany({
    data: accounts.map((account, index) => ({
      userId: account.user.id,
      date: new Date(`${localDate}T00:00:00.000Z`),
      steps: 1_000 + index,
    })),
  });
  for (let index = 1; index < accounts.length; index += 1) {
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participants[index].id,
      userId: accounts[index].user.id,
      targetUserId: accounts[index - 1].user.id,
      type: "LEECH",
      status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participants[index - 1].id,
      targetUserId: accounts[index - 1].user.id,
      sourceUserId: accounts[index].user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: index % 2 === 0 ? "EXPIRED" : "ACTIVE",
      startsAt,
      expiresAt: endsAt,
      metadata: { ratio: 2, stepsAtExpiry: 500 + index },
    } });
  }
  return { accounts, participants, event, race, startsAt, endsAt, localDate };
}

async function addConnectedRace(fixture, {
  name,
  startedAt,
  endsAt,
  impactIndexes,
  participantIndexes = fixture.accounts.map((_account, index) => index),
}) {
  const race = await prisma.race.create({ data: {
    creatorId: fixture.accounts[participantIndexes[0]].user.id,
    name,
    targetSteps: 100_000,
    status: "ACTIVE",
    startedAt,
    endsAt,
    powerupsEnabled: true,
  } });
  const participants = [];
  for (const index of participantIndexes) {
    const account = fixture.accounts[index];
    participants.push(await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: account.user.id,
      status: "ACCEPTED",
      joinedAt: startedAt,
    } }));
  }
  for (let position = 1; position < participantIndexes.length; position += 1) {
    const sourceIndex = participantIndexes[position];
    const targetIndex = participantIndexes[position - 1];
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participants[position].id,
      userId: fixture.accounts[sourceIndex].user.id,
      targetUserId: fixture.accounts[targetIndex].user.id,
      type: "LEECH",
      status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participants[position - 1].id,
      targetUserId: fixture.accounts[targetIndex].user.id,
      sourceUserId: fixture.accounts[sourceIndex].user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: position % 2 === 0 ? "EXPIRED" : "ACTIVE",
      startsAt: fixture.startsAt,
      expiresAt: fixture.endsAt,
      metadata: { ratio: 2, stepsAtExpiry: 500 + position },
    } });
  }
  await prisma.globalEventRaceImpact.createMany({
    data: impactIndexes.map((index) => ({
      eventId: fixture.event.id,
      raceId: race.id,
      userId: fixture.accounts[index].user.id,
      status: "PENDING",
      attributionVersion: 2,
    })),
  });
  return { race, participants };
}

async function capture(fixture, accountIndex, {
  steps = 2_000,
  idempotencyKey = randomUUID(),
  baseUrl = server.baseUrl,
} = {}) {
  const response = await request(baseUrl, "POST", "/steps/sync-v2", {
    token: fixture.accounts[accountIndex].token,
    headers: {
      "Idempotency-Key": idempotencyKey,
      "X-Timezone": "UTC",
      "X-Client-Features": CAPABILITIES,
    },
    body: {
      date: fixture.localDate,
      steps,
      samples: [{
        periodStart: new Date(fixture.startsAt.getTime() + 6 * 60_000).toISOString(),
        periodEnd: fixture.endsAt.toISOString(),
        steps,
        recordingMethod: "automatic",
      }],
    },
  });
  assert.equal(response.status, 202);
  return prisma.globalEventCaptureArtifact.findFirstOrThrow({ where: {
    eventId: fixture.event.id,
    raceId: fixture.race.id,
    userId: fixture.accounts[accountIndex].user.id,
  } });
}

describe("global-event mutable-fact reuse contract", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    coordinatedOptimizationMetrics.reset();
  });

  it("cold capture hydrates a fully connected historical dependency graph exactly once", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8, workIndexes: [0] });
    const artifact = await capture(fixture, 0);
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    assert.equal(
      hydratedRows(),
      artifactFactRowsForUsers(artifact.payload, allUserIds),
      "the cold miss may read each required mutable fact once, but no more",
    );
    assert.deepEqual(
      artifactGenerationUserIds(artifact),
      new Set(allUserIds),
      "the cold artifact must prove that the retained ACTIVE/EXPIRED chain is fully connected",
    );
    await assertArtifactMatchesCommittedFacts(artifact, allUserIds);
    assert.equal(artifact.payload.attributionDeltaSteps, 2_303);
  });

  it("reports physical fact reads separately from generation validation and cache outcomes", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await capture(fixture, 0);
    assert.equal(requiredHistogramSum(SAMPLE_DB_ROWS_METRIC), 25);
    assert.equal(requiredHistogramSum(DAILY_DB_ROWS_METRIC), 8);
    assert.equal(requiredHistogramSum(GENERATION_ROWS_METRIC), 16);
    assert.equal(metricCounter(FACT_CACHE_USERS_METRIC, "outcome=miss"), 8);
    assert.equal(metricCounter(FACT_CACHE_USERS_METRIC, "outcome=hit"), 0);

    const samplesAfterCold = requiredHistogramSum(SAMPLE_DB_ROWS_METRIC);
    const dailyAfterCold = requiredHistogramSum(DAILY_DB_ROWS_METRIC);
    const generationsAfterCold = requiredHistogramSum(GENERATION_ROWS_METRIC);
    await capture(fixture, 1);
    assert.equal(requiredHistogramSum(SAMPLE_DB_ROWS_METRIC) - samplesAfterCold, 4);
    assert.equal(requiredHistogramSum(DAILY_DB_ROWS_METRIC) - dailyAfterCold, 1);
    assert.equal(requiredHistogramSum(GENERATION_ROWS_METRIC) - generationsAfterCold, 9,
      "generation rows count both the closure witness and one miss revalidation");
    assert.equal(metricCounter(FACT_CACHE_USERS_METRIC, "outcome=miss"), 9);
    assert.equal(metricCounter(FACT_CACHE_USERS_METRIC, "outcome=hit"), 7);
  });

  it("a second uploader reuses every unchanged user's facts in the same connected race", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await capture(fixture, 0);
    const afterColdCapture = physicalMutableRows();
    const secondArtifact = await capture(fixture, 1);
    const secondUploaderId = fixture.accounts[1].user.id;
    assert.equal(
      physicalMutableRows() - afterColdCapture,
      artifactMutableRowsForUsers(secondArtifact.payload, [secondUploaderId]),
      "only the uploader whose sync advanced its scoring generation may miss the fact cache",
    );
    await assertArtifactMatchesCommittedFacts(
      secondArtifact,
      fixture.accounts.map((account) => account.user.id),
    );
    assert.equal(secondArtifact.payload.attributionDeltaSteps, 2_333);
  });

  it("keeps the warm-read budget flat across sequential captures in one connected component", async () => {
    const workIndexes = [0, 1, 2, 3, 4];
    const fixture = await createConnectedCaptureFixture({ participantCount: 12, workIndexes });
    await capture(fixture, 0);
    const actualWarmRows = [];
    const expectedWarmRows = [];
    const expectedAttributionDeltas = [2_334, 2_365, 2_396, 2_427];
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    for (const index of workIndexes.slice(1)) {
      const before = physicalMutableRows();
      const artifact = await capture(fixture, index, { steps: 2_000 + index });
      actualWarmRows.push(physicalMutableRows() - before);
      expectedWarmRows.push(artifactMutableRowsForUsers(
        artifact.payload,
        [fixture.accounts[index].user.id],
      ));
      await assertArtifactMatchesCommittedFacts(artifact, allUserIds);
      assert.equal(artifact.payload.attributionDeltaSteps, expectedAttributionDeltas[index - 1]);
    }
    assert.deepEqual(actualWarmRows, expectedWarmRows,
      "each later capture may hydrate its uploader, not the same connected population again");
  });

  it("hydrates shared mutable facts once when one sync captures multiple race impacts", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await addConnectedRace(fixture, {
      name: "Second simultaneous capture race",
      startedAt: fixture.race.startedAt,
      endsAt: fixture.race.endsAt,
      impactIndexes: [0, 1],
    });
    await prisma.globalEventSummaryWork.updateMany({
      where: { eventId: fixture.event.id },
      data: { requiredRaceCount: 2 },
    });
    await capture(fixture, 0);
    const afterColdCapture = physicalMutableRows();
    await capture(fixture, 1);
    const artifacts = await prisma.globalEventCaptureArtifact.findMany({ where: {
      eventId: fixture.event.id,
      userId: fixture.accounts[1].user.id,
    } });
    assert.equal(artifacts.length, 2);
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    for (const artifact of artifacts) {
      await assertArtifactMatchesCommittedFacts(artifact, allUserIds);
      assert.equal(artifact.payload.attributionDeltaSteps, 2_333);
    }
    assert.equal(
      physicalMutableRows() - afterColdCapture,
      artifactMutableRowsForUsers(artifacts[0].payload, [fixture.accounts[1].user.id]),
      "two impacts with the same population and range must not duplicate fact hydration",
    );
  });

  it("reuses a wider cached range when a later capture needs only a narrower race window", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    const wideStartedAt = new Date(fixture.race.startedAt.getTime() - 2 * 24 * 60 * 60 * 1000);
    await addConnectedRace(fixture, {
      name: "Wide first capture race",
      startedAt: wideStartedAt,
      endsAt: fixture.race.endsAt,
      impactIndexes: [0],
    });
    await prisma.globalEventSummaryWork.update({
      where: { eventId_userId: {
        eventId: fixture.event.id,
        userId: fixture.accounts[0].user.id,
      } },
      data: { requiredRaceCount: 2 },
    });
    await capture(fixture, 0);
    const afterWideCapture = physicalMutableRows();
    const narrowArtifact = await capture(fixture, 1);
    await assertArtifactMatchesCommittedFacts(
      narrowArtifact,
      fixture.accounts.map((account) => account.user.id),
    );
    assert.equal(
      physicalMutableRows() - afterWideCapture,
      artifactMutableRowsForUsers(narrowArtifact.payload, [fixture.accounts[1].user.id]),
      "narrowing the requested window must not invalidate unchanged dependencies",
    );
  });

  it("extends cached coverage when a later race needs an earlier range", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    const wideStartedAt = new Date(fixture.race.startedAt.getTime() - 2 * 24 * 60 * 60 * 1000);
    const oldSampleStart = new Date(wideStartedAt.getTime() + 10 * 60_000);
    const oldSampleEnd = new Date(oldSampleStart.getTime() + 2 * 60_000);
    const oldLocalDate = oldSampleStart.toISOString().slice(0, 10);
    await prisma.stepSample.createMany({
      data: fixture.accounts.map((account, index) => ({
        userId: account.user.id,
        periodStart: oldSampleStart,
        periodEnd: oldSampleEnd,
        steps: 700 + index,
      })),
    });
    await prisma.step.createMany({
      data: fixture.accounts.map((account, index) => ({
        userId: account.user.id,
        date: new Date(`${oldLocalDate}T00:00:00.000Z`),
        steps: 700 + index,
      })),
    });
    await capture(fixture, 0);
    const afterNarrowCapture = physicalMutableRows();

    const { race: wideRace } = await addConnectedRace(fixture, {
      name: "Earlier range extension race",
      startedAt: wideStartedAt,
      endsAt: fixture.race.endsAt,
      impactIndexes: [1],
    });
    await prisma.globalEventSummaryWork.update({
      where: { eventId_userId: {
        eventId: fixture.event.id,
        userId: fixture.accounts[1].user.id,
      } },
      data: { requiredRaceCount: 2 },
    });
    await capture(fixture, 1);
    const artifacts = await prisma.globalEventCaptureArtifact.findMany({ where: {
      eventId: fixture.event.id,
      userId: fixture.accounts[1].user.id,
    } });
    assert.equal(artifacts.length, 2);
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    for (const artifact of artifacts) await assertArtifactMatchesCommittedFacts(artifact, allUserIds);
    const wideArtifact = artifacts.find((artifact) => artifact.raceId === wideRace.id);
    const narrowArtifact = artifacts.find((artifact) => artifact.raceId === fixture.race.id);
    assert.ok(wideArtifact.payload.samples.some(
      (row) => row.userId === fixture.accounts[6].user.id && row.steps === 706,
    ), "range extension must fetch an unchanged dependency's previously uncovered sample");
    assert.ok(!narrowArtifact.payload.samples.some(
      (row) => row.userId === fixture.accounts[6].user.id && row.steps === 706,
    ), "facts fetched for a wider race must not leak outside the narrower artifact window");
    assert.equal(
      physicalMutableRows() - afterNarrowCapture,
      21,
      "range extension may fetch the uploader's full range and only the uncovered prefix for unchanged users",
    );
  });

  it("does not reuse in-range facts as though they covered a disjoint event window", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8, workIndexes: [0] });
    await capture(fixture, 0);

    const disjointStartsAt = new Date(fixture.startsAt.getTime() - 4 * 24 * 60 * 60 * 1000);
    const disjointEndsAt = new Date(disjointStartsAt.getTime() + 10 * 60_000);
    const disjointLocalDate = disjointStartsAt.toISOString().slice(0, 10);
    const disjointEvent = await prisma.globalStepEvent.create({ data: {
      startsAt: disjointStartsAt,
      endsAt: disjointEndsAt,
      multiplier: 2,
      summaryAttributionVersion: 2,
    } });
    await prisma.globalStepEventEntitlement.create({ data: {
      eventId: disjointEvent.id,
      userId: fixture.accounts[1].user.id,
      timezone: "UTC",
      localDate: disjointLocalDate,
      startsAt: disjointStartsAt,
      endsAt: disjointEndsAt,
      startOutcome: "ACTIVATED_ON_TIME",
      startProcessedAt: disjointStartsAt,
    } });
    await prisma.globalEventSummaryWork.create({ data: {
      eventId: disjointEvent.id,
      userId: fixture.accounts[1].user.id,
      status: "WAITING_SYNC",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      requiredRaceCount: 1,
    } });
    const disjointFixture = {
      ...fixture,
      event: disjointEvent,
      startsAt: disjointStartsAt,
      endsAt: disjointEndsAt,
      localDate: disjointLocalDate,
    };
    const { race: disjointRace } = await addConnectedRace(disjointFixture, {
      name: "Disjoint capture range",
      startedAt: new Date(disjointStartsAt.getTime() - 10 * 60_000),
      endsAt: new Date(disjointEndsAt.getTime() + 30 * 60_000),
      impactIndexes: [1],
    });
    disjointFixture.race = disjointRace;
    await prisma.stepSample.createMany({
      data: fixture.accounts.map((account, index) => ({
        userId: account.user.id,
        periodStart: disjointStartsAt,
        periodEnd: new Date(disjointStartsAt.getTime() + 2 * 60_000),
        steps: 800 + index,
      })),
    });
    await prisma.step.createMany({
      data: fixture.accounts.map((account, index) => ({
        userId: account.user.id,
        date: new Date(`${disjointLocalDate}T00:00:00.000Z`),
        steps: 800 + index,
      })),
    });

    const artifact = await capture(disjointFixture, 1, { steps: 3_000 });
    assert.equal(artifact.raceId, disjointRace.id);
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    await assertArtifactMatchesCommittedFacts(artifact, allUserIds);
    assert.ok(artifact.payload.samples.some(
      (row) => row.userId === fixture.accounts[6].user.id && row.steps === 806,
    ));
    assert.ok(!artifact.payload.samples.some(
      (row) => row.userId === fixture.accounts[6].user.id && row.steps === 160,
    ),
      "recent-window cached samples must not leak into the disjoint artifact");
  });

  it("does not invent coverage for the populated gap between two disjoint fills", async () => {
    const fixture = await createConnectedCaptureFixture({
      participantCount: 8,
      workIndexes: [0],
    });
    await capture(fixture, 0);

    async function createWindow({ accountIndex, dayOffset, name, sampleBase }) {
      const startsAt = new Date(fixture.startsAt.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const endsAt = new Date(startsAt.getTime() + 10 * 60_000);
      const localDate = startsAt.toISOString().slice(0, 10);
      const event = await prisma.globalStepEvent.create({ data: {
        startsAt,
        endsAt,
        multiplier: 2,
        summaryAttributionVersion: 2,
      } });
      await prisma.globalStepEventEntitlement.create({ data: {
        eventId: event.id,
        userId: fixture.accounts[accountIndex].user.id,
        timezone: "UTC",
        localDate,
        startsAt,
        endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: startsAt,
      } });
      await prisma.globalEventSummaryWork.create({ data: {
        eventId: event.id,
        userId: fixture.accounts[accountIndex].user.id,
        status: "WAITING_SYNC",
        expiresAt: new Date(Date.now() + 60 * 60_000),
        requiredRaceCount: 1,
      } });
      const windowFixture = { ...fixture, event, startsAt, endsAt, localDate };
      const { race } = await addConnectedRace(windowFixture, {
        name,
        startedAt: new Date(startsAt.getTime() - 10 * 60_000),
        endsAt: new Date(endsAt.getTime() + 30 * 60_000),
        impactIndexes: [accountIndex],
      });
      windowFixture.race = race;
      await prisma.stepSample.createMany({
        data: fixture.accounts.map((account, index) => ({
          userId: account.user.id,
          periodStart: startsAt,
          periodEnd: new Date(startsAt.getTime() + 2 * 60_000),
          steps: sampleBase + index,
        })),
      });
      return windowFixture;
    }

    const oldWindow = await createWindow({
      accountIndex: 1,
      dayOffset: -4,
      name: "Old disjoint cache window",
      sampleBase: 800,
    });
    await capture(oldWindow, 1, { steps: 3_000 });
    const middleWindow = await createWindow({
      accountIndex: 2,
      dayOffset: -2,
      name: "Populated cache coverage gap",
      sampleBase: 900,
    });
    const beforeMiddle = physicalMutableRows();
    const middleArtifact = await capture(middleWindow, 2, { steps: 4_000 });
    const allUserIds = fixture.accounts.map((account) => account.user.id);

    await assertArtifactMatchesCommittedFacts(middleArtifact, allUserIds);
    assert.ok(middleArtifact.payload.samples.some(
      (row) => row.userId === fixture.accounts[6].user.id && row.steps === 906,
    ), "an unchanged dependency's row in the uncovered middle must be captured");
    assert.equal(
      physicalMutableRows() - beforeMiddle,
      artifactMutableRowsForUsers(middleArtifact.payload, allUserIds),
      "the middle interval must remain a physical miss for every dependency",
    );
  });

  it("invalidates only the uploader and a dependency whose scoring generation changed", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await capture(fixture, 0);
    const changedDependency = fixture.accounts[5];
    const dependencySync = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: changedDependency.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: fixture.localDate,
        steps: 9_000,
        samples: [{
          periodStart: new Date(fixture.startsAt.getTime() + 6 * 60_000).toISOString(),
          periodEnd: fixture.endsAt.toISOString(),
          steps: 9_000,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(dependencySync.status, 202);
    const beforeSecondCapture = physicalMutableRows();
    const secondArtifact = await capture(fixture, 1);
    const expectedMisses = [fixture.accounts[1].user.id, changedDependency.user.id];
    assert.equal(
      physicalMutableRows() - beforeSecondCapture,
      artifactMutableRowsForUsers(secondArtifact.payload, expectedMisses),
      "one changed dependency must not invalidate the other connected participants",
    );
    assert.ok(
      secondArtifact.payload.samples.some(
        (row) => row.userId === changedDependency.user.id && row.steps === 9_000,
      ),
      "the immutable artifact must include the changed dependency's newly persisted facts",
    );
    await assertArtifactMatchesCommittedFacts(
      secondArtifact,
      fixture.accounts.map((account) => account.user.id),
    );
    assert.equal(secondArtifact.payload.attributionDeltaSteps, 2_333);
  });

  it("coalesces concurrent cold captures instead of hydrating the connected race twice", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await prisma.globalEventRaceImpact.deleteMany({ where: { raceId: fixture.race.id } });
    await prisma.raceActiveEffect.deleteMany({ where: { raceId: fixture.race.id } });
    await prisma.racePowerup.deleteMany({ where: { raceId: fixture.race.id } });
    await prisma.raceParticipant.deleteMany({ where: { raceId: fixture.race.id } });
    await prisma.race.delete({ where: { id: fixture.race.id } });
    const sharedIndexes = [2, 3, 4, 5, 6, 7];
    const firstIndexes = [0, ...sharedIndexes];
    const secondIndexes = [1, ...sharedIndexes];
    const { race: firstRace } = await addConnectedRace(fixture, {
      name: "Concurrent capture race A",
      startedAt: fixture.race.startedAt,
      endsAt: fixture.race.endsAt,
      participantIndexes: firstIndexes,
      impactIndexes: [0],
    });
    const { race: secondRace } = await addConnectedRace(fixture, {
      name: "Concurrent capture race B",
      startedAt: fixture.race.startedAt,
      endsAt: fixture.race.endsAt,
      participantIndexes: secondIndexes,
      impactIndexes: [1],
    });
    const firstFixture = { ...fixture, race: firstRace };
    const secondFixture = { ...fixture, race: secondRace };

    const originalClaimEligibleSummaryWork =
      globalEventSummaryCaptureService.claimEligibleSummaryWork;
    const arrivals = new Set();
    let signalBothReady;
    const bothReady = new Promise((resolve) => { signalBothReady = resolve; });
    globalEventSummaryCaptureService.claimEligibleSummaryWork = async (tx, args) => {
      arrivals.add(args.userId);
      if (arrivals.size === 2) signalBothReady();
      await bothReady;
      return originalClaimEligibleSummaryWork(tx, args);
    };
    let firstPromise;
    let secondPromise;
    try {
      firstPromise = capture(firstFixture, 0, { steps: 2_000 });
      secondPromise = capture(secondFixture, 1, { steps: 2_100 });
      let barrierTimeout;
      try {
        await Promise.race([
          bothReady,
          new Promise((_, reject) => {
            barrierTimeout = setTimeout(
              () => reject(new Error("both captures did not reach the pre-hydration barrier")),
              5_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(barrierTimeout);
      }
      const [firstArtifact, secondArtifact] = await Promise.all([firstPromise, secondPromise]);
      const firstUserIds = firstIndexes.map((index) => fixture.accounts[index].user.id);
      const secondUserIds = secondIndexes.map((index) => fixture.accounts[index].user.id);
      const oneColdPopulation = Math.max(
        artifactMutableRowsForUsers(firstArtifact.payload, firstUserIds),
        artifactMutableRowsForUsers(secondArtifact.payload, secondUserIds),
      );
      const uniqueUploader = Math.max(
        artifactMutableRowsForUsers(firstArtifact.payload, [fixture.accounts[0].user.id]),
        artifactMutableRowsForUsers(secondArtifact.payload, [fixture.accounts[1].user.id]),
      );
      assert.equal(
        physicalMutableRows(),
        oneColdPopulation + uniqueUploader,
        "shared dependency facts must have exactly one cold fill across independent race fences",
      );
      assert.deepEqual(artifactGenerationUserIds(firstArtifact), new Set(firstUserIds));
      assert.deepEqual(artifactGenerationUserIds(secondArtifact), new Set(secondUserIds));
      await assertArtifactMatchesCommittedFacts(firstArtifact, firstUserIds);
      await assertArtifactMatchesCommittedFacts(secondArtifact, secondUserIds);
    } finally {
      globalEventSummaryCaptureService.claimEligibleSummaryWork =
        originalClaimEligibleSummaryWork;
      signalBothReady();
      await Promise.allSettled([firstPromise, secondPromise].filter(Boolean));
    }
  });

  it("hydrates only newly connected users when the retained effect graph expands", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    const newlyConnectedIndex = fixture.accounts.length - 1;
    const newlyConnected = fixture.accounts[newlyConnectedIndex];
    await prisma.raceActiveEffect.deleteMany({ where: {
      raceId: fixture.race.id,
      sourceUserId: newlyConnected.user.id,
      targetUserId: fixture.accounts[newlyConnectedIndex - 1].user.id,
      type: "LEECH",
    } });
    await capture(fixture, 0);

    const powerup = await prisma.racePowerup.create({ data: {
      raceId: fixture.race.id,
      participantId: fixture.participants[newlyConnectedIndex].id,
      userId: newlyConnected.user.id,
      targetUserId: fixture.accounts[newlyConnectedIndex - 1].user.id,
      type: "LEECH",
      status: "USED",
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: fixture.race.id,
      targetParticipantId: fixture.participants[newlyConnectedIndex - 1].id,
      targetUserId: fixture.accounts[newlyConnectedIndex - 1].user.id,
      sourceUserId: newlyConnected.user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: "EXPIRED",
      startsAt: fixture.startsAt,
      expiresAt: fixture.endsAt,
      metadata: { ratio: 2, stepsAtExpiry: 500 },
    } });

    const beforeSecondCapture = physicalMutableRows();
    const secondArtifact = await capture(fixture, 1);
    assert.equal(
      physicalMutableRows() - beforeSecondCapture,
      artifactMutableRowsForUsers(secondArtifact.payload, [
        fixture.accounts[1].user.id,
        newlyConnected.user.id,
      ]),
      "topology expansion invalidates membership, not already-cached user generations",
    );
    assert.ok(artifactGenerationUserIds(secondArtifact).has(newlyConnected.user.id));
    await assertArtifactMatchesCommittedFacts(
      secondArtifact,
      fixture.accounts.map((account) => account.user.id),
    );
  });

  it("drops disconnected users from the artifact without invalidating retained cached facts", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    await capture(fixture, 0);
    const disconnectedIndex = fixture.accounts.length - 1;
    const disconnected = fixture.accounts[disconnectedIndex];
    await prisma.raceActiveEffect.deleteMany({ where: {
      raceId: fixture.race.id,
      sourceUserId: disconnected.user.id,
      targetUserId: fixture.accounts[disconnectedIndex - 1].user.id,
      type: "LEECH",
    } });

    const beforeSecondCapture = physicalMutableRows();
    const secondArtifact = await capture(fixture, 1);
    assert.equal(
      physicalMutableRows() - beforeSecondCapture,
      artifactMutableRowsForUsers(secondArtifact.payload, [fixture.accounts[1].user.id]),
      "topology contraction must reuse retained users and hydrate only the changed uploader",
    );
    assert.ok(
      secondArtifact.payload.dependencyInputGenerations.every(
        (row) => row.userId !== disconnected.user.id,
      ),
      "facts cached before a topology contraction must not leak into the immutable artifact",
    );
    assert.deepEqual(
      artifactGenerationUserIds(secondArtifact),
      new Set(fixture.accounts.slice(0, disconnectedIndex).map((account) => account.user.id)),
    );
    await assertArtifactMatchesCommittedFacts(
      secondArtifact,
      fixture.accounts.slice(0, disconnectedIndex).map((account) => account.user.id),
    );
  });

  it("keeps generation witnesses and warmed facts in one consistent committed snapshot", async () => {
    const fixture = await createConnectedCaptureFixture({
      participantCount: 8,
      workIndexes: [0, 1, 2],
    });
    await capture(fixture, 0);
    const dependency = fixture.accounts[5];
    let signalMutationReady;
    const mutationReady = new Promise((resolve) => { signalMutationReady = resolve; });
    let releaseMutation;
    const mutationReleased = new Promise((resolve) => { releaseMutation = resolve; });
    const mutation = prisma.$transaction(async (tx) => {
      await tx.userScoringInputVersion.update({
        where: { userId: dependency.user.id },
        data: { generation: { increment: 1n } },
      });
      await tx.step.update({
        where: { userId_date: {
          userId: dependency.user.id,
          date: new Date(`${fixture.localDate}T00:00:00.000Z`),
        } },
        data: { steps: 9_000 },
      });
      await tx.stepSample.create({ data: {
        userId: dependency.user.id,
        periodStart: new Date(fixture.startsAt.getTime() + 6 * 60_000),
        periodEnd: fixture.endsAt,
        steps: 9_000,
      } });
      signalMutationReady();
      await mutationReleased;
    });

    await mutationReady;
    const capturePromise = capture(fixture, 1);
    let mutationWasReleased = false;
    try {
      const earlyArtifact = await Promise.race([
        capturePromise,
        new Promise((resolve) => setTimeout(() => resolve(null), 200)),
      ]);
      if (earlyArtifact) {
        const dependencyGeneration = earlyArtifact.payload.dependencyInputGenerations.find(
          (row) => row.userId === dependency.user.id,
        );
        const dependencyDaily = earlyArtifact.payload.dailySteps.find(
          (row) => row.userId === dependency.user.id,
        );
        assert.deepEqual(
          [dependencyGeneration.generation, dependencyDaily.steps],
          ["1", 1_005],
          "a pre-commit capture may use the old snapshot, but may not mix old and uncommitted facts",
        );
      }
      releaseMutation();
      mutationWasReleased = true;
      await mutation;
      const artifact = earlyArtifact || await capturePromise;
      const dependencyGeneration = artifact.payload.dependencyInputGenerations.find(
        (row) => row.userId === dependency.user.id,
      );
      const dependencyDaily = artifact.payload.dailySteps.find(
        (row) => row.userId === dependency.user.id,
      );
      assert.ok(
        (dependencyGeneration.generation === "1" && dependencyDaily.steps === 1_005) ||
        (dependencyGeneration.generation === "2" && dependencyDaily.steps === 9_000),
        "the capture snapshot must pair facts with the generation that witnessed them",
      );

      const postCommitArtifact = await capture(fixture, 2);
      const allUserIds = fixture.accounts.map((account) => account.user.id);
      await assertArtifactMatchesCommittedFacts(postCommitArtifact, allUserIds);
      assert.ok(postCommitArtifact.payload.dependencyInputGenerations.some(
        (row) => row.userId === dependency.user.id && row.generation === "2",
      ));
      assert.ok(postCommitArtifact.payload.dailySteps.some(
        (row) => row.userId === dependency.user.id && row.steps === 9_000,
      ));
    } finally {
      if (!mutationWasReleased) releaseMutation();
      await Promise.allSettled([mutation, capturePromise]);
    }
  });

  it("does not publish facts from a capture transaction that rolls back", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8 });
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `reject_capture_${suffix}`;
    const triggerName = `reject_capture_trigger_${suffix}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.user_id = '${fixture.accounts[0].user.id}' THEN
           RAISE EXCEPTION 'intentional capture rollback';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON global_event_capture_artifacts
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      const failed = await request(server.baseUrl, "POST", "/steps/sync-v2", {
        token: fixture.accounts[0].token,
        headers: {
          "Idempotency-Key": randomUUID(),
          "X-Timezone": "UTC",
          "X-Client-Features": CAPABILITIES,
        },
        body: {
          date: fixture.localDate,
          steps: 2_000,
          samples: [{
            periodStart: new Date(fixture.startsAt.getTime() + 6 * 60_000).toISOString(),
            periodEnd: fixture.endsAt.toISOString(),
            steps: 2_000,
            recordingMethod: "automatic",
          }],
        },
      });
      assert.ok(failed.status >= 500);
      assert.equal(await prisma.globalEventCaptureArtifact.count(), 0);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${triggerName} ON global_event_capture_artifacts`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }

    const beforeRecovery = physicalMutableRows();
    const recoveryArtifact = await capture(fixture, 1);
    const allUserIds = fixture.accounts.map((account) => account.user.id);
    assert.equal(
      physicalMutableRows() - beforeRecovery,
      artifactMutableRowsForUsers(recoveryArtifact.payload, allUserIds),
      "a rolled-back cold fill must leave the next capture fully cold",
    );
    await assertArtifactMatchesCommittedFacts(recoveryArtifact, allUserIds);
  });

  it("does not hydrate again when the client retries the same accepted sync", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8, workIndexes: [0] });
    const idempotencyKey = randomUUID();
    await capture(fixture, 0, { idempotencyKey });
    const afterAcceptedCapture = optionalPhysicalMutableRows();
    await capture(fixture, 0, { idempotencyKey });
    assert.equal(optionalPhysicalMutableRows(), afterAcceptedCapture,
      "transport retries must return the accepted result without touching capture facts");
  });

  it("never reuses facts across unrelated user identities", async () => {
    const first = await createConnectedCaptureFixture({ participantCount: 4, workIndexes: [0] });
    await capture(first, 0);
    const second = await createConnectedCaptureFixture({ participantCount: 4, workIndexes: [0] });
    const beforeSecondPopulation = optionalPhysicalMutableRows();
    const secondArtifact = await capture(second, 0);
    assert.equal(
      optionalPhysicalMutableRows() - beforeSecondPopulation,
      artifactMutableRowsForUsers(
        secondArtifact.payload,
        second.accounts.map((account) => account.user.id),
      ),
      "a cold population with different user IDs must not observe another population's facts",
    );
  });

  it("does not count an ordinary dependency sync without eligible summary work as capture hydration", async () => {
    const fixture = await createConnectedCaptureFixture({ participantCount: 8, workIndexes: [0] });
    const dependency = fixture.accounts[6];
    const response = await request(server.baseUrl, "POST", "/steps/sync-v2", {
      token: dependency.token,
      headers: {
        "Idempotency-Key": randomUUID(),
        "X-Timezone": "UTC",
        "X-Client-Features": CAPABILITIES,
      },
      body: {
        date: fixture.localDate,
        steps: 4_000,
        samples: [{
          periodStart: new Date(fixture.startsAt.getTime() + 6 * 60_000).toISOString(),
          periodEnd: fixture.endsAt.toISOString(),
          steps: 4_000,
          recordingMethod: "automatic",
        }],
      },
    });
    assert.equal(response.status, 202);
    assert.equal(optionalPhysicalMutableRows(), 0,
      "fact reuse is demand-driven and must not move the broad read onto every background sync");
  });
});
