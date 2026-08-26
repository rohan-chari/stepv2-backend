const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");
const {
  auditReferralRaceActivityCatchUp,
  catchUpReferralRaceActivities,
} = require("../../src/modules/social/commands/recordReferralRaceActivity");
const {
  auditGiveawayPointReviewOwnership,
  catchUpGiveawayPointReviewOwnership,
} = require("../../src/modules/giveaways/commands/catchUpGiveawayPointReviewOwnership");

const GLOBAL_FEATURES = {
  "X-Client-Features": "referral_contest_v1,referral_contest_global_v1",
};

describe("joined referral contest dashboard contract", () => {
  const now = new Date("2026-08-25T16:00:00.000Z");
  let server;
  let entrant;
  let contest;

  before(async () => {
    assert.match(process.env.DATABASE_URL || "", /(?:_test(?:\?|$)|localhost)/,
      "joined contest integration tests require a local/test database");
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 = "joined-dashboard-integration-secret";
    await cleanDatabase();

    entrant = await createTestUser({ displayName: "DashboardBara" });
    contest = await prisma.giveawayContest.create({ data: {
      slug: "joined-dashboard",
      title: "Joined Dashboard",
      lifecycleStatus: "PUBLISHED",
      governingTimeZone: "UTC",
      startsAt: new Date("2026-08-01T00:00:00.000Z"),
      endsAt: new Date("2026-09-01T00:00:00.000Z"),
      cashMinor: 0,
      coinPrize: 5000,
      eligibilityMode: "BARA_ACCOUNT",
      sponsor: { name: "Bara" },
      rulesVersion: "joined-v1",
      rulesSections: [],
      rulesHash: "a".repeat(64),
      bannerMessage: "Join the contest.",
      publishedAt: new Date("2026-08-01T00:00:00.000Z"),
      frozenAt: new Date("2026-08-01T00:00:00.000Z"),
    } });
    await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id,
      userId: entrant.user.id,
      entrantIdentityHash: "v1:dashboard-entrant",
      status: "ELIGIBLE",
      rulesAcceptedAt: new Date("2026-08-10T00:00:00.000Z"),
      acceptedRulesVersion: "joined-v1",
      acceptedRulesHash: "a".repeat(64),
      displayNameSnapshot: "DashboardBara",
      displayNameConsentedAt: new Date("2026-08-10T00:00:00.000Z"),
    } });

    const refereeNames = ["SignedBara", "RacingBara", "ReviewBara", "WinnerBara", "RejectedBara"];
    const referees = await Promise.all(refereeNames.map((displayName) => createTestUser({ displayName })));
    const referrals = [];
    for (let index = 0; index < referees.length; index += 1) {
      referrals.push(await prisma.referral.create({ data: {
        referrerId: entrant.user.id,
        refereeId: referees[index].user.id,
        refereeSubHash: crypto.createHash("sha256").update(`joined-${index}`).digest("hex"),
        status: index === 2 ? "FLAGGED" : index >= 3 ? "REWARDED" : "PENDING",
        createdAt: new Date(index === 4 ? "2026-08-11T10:00:00.000Z" : `2026-08-2${index}T10:00:00.000Z`),
        ...(index >= 2 ? {
          qualifiedAt: new Date(index === 4 ? "2026-08-11T12:00:00.000Z" : `2026-08-2${index}T12:00:00.000Z`),
        } : {}),
      } }));
    }

    // Four newer qualification facts push the old rejected fact out of the
    // social fact source. Its recent review decision must independently bring
    // it back as NOT_COUNTED.
    for (let index = 0; index < 4; index += 1) {
      const referee = await createTestUser({ displayName: `FillerBara${index}` });
      const referral = await prisma.referral.create({ data: {
        referrerId: entrant.user.id,
        refereeId: referee.user.id,
        refereeSubHash: crypto.createHash("sha256").update(`joined-filler-${index}`).digest("hex"),
        status: "REWARDED",
        createdAt: new Date(`2026-08-${12 + index}T10:00:00.000Z`),
        qualifiedAt: new Date(`2026-08-20T0${6 + index}:00:00.000Z`),
      } });
      await prisma.referralQualificationFact.create({ data: {
        referralFactId: referral.id,
        referrerId: entrant.user.id,
        refereeIdentityHash: referral.refereeSubHash,
        status: "REWARDED",
        qualifiedAt: referral.qualifiedAt,
        referralCreatedAt: referral.createdAt,
      } });
    }

    // More than the retired referral sampling cap. The older RacingBara
    // attribution must still surface from the exact activity ledger.
    const newerUsers = Array.from({ length: 65 }, (_, index) => ({
      id: crypto.randomUUID(),
      displayName: `NewerBara${index}`,
    }));
    await prisma.user.createMany({ data: newerUsers });
    await prisma.referral.createMany({
      data: newerUsers.map((user, index) => ({
        id: crypto.randomUUID(),
        referrerId: entrant.user.id,
        refereeId: user.id,
        refereeSubHash: crypto.createHash("sha256").update(`joined-newer-${index}`).digest("hex"),
        status: "PENDING",
        createdAt: new Date(`2026-08-20T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      })),
    });

    const race = await prisma.race.create({ data: {
      name: "Referral race",
      status: "ACTIVE",
      targetSteps: 10000,
      startedAt: new Date("2026-08-21T10:30:00.000Z"),
      endsAt: new Date("2026-08-28T10:30:00.000Z"),
    } });
    const racingParticipant = await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: referees[1].user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-08-21T11:00:00.000Z"),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: entrant.user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-08-21T10:59:00.000Z"),
    } });
    await prisma.referralRaceActivity.create({ data: {
      referralId: referrals[1].id,
      referrerId: entrant.user.id,
      raceParticipantId: racingParticipant.id,
      occurredAt: racingParticipant.joinedAt,
    } });

    for (const index of [2, 3, 4]) {
      await prisma.referralQualificationFact.create({ data: {
        referralFactId: referrals[index].id,
        referrerId: entrant.user.id,
        refereeIdentityHash: referrals[index].refereeSubHash,
        status: index === 2 ? "FLAGGED" : "REWARDED",
        qualifiedAt: referrals[index].qualifiedAt,
        referralCreatedAt: referrals[index].createdAt,
      } });
    }
    const reviewer = await createTestUser({ displayName: "ReviewerBara" });
    await prisma.giveawayPointReview.create({ data: {
      contestId: contest.id,
      referralFactId: referrals[4].id,
      referrerIdSnapshot: entrant.user.id,
      qualifiedAtSnapshot: referrals[4].qualifiedAt,
      referralStatusSnapshot: "REWARDED",
      decision: "REJECT",
      reasonCode: "PRIVATE_REASON",
      privateNote: "never serialize this",
      actorId: reviewer.user.id,
      decidedAt: new Date("2026-08-25T15:00:00.000Z"),
    } });

    server = await startServer({ now: () => new Date(now) });
  });

  after(async () => {
    await server?.close();
    delete process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1;
  });

  it("returns the additive minimized newest-first activity contract only to capable clients", async () => {
    const capableResponse = await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token,
      headers: GLOBAL_FEATURES,
    });
    assert.equal(capableResponse.status, 200);
    const capable = await capableResponse.json();
    assert.deepEqual({
      percentile: capable.standing.percentile,
      nextTargetRank: capable.standing.nextTargetRank,
      referralsBehindNextTarget: capable.standing.referralsBehindNextTarget,
    }, {
      percentile: 100,
      nextTargetRank: null,
      referralsBehindNextTarget: null,
    });
    assert.deepEqual(capable.recentReferrals, [
      { displayName: "RejectedBara", occurredAt: "2026-08-25T15:00:00.000Z", status: "NOT_COUNTED" },
      { displayName: "WinnerBara", occurredAt: "2026-08-23T12:00:00.000Z", status: "QUALIFIED" },
      { displayName: "ReviewBara", occurredAt: "2026-08-22T12:00:00.000Z", status: "UNDER_REVIEW" },
      { displayName: "RacingBara", occurredAt: "2026-08-21T11:00:00.000Z", status: "IN_RACE" },
    ]);
    assert.equal(JSON.stringify(capable.recentReferrals).includes("PRIVATE_REASON"), false);
    assert.equal(JSON.stringify(capable.recentReferrals).includes("userId"), false);
    assert.equal(JSON.stringify(capable.recentReferrals).includes("raceId"), false);

    const legacyResponse = await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    });
    const legacy = await legacyResponse.json();
    assert.equal(Object.hasOwn(legacy, "recentReferrals"), false);
  });

  it("records exact event-time activity for create, direct join, and invite acceptance", async () => {
    const referredCreator = await createTestUser({ displayName: "LedgerCreator" });
    const referredJoiner = await createTestUser({ displayName: "LedgerJoiner" });
    const referredInvitee = await createTestUser({ displayName: "LedgerInvitee" });
    for (const [index, referred] of [referredCreator, referredJoiner, referredInvitee].entries()) {
      await prisma.referral.create({ data: {
        referrerId: entrant.user.id,
        refereeId: referred.user.id,
        refereeSubHash: crypto.createHash("sha256").update(`ledger-writer-${index}`).digest("hex"),
        status: "PENDING",
      } });
    }

    const createdResponse = await request(server.baseUrl, "POST", "/races", {
      token: referredCreator.token,
      body: { name: "Ledger Race", maxDurationDays: 1, isPublic: true },
    });
    assert.equal(createdResponse.status, 201, JSON.stringify(await createdResponse.clone().json()));
    const raceId = (await createdResponse.json()).race.id;

    const joinedResponse = await request(server.baseUrl, "POST", `/races/${raceId}/join`, {
      token: referredJoiner.token,
    });
    assert.ok([200, 201].includes(joinedResponse.status));

    await prisma.friendship.create({ data: {
      requesterId: referredCreator.user.id,
      addresseeId: referredInvitee.user.id,
      status: "ACCEPTED",
    } });
    const invitedResponse = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      token: referredCreator.token,
      body: { inviteeIds: [referredInvitee.user.id] },
    });
    assert.equal(invitedResponse.status, 200);
    const acceptedResponse = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: referredInvitee.token,
      body: { accept: true },
    });
    assert.equal(acceptedResponse.status, 200);

    const response = await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token,
      headers: GLOBAL_FEATURES,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    for (const displayName of ["LedgerCreator", "LedgerJoiner", "LedgerInvitee"]) {
      assert.ok(body.recentReferrals.some((item) =>
        item.displayName === displayName && item.status === "IN_RACE"));
    }
  });

  it("idempotently catches up rolling-deploy race and review ownership gaps", async () => {
    const legacyReferee = await createTestUser({ displayName: "LegacyGapBara" });
    const referral = await prisma.referral.create({ data: {
      referrerId: entrant.user.id,
      refereeId: legacyReferee.user.id,
      refereeSubHash: crypto.createHash("sha256").update("legacy-gap").digest("hex"),
      status: "REWARDED",
      createdAt: new Date("2026-08-20T08:00:00.000Z"),
      qualifiedAt: new Date("2026-08-24T08:00:00.000Z"),
    } });
    await prisma.referralQualificationFact.create({ data: {
      referralFactId: referral.id,
      referrerId: entrant.user.id,
      refereeIdentityHash: referral.refereeSubHash,
      status: "REWARDED",
      qualifiedAt: referral.qualifiedAt,
      referralCreatedAt: referral.createdAt,
    } });
    await prisma.giveawayPointReview.create({ data: {
      contestId: contest.id,
      referralFactId: referral.id,
      qualifiedAtSnapshot: referral.qualifiedAt,
      referralStatusSnapshot: "REWARDED",
      decision: "APPROVE",
      reasonCode: "LEGITIMATE",
      actorId: entrant.user.id,
      decidedAt: new Date("2026-08-25T15:30:00.000Z"),
    } });
    const fallbackReferee = await createTestUser({ displayName: "LegacyNoFactBara" });
    const fallbackReferral = await prisma.referral.create({ data: {
      referrerId: entrant.user.id,
      refereeId: fallbackReferee.user.id,
      refereeSubHash: crypto.createHash("sha256").update("legacy-no-fact").digest("hex"),
      status: "FLAGGED",
      createdAt: new Date("2026-08-20T08:30:00.000Z"),
      qualifiedAt: new Date("2026-08-24T08:30:00.000Z"),
    } });
    await prisma.giveawayPointReview.create({ data: {
      contestId: contest.id,
      referralFactId: fallbackReferral.id,
      qualifiedAtSnapshot: fallbackReferral.qualifiedAt,
      referralStatusSnapshot: "FLAGGED",
      decision: "REJECT",
      reasonCode: "FRAUD",
      actorId: entrant.user.id,
      decidedAt: new Date("2026-08-25T15:45:00.000Z"),
    } });
    const weakReferee = await createTestUser({ displayName: "WeakPendingBara" });
    const weakReferral = await prisma.referral.create({ data: {
      referrerId: entrant.user.id,
      refereeId: weakReferee.user.id,
      refereeSubHash: crypto.createHash("sha256").update("weak-pending").digest("hex"),
      status: "PENDING",
      createdAt: new Date("2026-08-20T08:45:00.000Z"),
    } });
    await prisma.giveawayPointReview.create({ data: {
      contestId: contest.id,
      referralFactId: weakReferral.id,
      qualifiedAtSnapshot: new Date("2026-08-24T08:45:00.000Z"),
      referralStatusSnapshot: "PENDING",
      decision: "REJECT",
      reasonCode: "FRAUD",
      actorId: entrant.user.id,
      decidedAt: new Date("2026-08-25T15:50:00.000Z"),
    } });
    const race = await prisma.race.create({ data: {
      name: "Rolling gap race",
      status: "ACTIVE",
      targetSteps: 1000,
      startedAt: new Date("2026-08-24T09:00:00.000Z"),
      endsAt: new Date("2026-08-26T09:00:00.000Z"),
    } });
    const participant = await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: legacyReferee.user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-08-24T09:30:00.000Z"),
    } });
    await prisma.raceParticipant.create({ data: {
      raceId: race.id,
      userId: entrant.user.id,
      status: "ACCEPTED",
      joinedAt: new Date("2026-08-24T09:31:00.000Z"),
    } });

    assert.equal(await auditReferralRaceActivityCatchUp(), 1);
    assert.equal(await auditGiveawayPointReviewOwnership(), 2);
    await prisma.$transaction(async (tx) => {
      assert.equal(await catchUpReferralRaceActivities({ tx }), 1);
      assert.equal(await catchUpGiveawayPointReviewOwnership({ tx }), 2);
    });
    assert.equal(await auditReferralRaceActivityCatchUp(), 0);
    assert.equal(await auditGiveawayPointReviewOwnership(), 0);
    await prisma.$transaction(async (tx) => {
      assert.equal(await catchUpReferralRaceActivities({ tx }), 0);
      assert.equal(await catchUpGiveawayPointReviewOwnership({ tx }), 0);
    });
    const activity = await prisma.referralRaceActivity.findUnique({
      where: { raceParticipantId: participant.id },
    });
    assert.equal(activity.referrerId, entrant.user.id);
    const review = await prisma.giveawayPointReview.findUnique({
      where: { contestId_referralFactId: { contestId: contest.id, referralFactId: referral.id } },
    });
    assert.equal(review.referrerIdSnapshot, entrant.user.id);
    const fallbackReview = await prisma.giveawayPointReview.findUnique({
      where: {
        contestId_referralFactId: {
          contestId: contest.id,
          referralFactId: fallbackReferral.id,
        },
      },
    });
    assert.equal(fallbackReview.referrerIdSnapshot, entrant.user.id);
    const weakReview = await prisma.giveawayPointReview.findUnique({
      where: {
        contestId_referralFactId: {
          contestId: contest.id,
          referralFactId: weakReferral.id,
        },
      },
    });
    assert.equal(weakReview.referrerIdSnapshot, null);
    const response = await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token,
      headers: GLOBAL_FEATURES,
    });
    const body = await response.json();
    assert.ok(body.recentReferrals.some((item) =>
      item.displayName === "LegacyNoFactBara" && item.status === "NOT_COUNTED"));
    assert.equal(body.recentReferrals.some((item) =>
      item.displayName === "WeakPendingBara"), false);
  });

  it("fails soft when the injected bounded activity query is unavailable", async () => {
    const errors = [];
    const failing = await startServer({
      now: () => new Date(now),
      getRecentGiveawayReferralCandidates: async () => { throw new Error("unavailable"); },
      logger: { error(message, details) { errors.push({ message, details }); }, warn() {}, info() {}, log() {} },
    });
    try {
      const response = await request(failing.baseUrl, "GET", "/giveaways/current/me", {
        token: entrant.token,
        headers: GLOBAL_FEATURES,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.recentReferrals, []);
      assert.ok(body.contest);
      assert.ok(body.entry);
      assert.ok(body.standing);
      assert.ok(body.share);
      assert.equal(errors.length, 1);
      assert.deepEqual(Object.keys(errors[0].details).sort(), ["contestId", "errorCode", "errorName", "userId"]);
    } finally {
      await failing.close();
    }
  });

  it("also fails soft when the optional point-review overlay is unavailable", async () => {
    // Remove established standing facts so the injected failure is reached only
    // by the optional activity pipeline, not by the core standings query.
    await prisma.giveawayPointReview.deleteMany();
    await prisma.referralQualificationFact.deleteMany();
    await prisma.referral.deleteMany();

    const failingReviewDelegate = new Proxy(prisma.giveawayPointReview, {
      get(target, property) {
        if (property === "findMany") return async () => { throw new Error("review overlay unavailable"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingDb = new Proxy(prisma, {
      get(target, property) {
        if (property === "giveawayPointReview") return failingReviewDelegate;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const errors = [];
    const failing = await startServer({
      prisma: failingDb,
      now: () => new Date(now),
      getRecentGiveawayReferralCandidates: async () => [{
        id: "optional-fact",
        referralFactId: "optional-fact",
        displayName: "OptionalBara",
        attributedAt: new Date("2026-08-20T10:00:00.000Z"),
        factStatus: "REWARDED",
        qualifiedAt: new Date("2026-08-20T12:00:00.000Z"),
      }],
      logger: { error(message, details) { errors.push({ message, details }); }, warn() {}, info() {}, log() {} },
    });
    try {
      const response = await request(failing.baseUrl, "GET", "/giveaways/current/me", {
        token: entrant.token,
        headers: GLOBAL_FEATURES,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.recentReferrals, []);
      assert.ok(body.contest);
      assert.ok(body.entry);
      assert.ok(body.standing);
      assert.ok(body.share);
      assert.equal(errors.length, 1);
    } finally {
      await failing.close();
    }
  });
});
