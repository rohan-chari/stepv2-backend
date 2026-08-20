const assert = require("node:assert/strict");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  disconnectDatabase,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const {
  appSettings,
} = require("../../src/shared/config/appSettings");
const {
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");
const {
  RaceResolutionJobV2,
} = require("../../src/modules/races/models/raceResolutionJobV2");

let server;
let identity = 0;
const originalEnforcement = process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED;
const originalPrizeV2 = process.env.FUNDED_PRIZE_V2_ENABLED;

async function createUser() {
  const response = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `funded-exposure-${++identity}` },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  return { id: body.user.id, token: body.sessionToken };
}

function createFundedRace(user, name, maxDurationDays = 1, maxParticipants = 10) {
  return request(server.baseUrl, "POST", "/races", {
    token: user.token,
    body: {
      name,
      maxDurationDays,
      maxParticipants,
      isPublic: true,
      buyInAmount: 500,
    },
  });
}

function tournamentRequest(method, path, user, body) {
  return request(server.baseUrl, method, path, {
    token: user.token,
    body,
    headers: { "X-Client-Features": "tournaments" },
  });
}

describe("funded exposure admission", () => {
  before(async () => {
    server = await getSharedServer();
  });

  after(async () => {
    if (originalEnforcement === undefined) {
      delete process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED;
    } else {
      process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = originalEnforcement;
    }
    if (originalPrizeV2 === undefined) {
      delete process.env.FUNDED_PRIZE_V2_ENABLED;
    } else {
      process.env.FUNDED_PRIZE_V2_ENABLED = originalPrizeV2;
    }
    await server.close();
    await disconnectDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    identity = 0;
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("raceExitActionsEnabled", true);
    process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = "true";
    process.env.FUNDED_PRIZE_V2_ENABLED = "true";
  });

  it("dual-writes immutable v2 race and creator exposure stamps through POST /races", async () => {
    const user = await createUser();
    const response = await createFundedRace(user, "Stamped race", 7);
    assert.equal(response.status, 201);
    const created = (await response.json()).race;
    const raceId = created.id;
    const detailResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}`,
      { token: user.token },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.prizePool.coinUnit, 10);
    assert.equal(detail.prizePool.maxCoins, 8_000);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: user.id } },
    });
    assert.equal(race.fundedPrize, true);
    assert.equal(race.buyInAmount, 0, "legacy buy-in input remains accepted and ignored");
    assert.equal(race.prizeCalculationVersion, 2);
    assert.equal(race.prizeCoinUnit, 10);
    assert.equal(race.prizePoolMaxCoins, 8_000);
    assert.equal(participant.fundedExposureMillicoins, 40_000);
    assert.equal(participant.fundedExposureRateMillicoinsPerDay, 5_715);
  });

  it("returns the exact 409 contract and leaves no partial fifth race", async () => {
    const user = await createUser();
    for (let index = 0; index < 4; index += 1) {
      const response = await createFundedRace(user, `Allowed ${index}`);
      assert.equal(response.status, 201);
    }

    const rejected = await createFundedRace(user, "Rejected fifth");
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "Finish or leave another funded race before joining this one.",
      code: "FUNDED_EXPOSURE_LIMIT",
      limitCoins: 300,
      dailyRateLimitCoins: 40,
      currentCoins: 40,
      requestedCoins: 10,
      currentDailyRateCoins: 40,
      requestedDailyRateCoins: 10,
    });
    assert.equal(await prisma.race.count(), 4);
    assert.equal(await prisma.raceParticipant.count(), 4);
  });

  it("serializes concurrent boundary creates with the per-user guard", async () => {
    const user = await createUser();
    for (let index = 0; index < 3; index += 1) {
      const response = await createFundedRace(user, `Existing ${index}`);
      assert.equal(response.status, 201);
    }

    const responses = await Promise.all([
      createFundedRace(user, "Boundary A"),
      createFundedRace(user, "Boundary B"),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409],
    );
    assert.equal(await prisma.race.count(), 4);
    assert.equal(await prisma.raceParticipant.count(), 4);
  });

  it("serializes opposing cross-race admissions at the exposure boundary", async () => {
    const joiner = await createUser();
    for (let index = 0; index < 3; index += 1) {
      assert.equal(
        (await createFundedRace(joiner, `Cross-race existing ${index}`)).status,
        201,
      );
    }
    const creatorA = await createUser();
    const creatorB = await createUser();
    const targetA = await createFundedRace(creatorA, "Cross-race target A");
    const targetB = await createFundedRace(creatorB, "Cross-race target B");
    const targetAId = (await targetA.json()).race.id;
    const targetBId = (await targetB.json()).race.id;

    const responses = await Promise.all([
      request(server.baseUrl, "POST", `/races/${targetAId}/join`, {
        token: joiner.token,
      }),
      request(server.baseUrl, "POST", `/races/${targetBId}/join`, {
        token: joiner.token,
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409],
    );
  });

  it("fails closed when an old writer inserts a new membership during null healing", async () => {
    const joiner = await createUser();
    const creatorA = await createUser();
    const creatorTarget = await createUser();
    const creatorDrift = await createUser();
    const raceAId = (await (await createFundedRace(creatorA, "Heal locked A")).json()).race.id;
    const targetId = (await (await createFundedRace(creatorTarget, "Heal target")).json()).race.id;
    const driftId = (await (await createFundedRace(creatorDrift, "Heal old writer")).json()).race.id;
    assert.equal(
      (await request(server.baseUrl, "POST", `/races/${raceAId}/join`, {
        token: joiner.token,
      })).status,
      201,
    );
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: raceAId, userId: joiner.id } },
      data: {
        fundedExposureMillicoins: null,
        fundedExposureRateMillicoinsPerDay: null,
      },
    });

    let releaseRaceLock;
    let markRaceLocked;
    const raceLocked = new Promise((resolve) => { markRaceLocked = resolve; });
    const release = new Promise((resolve) => { releaseRaceLock = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM races WHERE id = ${raceAId} FOR UPDATE`;
      markRaceLocked();
      await release;
    }, { timeout: 15_000 });
    await raceLocked;

    const admission = request(server.baseUrl, "POST", `/races/${targetId}/join`, {
      token: joiner.token,
    });
    const deadline = Date.now() + 5_000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const rows = await prisma.$queryRaw`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%FROM races WHERE id = ANY%'
        ) AS blocked
      `;
      blocked = rows[0]?.blocked === true;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "healer reached the held competition lock");

    await prisma.raceParticipant.create({
      data: {
        raceId: driftId,
        userId: joiner.id,
        status: "ACCEPTED",
        fundedExposureMillicoins: null,
        fundedExposureRateMillicoinsPerDay: null,
      },
    });
    releaseRaceLock();
    await holder;
    const response = await admission;
    const responseBody = await response.json();
    assert.equal(response.status, 409, JSON.stringify(responseBody));
    assert.equal(responseBody.code, "FUNDED_EXPOSURE_RETRY");
    const drift = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: driftId, userId: joiner.id } },
    });
    assert.equal(drift.fundedExposureMillicoins, null);
    assert.equal(drift.fundedExposureRateMillicoinsPerDay, null);
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId: targetId, userId: joiner.id } }),
      0,
    );
  });

  it("dual-writes legacy v1 exposure while enforcement and v2 issuance are dark", async () => {
    process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = "false";
    process.env.FUNDED_PRIZE_V2_ENABLED = "false";
    const user = await createUser();
    const response = await createFundedRace(user, "Mixed worker v1", 1);
    assert.equal(response.status, 201);
    const raceId = (await response.json()).race.id;

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: user.id } },
    });
    assert.equal(race.prizeCalculationVersion, 1);
    assert.equal(race.prizeCoinUnit, null);
    assert.equal(race.prizePoolMaxCoins, null);
    assert.equal(participant.fundedExposureMillicoins, 20_000);
    assert.equal(participant.fundedExposureRateMillicoinsPerDay, 20_000);
  });

  it("enforcement-off admission still waits for the target competition row before dual-write", async () => {
    process.env.FUNDED_EXPOSURE_ENFORCEMENT_ENABLED = "false";
    const creator = await createUser();
    const joiner = await createUser();
    const created = await createFundedRace(creator, "Dark launch target");
    const raceId = (await created.json()).race.id;

    let releaseLock;
    let markLocked;
    const locked = new Promise((resolve) => { markLocked = resolve; });
    const release = new Promise((resolve) => { releaseLock = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM races WHERE id = ${raceId} FOR UPDATE`;
      markLocked();
      await release;
    }, { timeout: 15_000 });
    await locked;

    const admission = request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
    });
    const finishedWhileLocked = await Promise.race([
      admission.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    assert.equal(finishedWhileLocked, false);
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId, userId: joiner.id } }),
      0,
    );
    releaseLock();
    await holder;
    assert.equal((await admission).status, 201);
  });

  it("non-funded account deletion serializes against create, public join, and invite", async () => {
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);

    const creatorUnderDelete = await createUser();
    const [deletedCreator, createResponse] = await Promise.all([
      request(server.baseUrl, "DELETE", "/auth/account", { token: creatorUnderDelete.token }),
      request(server.baseUrl, "POST", "/races", {
        token: creatorUnderDelete.token,
        body: { name: "Delete versus create", maxDurationDays: 1, isPublic: true },
      }),
    ]);
    assert.equal(deletedCreator.status, 204);
    assert.ok([201, 401, 404, 409].includes(createResponse.status));
    assert.equal(await prisma.raceParticipant.count({ where: { userId: creatorUnderDelete.id } }), 0);

    const host = await createUser();
    const joinerUnderDelete = await createUser();
    const target = await request(server.baseUrl, "POST", "/races", {
      token: host.token,
      body: { name: "Delete versus ordinary join", maxDurationDays: 1, isPublic: true },
    });
    assert.equal(target.status, 201);
    const targetId = (await target.json()).race.id;
    const [deletedJoiner, joinResponse] = await Promise.all([
      request(server.baseUrl, "DELETE", "/auth/account", { token: joinerUnderDelete.token }),
      request(server.baseUrl, "POST", `/races/${targetId}/join`, { token: joinerUnderDelete.token }),
    ]);
    assert.equal(deletedJoiner.status, 204);
    assert.ok([201, 401, 404, 409].includes(joinResponse.status));
    assert.equal(await prisma.raceParticipant.count({ where: { userId: joinerUnderDelete.id } }), 0);

    const inviteeUnderDelete = await createUser();
    await prisma.friendship.create({
      data: {
        requesterId: host.id,
        addresseeId: inviteeUnderDelete.id,
        status: "ACCEPTED",
      },
    });
    const [deletedInvitee, inviteResponse] = await Promise.all([
      request(server.baseUrl, "DELETE", "/auth/account", { token: inviteeUnderDelete.token }),
      request(server.baseUrl, "POST", `/races/${targetId}/invite`, {
        token: host.token,
        body: { inviteeIds: [inviteeUnderDelete.id] },
      }),
    ]);
    assert.equal(deletedInvitee.status, 204);
    assert.ok([200, 400, 404, 409].includes(inviteResponse.status));
    assert.equal(await prisma.raceParticipant.count({ where: { userId: inviteeUnderDelete.id } }), 0);
  });

  it("public create endpoints emit no concurrent pg query warning while hydrating responses", async () => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(String(warning?.message || warning));
    process.on("warning", onWarning);
    try {
      const raceCreator = await createUser();
      const race = await createFundedRace(raceCreator, "Hydrate after commit");
      assert.equal(race.status, 201);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        warnings.filter((message) => /already executing a query|Client\.query/i.test(message)),
        [],
        "POST /races must hydrate after commit",
      );
      warnings.length = 0;
      const tournamentCreator = await createUser();
      const tournament = await tournamentRequest("POST", "/tournaments", tournamentCreator, {
        name: "Hydrate bracket after commit",
        bracketSize: 4,
        matchupDurationDays: 2,
        isPublic: true,
      });
      assert.equal(tournament.status, 201);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener("warning", onWarning);
    }
    assert.deepEqual(
      warnings.filter((message) => /already executing a query|Client\.query/i.test(message)),
      [],
    );
  });

  it("heals a mixed-worker null stamp under the guard before admitting the next race", async () => {
    const user = await createUser();
    const raceIds = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await createFundedRace(user, `Mixed null ${index}`);
      assert.equal(response.status, 201);
      raceIds.push((await response.json()).race.id);
    }
    await prisma.raceParticipant.update({
      where: {
        raceId_userId: { raceId: raceIds[0], userId: user.id },
      },
      data: {
        fundedExposureMillicoins: null,
        fundedExposureRateMillicoinsPerDay: null,
      },
    });

    const admitted = await createFundedRace(user, "Mixed null healed");
    assert.equal(admitted.status, 201);
    const healed = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: { raceId: raceIds[0], userId: user.id },
      },
    });
    assert.equal(healed.fundedExposureMillicoins, 10_000);
    assert.equal(healed.fundedExposureRateMillicoinsPerDay, 10_000);
    assert.equal(
      (await createFundedRace(user, "Mixed null still bounded")).status,
      409,
    );
  });

  it("excludes live legacy non-funded memberships from exposure", async () => {
    const user = await createUser();
    const legacy = await prisma.race.create({
      data: {
        creatorId: user.id,
        name: "Legacy non-funded",
        targetSteps: 10_000,
        status: "ACTIVE",
        fundedPrize: false,
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: legacy.id,
        userId: user.id,
        status: "ACCEPTED",
      },
    });
    for (let index = 0; index < 4; index += 1) {
      assert.equal(
        (await createFundedRace(user, `Funded beside legacy ${index}`)).status,
        201,
      );
    }
    assert.equal(
      (await createFundedRace(user, "Funded limit remains four")).status,
      409,
    );
    const legacyMembership = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId: legacy.id, userId: user.id } },
    });
    assert.equal(legacyMembership.fundedExposureMillicoins, null);
  });

  it("settles from the immutable v2 race stamp after the launch environment flips", async () => {
    const creator = await createUser();
    const joiner = await createUser();
    const created = await createFundedRace(creator, "Immutable settlement");
    assert.equal(created.status, 201);
    const raceId = (await created.json()).race.id;
    assert.equal(
      (await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      })).status,
      201,
    );
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { joinedAt: "asc" },
    });
    const settlementStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const settlementEndedAt = new Date(Date.now() - 60_000);
    for (let index = 0; index < participants.length; index += 1) {
      await prisma.step.create({
        data: {
          userId: participants[index].userId,
          date: settlementStartedAt,
          steps: 5_000 - index * 1_000,
        },
      });
      await prisma.stepSample.create({
        data: {
          userId: participants[index].userId,
          periodStart: new Date(settlementStartedAt.getTime() + 60 * 60 * 1_000),
          periodEnd: new Date(settlementStartedAt.getTime() + 2 * 60 * 60 * 1_000),
          steps: 5_000 - index * 1_000,
          sourceName: "healthkit",
        },
      });
      await prisma.raceParticipant.update({
        where: { id: participants[index].id },
        data: {
          totalSteps: 5_000 - index * 1_000,
          rawSteps: 5_000 - index * 1_000,
          placement: index + 1,
          joinedAt: settlementStartedAt,
          baselineSteps: 0,
        },
      });
    }
    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        startedAt: settlementStartedAt,
        endsAt: settlementEndedAt,
      },
    });

    process.env.FUNDED_PRIZE_V2_ENABLED = "false";
    await resolveExpiredRaces();
    const settled = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(settled.prizeCalculationVersion, 2);
    assert.equal(settled.prizeCoinUnit, 10);
    assert.equal(settled.prizePoolMaxCoins, 8_000);
    assert.equal(settled.prizePoolCoins, 20);
  });

  it("stamps a user tournament and its creator reservation through POST /tournaments", async () => {
    const user = await createUser();
    const response = await tournamentRequest(
      "POST",
      "/tournaments",
      user,
      {
        name: "Stamped bracket",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 500,
        isPublic: true,
      },
    );
    assert.equal(response.status, 201);
    const created = (await response.json()).tournament;
    const tournament = await prisma.tournament.findUnique({
      where: { id: created.id },
    });
    const participant = await prisma.tournamentParticipant.findUnique({
      where: {
        tournamentId_userId: {
          tournamentId: created.id,
          userId: user.id,
        },
      },
    });
    assert.equal(tournament.buyInAmount, 0);
    assert.equal(tournament.prizeCalculationVersion, 2);
    assert.equal(tournament.prizeCoinUnit, 10);
    assert.equal(tournament.tournamentChampionMaxCoins, 500);
    assert.equal(participant.fundedExposureMillicoins, 40_000);
    assert.equal(participant.fundedExposureRateMillicoinsPerDay, 10_000);
    assert.equal(created.prizePool.coinUnit, 10);
    assert.equal(created.prizePool.maxCoins, 500);
  });

  it("applies the same 409 contract to funded tournament admission", async () => {
    const joiner = await createUser();
    for (let index = 0; index < 4; index += 1) {
      assert.equal(
        (await createFundedRace(joiner, `Joiner exposure ${index}`)).status,
        201,
      );
    }
    const creator = await createUser();
    const createResponse = await tournamentRequest(
      "POST",
      "/tournaments",
      creator,
      {
        name: "Join blocked bracket",
        bracketSize: 4,
        matchupDurationDays: 2,
        isPublic: true,
      },
    );
    assert.equal(createResponse.status, 201);
    const tournamentId = (await createResponse.json()).tournament.id;

    const rejected = await tournamentRequest(
      "POST",
      `/tournaments/${tournamentId}/join`,
      joiner,
    );
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "Finish or leave another funded race before joining this one.",
      code: "FUNDED_EXPOSURE_LIMIT",
      limitCoins: 300,
      dailyRateLimitCoins: 40,
      currentCoins: 40,
      requestedCoins: 40,
      currentDailyRateCoins: 40,
      requestedDailyRateCoins: 10,
    });
  });

  it("applies the cap to public race joins without creating a participant", async () => {
    const joiner = await createUser();
    for (let index = 0; index < 4; index += 1) {
      assert.equal(
        (await createFundedRace(joiner, `Public exposure ${index}`)).status,
        201,
      );
    }
    const creator = await createUser();
    const created = await createFundedRace(creator, "Public cap target");
    const raceId = (await created.json()).race.id;
    const rejected = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join`,
      { token: joiner.token },
    );
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "FUNDED_EXPOSURE_LIMIT");
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId, userId: joiner.id },
      }),
      0,
    );
  });

  it("applies the cap to invite acceptance and keeps the invite pending", async () => {
    const invitee = await createUser();
    for (let index = 0; index < 4; index += 1) {
      assert.equal(
        (await createFundedRace(invitee, `Invite exposure ${index}`)).status,
        201,
      );
    }
    const creator = await createUser();
    const created = await createFundedRace(creator, "Invite cap target");
    const raceId = (await created.json()).race.id;
    await prisma.raceParticipant.create({
      data: { raceId, userId: invitee.id, status: "INVITED" },
    });

    const rejected = await request(
      server.baseUrl,
      "PUT",
      `/races/${raceId}/respond`,
      { token: invitee.token, body: { accept: true } },
    );
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "FUNDED_EXPOSURE_LIMIT");
    const invite = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: invitee.id } },
    });
    assert.equal(invite.status, "INVITED");
    assert.equal(invite.fundedExposureMillicoins, null);
  });

  it("serializes the last public slot against invite acceptance", async () => {
    const creator = await createUser();
    const invitee = await createUser();
    const publicJoiner = await createUser();
    const created = await createFundedRace(creator, "One slot", 1, 2);
    assert.equal(created.status, 201);
    const raceId = (await created.json()).race.id;
    await prisma.raceParticipant.create({
      data: { raceId, userId: invitee.id, status: "INVITED" },
    });

    const [publicJoin, inviteAccept] = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: publicJoiner.token,
      }),
      request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
        token: invitee.token,
        body: { accept: true },
      }),
    ]);

    assert.equal(
      [publicJoin.status, inviteAccept.status].filter((status) => status < 300).length,
      1,
    );
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId, status: "ACCEPTED" },
      }),
      2,
    );
  });

  it("serializes a funded public join against cancellation", async () => {
    const creator = await createUser();
    const joiner = await createUser();
    const created = await createFundedRace(creator, "Cancel race");
    const raceId = (await created.json()).race.id;

    const [join, cancel] = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      }),
      request(server.baseUrl, "DELETE", `/races/${raceId}`, {
        token: creator.token,
      }),
    ]);
    assert.equal(cancel.status, 200);
    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.status, "CANCELLED");
    if (join.status < 300) {
      const participant = await prisma.raceParticipant.findUnique({
        where: { raceId_userId: { raceId, userId: joiner.id } },
      });
      assert.equal(participant.status, "ACCEPTED");
    } else {
      assert.equal(
        await prisma.raceParticipant.count({ where: { raceId, userId: joiner.id } }),
        0,
      );
    }
  });

  it("serializes a funded public join against worker completion", async () => {
    const creator = await createUser();
    const joiner = await createUser();
    const created = await createFundedRace(creator, "Complete race");
    const raceId = (await created.json()).race.id;
    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
        endsAt: new Date(Date.now() - 60_000),
      },
    });

    const [join] = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      }),
      resolveExpiredRaces(),
    ]);
    let race = await prisma.race.findUnique({ where: { id: raceId } });
    if (race.status === "ACTIVE") {
      // If the join committed between the worker's optimistic read and C0,
      // the worker must discard that stale snapshot. A fresh worker tick then
      // settles the authoritative membership set.
      await resolveExpiredRaces();
      race = await prisma.race.findUnique({ where: { id: raceId } });
    }
    assert.equal(race.status, "COMPLETED");
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: joiner.id } },
    });
    if (join.status < 300) {
      assert.equal(participant?.status, "ACCEPTED");
      assert.equal(
        await prisma.raceParticipant.count({
          where: {
            id: participant.id,
            race: { status: { in: ["PENDING", "ACTIVE"] } },
          },
        }),
        0,
        "a successful pre-completion join cannot remain live after settlement",
      );
    } else {
      assert.equal(participant, null);
    }
  });

  it("account deletion waits behind C0 while the same race settles", async () => {
    const user = await createUser();
    const created = await createFundedRace(user, "Delete versus settle");
    const raceId = (await created.json()).race.id;
    await prisma.race.update({
      where: { id: raceId },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 86_400_000),
        endsAt: new Date(Date.now() - 60_000),
      },
    });

    let releaseFence;
    let markFence;
    const fenced = new Promise((resolve) => { markFence = resolve; });
    const release = new Promise((resolve) => { releaseFence = resolve; });
    const holder = prisma.$transaction(async (tx) => {
      await RaceResolutionJobV2.acquireForWrite(tx, { raceId });
      markFence();
      await release;
    }, { timeout: 15_000 });
    await fenced;
    const deleting = request(server.baseUrl, "DELETE", "/auth/account", {
      token: user.token,
    });
    const settling = resolveExpiredRaces();
    let deletionFinishedWhileFenced = false;
    try {
      deletionFinishedWhileFenced = await Promise.race([
        deleting.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      assert.equal(
        deletionFinishedWhileFenced,
        false,
        "account deletion must acquire the race C0 before removing membership",
      );
    } finally {
      releaseFence();
      await holder;
    }
    const [deleted] = await Promise.all([deleting, settling]);
    assert.equal(deleted.status, 204);
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
    assert.equal(
      await prisma.raceParticipant.count({ where: { raceId, userId: user.id } }),
      0,
    );
  });

  it("account deletion and a different-race admission leave no orphan membership", async () => {
    const user = await createUser();
    const existing = await createFundedRace(user, "Delete existing");
    assert.equal(existing.status, 201);
    const targetCreator = await createUser();
    const target = await createFundedRace(targetCreator, "Delete admission target");
    const targetId = (await target.json()).race.id;
    const [deleted, joined] = await Promise.all([
      request(server.baseUrl, "DELETE", "/auth/account", { token: user.token }),
      request(server.baseUrl, "POST", `/races/${targetId}/join`, { token: user.token }),
    ]);
    assert.equal(deleted.status, 204);
    assert.ok([201, 401, 404, 409].includes(joined.status));
    assert.equal(await prisma.user.count({ where: { id: user.id } }), 0);
    assert.equal(
      await prisma.raceParticipant.count({ where: { userId: user.id } }),
      0,
    );
  });

  it("serializes mixed-null healing against a funded release", async () => {
    const joiner = await createUser();
    const raceIds = [];
    for (let index = 0; index < 5; index += 1) {
      const creator = await createUser();
      const created = await createFundedRace(creator, `Heal/release ${index}`);
      raceIds.push((await created.json()).race.id);
    }
    for (const raceId of raceIds.slice(0, 4)) {
      assert.equal((await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      })).status, 201);
    }
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: raceIds[0], userId: joiner.id } },
      data: {
        fundedExposureMillicoins: null,
        fundedExposureRateMillicoinsPerDay: null,
      },
    });

    const [leave, admission] = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceIds[0]}/leave`, {
        token: joiner.token,
        headers: { "X-Client-Features": "race_leave" },
      }),
      request(server.baseUrl, "POST", `/races/${raceIds[4]}/join`, {
        token: joiner.token,
      }),
    ]);
    assert.equal(leave.status, 200);
    if (admission.status === 409) {
      assert.equal((await request(server.baseUrl, "POST", `/races/${raceIds[4]}/join`, {
        token: joiner.token,
      })).status, 201);
    } else {
      assert.equal(admission.status, 201);
    }
    assert.equal(
      await prisma.raceParticipant.count({
        where: {
          userId: joiner.id,
          status: "ACCEPTED",
          race: { fundedPrize: true, status: { in: ["PENDING", "ACTIVE"] } },
        },
      }),
      4,
    );
  });

  it("serializes mixed-null healing against funded settlement", async () => {
    const joiner = await createUser();
    const raceIds = [];
    for (let index = 0; index < 5; index += 1) {
      const creator = await createUser();
      const created = await createFundedRace(creator, `Heal/settle ${index}`);
      raceIds.push((await created.json()).race.id);
    }
    for (const raceId of raceIds.slice(0, 4)) {
      assert.equal((await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      })).status, 201);
    }
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: raceIds[0], userId: joiner.id } },
      data: {
        fundedExposureMillicoins: null,
        fundedExposureRateMillicoinsPerDay: null,
      },
    });
    await prisma.race.update({
      where: { id: raceIds[0] },
      data: {
        status: "ACTIVE",
        startedAt: new Date(Date.now() - 24 * 60 * 60 * 1_000),
        endsAt: new Date(Date.now() - 60_000),
      },
    });

    const [admission] = await Promise.all([
      request(server.baseUrl, "POST", `/races/${raceIds[4]}/join`, {
        token: joiner.token,
      }),
      resolveExpiredRaces(),
    ]);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: raceIds[0] } })).status,
      "COMPLETED",
    );
    if (admission.status === 409) {
      assert.equal((await request(server.baseUrl, "POST", `/races/${raceIds[4]}/join`, {
        token: joiner.token,
      })).status, 201);
    } else {
      assert.equal(admission.status, 201);
    }
  });

  it("applies the cap to race share-link joins", async () => {
    const joiner = await createUser();
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await createFundedRace(joiner, `Share exposure ${index}`)).status, 201);
    }
    const creator = await createUser();
    const created = await createFundedRace(creator, "Shared cap target");
    const raceId = (await created.json()).race.id;
    const link = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, { token: creator.token });
    assert.equal(link.status, 201);
    const { shareToken } = await link.json();
    const rejected = await request(server.baseUrl, "POST", `/races/share/${shareToken}/join`, { token: joiner.token });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "FUNDED_EXPOSURE_LIMIT");
    assert.equal(await prisma.raceParticipant.count({ where: { raceId, userId: joiner.id } }), 0);
  });

  it("applies the cap to tournament share-link joins", async () => {
    const joiner = await createUser();
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await createFundedRace(joiner, `Bracket share exposure ${index}`)).status, 201);
    }
    const creator = await createUser();
    const created = await tournamentRequest("POST", "/tournaments", creator, {
      name: "Shared bracket cap target", bracketSize: 4,
      matchupDurationDays: 2, isPublic: true,
    });
    const tournamentId = (await created.json()).tournament.id;
    const link = await tournamentRequest("POST", `/tournaments/${tournamentId}/share-link`, creator);
    assert.equal(link.status, 201);
    const { shareToken } = await link.json();
    const rejected = await tournamentRequest("POST", `/tournaments/share/${shareToken}/join`, joiner);
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, "FUNDED_EXPOSURE_LIMIT");
  });

  it("releases exposure after leaving a pending ordinary race", async () => {
    const joiner = await createUser();
    const memberships = [];
    for (let index = 0; index < 5; index += 1) {
      const creator = await createUser();
      const created = await createFundedRace(creator, `Release target ${index}`);
      memberships.push((await created.json()).race.id);
    }
    for (const raceId of memberships.slice(0, 4)) {
      const joined = await request(server.baseUrl, "POST", `/races/${raceId}/join`, { token: joiner.token });
      assert.equal(joined.status, 201);
    }
    const blocked = await request(server.baseUrl, "POST", `/races/${memberships[4]}/join`, { token: joiner.token });
    assert.equal(blocked.status, 409);
    const left = await request(server.baseUrl, "POST", `/races/${memberships[0]}/leave`, {
      token: joiner.token,
      headers: { "X-Client-Features": "race_leave" },
    });
    assert.equal(left.status, 200);
    const admitted = await request(server.baseUrl, "POST", `/races/${memberships[4]}/join`, { token: joiner.token });
    assert.equal(admitted.status, 201);
  });

  it("releases tournament exposure after leaving a pending bracket", async () => {
    const joiner = await createUser();
    const tournamentIds = [];
    for (let index = 0; index < 5; index += 1) {
      const creator = await createUser();
      const created = await tournamentRequest("POST", "/tournaments", creator, {
        name: `Bracket release ${index}`,
        bracketSize: 4,
        matchupDurationDays: 2,
        isPublic: true,
      });
      assert.equal(created.status, 201);
      tournamentIds.push((await created.json()).tournament.id);
    }
    for (const tournamentId of tournamentIds.slice(0, 4)) {
      assert.equal(
        (await tournamentRequest(
          "POST",
          `/tournaments/${tournamentId}/join`,
          joiner,
        )).status,
        201,
      );
    }
    assert.equal(
      (await tournamentRequest(
        "POST",
        `/tournaments/${tournamentIds[4]}/join`,
        joiner,
      )).status,
      409,
    );
    assert.equal(
      (await tournamentRequest(
        "POST",
        `/tournaments/${tournamentIds[0]}/leave`,
        joiner,
      )).status,
      200,
    );
    assert.equal(
      (await tournamentRequest(
        "POST",
        `/tournaments/${tournamentIds[4]}/join`,
        joiner,
      )).status,
      201,
    );
  });
});
