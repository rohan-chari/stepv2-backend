const assert = require("node:assert/strict");
const { before, beforeEach, afterEach, describe, it } = require("node:test");
const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildResolvedImpactBoundaryScheduler,
} = require("../../src/modules/races/jobs/resolvedImpactBoundaryScheduler");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");
const {
  RaceActiveEffect,
} = require("../../src/modules/powerups/models/raceActiveEffect");
const {
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");
const {
  buildRecomputePlacements,
} = require("../../src/modules/races/jobs/placementRecompute");

const V2_HEADERS = {
  "X-Client-Features": "resolved_impact_events_v2,impact_notices",
};
const V2_POWERUP_HEADERS = {
  "X-Client-Features":
    "resolved_impact_events_v2,impact_notices,characters,powerups3,powerups4,powerups5",
};

let server;

async function createRaceWithParticipants(users, status = "ACTIVE", overrides = {}) {
  const race = await prisma.race.create({
    data: {
      creatorId: users[0].user.id,
      name: "Resolved impact v2 race",
      targetSteps: 10000,
      status,
      startedAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 3_600_000),
      powerupsEnabled: true,
      ...overrides,
    },
  });
  await prisma.raceParticipant.createMany({
    data: users.map(({ user }) => ({
      raceId: race.id,
      userId: user.id,
      status: "ACCEPTED",
    })),
  });
  return race;
}

async function createResolvedImpact({
  race,
  recipient,
  sourceFeedEventId = null,
  sourceId = `effect-${Date.now()}-${Math.random()}`,
  resolvedAt = new Date("2026-08-19T16:30:00.000Z"),
}) {
  return prisma.raceImpactEvent.create({
    data: {
      raceId: race.id,
      recipientUserId: recipient.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId,
      sourceFeedEventId,
      powerupType: "LEECH",
      deltaSteps: -426,
      description: "Leech drained 426 synced steps.",
      resolvedAt,
    },
  });
}

async function grantHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  return prisma.racePowerup.create({ data: {
    raceId,
    participantId: participant.id,
    userId,
    type,
    rarity: "COMMON",
    status: "HELD",
    earnedAtSteps,
  } });
}

