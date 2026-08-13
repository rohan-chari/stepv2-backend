const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer, startServer } = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { completeRace } = require("../../src/modules/races/commands/completeRace");
const { getNextRaceHome } = require("../../src/modules/races/queries/getNextRaceHome");
const { hasLiveUserCreatedRace } = require("../../src/modules/races/services/nextRacePolicy");
const { autoStartUnscheduledPrivateRaces } = require("../../src/modules/races/jobs/privateRaceAutoStart");
const {
  completeRaceUnderSettlementFence,
  resolveExpiredRaces,
} = require("../../src/modules/races/jobs/raceExpiry");
const { RaceResolutionJobV2 } = require("../../src/modules/races/models/raceResolutionJobV2");
const { recordReferral } = require("../../src/modules/social/commands/recordReferral");
const { getOrCreateReferralCode } = require("../../src/modules/social/commands/getOrCreateReferralCode");

const CAPABLE = { "X-Client-Features": "next_race_cta" };
let server;
let nextUser = 0;

async function user(name = "Walker") {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `next-race-${++nextUser}` },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    token: body.sessionToken,
    body: { displayName: `${name}${nextUser}` },
  });
  return { id: body.user.id, token: body.sessionToken };
}

function quickBody(overrides = {}) {
  return {
    name: "Weekend Sprint",
    maxDurationDays: 2,
    buyInAmount: 0,
    payoutPreset: "TOP3_70_20_10",
    isPublic: true,
    maxParticipants: 10,
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    creationSource: "QUICK_CREATE",
    startPolicy: "ON_MINIMUM_PARTICIPANTS",
    ...overrides,
  };
}

async function createQuick(owner, overrides = {}) {
  return request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    headers: CAPABLE,
    body: quickBody(overrides),
  });
}

