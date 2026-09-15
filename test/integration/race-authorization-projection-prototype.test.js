"use strict";

process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { before, after, beforeEach, describe, it } = require("node:test");
const {
  prisma,
  cleanDatabase,
  createTestUser,
  getSharedServer,
  request,
  startServer,
} = require("./setup");
const { buildAuthorizationCandidates } = require("../helpers/raceAuthorizationPrototype");

const SIZES = [20, 50, 100, 250, 500];
let baselineServer;
let candidateServer;
let observedQueries = null;

prisma.$on("query", (event) => {
  if (observedQueries) observedQueries.push(event);
});

async function makeFixture(size, { status = "ACCEPTED", seeded = false, raceStatus = "ACTIVE" } = {}) {
  const viewer = await createTestUser({ displayName: "Authorization viewer" });
  const otherIds = Array.from({ length: Math.max(0, size - 1) }, () => randomUUID());
  if (otherIds.length) {
    await prisma.user.createMany({
      data: otherIds.map((id, index) => ({
        id,
        appleId: `authorization-${id}`,
        displayName: `Authorization user ${index + 1}`,
      })),
    });
  }
  const race = await prisma.race.create({
    data: {
      creatorId: viewer.user.id,
      name: "Authorization prototype",
      status: raceStatus,
      isPublic: true,
      powerupsEnabled: false,
      targetSteps: 100000,
      maxParticipants: size + 10,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      endsAt: new Date("2026-01-02T00:00:00.000Z"),
      timezone: "UTC",
      ...(seeded ? { seededBucketId: randomUUID() } : {}),
    },
  });
  const users = [viewer.user.id, ...otherIds];
  await prisma.raceParticipant.createMany({
    data: users.map((userId, index) => ({
      id: randomUUID(),
      raceId: race.id,
      userId,
      status: index === 0 ? status : "ACCEPTED",
      joinedAt: new Date(2026, 0, 1, 0, 0, index),
      forfeitedAt: index === 0 && status === "ACCEPTED" ? new Date("2026-01-01T01:00:00.000Z") : null,
    })),
  });
  return { race, viewer };
}

async function readEndpoint(server, path, token) {
  observedQueries = [];
  const started = performance.now();
  const response = await request(server.baseUrl, "GET", path, {
    token,
    headers: {
      "X-Timezone": "UTC",
      ...(path.includes("active-impact-notices")
        ? { "X-Client-Features": "resolved_impact_events_v2" }
        : {}),
    },
  });
  const bodyText = await response.text();
  const finished = performance.now();
  const queries = observedQueries;
  observedQueries = null;
  const participantQueries = queries.filter((event) => /race_participants/i.test(event.query));
  return {
    status: response.status,
    body: JSON.parse(bodyText),
    responseBytes: Buffer.byteLength(bodyText),
    sql: queries.length,
    dbExecutionMs: queries.reduce((sum, event) => sum + Number(event.duration || 0), 0),
    participantQueries,
    endpointMs: finished - started,
  };
}

function participantRowsFor(flow, kind, size, participantQueries) {
  if (kind === "candidate" && flow === "feed") {
    // Viewer access plus event-referenced names. Fixtures have no events, so
    // the candidate identity query contains only the viewer.
    return participantQueries.length ? 2 : 0;
  }
  if (kind === "candidate" && (flow === "inventory" || flow === "impact")) {
    return participantQueries.length ? 1 : 0;
  }
  if (flow === "impact") return participantQueries.length ? 1 : 0;
  return participantQueries.length ? size : 0;
}