async function usePowerupPublicly(user, raceId, powerupId, body = {}) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${powerupId}/use`, {
    token: user.token,
    headers: V2_POWERUP_HEADERS,
    body,
  });
}

async function drainResolutionWorker(maxAttempts = 20) {
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    logger: { log() {}, error() {} },
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!(await worker.processOne())) break;
  }
}

async function scheduleNaturalEffectBoundaries() {
  await buildRecomputePlacements({
    requestStepSyncForUsers: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  })();
}

describe("resolved impact events v2 HTTP contract", () => {
  before(async () => { server = await getSharedServer(); });

  beforeEach(async () => {
    await cleanDatabase();
    await appSettings.setFlagsAtomically([
      ["apiActiveImpactNoticesV1Enabled", false],
      ["apiImpactNoticesEnabled", true],
    ]);
  });

  afterEach(async () => {
    await appSettings.setFlagsAtomically([
      ["apiActiveImpactNoticesV1Enabled", false],
      ["apiImpactNoticesEnabled", false],
    ]);
  });

  it("performs zero v2 source reads for an ordinary STEP_SYNC with no due source", async () => {
    const runner = await createTestUser({ displayName: "Ordinary Sync" });
    const race = await createRaceWithParticipants([runner]);
    const participant = await prisma.raceParticipant.findUniqueOrThrow({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "COMMON",
      status: "USED",
      earnedAtSteps: 1,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    const upload = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(Date.now() - 50_000).toISOString(),
        periodEnd: new Date(Date.now() - 40_000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(upload.status, 200);

    let v2SourceReads = 0;
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      RaceActiveEffect: {
        ...RaceActiveEffect,
        async findDueActiveImpactSourcesForRace(input) {
          v2SourceReads += 1;
          return RaceActiveEffect.findDueActiveImpactSourcesForRace(input);
        },
        async findActiveImpactSourcesByIds(input) {
          v2SourceReads += 1;
          return RaceActiveEffect.findActiveImpactSourcesByIds(input);
        },
        async findActiveImpactPrefixEffects(input) {
          v2SourceReads += 1;
          return RaceActiveEffect.findActiveImpactPrefixEffects(input);
        },
      },
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal(v2SourceReads, 0);
  });

  it("does not mutate retired v1 work when race expiry makes a race terminal", async () => {
    const runner = await createTestUser({ displayName: "Terminal V1 Inert" });
    const race = await createRaceWithParticipants([runner], "ACTIVE", {
      timeBased: true,
      endsAt: new Date(Date.now() - 1000),
    });
    const work = await prisma.activeRaceImpactWork.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      sourceKind: "POWERUP_EVENT",
      sourceId: `retired-v1-${Date.now()}`,
      powerupType: "PROTEIN_SHAKE",
      status: "PENDING",
      resolvedAt: new Date(),
    } });
    await resolveExpiredRaces();

    assert.equal((await prisma.race.findUniqueOrThrow({ where: { id: race.id } })).status, "COMPLETED");
    assert.equal((await prisma.activeRaceImpactWork.findUniqueOrThrow({ where: { id: work.id } })).status, "PENDING");
  });

  it("serves one canonical event to popup and private Activity and acknowledgement hides only the popup", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const row = await createResolvedImpact({ race, recipient: owner });

    const popup = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(popup.status, 200);
    assert.deepEqual(await popup.json(), {
      notices: [{
        id: `impact:${row.id}`,
        powerupType: "LEECH",
        deltaSteps: -426,
        description: "Leech drained 426 synced steps.",
        attackerDisplayName: null,
        sourceFeedEventId: null,
        impactScope: "ACTIVE_SYNCED_SNAPSHOT",
        valueStatus: "SYNCED_SNAPSHOT",
        resolvedAt: "2026-08-19T16:30:00.000Z",
      }],
      resolvedAfterApplied: false,
    });

    const feedBefore = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(feedBefore.status, 200);
    const beforeBody = await feedBefore.json();
    assert.equal(beforeBody.events.length, 1);
    assert.equal(beforeBody.events[0].id, `impact:${row.id}`);
    assert.equal(beforeBody.events[0].description, "Leech drained 426 synced steps.");
    assert.equal(beforeBody.events[0].sourceFeedEventId, null);
    assert.equal(beforeBody.events[0].impactScope, "ACTIVE_SYNCED_SNAPSHOT");

    const ack = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-notices/impact:${row.id}/acknowledge`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(ack.status, 200);
    assert.deepEqual(await ack.json(), { acknowledged: true });

    const popupAfter = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.deepEqual(await popupAfter.json(), {
      notices: [],
      resolvedAfterApplied: false,
    });

    const feedAfter = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal((await feedAfter.json()).events.length, 1);
  });

  it("filters active popup rows by the additive resolvedAfter cursor", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    await createResolvedImpact({
      race,
      recipient: owner,
      sourceId: "old-cutoff-row",
      resolvedAt: new Date("2026-08-19T16:30:00.000Z"),
    });
    const newRow = await createResolvedImpact({
      race,
      recipient: owner,
      sourceId: "new-cutoff-row",
      resolvedAt: new Date("2026-08-24T16:30:00.000Z"),
    });

    const filtered = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices?resolvedAfter=2026-08-23T00%3A00%3A00.000Z`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(filtered.status, 200);
    assert.deepEqual(
      (await filtered.json()).notices.map((notice) => notice.id),
      [`impact:${newRow.id}`],
    );

    const invalid = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices?resolvedAfter=not-a-date`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, "INVALID_QUERY");
  });

  it("serves active v2 Activity when the legacy impact gate is off and keeps terminal Activity behind it", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const row = await createResolvedImpact({ race, recipient: owner });
    await appSettings.setFlag("apiImpactNoticesEnabled", false);

    const active = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed`,
      {
        token: owner.token,
        headers: { "X-Client-Features": "resolved_impact_events_v2" },
      },
    );
    assert.equal(active.status, 200);
    assert.deepEqual((await active.json()).events.map((event) => event.id), [
      `impact:${row.id}`,
    ]);

    await prisma.race.update({
      where: { id: race.id },
      data: { status: "COMPLETED" },
    });
    const terminal = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed`,
      {
        token: owner.token,
        headers: { "X-Client-Features": "resolved_impact_events_v2" },
      },
    );
    assert.equal(terminal.status, 404);
    assert.equal((await terminal.json()).code, "FEATURE_DISABLED");
  });

  it("requires only the v2 capability and never exposes v1 rows", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    await createResolvedImpact({ race, recipient: owner });
    await prisma.activeRaceImpactWork.create({
      data: {
        raceId: race.id,
        recipientUserId: owner.user.id,
        sourceKind: "POWERUP_EVENT",
        sourceId: "v1-inert-source",
        powerupType: "PROTEIN_SHAKE",
        status: "PENDING",
        resolvedAt: new Date(),
      },
    });

    const oldClient = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      {
        token: owner.token,
        headers: { "X-Client-Features": "active_impact_notices_v1,impact_notices" },
      },
    );
    assert.equal(oldClient.status, 404);
    assert.equal((await oldClient.json()).code, "FEATURE_DISABLED");

    const capable = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(capable.status, 200);
    assert.equal((await capable.json()).notices.length, 1);
  });

  it("always materializes timed and Umbrella sources without a rollout setting", async () => {
    const caster = await createTestUser({ displayName: "Always On Caster" });
    const runner = await createTestUser({ displayName: "Always On Runner" });
    const race = await createRaceWithParticipants([caster, runner]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(current.getTime() + 2 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const timedPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 2050,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: timedPowerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(current.getTime() - 10 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    await prisma.stepSample.create({ data: {
      userId: runner.user.id,
      periodStart: new Date(current.getTime() - 60 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 50 * 60 * 1000),
      steps: 1000,
    } });

    const umbrellaPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "UMBRELLA",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 2051,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: umbrellaPowerup.id,
      type: "UMBRELLA",
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    const rainstorm = await grantHeldPowerup(race.id, caster.user.id, "RAINSTORM", 2052);
    assert.equal((await usePowerupPublicly(caster, race.id, rainstorm.id)).status, 200);
    assert.equal(await prisma.raceUmbrellaInterception.count({ where: { raceId: race.id } }), 1);

    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 40 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 30 * 60 * 1000).toISOString(),
        steps: 1,
      }] },
    });
    assert.equal(sync.status, 200);
    await scheduleNaturalEffectBoundaries();
    await drainResolutionWorker();
    const progress = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/progress`,
      { token: runner.token },
    );
    assert.equal(progress.status, 200);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "EXPIRED");
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 1);
    assert.equal(await prisma.raceUmbrellaInterception.count({ where: { raceId: race.id } }), 1);
  });

  it("keeps participant authorization nondisclosing and terminal behavior deterministic", async () => {
    const owner = await createTestUser();
    const outsider = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const row = await createResolvedImpact({ race, recipient: owner });

    const foreignRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: outsider.token, headers: V2_HEADERS },
    );
    assert.equal(foreignRead.status, 403);

    const foreignAck = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-notices/impact:${row.id}/acknowledge`,
      { token: outsider.token, headers: V2_HEADERS },
    );
    assert.equal(foreignAck.status, 404);
    assert.equal((await foreignAck.json()).code, "NOT_FOUND");

    await prisma.race.update({ where: { id: race.id }, data: { status: "COMPLETED" } });
    const terminalRead = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.deepEqual(await terminalRead.json(), {
      notices: [],
      resolvedAfterApplied: false,
    });

    const terminalAck = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-notices/impact:${row.id}/acknowledge`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(terminalAck.status, 409);
    assert.equal((await terminalAck.json()).code, "RACE_NOT_ACTIVE");
  });

  it("deletes v2 active rows with an account without touching final-impact retention rules", async () => {
    const owner = await createTestUser({ displayName: "Delete Impact Owner" });
    const race = await createRaceWithParticipants([owner]);
    const impact = await createResolvedImpact({ race, recipient: owner });

    const response = await request(server.baseUrl, "DELETE", "/auth/account", {
      token: owner.token,
    });
    assert.equal(response.status, 204);
    assert.equal(await prisma.user.findUnique({ where: { id: owner.user.id } }), null);
    assert.equal(await prisma.raceImpactEvent.findUnique({ where: { id: impact.id } }), null);
  });

  it("keeps active-v2 and terminal-authoritative cursors independent and rejects version skew", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const activeRows = [];
    for (let index = 0; index < 3; index++) {
      activeRows.push(await createResolvedImpact({
        race,
        recipient: owner,
        sourceId: `active-cursor-${index}`,
        resolvedAt: new Date(Date.UTC(2026, 7, 19, 16, 30 - index)),
      }));
    }

    const firstActive = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed?limit=2`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(firstActive.status, 200);
    const firstActiveBody = await firstActive.json();
    assert.deepEqual(
      firstActiveBody.events.map((event) => event.id),
      activeRows.slice(0, 2).map((row) => `impact:${row.id}`),
    );
    const activeCursor = JSON.parse(
      Buffer.from(firstActiveBody.nextCursor, "base64url").toString("utf8"),
    );
    assert.deepEqual(Object.keys(activeCursor).sort(), ["id", "resolvedAt", "version"]);
    assert.equal(activeCursor.version, 2);

    const secondActive = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed?limit=2&cursor=${encodeURIComponent(firstActiveBody.nextCursor)}`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(secondActive.status, 200);
    assert.deepEqual(
      (await secondActive.json()).events.map((event) => event.id),
      [`impact:${activeRows[2].id}`],
    );

    const terminalRows = [];
    for (let index = 0; index < 3; index++) {
      terminalRows.push(await prisma.raceEffectImpact.create({ data: {
        raceId: race.id,
        userId: owner.user.id,
        effectId: `terminal-cursor-${index}`,
        powerupType: "LEECH",
        deltaSteps: -(index + 1),
        settledAt: new Date(Date.UTC(2026, 7, 20, 16, 30 - index)),
      } }));
    }
    await prisma.race.update({ where: { id: race.id }, data: { status: "COMPLETED" } });

    const activeCursorOnTerminal = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed?limit=2&cursor=${encodeURIComponent(firstActiveBody.nextCursor)}`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(activeCursorOnTerminal.status, 400);
    assert.equal((await activeCursorOnTerminal.json()).code, "INVALID_CURSOR");

    const firstTerminal = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed?limit=2`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(firstTerminal.status, 200);
    const firstTerminalBody = await firstTerminal.json();
    assert.deepEqual(
      firstTerminalBody.events.map((event) => event.id),
      terminalRows.slice(0, 2).map((row) => `impact:${row.id}`),
    );
    assert.equal(
      firstTerminalBody.events.some((event) => activeRows.some((row) => event.id === `impact:${row.id}`)),
      false,
    );
    const terminalCursor = JSON.parse(
      Buffer.from(firstTerminalBody.nextCursor, "base64url").toString("utf8"),
    );
    assert.deepEqual(Object.keys(terminalCursor).sort(), ["createdAt", "id"]);

    await prisma.race.update({ where: { id: race.id }, data: { status: "ACTIVE" } });
    const terminalCursorOnActive = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/private-impact-feed?limit=2&cursor=${encodeURIComponent(firstTerminalBody.nextCursor)}`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(terminalCursorOnActive.status, 400);
    assert.equal((await terminalCursorOnActive.json()).code, "INVALID_CURSOR");
  });

  it("materializes direct impact sources from a frozen-client cast without leaking the v2 receipt", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const powerup = await grantHeldPowerup(
      race.id,
      owner.user.id,
      "PROTEIN_SHAKE",
      1000,
    );

    const use = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${powerup.id}/use`,
      {
        token: owner.token,
        headers: { "X-Client-Features": "characters,powerups3,powerups4,powerups5" },
        body: {},
      },
    );
    assert.equal(use.status, 200);
    const useBody = await use.json();
    assert.equal(useBody.activeImpactReceipt, undefined);

    const rows = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, recipientUserId: owner.user.id },
      include: { sourceFeedEvent: true },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].powerupType, "PROTEIN_SHAKE");
    assert.equal(rows[0].deltaSteps, useBody.result.bonus);
    assert.equal(rows[0].sourceFeedEventId, rows[0].sourceFeedEvent.id);
    assert.match(rows[0].description, new RegExp(`${useBody.result.bonus.toLocaleString("en-US")} synced steps`));

    const popup = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/active-impact-notices`,
      { token: owner.token, headers: V2_HEADERS },
    );
    const body = await popup.json();
    assert.equal(body.notices[0].id, `impact:${rows[0].id}`);
    assert.equal(body.notices[0].description, rows[0].description);
  });

  it("returns the canonical actor event as an inline receipt to a v2-capable caster", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const powerup = await grantHeldPowerup(
      race.id,
      owner.user.id,
      "PROTEIN_SHAKE",
      2000,
    );
    const use = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${powerup.id}/use`,
      { token: owner.token, headers: V2_HEADERS, body: {} },
    );
    assert.equal(use.status, 200);
    const body = await use.json();
    const event = await prisma.raceImpactEvent.findFirst({
      where: { raceId: race.id, recipientUserId: owner.user.id },
    });
    assert.deepEqual(body.activeImpactReceipt, {
      id: `impact:${event.id}`,
      raceId: race.id,
    });

    const ack = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-receipts/${body.activeImpactReceipt.id}/acknowledge`,
      { token: owner.token, headers: V2_HEADERS },
    );
    assert.equal(ack.status, 200);
    assert.ok((await prisma.raceImpactEvent.findUnique({ where: { id: event.id } })).popupAcknowledgedAt);
  });

  it("keeps actor receipt acknowledgement isolated from direct-effect victims", async () => {
    const actor = await createTestUser({ displayName: "Direct Actor" });
    const victim = await createTestUser({ displayName: "Direct Victim" });
    const race = await createRaceWithParticipants([actor, victim]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
      data: { totalSteps: 1200 },
    });
    const shortcut = await grantHeldPowerup(race.id, actor.user.id, "SHORTCUT", 2200);
    const response = await usePowerupPublicly(actor, race.id, shortcut.id, {
      targetUserId: victim.user.id,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.stolen, 1000);
    assert.equal(typeof body.activeImpactReceipt?.id, "string");

    const impacts = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, powerupType: "SHORTCUT" },
      orderBy: { deltaSteps: "asc" },
    });
    assert.deepEqual(
      impacts.map((impact) => [impact.recipientUserId, impact.deltaSteps]),
      [[victim.user.id, -1000], [actor.user.id, 1000]],
    );
    const actorImpact = impacts.find((impact) => impact.recipientUserId === actor.user.id);
    const victimImpact = impacts.find((impact) => impact.recipientUserId === victim.user.id);
    assert.equal(body.activeImpactReceipt.id, `impact:${actorImpact.id}`);
    const ack = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/active-impact-receipts/${body.activeImpactReceipt.id}/acknowledge`,
      { token: actor.token, headers: V2_HEADERS },
    );
    assert.equal(ack.status, 200);
    assert.ok((await prisma.raceImpactEvent.findUnique({ where: { id: actorImpact.id } })).popupAcknowledgedAt);
    assert.equal((await prisma.raceImpactEvent.findUnique({ where: { id: victimImpact.id } })).popupAcknowledgedAt, null);
  });

  it("attributes a reflected Shortcut to the actual debit and credit recipients", async () => {
    const attacker = await createTestUser({ displayName: "Shortcut Attacker" });
    const defender = await createTestUser({ displayName: "Mirror Defender" });
    const race = await createRaceWithParticipants([attacker, defender]);
    const attackerParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
      data: { totalSteps: 5000 },
    });
    const defenderParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: defender.user.id } },
      data: { totalSteps: 5000 },
    });
    const mirror = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: defenderParticipant.id,
      userId: defender.user.id,
      type: "MIRROR",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 2300,
    } });
    await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: defenderParticipant.id,
      targetUserId: defender.user.id,
      sourceUserId: defender.user.id,
      powerupId: mirror.id,
      type: "MIRROR",
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    } });
    const shortcut = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "SHORTCUT",
      rarity: "RARE",
      status: "HELD",
      earnedAtSteps: 2301,
    } });
    const response = await usePowerupPublicly(attacker, race.id, shortcut.id, {
      targetUserId: defender.user.id,
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.outcome, "REFLECTED");
    const impacts = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, powerupType: "SHORTCUT" },
      orderBy: { deltaSteps: "asc" },
    });
    assert.deepEqual(
      impacts.map((impact) => [impact.recipientUserId, impact.deltaSteps]),
      [[attacker.user.id, -1000], [defender.user.id, 1000]],
    );
  });

  it("covers every direct-effect family and omits blocked zero-consequences", async () => {
    const runner = await createTestUser({ displayName: "Direct Matrix Runner" });
    const leader = await createTestUser({ displayName: "Direct Matrix Leader" });
    const race = await createRaceWithParticipants([runner, leader]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
      data: { totalSteps: 1000 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: leader.user.id } },
      data: { totalSteps: 10_000 },
    });
    const uses = [
      ["RED_CARD", {}],
      ["PINECONE_TOSS", { targetDirection: "FRONT" }],
      ["SECOND_WIND", {}],
      ["TRAIL_MIX", {}],
    ];
    for (let index = 0; index < uses.length; index++) {
      const [type, body] = uses[index];
      const held = await grantHeldPowerup(race.id, runner.user.id, type, 2400 + index);
      const response = await usePowerupPublicly(runner, race.id, held.id, body);
      assert.equal(response.status, 200, `${type} public use should succeed`);
    }
    const rows = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, sourceKind: "POWERUP_EVENT" },
      select: { powerupType: true },
    });
    assert.deepEqual(
      new Set(rows.map((row) => row.powerupType)),
      new Set(uses.map(([type]) => type)),
    );

    const socks = await grantHeldPowerup(
      race.id,
      leader.user.id,
      "COMPRESSION_SOCKS",
      2490,
    );
    assert.equal((await usePowerupPublicly(leader, race.id, socks.id)).status, 200);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: leader.user.id } },
      data: { totalSteps: 100_000 },
    });
    const before = await prisma.raceImpactEvent.count({ where: { raceId: race.id } });
    const blocked = await grantHeldPowerup(
      race.id,
      runner.user.id,
      "PINECONE_TOSS",
      2491,
    );
    const blockedUse = await usePowerupPublicly(runner, race.id, blocked.id, {
      targetDirection: "FRONT",
    });
    assert.equal(blockedUse.status, 200);
    assert.equal((await blockedUse.json()).result.outcome, "BLOCKED");
    assert.equal(await prisma.raceImpactEvent.count({ where: { raceId: race.id } }), before);
  });

  it("materializes positive and offensive Mystery Potion outcomes through v2", async () => {
    const caster = await createTestUser({ displayName: "Potion Caster" });
    const victim = await createTestUser({ displayName: "Potion Victim" });
    const race = await createRaceWithParticipants([caster, victim]);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: caster.user.id } },
      data: { totalSteps: 5000 },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
      data: { totalSteps: 100_000 },
    });
    const offensive = new Set(["PINECONE_TOSS", "SHORTCUT"]);
    let sawPositive = false;
    let sawOffensive = false;
    for (let attempt = 0; attempt < 80 && (!sawPositive || !sawOffensive); attempt++) {
      const potion = await grantHeldPowerup(
        race.id,
        caster.user.id,
        "MYSTERY_POTION",
        2600 + attempt,
      );
      const response = await usePowerupPublicly(caster, race.id, potion.id);
      assert.equal(response.status, 200);
      const result = (await response.json()).result;
      if (result.rolled === "PROTEIN_SHAKE") sawPositive = true;
      if (offensive.has(result.rolled) && result.blocked !== true) sawOffensive = true;
    }
    assert.equal(sawPositive, true);
    assert.equal(sawOffensive, true);
    const rows = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, sourceKind: "POWERUP_EVENT" },
      select: { powerupType: true },
    });
    assert.ok(rows.some((row) => row.powerupType === "PROTEIN_SHAKE"));
    assert.ok(rows.some((row) => offensive.has(row.powerupType)));
  });

  it("rolls back the direct consequence, source event, and powerup consumption when the private event insert fails", async () => {
    const owner = await createTestUser();
    const race = await createRaceWithParticipants([owner]);
    const participantBefore = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: owner.user.id } },
    });
    const powerup = await grantHeldPowerup(
      race.id,
      owner.user.id,
      "PROTEIN_SHAKE",
      2500,
    );

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION fail_resolved_impact_v2_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'intentional resolved-impact insert failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_resolved_impact_v2_insert_trigger
      BEFORE INSERT ON race_impact_events
      FOR EACH ROW EXECUTE FUNCTION fail_resolved_impact_v2_insert()
    `);
    try {
      const use = await request(
        server.baseUrl,
        "POST",
        `/races/${race.id}/powerups/${powerup.id}/use`,
        { token: owner.token, headers: V2_HEADERS, body: {} },
      );
      assert.equal(use.status, 500);

      const [participantAfter, powerupAfter, sharedEvents, privateEvents] = await Promise.all([
        prisma.raceParticipant.findUnique({ where: { id: participantBefore.id } }),
        prisma.racePowerup.findUnique({ where: { id: powerup.id } }),
        prisma.racePowerupEvent.findMany({ where: { raceId: race.id } }),
        prisma.raceImpactEvent.findMany({ where: { raceId: race.id } }),
      ]);
      assert.equal(participantAfter.bonusSteps, participantBefore.bonusSteps);
      assert.equal(powerupAfter.status, "HELD");
      assert.equal(sharedEvents.length, 0);
      assert.equal(privateEvents.length, 0);
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS fail_resolved_impact_v2_insert_trigger ON race_impact_events",
      );
      await prisma.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS fail_resolved_impact_v2_insert()",
      );
    }
  });

  it("resolves an indexed Umbrella interception at its true boundary without scanning a 6,000-row feed", async () => {
    const caster = await createTestUser({ displayName: "Storm Caster" });
    const protectedRunner = await createTestUser({ displayName: "Umbrella Runner" });
    const race = await createRaceWithParticipants([caster, protectedRunner]);
    const protectedParticipant = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: { raceId: race.id, userId: protectedRunner.user.id },
      },
    });
    const umbrellaPowerup = await grantHeldPowerup(
      race.id,
      protectedRunner.user.id,
      "UMBRELLA",
      3100,
    );
    await prisma.racePowerup.update({
      where: { id: umbrellaPowerup.id },
      data: { status: "USED", usedAt: new Date() },
    });
    const umbrellaEffect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: protectedParticipant.id,
      targetUserId: protectedRunner.user.id,
      sourceUserId: protectedRunner.user.id,
      powerupId: umbrellaPowerup.id,
      type: "UMBRELLA",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const rainstorm = await grantHeldPowerup(
      race.id,
      caster.user.id,
      "RAINSTORM",
      3200,
    );

    const cast = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${rainstorm.id}/use`,
      {
        token: caster.token,
        headers: {
          "X-Client-Features":
            "resolved_impact_events_v2,impact_notices,powerups3,powerups4,powerups5",
        },
        body: {},
      },
    );
    assert.equal(cast.status, 200);
    const interception = await prisma.raceUmbrellaInterception.findUnique({
      where: {
        rainstormPowerupId_recipientUserId: {
          rainstormPowerupId: rainstorm.id,
          recipientUserId: protectedRunner.user.id,
        },
      },
    });
    assert.ok(interception);
    assert.equal(interception.umbrellaEffectId, umbrellaEffect.id);
    assert.equal(interception.status, "PENDING");
    assert.equal((await prisma.racePowerup.findUnique({ where: { id: rainstorm.id } })).status, "USED");
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: interception.id } }), 0);

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    // The ordinary powerup-mutation generation must not inspect/resolve the
    // future interception. Only the indexed due-boundary scheduler may enqueue
    // the domain boundary generation.
    assert.ok(await worker.processOne());
    assert.equal((await prisma.raceUmbrellaInterception.findUnique({
      where: { id: interception.id },
    })).status, "PENDING");

    const resolvesAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const windowStart = new Date(resolvesAt.getTime() - 60 * 60 * 1000);
    await prisma.raceUmbrellaInterception.update({
      where: { id: interception.id },
      data: { windowStart, resolvesAt },
    });
    await prisma.stepSample.create({ data: {
      userId: protectedRunner.user.id,
      periodStart: windowStart,
      periodEnd: resolvesAt,
      steps: 1001,
    } });

    const history = Array.from({ length: 6000 }, (_, index) => ({
      raceId: race.id,
      actorUserId: caster.user.id,
      eventType: "POWERUP_USED",
      powerupType: "PROTEIN_SHAKE",
      description: `Historical feed event ${index}`,
      createdAt: new Date(windowStart.getTime() - index * 1000),
    }));
    for (let index = 0; index < history.length; index += 1000) {
      await prisma.racePowerupEvent.createMany({ data: history.slice(index, index + 1000) });
    }

    const boundaryScheduler = buildResolvedImpactBoundaryScheduler({
      now: () => new Date(),
    });
    assert.equal(await boundaryScheduler.tick(), 1);
    assert.ok(await worker.processOne());

    const [resolvedSource, impact, feedCount] = await Promise.all([
      prisma.raceUmbrellaInterception.findUnique({ where: { id: interception.id } }),
      prisma.raceImpactEvent.findFirst({ where: {
        raceId: race.id,
        recipientUserId: protectedRunner.user.id,
        sourceId: interception.id,
        calculationVersion: 2,
      } }),
      prisma.racePowerupEvent.count({ where: { raceId: race.id } }),
    ]);
    assert.equal(feedCount, 6001);
    assert.equal(resolvedSource.status, "RESOLVED");
    assert.ok(resolvedSource.resolvedAt);
    assert.equal(impact.deltaSteps, 500);
    assert.equal(impact.powerupType, "UMBRELLA");
    assert.equal(impact.sourceFeedEventId, null);
  });

  it("preserves the Umbrella discriminator while resolving nine interceptions as eight then one", async () => {
    const runner = await createTestUser({ displayName: "Umbrella Continuation" });
    const race = await createRaceWithParticipants([runner]);
    const current = new Date();
    const resolvesAt = new Date(current.getTime() - 60_000);
    const windowStart = new Date(resolvesAt.getTime() - 60_000);
    const sources = [];
    for (let index = 0; index < 9; index++) {
      sources.push(await prisma.raceUmbrellaInterception.create({ data: {
        raceId: race.id,
        recipientUserId: runner.user.id,
        umbrellaEffectId: `umbrella-continuation-${index}`,
        rainstormPowerupId: `rain-continuation-${index}`,
        windowStart,
        resolvesAt,
        avoidedMultiplier: 0.5,
      } }));
    }
    await prisma.stepSample.create({ data: {
      userId: runner.user.id,
      periodStart: windowStart,
      periodEnd: resolvesAt,
      steps: 1000,
    } });

    const scheduler = buildResolvedImpactBoundaryScheduler({ now: () => current });
    assert.equal(await scheduler.tick(), 1);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      now: () => current,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal(await prisma.raceImpactEvent.count({ where: {
      sourceKind: "UMBRELLA_INTERCEPTION",
      sourceId: { in: sources.map((source) => source.id) },
    } }), 8);
    const continuation = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.equal(continuation.state, "QUEUED");
    assert.ok(continuation.dirtyReasons.includes("EFFECT_BOUNDARY"));
    assert.ok(continuation.dirtyPowerupTypes.includes("UMBRELLA"));

    assert.ok(await worker.processOne());
    const events = await prisma.raceImpactEvent.findMany({ where: {
      sourceKind: "UMBRELLA_INTERCEPTION",
      sourceId: { in: sources.map((source) => source.id) },
    } });
    assert.equal(events.length, 9);
    assert.equal(new Set(events.map((event) => event.sourceId)).size, 9);
    await worker.processOne();
    assert.equal(await prisma.raceImpactEvent.count({ where: {
      sourceKind: "UMBRELLA_INTERCEPTION",
      sourceId: { in: sources.map((source) => source.id) },
    } }), 9);
  });

  it("preserves the Umbrella boundary when the scheduler coalesces with FULL", async () => {
    const runner = await createTestUser({ displayName: "Umbrella Full Merge" });
    const race = await createRaceWithParticipants([runner]);
    const current = new Date();
    const resolvesAt = new Date(current.getTime() - 60_000);
    const windowStart = new Date(resolvesAt.getTime() - 60_000);
    const source = await prisma.raceUmbrellaInterception.create({ data: {
      raceId: race.id,
      recipientUserId: runner.user.id,
      umbrellaEffectId: "umbrella-full-merge",
      rainstormPowerupId: "rain-full-merge",
      windowStart,
      resolvesAt,
      avoidedMultiplier: 0.5,
    } });
    await prisma.stepSample.create({ data: {
      userId: runner.user.id,
      periodStart: windowStart,
      periodEnd: resolvesAt,
      steps: 1000,
    } });
    await RaceResolutionJobV2.enqueue({
      raceId: race.id,
      now: current,
      dirtyEnvelope: {
        reason: "FULL",
        dirtyUserIds: [],
        dirtyParticipantIds: [],
        powerupTypes: [],
        priority: "IMMEDIATE",
      },
      bypassDebounce: true,
    });
    const scheduler = buildResolvedImpactBoundaryScheduler({ now: () => current });
    assert.equal(await scheduler.tick(), 1);
    const queued = await prisma.raceResolutionJobV2.findUniqueOrThrow({
      where: { raceId: race.id },
    });
    assert.deepEqual(queued.dirtyReasons, ["FULL", "EFFECT_BOUNDARY"]);
    assert.deepEqual(queued.dirtyPowerupTypes, ["UMBRELLA"]);

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      now: () => current,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal((await prisma.raceUmbrellaInterception.findUnique({
      where: { id: source.id },
    })).status, "RESOLVED");
    assert.equal(await prisma.raceImpactEvent.count({
      where: { sourceKind: "UMBRELLA_INTERCEPTION", sourceId: source.id },
    }), 1);
  });

  it("suppresses due Umbrella sources for terminal and past-deadline races", async () => {
    const runner = await createTestUser({ displayName: "Suppressed Umbrella Runner" });
    const current = new Date();
    const terminalRace = await createRaceWithParticipants([runner], "COMPLETED", {
      startedAt: new Date(current.getTime() - 3_600_000),
      endsAt: new Date(current.getTime() - 60_000),
    });
    const pastDeadlineRace = await createRaceWithParticipants([runner], "ACTIVE", {
      startedAt: new Date(current.getTime() - 3_600_000),
      endsAt: new Date(current.getTime() - 60_000),
    });
    const sources = [];
    for (const [index, race] of [terminalRace, pastDeadlineRace].entries()) {
      const resolvesAt = new Date(current.getTime() - 120_000 - index * 10_000);
      const windowStart = new Date(resolvesAt.getTime() - 60_000);
      sources.push(await prisma.raceUmbrellaInterception.create({ data: {
        raceId: race.id,
        recipientUserId: runner.user.id,
        umbrellaEffectId: `suppressed-umbrella-${index}`,
        rainstormPowerupId: `suppressed-rain-${index}`,
        windowStart,
        resolvesAt,
        avoidedMultiplier: 0.5,
      } }));
      await prisma.stepSample.create({ data: {
        userId: runner.user.id,
        periodStart: windowStart,
        periodEnd: resolvesAt,
        steps: 1000,
      } });
    }

    const scheduler = buildResolvedImpactBoundaryScheduler({ now: () => current });
    assert.equal(await scheduler.tick(), 2);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      now: () => current,
      logger: { log() {}, error() {} },
    });
    while (await worker.processOne()) {}
    for (const source of sources) {
      const resolved = await prisma.raceUmbrellaInterception.findUnique({
        where: { id: source.id },
      });
      assert.equal(resolved.status, "RESOLVED");
      assert.ok(resolved.resolvedAt);
      assert.equal(await prisma.raceImpactEvent.count({
        where: { sourceKind: "UMBRELLA_INTERCEPTION", sourceId: source.id },
      }), 0);
    }
  });

  it("materializes at most eight due timed sources per generation and continues without loss or duplication", async () => {
    const runners = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        createTestUser({ displayName: `Timed Runner ${index}` })
      ),
    );
    const race = await createRaceWithParticipants(runners);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 7 * 60 * 60 * 1000);
    const effectStart = new Date(current.getTime() - 4 * 60 * 60 * 1000);
    const effectEnd = new Date(current.getTime() - 3 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(current.getTime() + 3 * 60 * 60 * 1000),
        timezone: "UTC",
        targetSteps: 100_000,
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId: race.id },
      orderBy: { userId: "asc" },
    });
    const runnerById = new Map(runners.map((runner) => [runner.user.id, runner]));
    const effects = [];
    for (let index = 0; index < participants.length; index++) {
      const participant = participants[index];
      const powerup = await prisma.racePowerup.create({ data: {
        raceId: race.id,
        participantId: participant.id,
        userId: participant.userId,
        type: "RUNNERS_HIGH",
        rarity: "COMMON",
        status: "USED",
        earnedAtSteps: 4000 + index,
      } });
      effects.push(await prisma.raceActiveEffect.create({ data: {
        raceId: race.id,
        targetParticipantId: participant.id,
        targetUserId: participant.userId,
        sourceUserId: participant.userId,
        powerupId: powerup.id,
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        startsAt: effectStart,
        expiresAt: effectEnd,
        metadata: { stepsAtBuffStart: 0 },
      } }));
      await prisma.stepSample.create({ data: {
        userId: participant.userId,
        periodStart: effectStart,
        periodEnd: effectEnd,
        steps: 1000,
      } });
    }
    await prisma.userScoringInputVersion.createMany({
      data: participants.map((participant) => ({
        userId: participant.userId,
        generation: 1n,
      })),
    });

    const enqueuer = runnerById.get(participants[0].userId);
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: enqueuer.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 30 * 60 * 1000).toISOString(),
        steps: 1,
      }] },
    });
    assert.equal(sync.status, 200);
    await scheduleNaturalEffectBoundaries();

    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal(await prisma.raceImpactEvent.count({ where: {
      raceId: race.id,
      sourceId: { in: effects.map((effect) => effect.id) },
    } }), 8);
    assert.equal(await prisma.raceActiveEffect.count({ where: {
      id: { in: effects.map((effect) => effect.id) },
      status: "ACTIVE",
    } }), 1);

    assert.ok(await worker.processOne());
    const impacts = await prisma.raceImpactEvent.findMany({ where: {
      raceId: race.id,
      sourceId: { in: effects.map((effect) => effect.id) },
    } });
    assert.equal(impacts.length, 9);
    assert.equal(new Set(impacts.map((impact) => impact.sourceId)).size, 9);
    assert.equal(impacts.every((impact) => impact.deltaSteps === 1000), true);
    assert.equal(await prisma.raceActiveEffect.count({ where: {
      id: { in: effects.map((effect) => effect.id) },
      status: "ACTIVE",
    } }), 0);
  });

  it("retries an injected timed scorer failure and materializes exactly one eventual event", async () => {
    const runner = await createTestUser({ displayName: "Retry Runner" });
    const race = await createRaceWithParticipants([runner]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    await prisma.race.update({ where: { id: race.id }, data: {
      startedAt,
      endsAt: new Date(current.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    } });
    const participant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
      data: { joinedAt: startedAt },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: runner.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 4001,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: runner.user.id,
      sourceUserId: runner.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(current.getTime() - 10 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    await prisma.stepSample.create({ data: {
      userId: runner.user.id,
      periodStart: new Date(current.getTime() - 60 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 50 * 60 * 1000),
      steps: 1000,
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: runner.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 45 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 40 * 60 * 1000).toISOString(),
        steps: 1,
      }] },
    });
    assert.equal(sync.status, 200);
    await scheduleNaturalEffectBoundaries();

    const failingWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      prefetchRaceScoringModels: async (input) => {
        return {
          stepsModel: input.stepsModel,
          stepSampleModel: input.stepSampleModel,
          raceActiveEffectModel: {
            ...input.raceActiveEffectModel,
            async findActiveImpactPrefixEffects() {
              const error = new Error("injected timed scorer failure");
              error.code = "INJECTED_SCORER_FAILURE";
              throw error;
            },
          },
        };
      },
      logger: { log() {}, error() {} },
    });
    assert.ok(await failingWorker.processOne());
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 0);

    const job = await prisma.raceResolutionJobV2.findUnique({ where: { raceId: race.id } });
    assert.equal(job.state, "QUEUED");
    assert.equal(job.lastErrorCode, "INJECTED_SCORER_FAILURE");
    await prisma.raceResolutionJobV2.update({
      where: { id: job.id },
      data: { retryAt: new Date(0) },
    });
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "EXPIRED");
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 1);
    await worker.processOne();
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 1);
  });

  it("materializes one immutable signed Leech event per recipient through C0", async () => {
    const caster = await createTestUser({ displayName: "Leech Caster" });
    const victim = await createTestUser({ displayName: "Leech Victim" });
    const race = await createRaceWithParticipants([caster, victim]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(current.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const victimParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
    });
    await prisma.stepSample.create({ data: {
      userId: victim.user.id,
      periodStart: new Date(current.getTime() - 3 * 60 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 150 * 60 * 1000),
      steps: 2000,
    } });
    await prisma.userScoringInputVersion.create({
      data: { userId: victim.user.id, generation: 1n },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: victimParticipant.id,
      userId: victim.user.id,
      type: "LEECH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 3900,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: victimParticipant.id,
      targetUserId: victim.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "LEECH",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(current.getTime() - 20 * 60 * 1000),
      metadata: { ratio: 2, scoringVersion: 2 },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: caster.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 852,
      }] },
    });
    assert.equal(sync.status, 200);
    await scheduleNaturalEffectBoundaries();
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    assert.ok(await worker.processOne());
    const rows = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, sourceId: effect.id },
      orderBy: { deltaSteps: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => [row.recipientUserId, row.deltaSteps, row.valueStatus]),
      [
        [victim.user.id, -426, "SYNCED_SNAPSHOT"],
        [caster.user.id, 426, "SYNCED_SNAPSHOT"],
      ],
    );
    await worker.processOne();
    assert.equal(await prisma.raceImpactEvent.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 2);
  });

  it("covers every remaining timed-effect family through public use and C0", async () => {
    const timedCases = [
      { type: "CAMPFIRE_REST", sampleOffsetMinutes: -20 },
      { type: "COIN_FLIP", sampleOffsetMinutes: -50 },
      { type: "GHOST_PEPPER", sampleOffsetMinutes: -50 },
      { type: "RAINSTORM", sampleOffsetMinutes: -50, sampleVictim: true },
      { type: "UPRISING", sampleOffsetMinutes: -50, teamRace: true, losingGate: true },
      { type: "RALLY_FLAG", sampleOffsetMinutes: -50, teamRace: true },
    ];
    for (let index = 0; index < timedCases.length; index++) {
      const scenario = timedCases[index];
      const runner = await createTestUser({ displayName: `${scenario.type} Runner` });
      const rival = await createTestUser({ displayName: `${scenario.type} Rival` });
      const current = new Date();
      const startedAt = new Date(current.getTime() - 2 * 60 * 60 * 1000);
      const race = await createRaceWithParticipants([runner, rival], "ACTIVE", {
        startedAt,
        endsAt: new Date(current.getTime() + 2 * 60 * 60 * 1000),
        timezone: "UTC",
        isTeamRace: scenario.teamRace === true,
      });
      await prisma.raceParticipant.updateMany({
        where: { raceId: race.id },
        data: { joinedAt: startedAt },
      });
      if (scenario.teamRace) {
        await prisma.raceParticipant.update({
          where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
          data: { team: "TEAM_A", totalSteps: 0 },
        });
        await prisma.raceParticipant.update({
          where: { raceId_userId: { raceId: race.id, userId: rival.user.id } },
          data: { team: "TEAM_B", totalSteps: scenario.losingGate ? 5000 : 0 },
        });
        if (scenario.losingGate) {
          await prisma.stepSample.create({ data: {
            userId: rival.user.id,
            periodStart: new Date(current.getTime() - 90 * 60 * 1000),
            periodEnd: new Date(current.getTime() - 80 * 60 * 1000),
            steps: 5000,
          } });
        }
      }
      const held = await grantHeldPowerup(
        race.id,
        runner.user.id,
        scenario.type,
        4000 + index,
      );
      const response = await usePowerupPublicly(runner, race.id, held.id);
      assert.equal(response.status, 200, `${scenario.type} public use should succeed`);
      const effects = await prisma.raceActiveEffect.findMany({
        where: { raceId: race.id, powerupId: held.id, type: scenario.type },
      });
      assert.ok(effects.length > 0, `${scenario.type} should create a source`);
      const startsAt = new Date(current.getTime() - 70 * 60 * 1000);
      for (const effect of effects) {
        await prisma.raceActiveEffect.update({
          where: { id: effect.id },
          data: { startsAt, expiresAt: new Date() },
        });
      }
      const sampleStart = new Date(
        current.getTime() + scenario.sampleOffsetMinutes * 60 * 1000,
      );
      await prisma.stepSample.create({ data: {
        userId: scenario.sampleVictim ? rival.user.id : runner.user.id,
        periodStart: sampleStart,
        periodEnd: new Date(sampleStart.getTime() + 10 * 60 * 1000),
        steps: 1000,
      } });
      await scheduleNaturalEffectBoundaries();
      await drainResolutionWorker();
      const sourceIds = effects.map((effect) => effect.id);
      const impacts = await prisma.raceImpactEvent.findMany({
        where: {
          raceId: race.id,
          sourceId: { in: sourceIds },
          powerupType: scenario.type,
        },
      });
      assert.equal(impacts.length, effects.length, `${scenario.type} should resolve once`);
      assert.equal(impacts.every((impact) => impact.deltaSteps !== 0), true);
    }

    const caster = await createTestUser({ displayName: "Quicksand Caster" });
    const blocked = await createTestUser({ displayName: "Quicksand Blocked" });
    const applied = await createTestUser({ displayName: "Quicksand Applied" });
    const current = new Date();
    const startedAt = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    const race = await createRaceWithParticipants([caster, blocked, applied], "ACTIVE", {
      startedAt,
      endsAt: new Date(current.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const socks = await grantHeldPowerup(race.id, blocked.user.id, "COMPRESSION_SOCKS", 4100);
    assert.equal((await usePowerupPublicly(blocked, race.id, socks.id)).status, 200);
    const sand = await grantHeldPowerup(race.id, caster.user.id, "QUICKSAND", 4101);
    const sandUse = await usePowerupPublicly(caster, race.id, sand.id, {
      targetUserIds: [blocked.user.id, applied.user.id],
    });
    assert.equal(sandUse.status, 200);
    const sandResult = (await sandUse.json()).result;
    assert.equal(sandResult.outcome, "PARTIAL");
    assert.deepEqual(
      sandResult.targetResults.map((entry) => [entry.targetUserId, entry.outcome]),
      [[blocked.user.id, "BLOCKED"], [applied.user.id, "APPLIED"]],
    );
    const sandEffect = await prisma.raceActiveEffect.findFirst({
      where: { raceId: race.id, powerupId: sand.id, type: "QUICKSAND" },
    });
    await prisma.raceActiveEffect.update({
      where: { id: sandEffect.id },
      data: {
        startsAt: new Date(current.getTime() - 60 * 60 * 1000),
        expiresAt: new Date(),
      },
    });
    await prisma.stepSample.create({ data: {
      userId: applied.user.id,
      periodStart: new Date(current.getTime() - 50 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 40 * 60 * 1000),
      steps: 1000,
    } });
    await scheduleNaturalEffectBoundaries();
    await drainResolutionWorker();
    const sandImpact = await prisma.raceImpactEvent.findFirst({
      where: { raceId: race.id, sourceId: sandEffect.id },
    });
    assert.equal(sandImpact?.deltaSteps, -1000);
  });

  it("freezes timed, Leech, and Hitchhike events atomically on ordinary leave", async () => {
    const creator = await createTestUser({ displayName: "Freeze Creator" });
    const leaver = await createTestUser({ displayName: "Freeze Leaver" });
    const current = new Date();
    const startedAt = new Date(current.getTime() - 3 * 60 * 60 * 1000);
    const race = await createRaceWithParticipants([creator, leaver], "ACTIVE", {
      startedAt,
      endsAt: new Date(current.getTime() + 3 * 60 * 60 * 1000),
      timezone: "UTC",
      exitActionsEnabled: true,
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const creatorParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: creator.user.id } },
    });
    const leaverParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: leaver.user.id } },
    });
    await prisma.stepSample.createMany({ data: [
      {
        userId: creator.user.id,
        periodStart: new Date(current.getTime() - 90 * 60 * 1000),
        periodEnd: new Date(current.getTime() - 80 * 60 * 1000),
        steps: 400,
      },
      {
        userId: leaver.user.id,
        periodStart: new Date(current.getTime() - 90 * 60 * 1000),
        periodEnd: new Date(current.getTime() - 80 * 60 * 1000),
        steps: 1000,
      },
    ] });
    const timedPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: leaverParticipant.id,
      userId: leaver.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 4200,
    } });
    const leechPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: creatorParticipant.id,
      userId: creator.user.id,
      type: "LEECH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 4201,
    } });
    const hitchPowerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: leaverParticipant.id,
      userId: leaver.user.id,
      type: "HITCHHIKE",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 4202,
    } });
    const common = {
      startsAt: new Date(current.getTime() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(current.getTime() + 60 * 60 * 1000),
      status: "ACTIVE",
    };
    const timed = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: leaverParticipant.id,
      targetUserId: leaver.user.id,
      sourceUserId: leaver.user.id,
      powerupId: timedPowerup.id,
      type: "RUNNERS_HIGH",
      metadata: { multiplier: 2 },
      ...common,
    } });
    const leech = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: leaverParticipant.id,
      targetUserId: leaver.user.id,
      sourceUserId: creator.user.id,
      powerupId: leechPowerup.id,
      type: "LEECH",
      metadata: { ratio: 2 },
      ...common,
    } });
    const hitch = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: creatorParticipant.id,
      targetUserId: creator.user.id,
      sourceUserId: leaver.user.id,
      powerupId: hitchPowerup.id,
      type: "HITCHHIKE",
      metadata: { copyRatio: 1 },
      ...common,
    } });
    const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: leaver.token,
      headers: {
        "X-Client-Features": "race_leave,resolved_impact_events_v2,impact_notices",
      },
      body: {},
    });
    assert.equal(response.status, 200);
    const rows = await prisma.raceImpactEvent.findMany({
      where: { raceId: race.id, recipientUserId: leaver.user.id },
      orderBy: { sourceId: "asc" },
    });
    assert.deepEqual(
      rows.map((row) => [row.sourceId, row.powerupType, row.deltaSteps]).sort(),
      [
        [timed.id, "RUNNERS_HIGH", 1000],
        [leech.id, "LEECH", -200],
        [hitch.id, "HITCHHIKE", 400],
      ].sort(),
    );
  });

  it("always writes the terminal impact in the leave transaction", async () => {
    const creator = await createTestUser({ displayName: "Boundary Creator" });
    const leaver = await createTestUser({ displayName: "Boundary Leaver" });
    const current = new Date();
    const startedAt = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    const race = await createRaceWithParticipants([creator, leaver], "ACTIVE", {
      startedAt,
      endsAt: new Date(current.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
      exitActionsEnabled: true,
    });
    const participant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: leaver.user.id } },
      data: { joinedAt: startedAt },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: leaver.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 4300,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: leaver.user.id,
      sourceUserId: leaver.user.id,
      powerupId: powerup.id,
      type: "RUNNERS_HIGH",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 60 * 60 * 1000),
      expiresAt: new Date(current.getTime() + 60 * 60 * 1000),
      metadata: { multiplier: 2 },
    } });
    await prisma.stepSample.create({ data: {
      userId: leaver.user.id,
      periodStart: new Date(current.getTime() - 55 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 50 * 60 * 1000),
      steps: 500,
    } });

    const response = await request(server.baseUrl, "POST", `/races/${race.id}/leave`, {
      token: leaver.token,
      headers: { "X-Client-Features": "race_leave,resolved_impact_events_v2" },
      body: {},
    });
    assert.equal(response.status, 200);
    assert.equal(await prisma.raceImpactEvent.count({
      where: { raceId: race.id, sourceId: effect.id },
    }), 1);
  });

  it("freezes more than eight live sources in one team-forfeit transaction", async () => {
    const opponent = await createTestUser({ displayName: "Forfeit Opponent" });
    const forfeiter = await createTestUser({ displayName: "Forfeiter" });
    const survivor = await createTestUser({ displayName: "Forfeit Survivor" });
    const race = await createRaceWithParticipants([opponent, forfeiter, survivor]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        isTeamRace: true,
        startedAt,
        endsAt: new Date(current.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
        targetSteps: 100_000,
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: opponent.user.id } },
      data: { team: "TEAM_A" },
    });
    const forfeiterParticipant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: forfeiter.user.id } },
      data: { team: "TEAM_B" },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: survivor.user.id } },
      data: { team: "TEAM_B" },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: forfeiterParticipant.id,
      userId: forfeiter.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 45_000,
    } });
    const effectStart = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    const effects = [];
    for (let index = 0; index < 9; index++) {
      const effectPowerup = index === 0 ? powerup : await prisma.racePowerup.create({ data: {
        raceId: race.id,
        participantId: forfeiterParticipant.id,
        userId: forfeiter.user.id,
        type: "RUNNERS_HIGH",
        rarity: "RARE",
        status: "USED",
        earnedAtSteps: 45_000 + index,
      } });
      effects.push(await prisma.raceActiveEffect.create({ data: {
        raceId: race.id,
        targetParticipantId: forfeiterParticipant.id,
        targetUserId: forfeiter.user.id,
        sourceUserId: forfeiter.user.id,
        powerupId: effectPowerup.id,
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        startsAt: effectStart,
        expiresAt: new Date(current.getTime() + 60 * 60 * 1000),
        metadata: { multiplier: 2 },
      } }));
    }
    await prisma.stepSample.create({ data: {
      userId: forfeiter.user.id,
      periodStart: effectStart,
      periodEnd: new Date(current.getTime() - 60 * 60 * 1000),
      steps: 1000,
    } });

    const response = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
      token: forfeiter.token,
      body: {},
    });
    assert.equal(response.status, 200);
    const impacts = await prisma.raceImpactEvent.findMany({
      where: {
        raceId: race.id,
        recipientUserId: forfeiter.user.id,
        sourceKind: "ACTIVE_EFFECT",
        sourceId: { in: effects.map((effect) => effect.id) },
      },
      orderBy: { sourceId: "asc" },
    });
    assert.equal(impacts.length, 9);
    assert.equal(new Set(impacts.map((impact) => impact.sourceId)).size, 9);
    assert.deepEqual(
      impacts.map((impact) => impact.deltaSteps).sort((a, b) => a - b),
      [1000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000],
    );
    assert.ok((await prisma.raceParticipant.findUnique({
      where: { id: forfeiterParticipant.id },
    })).forfeitedAt);
  });

  it("rolls back a >8-source team forfeit and retries with stable deduplication", async () => {
    const opponent = await createTestUser({ displayName: "Atomic Opponent" });
    const forfeiter = await createTestUser({ displayName: "Atomic Forfeiter" });
    const survivor = await createTestUser({ displayName: "Atomic Survivor" });
    const race = await createRaceWithParticipants([opponent, forfeiter, survivor]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 3 * 60 * 60 * 1000);
    await prisma.race.update({ where: { id: race.id }, data: {
      isTeamRace: true,
      startedAt,
      endsAt: new Date(current.getTime() + 3 * 60 * 60 * 1000),
      timezone: "UTC",
      targetSteps: 100_000,
    } });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: opponent.user.id } },
      data: { team: "TEAM_A" },
    });
    const participant = await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: forfeiter.user.id } },
      data: { team: "TEAM_B" },
    });
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: survivor.user.id } },
      data: { team: "TEAM_B" },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: forfeiter.user.id,
      type: "RUNNERS_HIGH",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 46_000,
    } });
    const effectStart = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    const effects = [];
    for (let index = 0; index < 9; index++) {
      const effectPowerup = index === 0 ? powerup : await prisma.racePowerup.create({ data: {
        raceId: race.id,
        participantId: participant.id,
        userId: forfeiter.user.id,
        type: "RUNNERS_HIGH",
        rarity: "RARE",
        status: "USED",
        earnedAtSteps: 46_000 + index,
      } });
      effects.push(await prisma.raceActiveEffect.create({ data: {
        raceId: race.id,
        targetParticipantId: participant.id,
        targetUserId: forfeiter.user.id,
        sourceUserId: forfeiter.user.id,
        powerupId: effectPowerup.id,
        type: "RUNNERS_HIGH",
        status: "ACTIVE",
        startsAt: effectStart,
        expiresAt: new Date(current.getTime() + 60 * 60 * 1000),
        metadata: { stepsAtBuffStart: 0 },
      } }));
    }
    await prisma.stepSample.create({ data: {
      userId: forfeiter.user.id,
      periodStart: effectStart,
      periodEnd: new Date(current.getTime() - 60 * 60 * 1000),
      steps: 1000,
    } });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_forfeit_v2_impact()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional forfeit impact failure'; END $$;
      CREATE TRIGGER test_fail_forfeit_v2_impact_trigger
      BEFORE INSERT ON race_impact_events
      FOR EACH ROW EXECUTE FUNCTION test_fail_forfeit_v2_impact();
    `);
    try {
      const response = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
        token: forfeiter.token,
        body: {},
      });
      assert.equal(response.status, 500);
      assert.equal((await prisma.raceParticipant.findUnique({
        where: { id: participant.id },
      })).forfeitedAt, null);
      assert.equal(await prisma.raceImpactEvent.count({ where: {
        raceId: race.id,
        sourceId: { in: effects.map((effect) => effect.id) },
      } }), 0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_forfeit_v2_impact_trigger ON race_impact_events;
        DROP FUNCTION IF EXISTS test_fail_forfeit_v2_impact();
      `);
    }

    const retry = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
      token: forfeiter.token,
      body: {},
    });
    assert.equal(retry.status, 200);
    assert.equal(await prisma.raceImpactEvent.count({ where: {
      raceId: race.id,
      sourceId: { in: effects.map((effect) => effect.id) },
    } }), 9);

    const duplicateRetry = await request(server.baseUrl, "POST", `/races/${race.id}/forfeit`, {
      token: forfeiter.token,
      body: {},
    });
    assert.equal(duplicateRetry.status, 400);
    assert.equal(await prisma.raceImpactEvent.count({ where: {
      raceId: race.id,
      sourceId: { in: effects.map((effect) => effect.id) },
    } }), 9);
  });

  it("materializes a Cleanse early-clamp from the same powerup transaction", async () => {
    const attacker = await createTestUser({ displayName: "Clamp Attacker" });
    const victim = await createTestUser({ displayName: "Clamp Victim" });
    const race = await createRaceWithParticipants([attacker, victim]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({ where: { id: race.id }, data: {
      startedAt,
      endsAt: new Date(current.getTime() + 4 * 60 * 60 * 1000),
      timezone: "UTC",
      targetSteps: 100_000,
    } });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const victimParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: victim.user.id } },
    });
    const source = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: victimParticipant.id,
      userId: attacker.user.id,
      type: "LEG_CRAMP",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: 47_000,
    } });
    const effectStart = new Date(current.getTime() - 2 * 60 * 60 * 1000);
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: victimParticipant.id,
      targetUserId: victim.user.id,
      sourceUserId: attacker.user.id,
      powerupId: source.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: effectStart,
      expiresAt: new Date(current.getTime() + 60 * 60 * 1000),
      metadata: { stepsAtFreezeStart: 0 },
    } });
    await prisma.stepSample.create({ data: {
      userId: victim.user.id,
      periodStart: effectStart,
      periodEnd: new Date(current.getTime() - 60 * 60 * 1000),
      steps: 1000,
    } });
    const cleanse = await grantHeldPowerup(race.id, victim.user.id, "CLEANSE", 47_001);

    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${cleanse.id}/use`,
      { token: victim.token, headers: V2_HEADERS, body: {} },
    );
    assert.equal(response.status, 200);
    assert.equal((await prisma.raceActiveEffect.findUnique({
      where: { id: effect.id },
    })).status, "EXPIRED");
    const impact = await prisma.raceImpactEvent.findFirst({ where: {
      raceId: race.id,
      recipientUserId: victim.user.id,
      sourceKind: "ACTIVE_EFFECT",
      sourceId: effect.id,
    } });
    assert.equal(impact?.deltaSteps, -1000);
    assert.equal((await prisma.racePowerup.findUnique({
      where: { id: cleanse.id },
    })).status, "USED");
  });

  it("does not resolve Quick Rinse or Pocket Watch edits before the edited boundary", async () => {
    const attacker = await createTestUser({ displayName: "Boundary Attacker" });
    const runner = await createTestUser({ displayName: "Boundary Runner" });
    const race = await createRaceWithParticipants([attacker, runner]);
    const current = new Date();
    const attackerParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: attacker.user.id } },
    });
    const runnerParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: runner.user.id } },
    });
    const source = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: attackerParticipant.id,
      userId: attacker.user.id,
      type: "LEG_CRAMP",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 97_000,
    } });
    const originalExpiry = new Date(current.getTime() + 60 * 60 * 1000);
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: runnerParticipant.id,
      targetUserId: runner.user.id,
      sourceUserId: attacker.user.id,
      powerupId: source.id,
      type: "LEG_CRAMP",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 10 * 60 * 1000),
      expiresAt: originalExpiry,
      metadata: { stepsAtFreezeStart: 0 },
    } });
    const rinse = await grantHeldPowerup(race.id, runner.user.id, "QUICK_RINSE", 97_001);
    assert.equal((await usePowerupPublicly(runner, race.id, rinse.id)).status, 200);
    const shortened = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(shortened.status, "ACTIVE");
    assert.ok(new Date(shortened.expiresAt) > current);
    assert.ok(new Date(shortened.expiresAt) < originalExpiry);
    assert.equal(shortened.metadata?.impactBoundaryV1?.endReason, "QUICK_RINSE");
    assert.equal(
      shortened.metadata?.impactBoundaryV1?.originalExpiresAt,
      originalExpiry.toISOString(),
    );
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 0);

    const watch = await grantHeldPowerup(race.id, attacker.user.id, "POCKET_WATCH", 97_002);
    const shortenedExpiry = new Date(shortened.expiresAt);
    const watchUse = await usePowerupPublicly(attacker, race.id, watch.id, {
      targetEffectId: effect.id,
    });
    assert.equal(watchUse.status, 200);
    const extended = await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } });
    assert.equal(extended.status, "ACTIVE");
    assert.ok(new Date(extended.expiresAt) > shortenedExpiry);
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 0);

    const dueAt = new Date(Date.now() - 1000);
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: { expiresAt: dueAt },
    });
    await prisma.userScoringInputVersion.createMany({
      data: [attacker, runner].map(({ user }) => ({
        userId: user.id,
        generation: 1n,
      })),
      skipDuplicates: true,
    });
    await scheduleNaturalEffectBoundaries();
    await drainResolutionWorker();
    await drainResolutionWorker();

    const expiryEvents = await prisma.racePowerupEvent.findMany({
      where: {
        raceId: race.id,
        eventType: "EFFECT_EXPIRED",
        powerupType: "LEG_CRAMP",
      },
    });
    assert.equal(expiryEvents.length, 1);
    assert.equal(expiryEvents[0].description, "Leg Cramp ended early.");
    assert.equal(
      await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }),
      0,
    );
  });

  it("commits an exact Trail Mine consequence and v2 event in the same C0 generation", async () => {
    const owner = await createTestUser({ displayName: "Mine Owner" });
    const victim = await createTestUser({ displayName: "Mine Victim" });
    const race = await createRaceWithParticipants([owner, victim]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 7 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: { startedAt, endsAt: new Date(current.getTime() + 4 * 60 * 60 * 1000), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId: race.id }, data: { joinedAt: startedAt } });
    const ownerParticipant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: owner.user.id } },
    });
    await prisma.stepSample.create({ data: {
      userId: owner.user.id,
      periodStart: new Date(current.getTime() - 6 * 60 * 60 * 1000),
      periodEnd: new Date(current.getTime() - 5 * 60 * 60 * 1000),
      steps: 10_000,
    } });
    await prisma.userScoringInputVersion.create({
      data: { userId: owner.user.id, generation: 1n },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: ownerParticipant.id,
      userId: owner.user.id,
      type: "TRAIL_MINE",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 900005,
    } });
    const mine = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: ownerParticipant.id,
      targetUserId: owner.user.id,
      sourceUserId: owner.user.id,
      powerupId: powerup.id,
      type: "TRAIL_MINE",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 4 * 60 * 60 * 1000),
      expiresAt: null,
      metadata: {
        ownerParticipantId: ownerParticipant.id,
        positionSteps: 10_000,
        penaltyPercent: 0.03,
        aheadParticipantIds: [],
      },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: victim.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 4 * 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 3 * 60 * 60 * 1000).toISOString(),
        steps: 13_000,
      }] },
    });
    assert.equal(sync.status, 200);
    const worker = buildRaceResolutionWorkerV2({ bootAt: 0, logger: { log() {}, error() {} } });
    assert.ok(await worker.processOne());

    const impact = await prisma.raceImpactEvent.findFirst({
      where: {
        raceId: race.id,
        recipientUserId: victim.user.id,
        sourceId: mine.id,
        calculationVersion: 2,
      },
    });
    assert.equal(impact.deltaSteps, -390);
    assert.equal(impact.powerupType, "TRAIL_MINE");
    assert.ok(impact.sourceFeedEventId);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: mine.id } })).status, "EXPIRED");
  });

  it("rolls back Drill Sergeant judgement with its v2 event, then retries once", async () => {
    const caster = await createTestUser({ displayName: "Drill Caster" });
    const target = await createTestUser({ displayName: "Drill Target" });
    const race = await createRaceWithParticipants([caster, target]);
    const current = new Date();
    const startedAt = new Date(current.getTime() - 4 * 60 * 60 * 1000);
    await prisma.race.update({
      where: { id: race.id },
      data: {
        startedAt,
        endsAt: new Date(current.getTime() + 4 * 60 * 60 * 1000),
        timezone: "UTC",
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId: race.id },
      data: { joinedAt: startedAt },
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: race.id, userId: target.user.id } },
    });
    const powerup = await prisma.racePowerup.create({ data: {
      raceId: race.id,
      participantId: participant.id,
      userId: caster.user.id,
      type: "DRILL_SERGEANT",
      rarity: "RARE",
      status: "USED",
      earnedAtSteps: 98_000,
    } });
    const effect = await prisma.raceActiveEffect.create({ data: {
      raceId: race.id,
      targetParticipantId: participant.id,
      targetUserId: target.user.id,
      sourceUserId: caster.user.id,
      powerupId: powerup.id,
      type: "DRILL_SERGEANT",
      status: "ACTIVE",
      startsAt: new Date(current.getTime() - 70 * 60 * 1000),
      expiresAt: new Date(current.getTime() - 5 * 60 * 1000),
      metadata: { goalSteps: 3000, penaltySteps: 1500, stepsAtStart: 0 },
    } });
    const sync = await request(server.baseUrl, "POST", "/steps/samples", {
      token: target.token,
      body: { samples: [{
        periodStart: new Date(current.getTime() - 60 * 60 * 1000).toISOString(),
        periodEnd: new Date(current.getTime() - 50 * 60 * 1000).toISOString(),
        steps: 100,
      }] },
    });
    assert.equal(sync.status, 200);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_drill_v2_impact()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional Drill impact failure'; END $$;
      CREATE TRIGGER test_fail_drill_v2_impact_trigger
      BEFORE INSERT ON race_impact_events
      FOR EACH ROW EXECUTE FUNCTION test_fail_drill_v2_impact();
    `);
    const worker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      logger: { log() {}, error() {} },
    });
    try {
      assert.ok(await worker.processOne());
      assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "ACTIVE");
      assert.equal((await prisma.raceParticipant.findUnique({ where: { id: participant.id } })).bonusSteps, 0);
      assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_drill_v2_impact_trigger ON race_impact_events;
        DROP FUNCTION IF EXISTS test_fail_drill_v2_impact();
      `);
    }

    const retryWorker = buildRaceResolutionWorkerV2({
      bootAt: 0,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
      logger: { log() {}, error() {} },
    });
    assert.ok(await retryWorker.processOne());
    const impact = await prisma.raceImpactEvent.findFirst({ where: {
      raceId: race.id,
      recipientUserId: target.user.id,
      sourceId: effect.id,
      calculationVersion: 2,
    } });
    assert.equal(impact?.powerupType, "DRILL_SERGEANT");
    assert.equal(impact?.deltaSteps, -100);
    assert.equal((await prisma.raceActiveEffect.findUnique({ where: { id: effect.id } })).status, "EXPIRED");
    assert.equal((await prisma.raceParticipant.findUnique({ where: { id: participant.id } })).bonusSteps, -100);
    await retryWorker.processOne();
    assert.equal(await prisma.raceImpactEvent.count({ where: { sourceId: effect.id } }), 1);
  });

  it("preserves Home all-zero global-summary filtering from the replaced suite", async () => {
    const user = await createTestUser();
    await appSettings.setFlagsAtomically([
      ["apiImpactSummariesEnabled", true],
      ["apiHomeShellV1Enabled", true],
      ["redisCacheHomeImpactSummaryEnabled", false],
    ]);
    try {
      const event = await prisma.globalStepEvent.create({ data: {
        startsAt: new Date(Date.now() - 120_000),
        endsAt: new Date(Date.now() - 60_000),
        multiplier: 2,
        summaryAttributionVersion: 2,
      } });
      const raceA = await createRaceWithParticipants([user], "COMPLETED");
      await prisma.globalEventRaceImpact.create({ data: {
        eventId: event.id,
        raceId: raceA.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: 0,
        attributionVersion: 2,
        settledAt: new Date(),
      } });
      const summary = await prisma.globalEventUserSummary.create({ data: {
        eventId: event.id,
        userId: user.user.id,
        extraRaceSteps: 0,
        raceCount: 1,
        attributionVersion: 2,
        expiresAt: new Date(Date.now() + 60_000),
      } });
      for (const features of [
        "impact_summaries,impact_summary_expiry_v1",
        "impact_summaries,impact_summary_expiry_v1,home_shell_v1",
      ]) {
        const response = await request(server.baseUrl, "GET", "/home/race-card", {
          token: user.token,
          headers: { "X-Client-Features": features },
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).globalEventSummary, undefined);
      }
      const raceB = await createRaceWithParticipants([user], "COMPLETED");
      await prisma.globalEventRaceImpact.update({
        where: {
          eventId_raceId_userId: {
            eventId: event.id,
            raceId: raceA.id,
            userId: user.user.id,
          },
        },
        data: { deltaSteps: 100 },
      });
      await prisma.globalEventRaceImpact.create({ data: {
        eventId: event.id,
        raceId: raceB.id,
        userId: user.user.id,
        status: "FINAL",
        deltaSteps: -100,
        attributionVersion: 2,
        settledAt: new Date(),
      } });
      const eligible = await request(server.baseUrl, "GET", "/home/race-card", {
        token: user.token,
        headers: { "X-Client-Features": "impact_summaries,impact_summary_expiry_v1" },
      });
      assert.equal(eligible.status, 200);
      assert.equal((await eligible.json()).globalEventSummary.id, summary.id);
    } finally {
      await appSettings.setFlagsAtomically([
        ["apiImpactSummariesEnabled", false],
        ["apiHomeShellV1Enabled", false],
        ["redisCacheHomeImpactSummaryEnabled", false],
      ]);
    }
  });
});
