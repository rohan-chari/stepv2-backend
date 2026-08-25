const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, describe, it } = require("node:test");

const {
  prisma,
  cleanDatabase,
  createTestUser,
  request,
  startServer,
} = require("./setup");
const {
  createReferralQualificationIntents,
  processReferralQualificationIntents,
} = require("../../src/modules/social");
const {
  recoverReferralQualificationIntents,
} = require("../../src/modules/giveaways/jobs/qualificationIntentRecovery");
const {
  buildGiveawayRetention,
} = require("../../src/modules/giveaways");
const {
  buildCompleteRace,
} = require("../../src/modules/races/commands/completeRace");

const REGION_CODES = [
  "US-AL", "US-AK", "US-AZ", "US-AR", "US-CA", "US-CO", "US-CT", "US-DE", "US-DC",
  "US-FL", "US-GA", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY",
  "US-LA", "US-ME", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT",
  "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NY", "US-NC", "US-ND", "US-OH",
  "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT",
  "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "US-WY",
];
const RULE_SECTIONS = [
  { heading: "How to enter", body: "No purchase necessary. Enter in Bara and complete verified referrals." },
  { heading: "Platform disclaimer", body: "Apple and Google are not sponsors, administrators, endorsers, or involved in this contest." },
  { heading: "Eligibility", body: "Open only to legal residents of the 50 United States and D.C. who are age 18 or older." },
];

function uuid() {
  return crypto.randomUUID();
}

function draft(overrides = {}) {
  return {
    slug: "bara-referral-2026-09",
    title: "Bara <Referral> Contest",
    governingTimeZone: "America/New_York",
    startsAt: "2026-09-01T04:00:00.000Z",
    endsAt: "2026-10-01T04:00:00.000Z",
    cashCurrency: "USD",
    cashMinor: 5000,
    coinPrize: 5000,
    minimumAge: 18,
    eligibleRegions: REGION_CODES,
    sponsor: { legalName: "Bara Steps LLC", mailingAddress: "123 Main St, New York, NY 10001" },
    rules: { version: "2026-09-v1", sections: RULE_SECTIONS },
    socialLinks: [
      { platform: "instagram", label: "Instagram", url: "https://www.instagram.com/bara" },
    ],
    bannerMessage: "Bara Referral Contest: win US$50 + 5,000 coins. Ends Sep 30.",
    ...overrides,
  };
}

async function json(response) {
  const payload = await response.json();
  return { response, payload };
}