describe("next-race CTA backend contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  // Also pin defaults after the LAST test in this file — otherwise whatever
  // this file's final test happened to set survives into the next test FILE
  // in the same run (app_settings persists across files; see beforeEach).
  after(async () => {
    await appSettings.setFlag("openUserRaceDiscoveryEnabled", false);
    await appSettings.setFlag("quickCreateRaceCtaEnabled", false);
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("setupInviteCodePromptEnabled", false);
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextUser = 0;
    // app_settings is deliberately NOT truncated by cleanDatabase() (it mirrors
    // prod's persistent config), so every flag this suite touches must be
    // pinned back to its default here — otherwise a flag flipped by one test
    // leaks into the next test, and (since this table also survives across
    // test FILES in the same run) into whichever integration suite runs next.
    await appSettings.setFlag("openUserRaceDiscoveryEnabled", false);
    await appSettings.setFlag("quickCreateRaceCtaEnabled", false);
    await appSettings.setFlag("fundedPrizePoolsEnabled", true);
    await appSettings.setFlag("setupInviteCodePromptEnabled", false);
  });

  it("keeps frozen clients on the legacy path and gates all new response fields", async () => {
    const owner = await user();
    const create = await request(server.baseUrl, "POST", "/races", {
      token: owner.token,
      body: quickBody(),
    });
    assert.equal(create.status, 201, JSON.stringify(await create.clone().json()));
    const created = await create.json();
    assert.equal(created.race.creationSource, null);
    assert.equal(created.race.startPolicy, null);

    const home = await request(server.baseUrl, "GET", "/home/race-card", {
      token: owner.token,
    });
    assert.equal((await home.json()).nextRace, undefined);

    const races = await request(server.baseUrl, "GET", "/races", {
      token: owner.token,
    });
    assert.equal((await races.json()).nextRace, undefined);
  });

  it("rejects supported quick create while its default-off flag is disabled", async () => {
    const owner = await user();
    const res = await createQuick(owner);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), {
      error: "Quick create is temporarily unavailable.",
      code: "QUICK_CREATE_DISABLED",
    });
  });

  it("emits every new app-setting flag default false and round-trips only literal true", async () => {
    const walker = await user();
    const initial = await request(server.baseUrl, "GET", "/auth/me", {
      token: walker.token,
    });
    assert.equal(initial.status, 200);
    const initialFlags = (await initial.json()).user.featureFlags;
    assert.equal(initialFlags.openUserRaceDiscoveryEnabled, false);
    assert.equal(initialFlags.quickCreateRaceCtaEnabled, false);
    assert.equal(initialFlags.setupInviteCodePromptEnabled, false);

    await appSettings.setFlag("setupInviteCodePromptEnabled", true);
    const enabled = await request(server.baseUrl, "GET", "/auth/me", {
      token: walker.token,
    });
    assert.equal((await enabled.json()).user.featureFlags.setupInviteCodePromptEnabled, true);
  });

  it("validates and persists the exact quick-create provenance pair", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const owner = await user();

    const partial = await createQuick(owner, { startPolicy: null });
    assert.equal(partial.status, 400);
    assert.equal((await partial.json()).code, "INVALID_QUICK_CREATE_CONFIG");

    const res = await createQuick(owner);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const body = await res.json();
    assert.equal(body.race.creationSource, "QUICK_CREATE");
    assert.equal(body.race.startPolicy, "ON_MINIMUM_PARTICIPANTS");
    const row = await prisma.race.findUnique({ where: { id: body.race.id } });
    assert.equal(row.creationSource, "QUICK_CREATE");
    assert.equal(row.startPolicy, "ON_MINIMUM_PARTICIPANTS");
  });

  it("rejects quick creation once the creator has a live human-created race", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const owner = await user();
    assert.equal((await createQuick(owner)).status, 201);
    const second = await createQuick(owner, { name: "Second Sprint" });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), {
      error: "Finish or leave your current race before starting another.",
      code: "QUICK_RACE_ALREADY_LIVE",
    });
  });

  it("serializes simultaneous quick creates for one creator", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const owner = await user();
    const responses = await Promise.all([
      createQuick(owner, { name: "First Sprint" }),
      createQuick(owner, { name: "Second Sprint" }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    assert.equal(
      await prisma.race.count({ where: { creatorId: owner.id, creationSource: "QUICK_CREATE" } }),
      1
    );
  });

  it("adds resolved eligibility to capable /races without discovery rows", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const walker = await user();
    const res = await request(server.baseUrl, "GET", "/races", {
      token: walker.token,
      headers: CAPABLE,
    });
    const body = await res.json();
    assert.deepEqual(body.nextRace, {
      resolved: true,
      eligible: true,
      createEnabled: true,
    });
    assert.equal(body.nextRace.openRaces, undefined);
  });

  it("returns a safe disabled /races projection while the create flag is off", async () => {
    const walker = await user();
    const res = await request(server.baseUrl, "GET", "/races", {
      token: walker.token,
      headers: CAPABLE,
    });
    assert.deepEqual((await res.json()).nextRace, {
      resolved: true,
      eligible: false,
      createEnabled: false,
    });
  });

  it("runs no eligibility/discovery builder without capability or enabled relevant flag", async () => {
    let homeBuilds = 0;
    let eligibilityChecks = 0;
    const counted = await startServer({
      getNextRaceHome: async (args) => {
        homeBuilds += 1;
        return getNextRaceHome(args);
      },
      hasLiveUserCreatedRace: async (...args) => {
        eligibilityChecks += 1;
        return hasLiveUserCreatedRace(...args);
      },
    });
    const walker = await user();
    try {
      await request(counted.baseUrl, "GET", "/home/race-card", { token: walker.token });
      await request(counted.baseUrl, "GET", "/races", { token: walker.token });
      await request(counted.baseUrl, "GET", "/home/race-card", {
        token: walker.token,
        headers: CAPABLE,
      });
      await request(counted.baseUrl, "GET", "/races", {
        token: walker.token,
        headers: CAPABLE,
      });
      assert.deepEqual({ homeBuilds, eligibilityChecks }, { homeBuilds: 0, eligibilityChecks: 0 });

      await appSettings.setFlag("openUserRaceDiscoveryEnabled", true);
      await request(counted.baseUrl, "GET", "/home/race-card", {
        token: walker.token,
        headers: CAPABLE,
      });
      assert.equal(homeBuilds, 1);
      assert.equal(eligibilityChecks, 0);

      await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
      await request(counted.baseUrl, "GET", "/races", {
        token: walker.token,
        headers: CAPABLE,
      });
      assert.equal(homeBuilds, 1, "/races never invokes discovery");
      assert.equal(eligibilityChecks, 1);
    } finally {
      await counted.close();
    }
  });

  it("returns a bounded, deduplicated open-race projection on capable Home", async () => {
    await appSettings.setFlag("openUserRaceDiscoveryEnabled", true);
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const viewer = await user("Viewer");
    const created = await createQuick(host);
    assert.equal(created.status, 201);
    const race = (await created.json()).race;

    const res = await request(server.baseUrl, "GET", "/home/race-card", {
      token: viewer.token,
      headers: CAPABLE,
    });
    const body = await res.json();
    assert.equal(body.nextRace.resolved, true);
    assert.equal(body.nextRace.eligible, true);
    assert.equal(body.nextRace.discoveryEnabled, true);
    assert.equal(body.nextRace.createEnabled, true);
    assert.equal(body.nextRace.openRaces.length, 1);
    assert.deepEqual(Object.keys(body.nextRace.openRaces[0]).sort(), [
      "creator", "endsAt", "id", "isTeamRace", "maxParticipants", "name",
      "participantCount", "startedAt", "status",
    ]);
    assert.equal(body.nextRace.openRaces[0].id, race.id);
  });

  it("automatically starts a quick race after participant two joins", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    const created = await createQuick(host);
    const raceId = (await created.json()).race.id;

    const join = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
      headers: CAPABLE,
    });
    assert.equal(join.status, 201, JSON.stringify(await join.clone().json()));
    const row = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(row.status, "ACTIVE");
    assert.ok(row.startedAt);
    assert.ok(row.endsAt);
    const event = await prisma.activationEvent.findUnique({
      where: { id: `server:quick-start:${raceId}` },
    });
    assert.equal(event.name, "quick_race_auto_started");
    assert.equal(event.context.race_id, raceId);
    assert.match(event.context.seconds_from_creation, /^\d+$/);
  });

  it("rolls back every durable start write on an injected in-transaction fault", async () => {
    await appSettings.setFlag("fundedPrizePoolsEnabled", false);
    const host = await user("Host");
    const joiner = await user("Joiner");
    await prisma.user.updateMany({
      where: { id: { in: [host.id, joiner.id] } },
      data: { coins: 500 },
    });
    const faulting = await startServer({
      beforeRaceStartedRecord: async () => {
        throw new Error("TEST_START_TRANSACTION_FAULT");
      },
    });
    try {
      const created = await request(faulting.baseUrl, "POST", "/races", {
        token: host.token,
        body: {
          name: "Faulted paid race",
          maxDurationDays: 2,
          buyInAmount: 100,
          payoutPreset: "WINNER_TAKES_ALL",
          isPublic: true,
        },
      });
      const raceId = (await created.json()).race.id;
      assert.equal((await request(faulting.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
      })).status, 201);
      const before = await prisma.raceParticipant.findMany({
        where: { raceId },
        orderBy: { userId: "asc" },
      });
      const started = await request(faulting.baseUrl, "POST", `/races/${raceId}/start`, {
        token: host.token,
      });
      assert.equal(started.status, 500);
      const race = await prisma.race.findUnique({ where: { id: raceId } });
      const after = await prisma.raceParticipant.findMany({
        where: { raceId },
        orderBy: { userId: "asc" },
      });
      assert.equal(race.status, "PENDING");
      assert.equal(race.startedAt, null);
      assert.equal(race.endsAt, null);
      assert.equal(race.potCoins, 0);
      assert.deepEqual(after.map((p) => p.buyInStatus), ["HELD", "HELD"]);
      assert.deepEqual(after.map((p) => p.baselineSteps), before.map((p) => p.baselineSteps));
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "RACE_STARTED" },
      }), 0);
    } finally {
      await faulting.close();
    }
  });

  it("backstop reconciles a committed quick join after inline start fails", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    let fail = true;
    const faulting = await startServer({
      beforeRaceStartedRecord: async () => {
        if (fail) throw new Error("TEST_INLINE_START_FAULT");
      },
      logger: { log() {}, error() {} },
    });
    let raceId;
    try {
      raceId = (await (await request(faulting.baseUrl, "POST", "/races", {
        token: host.token,
        headers: CAPABLE,
        body: quickBody(),
      })).json()).race.id;
      const joined = await request(faulting.baseUrl, "POST", `/races/${raceId}/join`, {
        token: joiner.token,
        headers: CAPABLE,
      });
      assert.equal(joined.status, 201);
      assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).status, "PENDING");
    } finally {
      await faulting.close();
    }
    fail = false;
    const started = await autoStartUnscheduledPrivateRaces();
    assert.ok(started.includes(raceId));
    assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).status, "ACTIVE");
    assert.equal(await prisma.racePowerupEvent.count({
      where: { raceId, eventType: "RACE_STARTED" },
    }), 1);
  });

  it("retries a participant-two/three snapshot change without missing a baseline", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const second = await user("Second");
    const third = await user("Third");
    let releaseFirstSnapshot;
    let firstSnapshotSeen;
    const firstSeen = new Promise((resolve) => { firstSnapshotSeen = resolve; });
    const release = new Promise((resolve) => { releaseFirstSnapshot = resolve; });
    let hookCalls = 0;
    const racing = await startServer({
      beforeCommitRaceStart: async () => {
        hookCalls += 1;
        if (hookCalls === 1) {
          firstSnapshotSeen();
          await release;
        }
      },
    });
    try {
      const raceId = (await (await request(racing.baseUrl, "POST", "/races", {
        token: host.token,
        headers: CAPABLE,
        body: quickBody(),
      })).json()).race.id;
      const secondJoin = request(racing.baseUrl, "POST", `/races/${raceId}/join`, {
        token: second.token,
        headers: CAPABLE,
      });
      await firstSeen;
      process.env.RACE_POLICY_AUTOSTART_DISABLED = "true";
      const thirdJoin = await request(racing.baseUrl, "POST", `/races/${raceId}/join`, {
        token: third.token,
        headers: CAPABLE,
      });
      delete process.env.RACE_POLICY_AUTOSTART_DISABLED;
      assert.equal(thirdJoin.status, 201);
      releaseFirstSnapshot();
      assert.equal((await secondJoin).status, 201);

      const race = await prisma.race.findUnique({ where: { id: raceId } });
      const participants = await prisma.raceParticipant.findMany({
        where: { raceId, status: "ACCEPTED" },
        orderBy: { userId: "asc" },
      });
      assert.equal(race.status, "ACTIVE");
      assert.equal(participants.length, 3);
      assert.ok(participants.every((p) => p.joinedAt >= race.startedAt));
      assert.equal(await prisma.racePowerupEvent.count({
        where: { raceId, eventType: "RACE_STARTED" },
      }), 1);
      assert.ok(hookCalls >= 2, "changed membership forces a fresh snapshot retry");
    } finally {
      delete process.env.RACE_POLICY_AUTOSTART_DISABLED;
      releaseFirstSnapshot?.();
      await racing.close();
    }
  });

  it("caps a walker at five live quick-race memberships", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const walker = await user("Walker");
    const raceIds = [];
    const hosts = [];
    for (let i = 0; i < 6; i++) {
      const host = await user(`Host${i}`);
      const created = await createQuick(host, { name: `Sprint ${i}` });
      hosts.push(host);
      raceIds.push((await created.json()).race.id);
    }
    for (const raceId of raceIds.slice(0, 5)) {
      const joined = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: walker.token,
        headers: CAPABLE,
      });
      assert.equal(joined.status, 201);
    }
    const shareLink = await request(
      server.baseUrl,
      "POST",
      `/races/${raceIds[5]}/share-link`,
      { token: hosts[5].token }
    );
    assert.equal(shareLink.status, 201);
    const { shareToken } = await shareLink.json();
    const sixth = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: walker.token, headers: CAPABLE }
    );
    assert.equal(sixth.status, 409);
    assert.deepEqual(await sixth.json(), {
      error:
        "You're already in 5 races that start automatically. Try again after one is over.",
      code: "QUICK_RACE_MEMBERSHIP_LIMIT",
    });
  });

  it("serializes public and share-token joins when one quick-race slot remains", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const walker = await user("ConcurrentWalker");
    const races = [];
    const hosts = [];
    for (let i = 0; i < 6; i++) {
      const host = await user(`ConcurrentHost${i}`);
      hosts.push(host);
      races.push(
        (await (await createQuick(host, { name: `Concurrent Sprint ${i}` })).json())
          .race.id
      );
    }

    for (const raceId of races.slice(0, 4)) {
      const joined = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: walker.token,
        headers: CAPABLE,
      });
      assert.equal(joined.status, 201);
    }

    const shareLink = await request(
      server.baseUrl,
      "POST",
      `/races/${races[5]}/share-link`,
      { token: hosts[5].token }
    );
    assert.equal(shareLink.status, 201);
    const { shareToken } = await shareLink.json();

    const results = await Promise.all([
      request(server.baseUrl, "POST", `/races/${races[4]}/join`, {
        token: walker.token,
        headers: CAPABLE,
      }),
      request(server.baseUrl, "POST", `/races/share/${shareToken}/join`, {
        token: walker.token,
        headers: CAPABLE,
      }),
    ]);

    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [201, 409]
    );
    const rejected = results.find((result) => result.status === 409);
    assert.equal((await rejected.json()).code, "QUICK_RACE_MEMBERSHIP_LIMIT");
    assert.equal(
      await prisma.raceParticipant.count({
        where: {
          userId: walker.id,
          status: "ACCEPTED",
          race: { creationSource: "QUICK_CREATE", status: { in: ["PENDING", "ACTIVE"] } },
        },
      }),
      5
    );
  });

  it("enforces the persisted quick-membership cap for a frozen client too", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const walker = await user("FrozenWalker");
    for (let i = 0; i < 6; i++) {
      const host = await user(`Host${i}`);
      const raceId = (await (await createQuick(host, { name: `Frozen Sprint ${i}` })).json())
        .race.id;
      const joined = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
        token: walker.token,
      });
      if (i < 5) {
        assert.equal(joined.status, 201, JSON.stringify(await joined.clone().json()));
      } else {
        assert.equal(joined.status, 409);
        const body = await joined.json();
        assert.equal(body.code, "QUICK_RACE_MEMBERSHIP_LIMIT");
        assert.equal(
          body.error,
          "You're already in 5 races that start automatically. Try again after one is over."
        );
      }
    }
    assert.equal(
      await prisma.raceParticipant.count({
        where: {
          userId: walker.id,
          status: "ACCEPTED",
          race: { creationSource: "QUICK_CREATE", status: { in: ["PENDING", "ACTIVE"] } },
        },
      }),
      5
    );
  });

  it("sizes and pays a two-person quick pool only from 2,000-step walkers", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    const raceId = (await (await createQuick(host)).json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
      headers: CAPABLE,
    });
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[0].id },
      data: { placement: 1, totalSteps: 5000, rawSteps: 5000 },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[1].id },
      data: { placement: 2, totalSteps: 4000, rawSteps: 4000 },
    });
    await completeRace({
      raceId,
      winnerUserId: participants[0].userId,
      participantUserIds: participants.map((p) => p.userId),
    });
    const settled = await prisma.race.findUnique({ where: { id: raceId } });
    const paid = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { placement: "asc" },
    });
    assert.equal(settled.prizePoolCoins, 80);
    assert.deepEqual(paid.map((p) => p.payoutCoins), [56, 16]);
    assert.equal(
      await prisma.coinTransaction.aggregate({
        where: { reason: "race_prize_pool_payout", refId: { startsWith: raceId } },
        _sum: { amount: true },
      }).then((x) => x._sum.amount || 0),
      72
    );
  });

  it("mints no quick-race prize when fewer than two accepted walkers qualify", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    const raceId = (await (await createQuick(host)).json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
      headers: CAPABLE,
    });
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[0].id },
      data: { placement: 1, totalSteps: 5000, rawSteps: 5000 },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[1].id },
      data: { placement: 2, totalSteps: 10000, rawSteps: null },
    });

    await completeRace({
      raceId,
      winnerUserId: participants[0].userId,
      participantUserIds: participants.map((p) => p.userId),
    });

    const settled = await prisma.race.findUnique({ where: { id: raceId } });
    const paid = await prisma.raceParticipant.findMany({ where: { raceId } });
    assert.equal(settled.prizePoolCoins, 0);
    assert.ok(paid.every((p) => p.payoutCoins === 0));
    assert.equal(
      await prisma.coinTransaction.count({
        where: { reason: "race_prize_pool_payout", refId: { startsWith: raceId } },
      }),
      0
    );
  });

  it("expiry refreshes raw steps before quick payout and race-share qualification", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    const raceId = (await (await createQuick(host)).json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
      headers: CAPABLE,
    });
    const code = await getOrCreateReferralCode({ userId: host.id });
    const joinerRow = await prisma.user.findUnique({ where: { id: joiner.id } });
    await recordReferral({
      newUser: joinerRow,
      referralCode: code,
      source: "provision_body",
      sourceRaceId: raceId,
    });
    const now = new Date();
    await prisma.race.update({
      where: { id: raceId },
      data: {
        startedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        endsAt: new Date(now.getTime() - 60 * 1000),
      },
    });
    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: {
        baselineSteps: 0,
        totalSteps: 0,
        rawSteps: null,
        // Effective start is max(joinedAt, race.startedAt) — backdate the join
        // too, or it pins the window to "now" and excludes the samples below.
        joinedAt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      },
    });
    // Race did not start at local midnight, so settlement reads closed hourly
    // samples (not the daily Step aggregate) — see calculateBaseAdjusted.
    const HOUR_MS = 60 * 60 * 1000;
    const periodStart = new Date(Math.floor((now.getTime() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS);
    const periodEnd = new Date(periodStart.getTime() + HOUR_MS);
    await prisma.stepSample.createMany({
      data: [
        { userId: host.id, periodStart, periodEnd, steps: 5000, sourceName: "healthkit" },
        { userId: joiner.id, periodStart, periodEnd, steps: 4000, sourceName: "healthkit" },
      ],
    });

    await resolveExpiredRaces();

    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { rawSteps: "desc" },
    });
    assert.deepEqual(participants.map((p) => p.rawSteps), [5000, 4000]);
    assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).prizePoolCoins, 80);
    const referral = await prisma.referral.findUnique({ where: { refereeId: joiner.id } });
    assert.equal(referral.status, "REWARDED");
    assert.ok(await prisma.activationEvent.findUnique({
      where: { id: `server:race-share-qualified:${referral.id}` },
    }));
  });

  it("holds quick payout writes behind the C0 settlement fence", async () => {
    await appSettings.setFlag("quickCreateRaceCtaEnabled", true);
    const host = await user("Host");
    const joiner = await user("Joiner");
    const raceId = (await (await createQuick(host)).json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: joiner.token,
      headers: CAPABLE,
    });
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    for (let index = 0; index < participants.length; index++) {
      await prisma.raceParticipant.update({
        where: { id: participants[index].id },
        data: { placement: index + 1, rawSteps: 5000 - index * 1000, totalSteps: 5000 - index * 1000 },
      });
    }

    let releaseFence;
    let fenceHeld;
    const held = new Promise((resolve) => { fenceHeld = resolve; });
    const release = new Promise((resolve) => { releaseFence = resolve; });
    const blocker = prisma.$transaction(async (tx) => {
      await RaceResolutionJobV2.acquireForWrite(tx, { raceId });
      fenceHeld();
      await release;
    });
    await held;
    let completed = false;
    const completion = completeRaceUnderSettlementFence(
      { id: raceId, creationSource: "QUICK_CREATE", startPolicy: "ON_MINIMUM_PARTICIPANTS" },
      {
        raceId,
        winnerUserId: participants[0].userId,
        participantUserIds: participants.map((p) => p.userId),
      }
    ).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(completed, false);
    assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).status, "ACTIVE");
    assert.equal(await prisma.coinTransaction.count({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: raceId } },
    }), 0);
    releaseFence();
    await blocker;
    await completion;
    assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).status, "COMPLETED");
    assert.equal(await prisma.coinTransaction.count({
      where: { reason: "race_prize_pool_payout", refId: { startsWith: raceId } },
    }), 2);
  });

  it("appends the authenticated participant's referral code to a race share URL", async () => {
    const owner = await user();
    const race = await request(server.baseUrl, "POST", "/races", {
      token: owner.token,
      body: { name: "Shared Race", maxDurationDays: 7 },
    });
    const raceId = (await race.json()).race.id;
    const share = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: owner.token,
    });
    assert.equal(share.status, 201);
    const body = await share.json();
    const dbUser = await prisma.user.findUnique({ where: { id: owner.id } });
    assert.match(body.url, new RegExp(`\\?ref=${encodeURIComponent(dbUser.referralCode)}$`));
  });

  it("accepts the documented next-race analytics identifiers and context", async () => {
    const walker = await user();
    const event = {
      id: `next-race-event-${Date.now()}`,
      name: "quick_create_succeeded",
      context: {
        preset: "2_day",
        race_id: "d63de5b7-8e68-4668-ab78-ddbd9aa38ff0",
      },
      appVersion: "2.3.0",
      platform: "ios",
      timestamp: new Date().toISOString(),
    };
    const res = await request(server.baseUrl, "POST", "/analytics/activation-events", {
      token: walker.token,
      body: { events: [event] },
    });
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    assert.deepEqual(await res.json(), { accepted: 1, inserted: 1 });
  });
});
