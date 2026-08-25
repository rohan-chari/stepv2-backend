const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");
const { buildCompleteRace } = require("../../src/modules/races/commands/completeRace");
const {
  createReferralQualificationIntents,
  processReferralQualificationIntents,
} = require("../../src/modules/social");
const {
  recoverReferralQualificationIntents,
} = require("../../src/modules/giveaways/jobs/qualificationIntentRecovery");
const { buildGiveawayRetention } = require("../../src/modules/giveaways");

const ALL_REGIONS = [
  "US-AL", "US-AK", "US-AZ", "US-AR", "US-CA", "US-CO", "US-CT", "US-DE", "US-DC",
  "US-FL", "US-GA", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY",
  "US-LA", "US-ME", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT",
  "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NY", "US-NC", "US-ND", "US-OH",
  "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT",
  "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "US-WY",
];
const RULES = [
  { heading: "Eligibility", body: "Open only to legal residents of the 50 United States and D.C. age 18 or older." },
  { heading: "How to enter and win", body: "No purchase necessary. Accept the rules, then the eligible entrant with the most verified completed referrals wins. Ties go to the entrant who reached the final count first." },
  { heading: "Platforms", body: "Apple and Google are not sponsors, administrators, endorsers, or involved in this contest." },
];

function uuid() { return crypto.randomUUID(); }
function contestBody(overrides = {}) {
  return {
    slug: `hardening-${crypto.randomUUID()}`,
    title: "Bara Referral Contest",
    governingTimeZone: "America/New_York",
    startsAt: "2026-08-01T04:00:00.000Z",
    endsAt: "2026-10-01T04:00:00.000Z",
    cashCurrency: "USD",
    cashMinor: 5000,
    coinPrize: 5000,
    minimumAge: 18,
    eligibleRegions: ALL_REGIONS,
    sponsor: { legalName: "Bara Steps LLC", mailingAddress: "123 Main St, New York, NY 10001" },
    rules: { version: "hardening-v1", sections: RULES },
    socialLinks: [],
    bannerMessage: "Bara Referral Contest: win US$50 + 5,000 coins.",
    ...overrides,
  };
}

async function read(response) {
  const resolved = await response;
  return { response: resolved, payload: await resolved.json() };
}