describe("referral giveaway — complete HTTP workflow", () => {
  let server;
  let clock = new Date("2026-08-25T12:00:00.000Z");
  let admin;

  before(async () => {
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 =
      "integration-test-only-giveaway-entrant-hmac-secret";
    process.env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET =
      "integration-test-only-provider-reference-hmac-secret";
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    process.env.REFERRAL_IP_HMAC_SECRET_V1 =
      "integration-test-only-referral-ip-hmac-secret-material";
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Contest Admin" });
    server = await startServer({
      now: () => new Date(clock),
      isAdminUser: (user) => user?.id === admin.user.id,
    });
  });

  after(async () => {
    await server?.close();
    delete process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1;
    delete process.env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET;
    delete process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION;
    delete process.env.REFERRAL_IP_HMAC_SECRET_V1;
  });

  it("runs draft through archive, preserving intent, review, alternate, and exactly-once fulfillment invariants", async () => {
    let out = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: draft(),
    }));
    assert.equal(out.response.status, 201);
    assert.equal(out.payload.contest.status, "DRAFT");
    const contestId = out.payload.contest.id;
    let revision = out.payload.contest.revision;

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/publish`, {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: { revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "SCHEDULED");
    revision = out.payload.contest.revision;

    const scheduledEntry = await createTestUser({ displayName: "Too Early" });
    out = await json(await request(server.baseUrl, "POST", "/giveaways/bara-referral-2026-09/entries", {
      token: scheduledEntry.token,
      body: {
        rulesVersion: "2026-09-v1", country: "US", region: "US-NY",
        ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true,
      },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "CONTEST_NOT_OPEN");

    clock = new Date("2026-09-02T15:00:00.000Z");
    const alice = await createTestUser({ displayName: "Alice <script>" });
    const bob = await createTestUser({ displayName: "Bob" });
    const withdrawn = await createTestUser({
      appleId: "stable-deleted-contest-identity",
      displayName: "Deleted Player",
    });
    const entryBody = {
      rulesVersion: "2026-09-v1", country: "US", region: "US-NY",
      ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true,
    };
    for (const entrant of [alice, bob, withdrawn]) {
      const first = await json(await request(server.baseUrl, "POST", "/giveaways/bara-referral-2026-09/entries", {
        token: entrant.token, body: entryBody,
      }));
      assert.equal(first.response.status, 201);
      const replay = await json(await request(server.baseUrl, "POST", "/giveaways/bara-referral-2026-09/entries", {
        token: entrant.token, body: entryBody,
      }));
      assert.equal(replay.response.status, 200);
      assert.deepEqual(replay.payload, first.payload);
    }

    const forbiddenData = { ...entryBody, bankAccount: "do-not-store", governmentId: "do-not-store" };
    out = await json(await request(server.baseUrl, "POST", "/giveaways/bara-referral-2026-09/entries", {
      token: alice.token, body: forbiddenData,
    }));
    assert.equal(out.response.status, 400);
    assert.equal(out.payload.code, "INVALID_BODY");

    async function referralFor(referrerId, status, qualifiedAt, suffix) {
      const referee = await createTestUser({ displayName: `Referee ${suffix}` });
      return prisma.referral.create({
        data: {
          referrerId,
          refereeId: referee.user.id,
          refereeSubHash: crypto.createHash("sha256").update(`referee-${suffix}`).digest("hex"),
          status,
          qualifiedAt,
          qualifyingRaceId: null,
        },
      });
    }

    // The public score begins at the durable settlement seam: completion and
    // qualification-intent insertion commit together, then reward processing
    // consumes the intent without changing its original time/race.
    const durableReferee = await createTestUser({ displayName: "Durable Referee" });
    const durableOpponent = await createTestUser({ displayName: "Durable Opponent" });
    const durableReferral = await prisma.referral.create({ data: {
      referrerId: alice.user.id,
      refereeId: durableReferee.user.id,
      refereeSubHash: crypto.createHash("sha256").update("durable-referee").digest("hex"),
      status: "PENDING",
    } });
    const durableRace = await prisma.race.create({ data: {
      name: "Durable giveaway qualifier", targetSteps: 10000, status: "ACTIVE",
      participants: { create: [
        { userId: durableReferee.user.id, status: "ACCEPTED", placement: 2, totalSteps: 5000, rawSteps: 5000 },
        { userId: durableOpponent.user.id, status: "ACCEPTED", placement: 1, totalSteps: 8000, rawSteps: 8000 },
      ] },
    } });
    await buildCompleteRace({ now: () => new Date(clock), eventBus: { emit() {} } })({
      raceId: durableRace.id,
      winnerUserId: durableOpponent.user.id,
      participantUserIds: [durableReferee.user.id, durableOpponent.user.id],
    });
    const durableFact = await prisma.referral.findUnique({ where: { id: durableReferral.id } });
    const durableIntent = await prisma.referralQualificationIntent.findFirst({ where: { referralId: durableReferral.id } });
    assert.equal(durableFact.status, "REWARDED");
    assert.equal(durableFact.qualifiedAt.toISOString(), "2026-09-02T15:00:00.000Z");
    assert.equal(durableFact.qualifyingRaceId, durableRace.id);
    assert.equal(durableIntent.qualifiedAt.toISOString(), "2026-09-02T15:00:00.000Z");
    assert.ok(durableIntent.processedAt);

    // Boundary: start inclusive, end exclusive. Pre-entry and end-time facts do not score.
    await referralFor(alice.user.id, "REWARDED", new Date("2026-09-03T12:00:00.000Z"), "a2");
    await referralFor(alice.user.id, "REWARDED", new Date("2026-09-02T14:59:59.999Z"), "pre-entry");
    await referralFor(alice.user.id, "REWARDED", new Date("2026-10-01T04:00:00.000Z"), "at-end");
    const bobApproved = await referralFor(bob.user.id, "REWARDED", new Date("2026-09-03T11:59:00.000Z"), "b1");
    const bobFlagged = await referralFor(bob.user.id, "FLAGGED", new Date("2026-09-03T11:59:00.000Z"), "b2");
    await referralFor(bob.user.id, "EXPIRED", new Date("2026-09-03T12:00:00.000Z"), "expired");
    await referralFor(bob.user.id, "EXCLUDED", new Date("2026-09-03T12:00:00.000Z"), "excluded");
    await referralFor(bob.user.id, "PENDING", null, "pending");

    out = await json(await request(server.baseUrl, "GET", "/giveaways/current/me", { token: alice.token }));
    assert.equal(out.response.status, 200);
    assert.equal(out.response.headers.get("cache-control"), "private, no-store");
    assert.equal(out.payload.contest.status, "ACTIVE");
    assert.equal(out.payload.standing.verifiedCount, 2);
    assert.equal(out.payload.standing.reviewableCount, 0);
    assert.equal(out.payload.leaderboard[0].displayName, "Alice <script>");
    assert.ok(!JSON.stringify(out.payload).includes(alice.user.id));

    const publicData = await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09/data?limit=1");
    assert.equal(publicData.status, 200);
    assert.match(publicData.headers.get("cache-control"), /^public, max-age=30/);
    assert.ok(publicData.headers.get("etag"));
    const notModified = await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09/data?limit=1", {
      headers: { "If-None-Match": publicData.headers.get("etag") },
    });
    assert.equal(notModified.status, 304);
    const publicPayload = await publicData.json();
    assert.equal(publicPayload.leaderboard.length, 1);
    assert.equal(publicPayload.winner, null);
    assert.ok(!JSON.stringify(publicPayload).includes(alice.user.id));

    const html = await (await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09")).text();
    const rulesHtml = await (await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09/rules")).text();
    assert.match(html, /Bara &lt;Referral&gt; Contest/);
    assert.doesNotMatch(html, /Alice <script>/);
    assert.match(html, /Optional — does not affect contest/);
    assert.match(html, /href="https:\/\/www\.instagram\.com\/bara"/);
    assert.match(html, /rel="canonical" href="https:\/\/barastep\.com\/giveaways\/bara-referral-2026-09"/);
    assert.match(rulesHtml, /No purchase necessary/);
    assert.match(rulesHtml, /Apple and Google/);
    assert.match(rulesHtml, /rel="canonical" href="https:\/\/barastep\.com\/giveaways\/bara-referral-2026-09\/rules"/);

    // Deleted entrant is withdrawn and the stable provider identity cannot re-enter.
    const deletion = await request(server.baseUrl, "DELETE", "/auth/account", { token: withdrawn.token });
    assert.equal(deletion.status, 204);
    const recreated = await createTestUser({
      appleId: "stable-deleted-contest-identity",
      displayName: "Recreated Player",
    });
    out = await json(await request(server.baseUrl, "GET", "/giveaways/current/me", { token: recreated.token }));
    assert.equal(out.payload.entry.status, "WITHDRAWN");
    assert.equal(out.payload.standing, null);
    assert.equal(out.payload.share, null);
    out = await json(await request(server.baseUrl, "POST", "/giveaways/bara-referral-2026-09/entries", {
      token: recreated.token, body: entryBody,
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "ENTRY_IMMUTABLE");

    clock = new Date("2026-10-01T05:00:00.000Z");
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "OUTCOME_REVIEW_REQUIRED");

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/reviews`, {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: { revision, referralFactId: bobFlagged.id, decision: "APPROVE", reasonCode: "LEGITIMATE", privateNote: "Reviewed referral evidence" },
    }));
    assert.equal(out.response.status, 200);
    revision = out.payload.contest.revision;

    const intentReferee = await createTestUser({ displayName: "Intent Referee" });
    const intentReferral = await prisma.referral.create({
      data: {
        referrerId: bob.user.id,
        refereeId: intentReferee.user.id,
        refereeSubHash: crypto.createHash("sha256").update("intent-referee").digest("hex"),
        status: "PENDING",
      },
    });
    const intentRace = await prisma.race.create({
      data: {
        name: "Recovered qualifying race",
        targetSteps: 10000,
        status: "COMPLETED",
        completedAt: new Date("2026-09-20T12:00:00.000Z"),
      },
    });
    const intentRaceId = intentRace.id;
    await prisma.$transaction((tx) => createReferralQualificationIntents({
      tx,
      raceId: intentRaceId,
      qualifiedAt: new Date("2026-09-20T12:00:00.000Z"),
      participantUserIds: [intentReferee.user.id, bob.user.id],
      seedId: null,
      tournamentId: null,
    }));

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 409);
    assert.equal(out.payload.code, "QUALIFICATION_PROCESSING_PENDING");

    let injected = true;
    await assert.rejects(
      processReferralQualificationIntents({
        limit: 10,
        before: new Date("2026-10-01T04:00:00.000Z"),
        now: () => new Date(clock),
        processOne: async () => {
          if (injected) { injected = false; throw new Error("injected once"); }
        },
      }),
      /injected once/
    );
    await recoverReferralQualificationIntents({
      limit: 10,
      now: () => new Date(clock.getTime() + 61 * 1000),
      findRace: async (raceId) => ({ id: raceId }),
      grantReferralRewardsForRace: async () => {
        await prisma.referral.update({ where: { id: intentReferral.id }, data: { status: "REWARDED" } });
      },
    });
    const recovered = await prisma.referral.findUnique({ where: { id: intentReferral.id } });
    assert.equal(recovered.qualifiedAt.toISOString(), "2026-09-20T12:00:00.000Z");
    assert.equal(recovered.qualifyingRaceId, intentRaceId);

    const finalizeKey = uuid();
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": finalizeKey }, body: { revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "VERIFYING");
    assert.equal(out.payload.result.potentialWinner.displayName, "Bob");
    revision = out.payload.contest.revision;
    const reopenedVerifying = await json(await request(server.baseUrl, "GET", `/admin/giveaways/${contestId}`, {
      token: admin.token,
    }));
    assert.equal(reopenedVerifying.payload.result.potentialWinner.displayName, "Bob");
    assert.equal(reopenedVerifying.payload.result.verifiedWinner, null);
    assert.equal(reopenedVerifying.payload.fulfillment, null);
    const finalizeReplay = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": finalizeKey }, body: { revision: revision - 1 },
    }));
    assert.equal(finalizeReplay.response.status, 200);
    assert.deepEqual(finalizeReplay.payload, out.payload);

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/winner`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision, entrantId: out.payload.result.potentialWinner.entrantId, decision: "REJECT", reasonCode: "INELIGIBLE" },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "VERIFYING");
    revision = out.payload.contest.revision;

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/select-next`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.result.potentialWinner.displayName, "Alice <script>");
    revision = out.payload.contest.revision;

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/winner`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision, entrantId: out.payload.result.potentialWinner.entrantId, decision: "VERIFY", reasonCode: "ELIGIBILITY_VERIFIED" },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "FINAL");
    revision = out.payload.contest.revision;

    const finalPublic = await (await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09/data")).json();
    assert.deepEqual(finalPublic.winner, { displayName: "Alice <script>", originalRank: 2 });
    const finalMember = await (await request(server.baseUrl, "GET", "/giveaways/current/me", { token: alice.token })).json();
    assert.equal(finalMember.contest.status, "FINAL");
    assert.deepEqual(finalMember.winner, { displayName: "Alice <script>", originalRank: 2 });
    assert.equal(finalMember.standing.reviewableCount, 0);

    for (const [transition, provider, providerReference] of [
      ["CLAIMED", null, null],
      ["CASH_SENT", "ACH", "secret-provider-ref"],
      ["CASH_DELIVERED", "ACH", "secret-provider-ref"],
    ]) {
      out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/fulfillment`, {
        token: admin.token, headers: { "Idempotency-Key": uuid() },
        body: { revision, transition, ...(provider ? { provider, providerReference } : {}) },
      }));
      assert.equal(out.response.status, 200);
      assert.ok(!JSON.stringify(out.payload).includes("secret-provider-ref"));
      revision = out.payload.contest.revision;
    }

    const awardRequests = [uuid(), uuid()].map((key) =>
      request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/award-coins`, {
        token: admin.token, headers: { "Idempotency-Key": key }, body: { revision },
      })
    );
    const awardResponses = await Promise.all(awardRequests);
    assert.ok(awardResponses.every((response) => [200, 409].includes(response.status)));
    assert.equal(await prisma.coinTransaction.count({
      where: { reason: "giveaway_winner", refId: { startsWith: `giveaway:${contestId}:` } },
    }), 1);
    assert.equal((await prisma.user.findUnique({ where: { id: alice.user.id } })).coins, 5500);
    const refreshedContest = await prisma.giveawayContest.findUnique({ where: { id: contestId } });
    revision = refreshedContest.revision;
    const reopenedFulfilled = await json(await request(server.baseUrl, "GET", `/admin/giveaways/${contestId}`, {
      token: admin.token,
    }));
    assert.equal(reopenedFulfilled.payload.result.verifiedWinner.displayName, "Alice <script>");
    assert.equal(reopenedFulfilled.payload.fulfillment.status, "COINS_AWARDED");
    assert.ok(reopenedFulfilled.payload.fulfillment.coinTransactionId);

    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contestId}/archive`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "ARCHIVED");
    out = await json(await request(server.baseUrl, "GET", "/giveaways/current/me", { token: alice.token }));
    assert.deepEqual(out.payload, { contest: null, leaderboard: [], entry: null, standing: null, share: null });
    assert.equal((await request(server.baseUrl, "GET", "/giveaways/bara-referral-2026-09")).status, 200);

    assert.ok(await prisma.giveawayAuditEvent.count({ where: { contestId } }) >= 10);
    assert.equal(bobApproved.status, "REWARDED");
  });
});