describe("race authorization projection prototype", () => {
  before(async () => {
    baselineServer = await startServer({
      getRaceFeed: buildAuthorizationCandidates({ prisma, broad: true }).getRaceFeed,
      getRaceInventory: buildAuthorizationCandidates({ prisma, broad: true }).getRaceInventory,
    });
    // The candidate must execute the submitted production query functions via
    // the normal router, with no injected replacement.
    candidateServer = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  after(async () => {
    await baselineServer?.close();
    await prisma.$disconnect();
  });

  it("routes baseline and candidate through the real race router and preserves decisions/bodies", async () => {
    for (const size of [20, 500]) {
      await cleanDatabase();
      const fixture = await makeFixture(size);
      for (const [path, expected] of [
        [`/races/${fixture.race.id}/feed`, 200],
        [`/races/${fixture.race.id}/inventory`, 200],
        [`/races/${fixture.race.id}/active-impact-notices`, 200],
      ]) {
        const baseline = await readEndpoint(baselineServer, path, fixture.viewer.token);
        const candidate = await readEndpoint(candidateServer, path, fixture.viewer.token);
        assert.equal(baseline.status, expected);
        assert.equal(candidate.status, baseline.status);
        assert.deepEqual(candidate.body, baseline.body);
      }
    }
  });

  it("preserves denied and seeded-membership behavior", async () => {
    const fixture = await makeFixture(20, { status: "INVITED", seeded: true });
    const outsider = await createTestUser({ displayName: "Outsider" });
    for (const token of [fixture.viewer.token, outsider.token]) {
      for (const route of ["feed", "inventory"]) {
        const baseline = await readEndpoint(baselineServer, `/races/${fixture.race.id}/${route}`, token);
        const candidate = await readEndpoint(candidateServer, `/races/${fixture.race.id}/${route}`, token);
        assert.equal(candidate.status, baseline.status);
        assert.deepEqual(candidate.body, baseline.body);
      }
    }
  });

  it("preserves pending, rejected, forfeited, and completed-race behavior", async () => {
    for (const status of ["INVITED", "DECLINED", "ACCEPTED"]) {
      const fixture = await makeFixture(20, { status });
      for (const route of ["feed", "inventory"]) {
        const baseline = await readEndpoint(baselineServer, `/races/${fixture.race.id}/${route}`, fixture.viewer.token);
        const candidate = await readEndpoint(candidateServer, `/races/${fixture.race.id}/${route}`, fixture.viewer.token);
        assert.equal(candidate.status, baseline.status);
        assert.deepEqual(candidate.body, baseline.body);
      }
      await cleanDatabase();
    }
    const completed = await makeFixture(20, { raceStatus: "COMPLETED" });
    for (const route of ["feed", "inventory"]) {
      const baseline = await readEndpoint(baselineServer, `/races/${completed.race.id}/${route}`, completed.viewer.token);
      const candidate = await readEndpoint(candidateServer, `/races/${completed.race.id}/${route}`, completed.viewer.token);
      assert.equal(candidate.status, baseline.status);
      assert.deepEqual(candidate.body, baseline.body);
    }
  });

  it("preserves feed name redaction inputs and inventory filtering with populated data", async () => {
    const fixture = await makeFixture(20);
    const [viewerParticipant, namedParticipant] = await prisma.raceParticipant.findMany({
      where: { raceId: fixture.race.id },
      orderBy: { joinedAt: "asc" },
      take: 2,
      include: { user: { select: { displayName: true } } },
    });
    await prisma.racePowerupEvent.create({
      data: {
        raceId: fixture.race.id,
        actorUserId: namedParticipant.userId,
        targetUserId: fixture.viewer.user.id,
        eventType: "POWERUP_USED",
        powerupType: "RUNNERS_HIGH",
        description: `${namedParticipant.user.displayName} used Runner's High!`,
        metadata: {},
      },
    });
    await prisma.racePowerup.createMany({
      data: [
        { raceId: fixture.race.id, participantId: viewerParticipant.id, userId: fixture.viewer.user.id, type: "RUNNERS_HIGH", rarity: "COMMON", status: "HELD", earnedAtSteps: 10 },
        { raceId: fixture.race.id, participantId: viewerParticipant.id, userId: fixture.viewer.user.id, type: "QUICKSAND", rarity: "COMMON", status: "HELD", earnedAtSteps: 20 },
        { raceId: fixture.race.id, participantId: viewerParticipant.id, userId: fixture.viewer.user.id, type: "MYSTERY_BOX", rarity: "COMMON", status: "MYSTERY_BOX", earnedAtSteps: 30 },
      ],
    });
    const baselineFeed = await readEndpoint(baselineServer, `/races/${fixture.race.id}/feed`, fixture.viewer.token);
    const candidateFeed = await readEndpoint(candidateServer, `/races/${fixture.race.id}/feed`, fixture.viewer.token);
    assert.deepEqual(candidateFeed.body, baselineFeed.body);
    assert.ok(baselineFeed.body.events.some((event) => event.description.includes(namedParticipant.user.displayName)));
    const baselineInventory = await readEndpoint(baselineServer, `/races/${fixture.race.id}/inventory`, fixture.viewer.token);
    const candidateInventory = await readEndpoint(candidateServer, `/races/${fixture.race.id}/inventory`, fixture.viewer.token);
    assert.deepEqual(candidateInventory.body, baselineInventory.body);
    assert.ok(Array.isArray(baselineInventory.body.inventory));
    assert.ok(Array.isArray(baselineInventory.body.mysteryBoxes));
  });

  it("measures actual endpoint work at every race size", async (t) => {
    const reports = [];
    for (const size of SIZES) {
      await cleanDatabase();
      const fixture = await makeFixture(size);
      for (const flow of ["feed", "inventory", "impact"]) {
        const path = flow === "feed"
          ? `/races/${fixture.race.id}/feed`
          : flow === "inventory"
            ? `/races/${fixture.race.id}/inventory`
            : `/races/${fixture.race.id}/active-impact-notices`;
        const baselineSamples = [];
        const candidateSamples = [];
        for (let repetition = 0; repetition < 5; repetition += 1) {
          const baseline = await readEndpoint(baselineServer, path, fixture.viewer.token);
          const candidate = await readEndpoint(candidateServer, path, fixture.viewer.token);
          assert.equal(candidate.status, baseline.status);
          assert.deepEqual(candidate.body, baseline.body);
          baselineSamples.push(baseline);
          candidateSamples.push(candidate);
        }
        const summarize = (samples, kind) => {
          const sorted = samples.map((sample) => sample.endpointMs).sort((a, b) => a - b);
          const representative = samples[0];
          const candidateFeed = kind === "candidate" && flow === "feed";
          return {
            sql: representative.sql,
            dbExecutionMs: representative.dbExecutionMs,
            participantRows: candidateFeed
              ? 2
              : participantRowsFor(flow, kind, size, representative.participantQueries),
            responseBytes: representative.responseBytes,
            p50: sorted[2],
            p95: sorted[4],
          };
        };
        reports.push({
          flow,
          size,
          baseline: summarize(baselineSamples, "baseline"),
          candidate: summarize(candidateSamples, "candidate"),
        });
      }
    }
    t.diagnostic(`RACE_AUTHORIZATION_PROJECTION_BENCHMARK ${JSON.stringify(reports)}`);
    assert.equal(reports.length, SIZES.length * 3);
    assert.ok(reports.filter((r) => r.flow === "inventory").every((r) => r.candidate.sql <= r.baseline.sql && r.candidate.participantRows === 1));
    assert.ok(reports.filter((r) => r.flow === "feed").every((r) => r.candidate.participantRows <= 2));
    assert.ok(reports.filter((r) => r.flow === "impact").every((r) => r.candidate.participantRows === r.baseline.participantRows));
  }, { timeout: 120000 });
});