describe("referral giveaway hardening", () => {
  let server;
  let admin;
  let clock = new Date("2026-08-25T12:00:00.000Z");

  before(async () => {
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "2";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 = "old-integration-giveaway-secret-material-v1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V2 = "new-integration-giveaway-secret-material-v2";
    process.env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET = "integration-provider-reference-hmac-secret";
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    process.env.REFERRAL_IP_HMAC_SECRET_V1 = "integration-test-only-referral-hmac-secret-material";
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Hardening Admin" });
    server = await startServer({ now: () => new Date(clock), isAdminUser: (user) => user?.id === admin.user.id });
  });

  beforeEach(async () => {
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Hardening Admin" });
    clock = new Date("2026-08-25T12:00:00.000Z");
  });

  after(async () => {
    await server?.close();
    for (const name of [
      "GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION", "GIVEAWAY_ENTRANT_HMAC_SECRET_V1",
      "GIVEAWAY_ENTRANT_HMAC_SECRET_V2", "GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET",
      "REFERRAL_IP_HMAC_ACTIVE_VERSION", "REFERRAL_IP_HMAC_SECRET_V1",
    ]) delete process.env[name];
  });

  async function createAndPublish(overrides = {}) {
    let out = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: contestBody(overrides),
    }));
    assert.equal(out.response.status, 201, JSON.stringify(out.payload));
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${out.payload.contest.id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: out.payload.contest.revision },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    return out.payload.contest;
  }

  async function enter(contest, user) {
    const out = await read(await request(server.baseUrl, "POST", `/giveaways/${contest.slug}/entries`, {
      token: user.token,
      body: { rulesVersion: "hardening-v1", country: "US", region: "US-NY", ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true },
    }));
    assert.equal(out.response.status, 201, JSON.stringify(out.payload));
    return out.payload.entry;
  }

  async function makeFriends(a, b) {
    let out = await read(await request(server.baseUrl, "POST", "/friends/request", {
      token: a.token, body: { addresseeId: b.user.id },
    }));
    assert.equal(out.response.status, 201, JSON.stringify(out.payload));
    const friendshipId = out.payload.friendship.id;
    out = await read(await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      token: b.token, body: { accept: true },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
  }

  async function seedEntrantFacts(contest, name, statuses, minuteOffset = 0) {
    const user = await createTestUser({ displayName: name });
    const entrant = await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: user.user.id, entrantIdentityHash: `v2:${uuid()}`, identityHashVersion: 2,
      status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: new Date("2026-08-02T00:00:00Z"),
      residencyConfirmedAt: new Date("2026-08-02T00:00:00Z"), rulesAcceptedAt: new Date("2026-08-02T00:00:00Z"),
      acceptedRulesVersion: "hardening-v1", acceptedRulesHash: contest.rules.sha256,
      displayNameSnapshot: name, displayNameConsentedAt: new Date("2026-08-02T00:00:00Z"),
    } });
    for (const [index, status] of statuses.entries()) {
      const referee = await createTestUser({ displayName: `${name} Referee ${index}` });
      const race = await prisma.race.create({ data: { name: `${name} fact ${index}`, status: "COMPLETED", targetSteps: 1000 } });
      await prisma.referral.create({ data: {
        referrerId: user.user.id, refereeId: referee.user.id, refereeSubHash: `outcome:${uuid()}`,
        status, createdAt: new Date("2026-08-03T00:00:00Z"),
        qualifiedAt: new Date(`2026-08-10T00:${String(minuteOffset + index).padStart(2, "0")}:00Z`), qualifyingRaceId: race.id,
      } });
    }
    return { user, entrant };
  }

  it("uses real HTTP attribution and race lifecycle, then the real expiry worker settles qualification and rewards exactly once", async () => {
    const contest = await createAndPublish();
    const referrer = await createTestUser({ displayName: "Real Referrer" });
    const referee = await createTestUser({ displayName: "Real Referee" });
    const peer = await createTestUser({ displayName: "Real Peer" });
    await enter(contest, referrer);

    let out = await read(await request(server.baseUrl, "GET", "/referrals/me", { token: referrer.token }));
    assert.equal(out.response.status, 200);
    const referralCode = out.payload.code;
    out = await read(await request(server.baseUrl, "POST", "/referrals/redeem", {
      token: referee.token, body: { referralCode },
    }));
    assert.deepEqual(out.payload, { attributed: true });

    await makeFriends(referee, peer);
    out = await read(await request(server.baseUrl, "POST", "/races", {
      token: referee.token,
      body: { name: "Real qualifying race", targetSteps: 100000, maxDurationDays: 7, powerupsEnabled: false },
    }));
    assert.equal(out.response.status, 201, JSON.stringify(out.payload));
    const raceId = out.payload.race.id;
    assert.equal((await request(server.baseUrl, "POST", `/races/${raceId}/invite`, { token: referee.token, body: { inviteeIds: [peer.user.id] } })).status, 200);
    assert.equal((await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, { token: peer.token, body: { accept: true } })).status, 200);
    // The second accepted participant auto-starts a private race through the
    // production invite-response path; no direct settlement setup shortcut.
    assert.equal((await prisma.race.findUnique({ where: { id: raceId } })).status, "ACTIVE");

    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await prisma.race.update({ where: { id: raceId }, data: { startedAt, endsAt: new Date(Date.now() - 1000), timezone: "UTC" } });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: startedAt } });
    const samples = [{ periodStart: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), periodEnd: new Date(Date.now() - 60 * 60 * 1000).toISOString(), steps: 3000 }];
    assert.equal((await request(server.baseUrl, "POST", "/steps/samples", { token: referee.token, body: { samples } })).status, 200);
    assert.equal((await request(server.baseUrl, "POST", "/steps/samples", { token: peer.token, body: { samples } })).status, 200);

    await resolveExpiredRaces();
    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.user.id } });
    const intent = await prisma.referralQualificationIntent.findFirst({ where: { referralId: referral.id } });
    assert.equal(referral.status, "REWARDED");
    assert.equal(referral.qualifyingRaceId, raceId);
    assert.ok(referral.qualifiedAt);
    assert.ok(intent.processedAt);
    assert.equal(await prisma.referralRewardGrant.count({ where: { referralId: referral.id } }), 2);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "referral_reward" } }), 2);
    const publicData = await (await request(server.baseUrl, "GET", `/giveaways/${contest.slug}/data`)).json();
    assert.deepEqual(publicData.leaderboard[0], { rank: 1, displayName: "Real Referrer", completedCount: 1 });
  });

  it("keeps a crashed qualification intent pending after rewards commit, then real recovery marks it once without recursion or double pay", async () => {
    const referrer = await createTestUser({ displayName: "Crash Referrer" });
    const referee = await createTestUser({ displayName: "Crash Referee" });
    const code = (await (await request(server.baseUrl, "GET", "/referrals/me", { token: referrer.token })).json()).code;
    await request(server.baseUrl, "POST", "/referrals/redeem", { token: referee.token, body: { referralCode: code } });
    const race = await prisma.race.create({ data: { name: "Crash race", status: "COMPLETED", targetSteps: 10000, completedAt: clock, participants: { create: [
      { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
      { userId: referrer.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
    ] } } });
    const referral = await prisma.referral.findUnique({ where: { refereeId: referee.user.id } });
    await prisma.referral.update({ where: { id: referral.id }, data: { createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000) } });
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: race.id, qualifiedAt: clock,
      participantUserIds: [referee.user.id, referrer.user.id], seedId: null, tournamentId: null,
    }));

    await assert.rejects(() => processReferralQualificationIntents({
      raceId: race.id,
      now: () => new Date(clock),
      afterRewardCommitted: () => { throw new Error("crash-after-reward"); },
    }), /crash-after-reward/);
    let intent = await prisma.referralQualificationIntent.findFirst({ where: { referralId: referral.id } });
    assert.equal(intent.processedAt, null);
    assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, "REWARDED");
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "REWARDED");
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "referral_reward" } }), 2);

    await recoverReferralQualificationIntents({ now: () => new Date(clock.getTime() + 61 * 1000) });
    intent = await prisma.referralQualificationIntent.findUnique({ where: { id: intent.id } });
    assert.ok(intent.processedAt);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "referral_reward" } }), 2);
  });

  it("isolates a poisoned qualification intent so a later fact is still rewarded", async () => {
    const referrals = [];
    const refereeIds = [];
    for (const label of ["Poison", "Healthy"]) {
      const referrer = await createTestUser({ displayName: `${label} Referrer` });
      const referee = await createTestUser({ displayName: `${label} Referee` });
      refereeIds.push(referee.user.id);
      referrals.push(await prisma.referral.create({ data: {
        referrerId: referrer.user.id, refereeId: referee.user.id,
        refereeSubHash: `${label.toLowerCase()}:${uuid()}`, status: "PENDING",
        createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
      } }));
    }
    const race = await prisma.race.create({ data: { name: "Poison isolation", status: "COMPLETED", targetSteps: 1000 } });
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: race.id, qualifiedAt: clock, participantUserIds: refereeIds,
      seedId: null, tournamentId: null,
    }));
    await processReferralQualificationIntents({
      rewardOne: async ({ referralId }) => {
        if (referralId === referrals[0].id) throw new Error("poison");
        return require("../../src/modules/social").grantQualifiedReferralReward({ referralId });
      },
      throwOnError: false,
    });
    assert.equal((await prisma.referral.findUnique({ where: { id: referrals[0].id } })).status, "PENDING");
    assert.equal((await prisma.referral.findUnique({ where: { id: referrals[1].id } })).status, "REWARDED");
    const poisonIntent = await prisma.referralQualificationIntent.findFirst({ where: { referralId: referrals[0].id } });
    const healthyIntent = await prisma.referralQualificationIntent.findFirst({ where: { referralId: referrals[1].id } });
    assert.equal(poisonIntent.processedAt, null);
    assert.match(poisonIntent.lastError, /poison/);
    assert.ok(healthyIntent.processedAt);
  });

  it("claims intents with SKIP LOCKED and preserves the earliest concurrent qualification fact", async () => {
    const referrer = await createTestUser({ displayName: "Concurrent Referrer" });
    const referee = await createTestUser({ displayName: "Concurrent Referee" });
    const opponent = await createTestUser({ displayName: "Concurrent Opponent" });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id,
      refereeSubHash: `concurrent:${uuid()}`, status: "PENDING",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    const earlyAt = new Date(clock.getTime() - 60 * 60 * 1000);
    const lateAt = new Date(clock);
    const [earlyRace, lateRace] = await Promise.all([
      prisma.race.create({ data: { name: "Early fact", status: "COMPLETED", targetSteps: 1000 } }),
      prisma.race.create({ data: { name: "Late fact", status: "COMPLETED", targetSteps: 1000 } }),
    ]);
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: earlyRace.id, qualifiedAt: earlyAt,
      participantUserIds: [referee.user.id, opponent.user.id], seedId: null, tournamentId: null,
    }));
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: lateRace.id, qualifiedAt: lateAt,
      participantUserIds: [referee.user.id, opponent.user.id], seedId: null, tournamentId: null,
    }));
    const delayedEarly = async (intent) => {
      if (intent.qualifyingRaceId === earlyRace.id) await new Promise((resolve) => setTimeout(resolve, 30));
    };
    await Promise.all([
      processReferralQualificationIntents({ limit: 2, retryDelayMs: 0, processOne: delayedEarly }),
      processReferralQualificationIntents({ limit: 2, retryDelayMs: 0 }),
    ]);
    const fact = await prisma.referral.findUnique({ where: { id: referral.id } });
    assert.equal(fact.qualifiedAt.toISOString(), earlyAt.toISOString());
    assert.equal(fact.qualifyingRaceId, earlyRace.id);
    assert.equal(await prisma.referralQualificationIntent.count({ where: { referralId: referral.id, processedAt: { not: null } } }), 2);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "referral_reward" } }), 2);
  });

  it("enforces exact territory and exact nested/body allowlists", async () => {
    let out = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: contestBody({ eligibleRegions: ["US-NY"] }),
    }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_REGION");
    out = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { ...contestBody(), unknown: "must reject" },
    }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_BODY");
    out = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: contestBody({ sponsor: { legalName: "Bara Steps LLC", mailingAddress: "123 Main", secret: "reject" } }),
    }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_BODY");
  });

  it("matches retained entrant HMAC versions after account deletion and key rotation", async () => {
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    const contest = await createAndPublish();
    const entrant = await createTestUser({ appleId: "rotating-stable-sub", displayName: "Rotating Entrant" });
    await enter(contest, entrant);
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: entrant.token })).status, 204);
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "2";
    const recreated = await createTestUser({ appleId: "rotating-stable-sub", displayName: "Rotating Entrant Again" });
    const out = await read(await request(server.baseUrl, "POST", `/giveaways/${contest.slug}/entries`, {
      token: recreated.token,
      body: { rulesVersion: "hardening-v1", country: "US", region: "US-NY", ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "ENTRY_IMMUTABLE");
  });

  it("rejects review-account contest entry", async () => {
    const contest = await createAndPublish({ slug: "review-account-entry" });
    const reviewer = await createTestUser({ displayName: "Store Reviewer", isReviewAccount: true });
    const out = await read(await request(server.baseUrl, "POST", `/giveaways/${contest.slug}/entries`, {
      token: reviewer.token,
      body: { rulesVersion: "hardening-v1", country: "US", region: "US-NY", ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "ENTRY_INELIGIBLE");
  });

  it("serializes create/PATCH/publish idempotency and never re-finalizes or revives an outcome", async () => {
    const key = uuid();
    const body = contestBody({ slug: "simultaneous-create" });
    const created = await Promise.all([1, 2].map(() => read(request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": key }, body,
    }))));
    assert.deepEqual(created.map((x) => x.response.status), [201, 201]);
    assert.equal(created[0].payload.contest.id, created[1].payload.contest.id);
    assert.equal(await prisma.giveawayContest.count({ where: { slug: body.slug } }), 1);

    const contest = created[0].payload.contest;
    const patched = await Promise.all(["First", "Second"].map((title) => read(request(server.baseUrl, "PATCH", `/admin/giveaways/${contest.id}`, {
      token: admin.token, body: { revision: contest.revision, patch: { title } },
    }))));
    assert.deepEqual(patched.map((x) => x.response.status).sort(), [200, 409]);

    const fresh = (await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json()).contest;
    const secondDraft = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: contestBody({ slug: "simultaneous-publish-2" }),
    }));
    const publications = await Promise.all([
      [contest.id, fresh.revision], [secondDraft.payload.contest.id, secondDraft.payload.contest.revision],
    ].map(([id, revision]) => read(request(server.baseUrl, "POST", `/admin/giveaways/${id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }))));
    assert.deepEqual(publications.map((x) => x.response.status).sort(), [200, 409]);
    assert.equal(await prisma.giveawayContest.count({ where: { lifecycleStatus: "PUBLISHED" } }), 1);

    const published = publications.find((x) => x.response.status === 200).payload.contest;
    await prisma.giveawayContest.update({ where: { id: published.id }, data: { endsAt: new Date("2026-08-20T04:00:00.000Z") } });
    let out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${published.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: published.revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "FINAL");
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${published.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: out.payload.contest.revision },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "INVALID_TRANSITION");
    const finalized = await prisma.giveawayContest.findUnique({ where: { id: published.id } });
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${published.id}/cancel`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: finalized.revision, publicReason: "Final results cannot be cancelled.", amendedRulesVersion: "hardening-v2" },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "INVALID_TRANSITION");
    const noWinnerHtml = await (await request(server.baseUrl, "GET", `/giveaways/${published.slug}`)).text();
    assert.match(noWinnerHtml, /No eligible winner was selected/i);
  });

  it("keeps frozen final winner/results on archived public pages and renders all material lifecycle terms", async () => {
    const contest = await createAndPublish({ slug: "archived-final-material" });
    const winner = await createTestUser({ displayName: "Frozen Winner" });
    const entrant = await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: winner.user.id, entrantIdentityHash: "v2:frozen", identityHashVersion: 2,
      status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: clock,
      residencyConfirmedAt: clock, rulesAcceptedAt: clock, acceptedRulesVersion: "hardening-v1",
      acceptedRulesHash: contest.rules.sha256, displayNameSnapshot: "Frozen Winner", displayNameConsentedAt: clock,
    } });
    await prisma.giveawayResult.create({ data: { entrantId: entrant.id, frozenCount: 9, finalRank: 1, status: "VERIFIED", verifiedAt: clock } });
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { lifecycleStatus: "ARCHIVED", finalizedAt: clock, archivedAt: clock } });
    const data = await (await request(server.baseUrl, "GET", "/giveaways/archived-final-material/data")).json();
    assert.deepEqual(data.winner, { displayName: "Frozen Winner", originalRank: 1 });
    assert.deepEqual(data.leaderboard[0], { rank: 1, displayName: "Frozen Winner", completedCount: 9 });
    const html = await (await request(server.baseUrl, "GET", "/giveaways/archived-final-material")).text();
    for (const copy of ["Bara Steps LLC", "No purchase necessary", "most verified completed referrals", "reached the final count first", "Final", "Frozen Winner"]) {
      assert.match(html, new RegExp(copy, "i"), copy);
    }
  });

  it("cannot verify a withdrawn winner and skips ineligible alternates without erasing rank history", async () => {
    const contest = await createAndPublish({ slug: "live-winner-eligibility" });
    const seeded = [];
    for (const name of ["Withdrawn First", "Deleted Second", "Eligible Third"]) {
      const user = await createTestUser({ displayName: name });
      const entrant = await prisma.giveawayEntrant.create({ data: {
        contestId: contest.id, userId: user.user.id, entrantIdentityHash: `v2:${uuid()}`, identityHashVersion: 2,
        status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: clock,
        residencyConfirmedAt: clock, rulesAcceptedAt: clock, acceptedRulesVersion: "hardening-v1",
        acceptedRulesHash: contest.rules.sha256, displayNameSnapshot: name, displayNameConsentedAt: clock,
      } });
      seeded.push({ user, entrant });
    }
    await prisma.giveawayResult.createMany({ data: seeded.map(({ entrant }, index) => ({
      entrantId: entrant.id, frozenCount: 3 - index, finalRank: index + 1,
      status: index === 0 ? "POTENTIAL" : "RANKED", selectedAt: index === 0 ? clock : null,
    })) });
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { finalizedAt: clock } });
    await prisma.giveawayEntrant.update({ where: { id: seeded[0].entrant.id }, data: { status: "WITHDRAWN" } });
    let detail = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    let out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/winner`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: detail.contest.revision, entrantId: seeded[0].entrant.id, decision: "VERIFY", reasonCode: "ELIGIBILITY_VERIFIED" },
    }));
    assert.equal(out.response.status, 409);
    detail = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/winner`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: detail.contest.revision, entrantId: seeded[0].entrant.id, decision: "REJECT", reasonCode: "INELIGIBLE" },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    await prisma.giveawayEntrant.update({ where: { id: seeded[1].entrant.id }, data: { status: "WITHDRAWN", userId: null } });
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/select-next`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: out.payload.contest.revision },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal(out.payload.result.potentialWinner.entrantId, seeded[2].entrant.id);
    const history = await prisma.giveawayResult.findMany({ where: { entrant: { contestId: contest.id } }, orderBy: { finalRank: "asc" } });
    assert.deepEqual(history.map((row) => [row.finalRank, row.status]), [[1, "REJECTED"], [2, "REJECTED"], [3, "POTENTIAL"]]);
  });

  it("pays an approved flagged referral through the ordinary grant and retained review no longer blocks either account deletion", async () => {
    const contest = await createAndPublish({ slug: "approved-flagged" });
    const referrer = await createTestUser({ displayName: "Approved Referrer" });
    const referee = await createTestUser({ displayName: "Approved Referee" });
    await enter(contest, referrer);
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id, refereeSubHash: `flagged:${uuid()}`,
      code: `BARA-${crypto.randomBytes(5).toString("hex").toUpperCase()}`, status: "FLAGGED",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
      qualifiedAt: clock, qualifyingRaceId: (await prisma.race.create({ data: { name: "Flagged fact race", status: "COMPLETED", targetSteps: 1000 } })).id,
    } });
    let detail = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    const out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/reviews`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: detail.contest.revision, referralFactId: referral.id, decision: "APPROVE", reasonCode: "LEGITIMATE", privateNote: "bounded note" },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, "REWARDED");
    assert.equal(await prisma.referralRewardGrant.count({ where: { referralId: referral.id } }), 2);
    assert.equal(await prisma.coinTransaction.count({ where: { reason: "referral_reward" } }), 2);
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referee.token })).status, 204);
    const ordinaryStatus = await (await request(server.baseUrl, "GET", "/referrals/me", { token: referrer.token })).json();
    assert.equal(ordinaryStatus.referredCount, 0, "legacy referral dashboard keeps referee-delete CASCADE behavior");
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referrer.token })).status, 204);
    const review = await prisma.giveawayPointReview.findFirst({ where: { contestId: contest.id } });
    assert.ok(review);
    assert.equal(review.referralFactId, referral.id);
  });

  it("retains a qualified referral fact when its referee deletes before finalization", async () => {
    const contest = await createAndPublish({
      slug: "deleted-referee-fact",
      endsAt: "2026-08-25T13:00:00.000Z",
    });
    const referrer = await createTestUser({ displayName: "Retained Referrer" });
    const referee = await createTestUser({ displayName: "Deleting Referee" });
    await enter(contest, referrer);
    const opponent = await createTestUser({ displayName: "Retained Opponent" });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id, refereeSubHash: `retained:${uuid()}`,
      status: "PENDING", createdAt: new Date("2026-08-03T00:00:00Z"),
    } });
    const race = await prisma.race.create({ data: {
      name: "Retained fact race", status: "ACTIVE", targetSteps: 1000,
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    const complete = buildCompleteRace({
      now: () => new Date(clock), eventBus: { emit() {} },
      grantReferralRewardsForRace: async () => [], createReviewOpportunity: async () => null,
    });
    await complete({ raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id] });
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "PENDING");
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referee.token })).status, 204);
    assert.equal(await prisma.referral.findUnique({ where: { id: referral.id } }), null);
    const retainedIntent = await prisma.referralQualificationIntent.findFirst({ where: { referralFactId: referral.id } });
    assert.ok(retainedIntent);
    assert.equal(retainedIntent.referralId, null);
    let data = await (await request(server.baseUrl, "GET", `/giveaways/${contest.slug}/data`)).json();
    assert.deepEqual(data.leaderboard, [], "pending adjudication is never a provisional point");
    clock = new Date("2026-08-25T14:00:00.000Z");
    const blockedFinalize = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: contest.revision },
    }));
    assert.equal(blockedFinalize.response.status, 409);
    assert.equal(blockedFinalize.payload.code, "QUALIFICATION_PROCESSING_PENDING");
    await processReferralQualificationIntents({ retryDelayMs: 0 });
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "QUALIFIED");
    assert.ok((await prisma.referralQualificationIntent.findUnique({ where: { id: retainedIntent.id } })).processedAt);
    assert.ok(await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } }));
    data = await (await request(server.baseUrl, "GET", `/giveaways/${contest.slug}/data`)).json();
    assert.deepEqual(data.leaderboard[0], { rank: 1, displayName: "Retained Referrer", completedCount: 1 });
  });

  it("keeps an at-cap immediate-delete qualification pending, then flags it through deletion-independent adjudication", async () => {
    const contest = await createAndPublish({ slug: "deleted-at-cap" });
    const referrer = await createTestUser({ displayName: "At Cap Referrer" });
    const referee = await createTestUser({ displayName: "At Cap Referee" });
    const opponent = await createTestUser({ displayName: "At Cap Opponent" });
    await enter(contest, referrer);
    for (let index = 0; index < 5; index += 1) {
      await prisma.referralRewardGrant.create({ data: {
        userId: referrer.user.id,
        role: "REFERRER",
        refereeSubHash: `prior-cap-${index}:${uuid()}`,
        coins: 500,
        grantedAt: new Date(clock.getTime() - (index + 1) * 1000),
      } });
    }
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id,
      refereeId: referee.user.id,
      refereeSubHash: `deleted-at-cap:${uuid()}`,
      status: "PENDING",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    const race = await prisma.race.create({ data: {
      name: "At-cap retained fact race", status: "ACTIVE", targetSteps: 1000,
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    await buildCompleteRace({
      now: () => new Date(clock), eventBus: { emit() {} },
      grantReferralRewardsForRace: async () => [], createReviewOpportunity: async () => null,
    })({ raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id] });
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "PENDING");
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referee.token })).status, 204);
    await processReferralQualificationIntents({ retryDelayMs: 0 });
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "FLAGGED");
    const data = await (await request(server.baseUrl, "GET", `/giveaways/${contest.slug}/data`)).json();
    assert.deepEqual(data.leaderboard, []);
    const candidates = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates`, { token: admin.token })).json();
    const record = candidates.records.find((candidate) => candidate.displayName === "At Cap Referrer");
    assert.equal(record.verifiedCount, 0);
    assert.equal(record.reviewableCount, 1);
  });

  it("does not let later grants falsely flag an earlier detached qualification during delayed recovery", async () => {
    const referrer = await createTestUser({ displayName: "Historical Cap Referrer" });
    const referee = await createTestUser({ displayName: "Historical Cap Referee" });
    const opponent = await createTestUser({ displayName: "Historical Cap Opponent" });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id,
      refereeId: referee.user.id,
      refereeSubHash: `historical-cap:${uuid()}`,
      status: "PENDING",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    const race = await prisma.race.create({ data: {
      name: "Historical cap race", status: "ACTIVE", targetSteps: 1000,
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    await buildCompleteRace({
      now: () => new Date(clock), eventBus: { emit() {} },
      grantReferralRewardsForRace: async () => [], createReviewOpportunity: async () => null,
    })({ raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id] });
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referee.token })).status, 204);
    const later = new Date(clock.getTime() + 60 * 60 * 1000);
    for (let index = 0; index < 5; index += 1) {
      await prisma.referralRewardGrant.create({ data: {
        userId: referrer.user.id,
        role: "REFERRER",
        refereeSubHash: `later-cap-${index}:${uuid()}`,
        coins: 500,
        grantedAt: new Date(later.getTime() + index),
      } });
    }
    await processReferralQualificationIntents({ retryDelayMs: 0, now: () => new Date(later) });
    assert.equal((await prisma.referralQualificationFact.findUnique({
      where: { referralFactId: referral.id },
    })).status, "QUALIFIED");
  });

  it("does not reserve cap capacity for earlier pending facts already destined for expiry or review exclusion", async () => {
    const referrer = await createTestUser({ displayName: "Eligible Reservation Referrer" });
    const referee = await createTestUser({ displayName: "Eligible Reservation Referee" });
    const opponent = await createTestUser({ displayName: "Eligible Reservation Opponent" });
    for (let index = 0; index < 4; index += 1) {
      await prisma.referralRewardGrant.create({ data: {
        userId: referrer.user.id,
        role: "REFERRER",
        refereeSubHash: `eligible-reservation-prior-${index}:${uuid()}`,
        coins: 500,
        grantedAt: new Date(clock.getTime() - 60 * 60 * 1000),
        qualifiedAtSnapshot: new Date(clock.getTime() - 60 * 60 * 1000),
      } });
    }
    await prisma.referralQualificationFact.createMany({ data: [
      {
        referralFactId: uuid(), referrerId: referrer.user.id,
        refereeIdentityHash: `expired-reservation:${uuid()}`,
        qualifiedAt: new Date(clock.getTime() - 2 * 60 * 1000),
        referralCreatedAt: new Date(clock.getTime() - 31 * 24 * 60 * 60 * 1000),
        status: "PENDING",
      },
      {
        referralFactId: uuid(), referrerId: referrer.user.id,
        refereeIdentityHash: `review-reservation:${uuid()}`,
        qualifiedAt: new Date(clock.getTime() - 60 * 1000),
        referralCreatedAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
        refereeWasReview: true,
        status: "PENDING",
      },
    ] });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id,
      refereeId: referee.user.id,
      refereeSubHash: `valid-fifth-reservation:${uuid()}`,
      status: "PENDING",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    const race = await prisma.race.create({ data: {
      name: "Valid fifth reservation race", status: "ACTIVE", targetSteps: 1000,
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    const beforeGrant = new Date();
    await buildCompleteRace({ now: () => new Date(clock), eventBus: { emit() {} }, createReviewOpportunity: async () => null })({
      raceId: race.id, winnerUserId: referee.user.id,
      participantUserIds: [referee.user.id, opponent.user.id],
    });
    assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, "REWARDED");
    const grant = await prisma.referralRewardGrant.findFirst({ where: {
      referralId: referral.id, role: "REFERRER",
    } });
    assert.equal(grant.qualifiedAtSnapshot.toISOString(), clock.toISOString());
    assert.ok(grant.grantedAt >= beforeGrant, "grantedAt remains the actual mint audit time");
    assert.equal(await prisma.referralRewardGrant.count({ where: {
      userId: referrer.user.id, role: "REFERRER",
    } }), 5);
  });

  it("adjudicates a flagged durable fact after referee deletion without reviving the ordinary referral", async () => {
    const contest = await createAndPublish({ slug: "deleted-flagged-review" });
    const referrer = await createTestUser({ displayName: "Deleted Review Referrer" });
    const referee = await createTestUser({ displayName: "Deleted Review Referee" });
    await enter(contest, referrer);
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id,
      refereeSubHash: `deleted-review:${uuid()}`, status: "FLAGGED",
      qualifiedAt: clock, createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    await prisma.referralQualificationFact.create({ data: {
      referralFactId: referral.id, referrerId: referrer.user.id,
      refereeIdentityHash: referral.refereeSubHash, attributionSource: "redeem",
      qualifiedAt: clock, status: "FLAGGED",
    } });
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: referee.token })).status, 204);
    assert.equal(await prisma.referral.findUnique({ where: { id: referral.id } }), null);
    const detail = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    const out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/reviews`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: detail.contest.revision, referralFactId: referral.id, decision: "REJECT", reasonCode: "FRAUD", privateNote: "Deletion-safe adjudication" },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal((await prisma.referralQualificationFact.findUnique({ where: { referralFactId: referral.id } })).status, "FLAGGED");
    assert.ok(await prisma.giveawayPointReview.findUnique({ where: { contestId_referralFactId: { contestId: contest.id, referralFactId: referral.id } } }));
  });

  it("counts one provider qualification across delete, recreate, and requalification", async () => {
    const contest = await createAndPublish({ slug: "provider-requalification-dedupe" });
    const referrer = await createTestUser({ displayName: "Dedupe Referrer" });
    const firstReferee = await createTestUser({ appleId: "stable-dedupe-referee", displayName: "First Dedupe Referee" });
    const opponent = await createTestUser({ displayName: "Dedupe Opponent" });
    await enter(contest, referrer);
    const stableHash = `stable-provider:${uuid()}`;
    const qualify = async (referee, suffix) => {
      await prisma.referral.create({ data: {
        referrerId: referrer.user.id, refereeId: referee.user.id,
        refereeSubHash: stableHash, status: "PENDING",
        createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
      } });
      const race = await prisma.race.create({ data: {
        name: `Dedupe ${suffix}`, status: "ACTIVE", targetSteps: 1000,
        participants: { create: [
          { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
          { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
        ] },
      } });
      await buildCompleteRace({ now: () => new Date(clock), eventBus: { emit() {} }, createReviewOpportunity: async () => null })({
        raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id],
      });
    };
    await qualify(firstReferee, "first");
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: firstReferee.token })).status, 204);
    const recreated = await createTestUser({ appleId: "stable-dedupe-referee", displayName: "Recreated Dedupe Referee" });
    clock = new Date(clock.getTime() + 60 * 1000);
    await qualify(recreated, "second");
    assert.equal(await prisma.referralQualificationFact.count({ where: { refereeIdentityHash: stableHash } }), 1);
    const data = await (await request(server.baseUrl, "GET", `/giveaways/${contest.slug}/data`)).json();
    assert.deepEqual(data.leaderboard[0], { rank: 1, displayName: "Dedupe Referrer", completedCount: 1 });
  });

  it("never lets a recreated provider overwrite the earlier owner's flagged fact", async () => {
    const contest = await createAndPublish({ slug: "provider-owner-isolation" });
    const firstReferrer = await createTestUser({ displayName: "Original Flagged Owner" });
    const secondReferrer = await createTestUser({ displayName: "Later Referral Owner" });
    const firstReferee = await createTestUser({ appleId: "stable-flagged-owner", displayName: "Original Referee" });
    const opponent = await createTestUser({ displayName: "Owner Isolation Opponent" });
    await enter(contest, firstReferrer);
    await enter(contest, secondReferrer);
    const stableHash = `stable-flagged-owner:${uuid()}`;
    const firstReferral = await prisma.referral.create({ data: {
      referrerId: firstReferrer.user.id, refereeId: firstReferee.user.id,
      refereeSubHash: stableHash, status: "FLAGGED", qualifiedAt: clock,
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    await prisma.referralQualificationFact.create({ data: {
      referralFactId: firstReferral.id, referrerId: firstReferrer.user.id,
      refereeIdentityHash: stableHash, qualifiedAt: clock,
      referralCreatedAt: firstReferral.createdAt, status: "FLAGGED",
    } });
    assert.equal((await request(server.baseUrl, "DELETE", "/auth/account", { token: firstReferee.token })).status, 204);

    const recreated = await createTestUser({ appleId: "stable-flagged-owner", displayName: "Recreated Referee" });
    const secondReferral = await prisma.referral.create({ data: {
      referrerId: secondReferrer.user.id, refereeId: recreated.user.id,
      refereeSubHash: stableHash, status: "PENDING",
      createdAt: new Date(clock.getTime() - 12 * 60 * 60 * 1000),
    } });
    const race = await prisma.race.create({ data: {
      name: "Owner isolation race", status: "ACTIVE", targetSteps: 1000,
      participants: { create: [
        { userId: recreated.user.id, status: "ACCEPTED", placement: 1, rawSteps: 3000, totalSteps: 3000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    clock = new Date(clock.getTime() + 60 * 1000);
    await buildCompleteRace({ now: () => new Date(clock), eventBus: { emit() {} }, createReviewOpportunity: async () => null })({
      raceId: race.id, winnerUserId: recreated.user.id,
      participantUserIds: [recreated.user.id, opponent.user.id],
    });
    const durable = await prisma.referralQualificationFact.findUnique({ where: { refereeIdentityHash: stableHash } });
    assert.equal(durable.referralFactId, firstReferral.id);
    assert.equal(durable.referrerId, firstReferrer.user.id);
    assert.equal(durable.status, "FLAGGED");
    assert.equal((await prisma.referral.findUnique({ where: { id: secondReferral.id } })).status, "REWARDED");
    const candidates = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates`, { token: admin.token })).json();
    const original = candidates.records.find((candidate) => candidate.displayName === "Original Flagged Owner");
    const later = candidates.records.find((candidate) => candidate.displayName === "Later Referral Owner");
    assert.equal(original.reviewableCount, 1);
    assert.equal(later.verifiedCount, 0);
  });

  it("stores no raw provider reference in fulfillment, audit, or idempotency persistence and anonymizes seven-year winner PII", async () => {
    const contest = await createAndPublish({ slug: "provider-redaction" });
    const user = await createTestUser({ displayName: "Privacy Winner" });
    const entrant = await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: user.user.id, entrantIdentityHash: "v2:privacy", identityHashVersion: 2,
      status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: clock,
      residencyConfirmedAt: clock, rulesAcceptedAt: clock, acceptedRulesVersion: "hardening-v1",
      acceptedRulesHash: contest.rules.sha256, displayNameSnapshot: "Privacy Winner", displayNameConsentedAt: clock,
    } });
    await prisma.giveawayResult.create({ data: { entrantId: entrant.id, frozenCount: 3, finalRank: 1, status: "VERIFIED", verifiedAt: clock } });
    await prisma.giveawayFulfillment.create({ data: { entrantId: entrant.id } });
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { lifecycleStatus: "FINAL", finalizedAt: clock } });
    let revision = contest.revision;
    let out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/fulfillment`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision, transition: "CLAIMED" },
    }));
    revision = out.payload.contest.revision;
    const secretReference = "paypal-raw-winner-reference-1234";
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/fulfillment`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision, transition: "CASH_SENT", provider: "PAYPAL", providerReference: secretReference },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    const stored = await prisma.giveawayFulfillment.findUnique({ where: { entrantId: entrant.id } });
    assert.ok(stored.providerReference);
    assert.ok(!stored.providerReference.includes(secretReference));
    const auditRows = await prisma.giveawayAuditEvent.findMany({ where: { contestId: contest.id } });
    assert.ok(!JSON.stringify(auditRows).includes(secretReference));
    const receipts = await prisma.giveawayIdempotencyReceipt.findMany({ where: { contestId: contest.id } });
    assert.ok(!JSON.stringify(receipts).includes(secretReference));

    const referee = await createTestUser({ displayName: "Old Review Referee" });
    const reviewedFact = await prisma.referral.create({ data: {
      referrerId: user.user.id, refereeId: referee.user.id, refereeSubHash: `old-review:${uuid()}`,
      status: "FLAGGED", qualifiedAt: clock, createdAt: clock,
    } });
    const oldReview = await prisma.giveawayPointReview.create({ data: {
      contestId: contest.id, referralFactId: reviewedFact.id, qualifiedAtSnapshot: clock,
      referralStatusSnapshot: "FLAGGED", decision: "REJECT", reasonCode: "FRAUD",
      privateNote: "must expire after three years", actorId: admin.user.id, decidedAt: clock,
    } });

    await prisma.giveawayFulfillment.update({ where: { entrantId: entrant.id }, data: { fulfilledAt: new Date("2026-08-26T00:00:00.000Z") } });
    const retention = buildGiveawayRetention({
      now: () => new Date("2034-09-01T00:00:00.000Z"),
      JobRun: { lastRanFor: async () => null, claimRun: async () => true }, env: {}, logger: { log() {}, error() {} },
    });
    await retention();
    const anonymized = await prisma.giveawayEntrant.findUnique({ where: { id: entrant.id } });
    assert.equal(anonymized.userId, null);
    assert.equal(anonymized.displayNameSnapshot, null);
    assert.equal(anonymized.region, "PURGED");
    assert.match(anonymized.entrantIdentityHash, /^purged:/);
    assert.equal((await prisma.giveawayPointReview.findUnique({ where: { id: oldReview.id } })).privateNote, null);
  });

  it("preserves a linked banner for a frozen admin payload, binds activation to frozen copy, and audits corrections/autoarchive", async () => {
    const contest = await createAndPublish({ slug: "banner-frozen" });
    let out = await read(await request(server.baseUrl, "PATCH", "/admin/settings/home-service-banner", {
      token: admin.token, body: { enabled: true, message: contest.bannerMessage, contestSlug: contest.slug },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    out = await read(await request(server.baseUrl, "PATCH", "/admin/settings/home-service-banner", {
      token: admin.token, body: { enabled: true, message: contest.bannerMessage },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal(out.payload.settings.homeServiceBannerContestSlug, contest.slug);
    out = await read(await request(server.baseUrl, "PATCH", "/admin/settings/home-service-banner", {
      token: admin.token, body: { enabled: true, message: "Unfrozen contest copy", contestSlug: contest.slug },
    }));
    assert.equal(out.response.status, 400);

    const beforeCorrection = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/banner-correction`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: beforeCorrection.contest.revision, bannerMessage: "Maintenance wording only", reason: "This would silently remove material prize terms." },
    }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_BANNER_CORRECTION");

    const detail = await (await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}`, { token: admin.token })).json();
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/banner-correction`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: detail.contest.revision, bannerMessage: "Bara Giveaway: win US$50 + 5,000 Bara coins.", reason: "Corrected end-user wording without changing material terms." },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal(out.payload.contest.bannerMessage, "Bara Giveaway: win US$50 + 5,000 Bara coins.");
    assert.ok(await prisma.giveawayAuditEvent.findFirst({ where: { contestId: contest.id, action: "BANNER_CORRECTION" } }));

    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { lifecycleStatus: "FINAL", finalizedAt: clock } });
    const next = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: contestBody({ slug: "after-autoarchive" }),
    }));
    out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${next.payload.contest.id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: next.payload.contest.revision },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.ok(await prisma.giveawayAuditEvent.findFirst({ where: { contestId: contest.id, action: "AUTO_ARCHIVE" } }));
  });

  it("excludes tournament matchups at the real settlement fact seam", async () => {
    const referrer = await createTestUser({ displayName: "Tournament Referrer" });
    const referee = await createTestUser({ displayName: "Tournament Referee" });
    const opponent = await createTestUser({ displayName: "Tournament Opponent" });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id,
      refereeSubHash: `tournament:${uuid()}`, status: "PENDING",
      createdAt: new Date(clock.getTime() - 24 * 60 * 60 * 1000),
    } });
    const tournament = await prisma.tournament.create({ data: {
      name: "No referral farming", status: "ACTIVE", bracketSize: 4,
      matchupDurationDays: 1, currentRound: 1, totalRounds: 2,
      participants: { create: [
        { userId: referee.user.id, seed: 0, status: "ACCEPTED" },
        { userId: opponent.user.id, seed: 1, status: "ACCEPTED" },
      ] },
    } });
    const race = await prisma.race.create({ data: {
      name: "Tournament matchup", status: "ACTIVE", targetSteps: 10000,
      tournamentId: tournament.id, tournamentRound: 1, tournamentMatchIndex: 0,
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 4000, totalSteps: 4000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    const complete = buildCompleteRace({
      eventBus: { emit() {} },
      advanceTournament: async () => null,
      createReviewOpportunity: async () => null,
    });
    await complete({ raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id] });
    assert.equal(await prisma.referralQualificationIntent.count({ where: { referralId: referral.id } }), 0);
    assert.equal((await prisma.referral.findUnique({ where: { id: referral.id } })).status, "PENDING");
    assert.equal(await prisma.referralRewardGrant.count({ where: { referralId: referral.id } }), 0);
  });

  it("synchronizes concurrent real settlement and HTTP finalization so the final snapshot cannot miss a fact", async () => {
    const contest = await createAndPublish({ slug: "settlement-finalize-fence" });
    const referrer = await createTestUser({ displayName: "Fence Referrer" });
    const referee = await createTestUser({ displayName: "Fence Referee" });
    const opponent = await createTestUser({ displayName: "Fence Opponent" });
    await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: referrer.user.id, entrantIdentityHash: `v2:${uuid()}`, identityHashVersion: 2,
      status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: new Date("2026-08-02T00:00:00Z"),
      residencyConfirmedAt: new Date("2026-08-02T00:00:00Z"), rulesAcceptedAt: new Date("2026-08-02T00:00:00Z"),
      acceptedRulesVersion: "hardening-v1", acceptedRulesHash: contest.rules.sha256,
      displayNameSnapshot: "Fence Referrer", displayNameConsentedAt: new Date("2026-08-02T00:00:00Z"),
    } });
    const referral = await prisma.referral.create({ data: {
      referrerId: referrer.user.id, refereeId: referee.user.id, refereeSubHash: `fence:${uuid()}`,
      status: "PENDING", createdAt: new Date("2026-08-03T00:00:00Z"),
    } });
    const race = await prisma.race.create({ data: {
      name: "Concurrent qualifying race", status: "ACTIVE", targetSteps: 10000,
      endsAt: new Date("2026-08-19T00:00:00Z"),
      participants: { create: [
        { userId: referee.user.id, status: "ACCEPTED", placement: 1, rawSteps: 4000, totalSteps: 4000 },
        { userId: opponent.user.id, status: "ACCEPTED", placement: 2, rawSteps: 3000, totalSteps: 3000 },
      ] },
    } });
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { endsAt: new Date("2026-08-20T04:00:00Z") } });
    const complete = buildCompleteRace({ eventBus: { emit() {} }, createReviewOpportunity: async () => null, now: () => new Date("2026-08-19T01:00:00Z") });
    const [, finalResponse] = await Promise.all([
      complete({ raceId: race.id, winnerUserId: referee.user.id, participantUserIds: [referee.user.id, opponent.user.id] }),
      request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
        token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: contest.revision },
      }),
    ]);
    assert.ok([200, 409].includes(finalResponse.status));
    const finalPayload = await finalResponse.json();
    if (finalResponse.status === 409) assert.equal(finalPayload.code, "QUALIFICATION_PROCESSING_PENDING");
    const fact = await prisma.referral.findUnique({ where: { id: referral.id } });
    assert.equal(fact.status, "REWARDED");
    assert.ok(fact.qualifiedAt);
    if (finalResponse.status === 200) {
      const frozen = await prisma.giveawayResult.findFirst({ where: { entrant: { contestId: contest.id } } });
      assert.equal(frozen.frozenCount, 1, "a successful concurrent snapshot includes the settled fact");
    }
  });

  it("ignores pre-entry poison and non-owning duplicate work when finalizing", async () => {
    const contest = await createAndPublish({
      slug: "irrelevant-pending-finalize",
      endsAt: "2026-08-25T13:00:00.000Z",
    });
    const entrant = await createTestUser({ displayName: "Pending Window Entrant" });
    const outsider = await createTestUser({ displayName: "Provider Fact Owner" });
    const preEntryReferee = await createTestUser({ displayName: "Pre-entry Referee" });
    const duplicateReferee = await createTestUser({ displayName: "Duplicate Referee" });
    const opponent = await createTestUser({ displayName: "Pending Window Opponent" });
    await enter(contest, entrant);

    await prisma.referral.create({ data: {
      referrerId: entrant.user.id, refereeId: preEntryReferee.user.id,
      refereeSubHash: `pre-entry:${uuid()}`, status: "PENDING",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    } });
    const preEntryRace = await prisma.race.create({ data: {
      name: "Pre-entry pending race", status: "COMPLETED", targetSteps: 1000,
    } });
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: preEntryRace.id,
      qualifiedAt: new Date("2026-08-25T11:30:00.000Z"),
      participantUserIds: [preEntryReferee.user.id, opponent.user.id],
      seedId: null, tournamentId: null,
    }));

    const providerHash = `non-owning:${uuid()}`;
    await prisma.referralQualificationFact.create({ data: {
      referralFactId: uuid(), referrerId: outsider.user.id,
      refereeIdentityHash: providerHash,
      qualifiedAt: new Date("2026-08-25T12:10:00.000Z"),
      status: "REWARDED",
    } });
    const duplicate = await prisma.referral.create({ data: {
      referrerId: entrant.user.id, refereeId: duplicateReferee.user.id,
      refereeSubHash: providerHash, status: "PENDING",
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    } });
    const duplicateRace = await prisma.race.create({ data: {
      name: "Non-owning duplicate race", status: "COMPLETED", targetSteps: 1000,
    } });
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx, raceId: duplicateRace.id,
      qualifiedAt: new Date("2026-08-25T12:30:00.000Z"),
      participantUserIds: [duplicateReferee.user.id, opponent.user.id],
      seedId: null, tournamentId: null,
    }));
    assert.ok(await prisma.referralQualificationIntent.findFirst({
      where: { referralFactId: duplicate.id, processedAt: null },
    }));

    clock = new Date("2026-08-25T14:00:00.000Z");
    const finalized = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: contest.revision },
    }));
    assert.equal(finalized.response.status, 200, JSON.stringify(finalized.payload));
    assert.equal(finalized.payload.result.noWinner, true);
  });

  it("returns bounded real fraud evidence and snapshot-stable normalized candidate cursors", async () => {
    const contest = await createAndPublish({ slug: "candidate-evidence" });
    const entrantUser = await createTestUser({ displayName: "Evidence Entrant" });
    await enter(contest, entrantUser);
    const secondEntrant = await createTestUser({ displayName: "Second Entrant" });
    await enter(contest, secondEntrant);
    const refereeA = await createTestUser({ displayName: "Evidence A" });
    const refereeB = await createTestUser({ displayName: "Evidence B" });
    const evidenceFacts = [];
    const race = await prisma.race.create({ data: { name: "Shared evidence race", status: "COMPLETED", targetSteps: 1000,
      participants: { create: [{ userId: entrantUser.user.id, status: "ACCEPTED", rawSteps: 3000, totalSteps: 3000 }] },
    } });
    for (const [index, referee] of [refereeA, refereeB].entries()) {
      evidenceFacts.push(await prisma.referral.create({ data: {
        referrerId: entrantUser.user.id, refereeId: referee.user.id, refereeSubHash: `evidence:${uuid()}`,
        code: `BARA-EVIDENCE-${index}`, source: "ip_fallback_exact",
        status: index === 0 ? "FLAGGED" : "REWARDED", createdAt: new Date("2026-08-03T00:00:00Z"),
        qualifiedAt: new Date(`2026-08-26T00:${String(index * 10).padStart(2, "0")}:00Z`), qualifyingRaceId: race.id,
      } }));
      await prisma.stepSample.create({ data: {
        userId: referee.user.id, periodStart: new Date("2026-08-26T00:00:00Z"),
        periodEnd: new Date("2026-08-26T01:00:00Z"), steps: 3000,
        sourceDeviceId: "private-shared-device-id",
      } });
      await prisma.linkOpen.create({ data: {
        kind: "referral", code: `BARA-EVIDENCE-${index}`,
        ipHash: "private-shared-network-hash", ipHashVersion: 1,
        createdAt: new Date("2026-08-25T23:00:00Z"),
      } });
    }
    let out = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates?limit=100`, { token: admin.token }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    const evidence = out.payload.records.find((record) => record.displayName === "Evidence Entrant");
    assert.equal(evidence.auditSignals.sharedRaceCount, 1);
    assert.deepEqual(evidence.auditSignals.correlationFlags.sort(), [
      "MULTIPLE_REFERRALS_SAME_RACE", "RAPID_QUALIFICATIONS", "REFERRER_IN_QUALIFYING_RACE",
      "SHARED_DEVICE_SOURCE", "SHARED_NETWORK_SOURCE", "SYNCHRONIZED_STEPS",
    ].sort());
    assert.ok(evidence.reviewFacts.length <= 100);
    assert.equal(evidence.reviewFacts.length, 1, "verified facts inform fraud signals but are not reviewable");
    assert.deepEqual(evidence.auditFacts, [
      { referralFactId: evidenceFacts[0].id, status: "FLAGGED" },
      { referralFactId: evidenceFacts[1].id, status: "REWARDED" },
    ]);
    assert.deepEqual(evidence.auditSignals.attributionSources, [{ source: "ip_fallback_exact", count: 2 }]);
    assert.equal(evidence.auditSignals.network.sharedHashCount, 1);
    assert.equal(evidence.auditSignals.device.sharedSourceCount, 1);
    assert.equal(evidence.auditSignals.synchronizedSteps.matchingWindowCount, 1);
    assert.equal(evidence.auditSignals.velocity.maxInHour, 2);
    assert.ok(!JSON.stringify(evidence).includes("private-shared-device-id"));
    assert.ok(!JSON.stringify(evidence).includes("private-shared-network-hash"));
    out = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates?limit=1`, { token: admin.token }));
    const cursor = JSON.parse(Buffer.from(out.payload.nextCursor, "base64url").toString("utf8"));
    assert.equal(new Date(cursor.asOf).toISOString(), cursor.asOf);
    const late = await createTestUser({ displayName: "Late Entrant" });
    await prisma.giveawayEntrant.create({ data: {
      contestId: contest.id, userId: late.user.id, entrantIdentityHash: `v2:${uuid()}`, identityHashVersion: 2,
      status: "ELIGIBLE", country: "US", region: "US-NY", ageConfirmedAt: clock, residencyConfirmedAt: clock,
      rulesAcceptedAt: clock, acceptedRulesVersion: "hardening-v1", acceptedRulesHash: contest.rules.sha256,
      displayNameSnapshot: "Late Entrant", displayNameConsentedAt: clock,
      createdAt: new Date(new Date(cursor.asOf).getTime() + 1000),
    } });
    out = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates?limit=1&cursor=${encodeURIComponent(out.payload.nextCursor)}`, { token: admin.token }));
    assert.equal(out.response.status, 200);
    assert.ok(out.payload.records.every((record) => record.displayName !== "Late Entrant"));
    const invalid = Buffer.from(JSON.stringify({ ...cursor, asOf: "2026-8-1" })).toString("base64url");
    out = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates?cursor=${invalid}`, { token: admin.token }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_CURSOR");
  });

  it("finalizes with outcome-irrelevant flags but preserves the leader's unresolved review history", async () => {
    const contest = await createAndPublish({ slug: "irrelevant-flags" });
    const leader = await seedEntrantFacts(contest, "Certain Leader", ["REWARDED", "REWARDED", "FLAGGED"]);
    await seedEntrantFacts(contest, "Distant Challenger", ["FLAGGED"]);
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { endsAt: new Date("2026-08-20T04:00:00Z") } });
    const out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: contest.revision },
    }));
    assert.equal(out.response.status, 200, JSON.stringify(out.payload));
    assert.equal(out.payload.result.potentialWinner.entrantId, leader.entrant.id);
    assert.equal(await prisma.referral.count({ where: { referrerId: leader.user.user.id, status: "FLAGGED" } }), 1);
  });

  it("blocks finalization only when an unresolved flag can change first place", async () => {
    const contest = await createAndPublish({ slug: "outcome-changing-flags" });
    await seedEntrantFacts(contest, "Current Leader", ["REWARDED"]);
    await seedEntrantFacts(contest, "Possible Challenger", ["REWARDED", "FLAGGED"], 10);
    await prisma.giveawayContest.update({ where: { id: contest.id }, data: { endsAt: new Date("2026-08-20T04:00:00Z") } });
    const out = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: contest.revision },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "OUTCOME_REVIEW_REQUIRED");
    assert.equal(await prisma.giveawayResult.count({ where: { entrant: { contestId: contest.id } } }), 0);
  });
});