describe("referral giveaway — validation, lifecycle, pagination, and compatibility", () => {
  let server;
  let clock = new Date("2026-08-25T12:00:00.000Z");
  let admin;

  before(async () => {
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 =
      "integration-test-only-giveaway-entrant-hmac-secret";
    process.env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET =
      "integration-test-only-provider-reference-hmac-secret";
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    process.env.REFERRAL_IP_HMAC_SECRET_V1 =
      "integration-test-only-referral-ip-hmac-secret-material";
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Second Admin" });
    server = await startServer({ now: () => new Date(clock), isAdminUser: () => true });
  });
  after(async () => {
    await server?.close();
    delete process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1;
    delete process.env.GIVEAWAY_PROVIDER_REFERENCE_HMAC_SECRET;
    delete process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION;
    delete process.env.REFERRAL_IP_HMAC_SECRET_V1;
  });

  it("rejects invalid content and overlap, keeps cursor orders stable, and supports no-winner/cancelled paths", async () => {
    const unauthorizedAdmin = await request(server.baseUrl, "GET", "/admin/giveaways");
    assert.equal(unauthorizedAdmin.status, 401);
    assert.equal(unauthorizedAdmin.headers.get("cache-control"), "private, no-store");
    let missingKey = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      body: draft({ slug: "missing-key" }),
    }));
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.payload.code, "INVALID_IDEMPOTENCY_KEY");
    const oversized = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: draft({ bannerMessage: "x".repeat(33 * 1024) }),
    }));
    assert.equal(oversized.response.status, 413);
    assert.equal(oversized.payload.code, "GIVEAWAY_BODY_TOO_LARGE");
    let out = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: draft({ slug: "unsafe", socialLinks: [{ platform: "instagram", label: "bad", url: "http://evil.example/x" }] }),
    }));
    assert.equal(out.response.status, 400);

    const contests = [];
    for (let index = 0; index < 3; index += 1) {
      out = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
        token: admin.token,
        headers: { "Idempotency-Key": uuid() },
        body: draft({ slug: `contest-${index}`, title: `Contest ${index}` }),
      }));
      assert.equal(out.response.status, 201);
      contests.push(out.payload.contest);
    }
    out = await json(await request(server.baseUrl, "GET", "/admin/giveaways?limit=2", { token: admin.token }));
    assert.equal(out.payload.records.length, 2);
    assert.ok(out.payload.nextCursor);
    const concurrent = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: draft({ slug: "contest-concurrent", title: "Concurrent Contest" }),
    }));
    assert.equal(concurrent.response.status, 201);
    const page2 = await json(await request(server.baseUrl, "GET", `/admin/giveaways?limit=2&cursor=${encodeURIComponent(out.payload.nextCursor)}`, { token: admin.token }));
    assert.equal(page2.payload.records.length, 1);
    assert.equal(new Set([...out.payload.records, ...page2.payload.records].map((r) => r.id)).size, 3);

    let revision = contests[0].revision;
    assert.equal((await request(server.baseUrl, "GET", "/giveaways/contest-1/data")).status, 404);
    assert.equal((await request(server.baseUrl, "GET", "/giveaways/does-not-exist/data")).status, 404);
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contests[0].id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 200);
    revision = out.payload.contest.revision;
    const conflict = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contests[1].id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: contests[1].revision },
    }));
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, "CONTEST_WINDOW_CONFLICT");

    const immutable = await json(await request(server.baseUrl, "PATCH", `/admin/giveaways/${contests[0].id}`, {
      token: admin.token, body: { revision, patch: { endsAt: "2026-11-01T04:00:00.000Z" } },
    }));
    assert.equal(immutable.response.status, 409);
    assert.equal(immutable.payload.code, "CONTEST_IMMUTABLE");

    clock = new Date("2026-10-01T05:00:00.000Z");
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contests[0].id}/finalize`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "FINAL");
    assert.equal(out.payload.result.potentialWinner, null);
    assert.equal((await (await request(server.baseUrl, "GET", "/giveaways/contest-0/data")).json()).winner, null);

    let cancelRevision = contests[2].revision;
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contests[2].id}/publish`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() }, body: { revision: cancelRevision },
    }));
    assert.equal(out.response.status, 200);
    cancelRevision = out.payload.contest.revision;
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${contests[2].id}/cancel`, {
      token: admin.token, headers: { "Idempotency-Key": uuid() },
      body: { revision: cancelRevision, publicReason: "Contest cancelled by sponsor.", amendedRulesVersion: "2026-09-v2" },
    }));
    assert.equal(out.response.status, 200);
    assert.equal(out.payload.contest.status, "CANCELLED");
    const cancelledHtml = await (await request(server.baseUrl, "GET", "/giveaways/contest-2")).text();
    assert.match(cancelledHtml, /Contest cancelled by sponsor/);
  });

  it("capability-gates linked banners but leaves ordinary legacy banners byte-compatible", async () => {
    const entrant = await createTestUser({ displayName: "Banner User" });
    const bannerContest = await prisma.giveawayContest.create({
      data: {
        ...(() => {
          const data = draft({
            slug: "banner-live",
            title: "Banner Live",
            startsAt: "2026-08-01T04:00:00.000Z",
            endsAt: "2026-09-01T04:00:00.000Z",
          });
          return {
            slug: data.slug,
            title: data.title,
            governingTimeZone: data.governingTimeZone,
            startsAt: new Date(data.startsAt),
            endsAt: new Date(data.endsAt),
            cashCurrency: data.cashCurrency,
            cashMinor: data.cashMinor,
            coinPrize: data.coinPrize,
            minimumAge: data.minimumAge,
            eligibleCountries: ["US"],
            eligibleRegions: data.eligibleRegions,
            sponsor: data.sponsor,
            rulesVersion: data.rules.version,
            rulesSections: data.rules.sections,
            rulesHash: crypto.createHash("sha256").update(JSON.stringify(data.rules)).digest("hex"),
            socialLinks: data.socialLinks,
            bannerMessage: "Bara Giveaway: win US$50 + 5,000 coins.",
          };
        })(),
        lifecycleStatus: "PUBLISHED",
        publishedAt: new Date("2026-08-01T00:00:00.000Z"),
        frozenAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });
    const linkedSettings = {
      async getFlag(key) {
        return {
          homeServiceBannerEnabled: true,
          homeServiceBannerMessage: "Bara Giveaway: win US$50 + 5,000 coins.",
          homeServiceBannerContestSlug: "banner-live",
        }[key];
      },
    };
    const linked = await startServer({ appSettings: linkedSettings });
    const oldClient = await (await request(linked.baseUrl, "GET", "/home/race-card", { token: entrant.token })).json();
    assert.equal(oldClient.homeServiceBanner, undefined);
    const capableClient = await (await request(linked.baseUrl, "GET", "/home/race-card", {
      token: entrant.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    })).json();
    assert.deepEqual(capableClient.homeServiceBanner, {
      enabled: true,
      message: "Bara Giveaway: win US$50 + 5,000 coins.",
      action: { type: "contest", contestSlug: "banner-live" },
    });
    await linked.close();

    const ordinarySettings = {
      async getFlag(key) {
        return {
          homeServiceBannerEnabled: true,
          homeServiceBannerMessage: "Maintenance tonight",
          homeServiceBannerContestSlug: "",
        }[key];
      },
    };
    const ordinary = await startServer({ appSettings: ordinarySettings });
    const legacy = await (await request(ordinary.baseUrl, "GET", "/home/race-card", { token: entrant.token })).json();
    assert.deepEqual(legacy.homeServiceBanner, { enabled: true, message: "Maintenance tonight" });
    await ordinary.close();
    await prisma.giveawayContest.update({ where: { id: bannerContest.id }, data: { lifecycleStatus: "ARCHIVED", archivedAt: new Date() } });
    await prisma.giveawayContest.delete({ where: { slug: "banner-live" } });
  });

  it("purges non-winner acceptance after three years and financial records after seven through the fenced retention job", async () => {
    const oldContest = await prisma.giveawayContest.create({
      data: {
        slug: "retention-contest",
        title: "Retention Contest",
        lifecycleStatus: "FINAL",
        governingTimeZone: "America/New_York",
        startsAt: new Date("2026-01-01T05:00:00.000Z"),
        endsAt: new Date("2026-02-01T05:00:00.000Z"),
        eligibleCountries: ["US"], eligibleRegions: ["US-NY"],
        sponsor: { legalName: "Bara Steps LLC", mailingAddress: "123 Main St" },
        rulesVersion: "retention-v1", rulesSections: RULE_SECTIONS,
        rulesHash: crypto.createHash("sha256").update("retention").digest("hex"),
        socialLinks: [], bannerMessage: "Retention contest", finalizedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    const winnerUser = await createTestUser({ displayName: "Old Winner" });
    const nonWinnerUser = await createTestUser({ displayName: "Old Entrant" });
    async function retainedEntry(user, suffix) {
      return prisma.giveawayEntrant.create({ data: {
        contestId: oldContest.id, userId: user.user.id, entrantIdentityHash: `v1:${suffix}`,
        status: "ELIGIBLE", country: "US", region: "US-NY",
        ageConfirmedAt: oldContest.startsAt, residencyConfirmedAt: oldContest.startsAt,
        rulesAcceptedAt: oldContest.startsAt, acceptedRulesVersion: oldContest.rulesVersion,
        acceptedRulesHash: oldContest.rulesHash, displayNameSnapshot: user.user.displayName,
        displayNameConsentedAt: oldContest.startsAt,
      } });
    }
    const winnerEntry = await retainedEntry(winnerUser, "winner");
    const nonWinnerEntry = await retainedEntry(nonWinnerUser, "nonwinner");
    await prisma.giveawayResult.create({ data: { entrantId: winnerEntry.id, frozenCount: 2, finalRank: 1, status: "VERIFIED", verifiedAt: new Date("2026-02-03T00:00:00.000Z") } });
    await prisma.giveawayResult.create({ data: { entrantId: nonWinnerEntry.id, frozenCount: 1, finalRank: 2, status: "RANKED" } });
    await prisma.giveawayFulfillment.create({ data: { entrantId: winnerEntry.id, cashStatus: "COINS_AWARDED", fulfilledAt: new Date("2026-02-04T00:00:00.000Z") } });
    const audit = await prisma.giveawayAuditEvent.create({ data: {
      contestId: oldContest.id, actorId: admin.user.id, method: "POST:test", action: "TEST",
      requestBody: { privateNote: "remove" }, responseBody: { entrantId: nonWinnerEntry.id },
    } });
    const run = buildGiveawayRetention({
      now: () => new Date("2034-03-01T12:00:00.000Z"),
      JobRun: { lastRanFor: async () => null, claimRun: async () => true },
      env: {}, logger: { log() {}, error() {} },
    });
    const result = await run();
    assert.equal(result.nonWinners >= 1, true);
    assert.equal(result.financial, 1);
    assert.equal(await prisma.giveawayEntrant.findUnique({ where: { id: nonWinnerEntry.id } }), null);
    assert.ok(await prisma.giveawayEntrant.findUnique({ where: { id: winnerEntry.id } }));
    assert.equal(await prisma.giveawayFulfillment.findUnique({ where: { entrantId: winnerEntry.id } }), null);
    const redacted = await prisma.giveawayAuditEvent.findUnique({ where: { id: audit.id } });
    assert.equal(redacted.requestBody, null);
    assert.equal(redacted.responseBody, null);
  });

  it("enforces persistent public-detail and entry attempt rate limits", async () => {
    clock = new Date("2026-10-15T12:00:00.000Z");
    await prisma.giveawayRateWindow.deleteMany();
    let out = await json(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: draft({
        slug: "rate-limited-contest",
        title: "Rate Limited Contest",
        startsAt: "2026-10-01T04:00:00.000Z",
        endsAt: "2026-11-01T04:00:00.000Z",
      }),
    }));
    assert.equal(out.response.status, 201);
    out = await json(await request(server.baseUrl, "POST", `/admin/giveaways/${out.payload.contest.id}/publish`, {
      token: admin.token,
      headers: { "Idempotency-Key": uuid() },
      body: { revision: out.payload.contest.revision },
    }));
    assert.equal(out.response.status, 200);

    const entrant = await createTestUser({ displayName: "Rate Limited Entrant" });
    const entryBody = {
      rulesVersion: "2026-09-v1", country: "US", region: "US-NY",
      ageConfirmed: true, residencyConfirmed: true, rulesAccepted: true,
    };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await request(server.baseUrl, "POST", "/giveaways/rate-limited-contest/entries", {
        token: entrant.token, body: entryBody,
      });
      assert.ok([200, 201].includes(response.status), `entry attempt ${attempt + 1}`);
    }
    out = await json(await request(server.baseUrl, "POST", "/giveaways/rate-limited-contest/entries", {
      token: entrant.token, body: entryBody,
    }));
    assert.equal(out.response.status, 429);
    assert.equal(out.payload.code, "GIVEAWAY_ENTRY_RATE_LIMITED");

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await request(server.baseUrl, "GET", "/giveaways/rate-limited-contest/data");
      assert.equal(response.status, 200, `public detail attempt ${attempt + 1}`);
    }
    out = await json(await request(server.baseUrl, "GET", "/giveaways/rate-limited-contest/data"));
    assert.equal(out.response.status, 429);
    assert.equal(out.payload.code, "GIVEAWAY_PUBLIC_RATE_LIMITED");
  });
});
