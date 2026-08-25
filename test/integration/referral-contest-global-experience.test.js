const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, describe, it } = require("node:test");
const cacheKeys = require("../../src/shared/cache/cacheKeys");
const redisCache = require("../../src/shared/cache/redisCache");
const { buildGiveawayService } = require("../../src/modules/giveaways/services/giveawayService");
const { startTestRedis } = require("./redisTestServer");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

const GLOBAL_FEATURES = {
  "X-Client-Features": "referral_contest_v1,referral_contest_global_v1",
};
const US_REGIONS = [
  "US-AL", "US-AK", "US-AZ", "US-AR", "US-CA", "US-CO", "US-CT", "US-DE", "US-DC",
  "US-FL", "US-GA", "US-HI", "US-ID", "US-IL", "US-IN", "US-IA", "US-KS", "US-KY",
  "US-LA", "US-ME", "US-MD", "US-MA", "US-MI", "US-MN", "US-MS", "US-MO", "US-MT",
  "US-NE", "US-NV", "US-NH", "US-NJ", "US-NM", "US-NY", "US-NC", "US-ND", "US-OH",
  "US-OK", "US-OR", "US-PA", "US-RI", "US-SC", "US-SD", "US-TN", "US-TX", "US-UT",
  "US-VT", "US-VA", "US-WA", "US-WV", "US-WI", "US-WY",
];

function compactDraft(overrides = {}) {
  return {
    slug: "september-trail",
    title: "September Referral Trail",
    startsAt: "2026-09-01T04:00:00.000Z",
    endsAt: "2026-10-01T04:00:00.000Z",
    coinPrize: 5000,
    bannerMessage: "Bring your crew. The referral trail is open.",
    eligibilityMode: "BARA_ACCOUNT",
    ...overrides,
  };
}

function legacyCashDraft(overrides = {}) {
  return {
    slug: "legacy-cash-new-client",
    title: "Legacy Cash Contest",
    governingTimeZone: "America/New_York",
    startsAt: "2026-09-01T04:00:00.000Z",
    endsAt: "2026-10-01T04:00:00.000Z",
    cashCurrency: "USD",
    cashMinor: 5000,
    coinPrize: 5000,
    minimumAge: 18,
    eligibleRegions: US_REGIONS,
    sponsor: { legalName: "Bara Steps LLC", mailingAddress: "123 Main St" },
    rules: { version: "legacy-v1", sections: [
      { heading: "Rules", body: "No purchase necessary. Apple and Google are not sponsors." },
    ] },
    socialLinks: [],
    bannerMessage: "Bara Giveaway: win US$50 + 5,000 coins.",
    ...overrides,
  };
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

describe("global coin-only referral contest HTTP contract", () => {
  let server;
  let admin;
  let entrant;
  let clock = new Date("2026-08-25T12:00:00.000Z");

  before(async () => {
    assert.match(process.env.DATABASE_URL || "", /(?:_test(?:\?|$)|localhost)/,
      "global contest integration tests require a local/test database");
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 = "global-contest-integration-secret";
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Contest Admin" });
    entrant = await createTestUser({ displayName: "TrailBara" });
    server = await startServer({
      now: () => new Date(clock),
      isAdminUser: (user) => user?.id === admin.user.id,
      appSettings: { async getFlag() { return false; } },
    });
  });

  after(async () => {
    await server?.close();
    await redisCache.close();
    delete process.env.REDIS_URL;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1;
  });

  it("creates a standardized BARA_ACCOUNT draft and capability-hides it from legacy admin clients", async () => {
    const created = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: compactDraft(),
    }));
    assert.equal(created.status, 201);
    assert.equal(created.body.contest.eligibilityMode, "BARA_ACCOUNT");
    assert.equal(created.body.contest.governingTimeZone, "UTC");
    assert.equal(created.body.contest.cashMinor, 0);
    assert.equal(created.body.contest.cashCurrency, "USD");
    assert.equal(created.body.contest.minimumAge, null);
    assert.equal(created.body.contest.eligibleCountries, null);
    assert.equal(created.body.contest.eligibleRegions, null);
    assert.deepEqual(created.body.contest.sponsor, { name: "Bara" });
    assert.deepEqual(created.body.contest.socialLinks, []);
    assert.match(created.body.contest.rules.version, /^bara-account-v1-[0-9a-f]{24}$/);
    assert.match(created.body.contest.rules.sha256, /^[0-9a-f]{64}$/);
    assert.ok(created.body.contest.rules.sections.some((section) => /no purchase necessary/i.test(section.body)));

    const stored = await prisma.giveawayContest.findUnique({ where: { id: created.body.contest.id } });
    assert.equal(stored.minimumAge, null);
    assert.equal(stored.eligibleCountries, null);
    assert.equal(stored.eligibleRegions, null);

    const legacyList = await read(await request(server.baseUrl, "GET", "/admin/giveaways", {
      token: admin.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    }));
    assert.equal(legacyList.status, 200);
    assert.deepEqual(legacyList.body.records, []);

    const hiddenDetail = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    }));
    assert.equal(hiddenDetail.status, 404);
    assert.equal(hiddenDetail.body.code, "CONTEST_NOT_FOUND");
  });

  it("rejects malformed global create input and prohibited banner claims", async () => {
    for (const body of [
      compactDraft({ bannerMessage: undefined }),
      compactDraft({ bannerMessage: "Win $50 from Bara today" }),
      compactDraft({ bannerMessage: "Win fifty dollars from Bara today" }),
      compactDraft({ bannerMessage: "Win a digital currency prize today" }),
      compactDraft({ bannerMessage: "Win a gift card from Bara today" }),
      compactDraft({ bannerMessage: "Win crypto from Bara this month" }),
      compactDraft({ bannerMessage: "Win exclusive Bara merchandise today" }),
      compactDraft({ bannerMessage: "Win store credit from Bara today" }),
      compactDraft({ bannerMessage: "x".repeat(97) }),
      { ...compactDraft(), sponsor: { name: "Someone else" } },
      { ...compactDraft(), cashMinor: 1 },
    ]) {
      const response = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body,
      }));
      assert.equal(response.status, 400);
    }
  });

  it("lets refreshed clients edit legacy cash drafts only when cash/legal fields round-trip unchanged", async () => {
    const create = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: legacyCashDraft(),
    }));
    assert.equal(create.status, 400);
    assert.equal(create.body.code, "INVALID_PRIZE");

    const legacy = legacyCashDraft({ slug: "pre-cutover-cash-draft" });
    const historicalDraft = await prisma.giveawayContest.create({ data: {
      slug: legacy.slug,
      title: legacy.title,
      governingTimeZone: legacy.governingTimeZone,
      startsAt: new Date(legacy.startsAt),
      endsAt: new Date(legacy.endsAt),
      cashCurrency: legacy.cashCurrency,
      cashMinor: legacy.cashMinor,
      coinPrize: legacy.coinPrize,
      minimumAge: legacy.minimumAge,
      eligibleCountries: ["US"],
      eligibleRegions: legacy.eligibleRegions,
      sponsor: legacy.sponsor,
      rulesVersion: "legacy-v1",
      rulesSections: [{ heading: "Rules", body: "No purchase necessary. Apple and Google are not sponsors." }],
      rulesHash: crypto.createHash("sha256").update("legacy-rules").digest("hex"),
      socialLinks: [],
      bannerMessage: legacy.bannerMessage,
    } });

    const preserved = await read(await request(server.baseUrl, "PATCH", `/admin/giveaways/${historicalDraft.id}`, {
      token: admin.token,
      headers: GLOBAL_FEATURES,
      body: { revision: historicalDraft.revision, patch: {
        title: "Legacy Cash Contest Renamed",
        cashCurrency: legacy.cashCurrency,
        cashMinor: legacy.cashMinor,
        minimumAge: legacy.minimumAge,
        eligibleRegions: legacy.eligibleRegions,
        sponsor: legacy.sponsor,
        rules: legacy.rules,
        socialLinks: legacy.socialLinks,
        bannerMessage: legacy.bannerMessage,
      } },
    }));
    assert.equal(preserved.status, 200);
    assert.equal(preserved.body.contest.title, "Legacy Cash Contest Renamed");
    assert.equal(preserved.body.contest.cashCurrency, "USD");
    assert.equal(preserved.body.contest.cashMinor, 5000);

    for (const patch of [
      { cashMinor: 4999 },
      { cashMinor: 5001 },
      { cashCurrency: "EUR" },
      { eligibilityMode: "BARA_ACCOUNT" },
    ]) {
      const changed = await read(await request(server.baseUrl, "PATCH", `/admin/giveaways/${historicalDraft.id}`, {
        token: admin.token,
        headers: GLOBAL_FEATURES,
        body: { revision: preserved.body.contest.revision, patch },
      }));
      assert.equal(changed.status, 400);
    }

    const publish = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${historicalDraft.id}/publish`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision: preserved.body.contest.revision },
    }));
    assert.equal(publish.status, 400);
    assert.equal(publish.body.code, "PUBLISH_VALIDATION_FAILED");
    assert.ok(publish.body.fields.includes("prize"));
  });

  it("regenerates global rules only for material draft edits and fails malformed publication", async () => {
    const created = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: compactDraft({ slug: "edit-rules", title: "Edit Rules" }),
    }));
    assert.equal(created.status, 201);
    const original = created.body.contest.rules;
    const bannerOnly = await read(await request(server.baseUrl, "PATCH", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token, headers: GLOBAL_FEATURES,
      body: { revision: created.body.contest.revision, patch: { bannerMessage: "A fresh trail headline for everyone." } },
    }));
    assert.equal(bannerOnly.status, 200);
    assert.deepEqual(bannerOnly.body.contest.rules, original);
    const material = await read(await request(server.baseUrl, "PATCH", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token, headers: GLOBAL_FEATURES,
      body: { revision: bannerOnly.body.contest.revision, patch: { title: "Edited Rules Trail" } },
    }));
    assert.equal(material.status, 200);
    assert.notEqual(material.body.contest.rules.version, original.version);
    await prisma.giveawayContest.update({ where: { id: created.body.contest.id }, data: { rulesHash: "0".repeat(64) } });
    const publish = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${created.body.contest.id}/publish`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision: material.body.contest.revision },
    }));
    assert.equal(publish.status, 400);
    assert.equal(publish.body.code, "PUBLISH_VALIDATION_FAILED");
    assert.ok(publish.body.fields.includes("rules"));
  });

  it("publishes, capability-gates member/Home discovery, and enters without age or location facts", async () => {
    const draft = await prisma.giveawayContest.findUnique({ where: { slug: "september-trail" } });
    const published = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${draft.id}/publish`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision: draft.revision },
    }));
    assert.equal(published.status, 200);

    clock = new Date("2026-09-02T12:00:00.000Z");
    const legacyMember = await read(await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    }));
    assert.deepEqual(legacyMember.body, {
      contest: null, leaderboard: [], entry: null, standing: null, share: null,
    });

    const member = await read(await request(server.baseUrl, "GET", "/giveaways/current/me", {
      token: entrant.token, headers: GLOBAL_FEATURES,
    }));
    assert.equal(member.status, 200);
    assert.equal(member.body.contest.eligibility.mode, "BARA_ACCOUNT");
    assert.equal(member.body.entry.status, "ACTION_REQUIRED");

    const oldHome = await read(await request(server.baseUrl, "GET", "/home/race-card", {
      token: entrant.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
    }));
    assert.equal(oldHome.body.homeGiveawayBanner, undefined);
    const newHome = await read(await request(server.baseUrl, "GET", "/home/race-card", {
      token: entrant.token, headers: GLOBAL_FEATURES,
    }));
    assert.deepEqual(newHome.body.homeGiveawayBanner, {
      type: "referral_contest",
      contestSlug: "september-trail",
      title: "September Referral Trail",
      message: "Bring your crew. The referral trail is open.",
      status: "ACTIVE",
      endsAt: "2026-10-01T04:00:00.000Z",
      coinPrize: 5000,
    });

    const rulesVersion = member.body.contest.rules.version;
    const hiddenEntry = await read(await request(server.baseUrl, "POST", "/giveaways/september-trail/entries", {
      token: entrant.token,
      headers: { "X-Client-Features": "referral_contest_v1" },
      body: { rulesVersion, rulesAccepted: true },
    }));
    assert.equal(hiddenEntry.status, 404);
    assert.equal(hiddenEntry.body.code, "CONTEST_NOT_FOUND");

    await assert.rejects(
      () => buildGiveawayService({ prisma }).contestById(draft.id),
      (error) => error?.code === "CONTEST_NOT_FOUND" && error?.statusCode === 404,
    );

    const entered = await read(await request(server.baseUrl, "POST", "/giveaways/september-trail/entries", {
      token: entrant.token,
      headers: GLOBAL_FEATURES,
      body: { rulesVersion, rulesAccepted: true },
    }));
    assert.equal(entered.status, 201);
    assert.deepEqual(Object.keys(entered.body.entry).sort(), ["acceptedAt", "displayName", "rulesVersion", "status"]);
    assert.equal(entered.body.entry.displayName, "TrailBara");
    const row = await prisma.giveawayEntrant.findUnique({
      where: { contestId_userId: { contestId: draft.id, userId: entrant.user.id } },
    });
    assert.equal(row.country, null);
    assert.equal(row.region, null);
    assert.equal(row.ageConfirmedAt, null);
    assert.equal(row.residencyConfirmedAt, null);

    const replay = await read(await request(server.baseUrl, "POST", "/giveaways/september-trail/entries", {
      token: entrant.token, headers: GLOBAL_FEATURES,
      body: { rulesVersion, rulesAccepted: true },
    }));
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, entered.body);
  });

  it("fails closed and reloads PostgreSQL when an old worker cached a pre-mode banner payload", async (t) => {
    const live = await startTestRedis();
    if (!live) return t.skip("no local Redis available");
    process.env.REDIS_URL = live.url;
    process.env.CACHE_ENV_PREFIX = "t:";
    await redisCache.close();
    const client = new (require("ioredis"))(live.url);
    await client.flushdb();
    try {
      await redisCache.setJSON(cacheKeys.homeGiveawayBanner(), { v: {
        contestSlug: "september-trail",
        title: "September Referral Trail",
        status: "ACTIVE",
        endsAt: "2026-10-01T04:00:00.000Z",
        coinPrize: 5000,
      } }, 15);

      const oldHome = await read(await request(server.baseUrl, "GET", "/home/race-card", {
        token: entrant.token,
        headers: { "X-Client-Features": "referral_contest_v1" },
      }));
      assert.equal(oldHome.body.homeGiveawayBanner, undefined,
        "old clients must not see a global row misclassified from an old cache payload");

      const newHome = await read(await request(server.baseUrl, "GET", "/home/race-card", {
        token: entrant.token,
        headers: GLOBAL_FEATURES,
      }));
      assert.equal(newHome.body.homeGiveawayBanner.message,
        "Bring your crew. The referral trail is open.");
      const repaired = await redisCache.getJSON(cacheKeys.homeGiveawayBanner());
      assert.equal(repaired.v.eligibilityMode, "BARA_ACCOUNT");
      assert.equal(repaired.v.message, "Bring your crew. The referral trail is open.");
    } finally {
      await client.quit().catch(() => {});
      await redisCache.close();
      delete process.env.REDIS_URL;
      await live.close();
    }
  });

  it("enforces exact global entry errors and concurrent identical requests", async () => {
    const contest = await prisma.giveawayContest.findUnique({ where: { slug: "september-trail" } });
    const rulesVersion = contest.rulesVersion;
    const review = await createTestUser({ displayName: "ReviewBara", isReviewAccount: true });
    const missingName = await createTestUser({ displayName: null });
    for (const [user, body, code] of [
      [await createTestUser({ displayName: "FalseAccept" }), { rulesVersion, rulesAccepted: false }, "RULES_ACCEPTANCE_REQUIRED"],
      [await createTestUser({ displayName: "StaleRules" }), { rulesVersion: "stale", rulesAccepted: true }, "RULES_CHANGED"],
      [await createTestUser({ displayName: "UnknownKey" }), { rulesVersion, rulesAccepted: true, country: "US" }, "INVALID_BODY"],
      [review, { rulesVersion, rulesAccepted: true }, "ENTRY_INELIGIBLE"],
      [missingName, { rulesVersion, rulesAccepted: true }, "DISPLAY_NAME_REQUIRED"],
    ]) {
      const response = await read(await request(server.baseUrl, "POST", "/giveaways/september-trail/entries", {
        token: user.token, headers: GLOBAL_FEATURES, body,
      }));
      assert.ok([400, 409].includes(response.status));
      assert.equal(response.body.code, code);
    }

    const concurrent = await createTestUser({ displayName: "RaceJoiner" });
    const responses = await Promise.all([1, 2].map(() => request(server.baseUrl, "POST", "/giveaways/september-trail/entries", {
      token: concurrent.token, headers: GLOBAL_FEATURES, body: { rulesVersion, rulesAccepted: true },
    })));
    const decoded = await Promise.all(responses.map(read));
    assert.deepEqual(decoded.map((item) => item.status).sort(), [200, 201]);
    assert.deepEqual(decoded[0].body, decoded[1].body);
    assert.equal(await prisma.giveawayEntrant.count({ where: { contestId: contest.id, userId: concurrent.user.id } }), 1);
  });

  it("renders global HTML without legacy residency, age, cash, payout, or address claims", async () => {
    for (const path of ["/giveaways/september-trail", "/giveaways/september-trail/rules"]) {
      const response = await request(server.baseUrl, "GET", path);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.doesNotMatch(html, /United States|18\+|age 18|mailing|address|cash|payout/i);
      assert.match(html, /Sponsored by Bara|Sponsor:<\/strong> Bara/i);
      assert.match(html, /Apple and Google/i);
    }
  });

  it("requires explicit review of rapid global leader facts but does not alter legacy settlement policy", async () => {
    const contest = await prisma.giveawayContest.findUnique({ where: { slug: "september-trail" } });
    const referees = await Promise.all([
      createTestUser({ displayName: "RiskRefOne" }),
      createTestUser({ displayName: "RiskRefTwo" }),
    ]);
    const facts = [];
    for (let index = 0; index < referees.length; index += 1) {
      facts.push(await prisma.referral.create({ data: {
        referrerId: entrant.user.id,
        refereeId: referees[index].user.id,
        refereeSubHash: crypto.createHash("sha256").update(`global-risk-${index}`).digest("hex"),
        status: "REWARDED",
        qualifiedAt: new Date(`2026-09-03T12:0${index}:00.000Z`),
      } }));
    }
    clock = new Date("2026-10-02T12:00:00.000Z");
    let revision = (await prisma.giveawayContest.findUnique({ where: { id: contest.id } })).revision;
    const candidates = await read(await request(server.baseUrl, "GET", `/admin/giveaways/${contest.id}/candidates`, {
      token: admin.token, headers: GLOBAL_FEATURES,
    }));
    assert.equal(candidates.status, 200);
    const leader = candidates.body.records.find((row) => row.displayName === "TrailBara");
    assert.deepEqual(leader.reviewFacts.map((fact) => fact.referralFactId).sort(), facts.map((fact) => fact.id).sort());
    const blocked = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision },
    }));
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "OUTCOME_REVIEW_REQUIRED");

    for (const fact of facts) {
      const reviewed = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/reviews`, {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: { revision, referralFactId: fact.id, decision: "APPROVE", reasonCode: "LEGITIMATE" },
      }));
      assert.equal(reviewed.status, 200);
      revision = reviewed.body.contest.revision;
    }
    const finalized = await read(await request(server.baseUrl, "POST", `/admin/giveaways/${contest.id}/finalize`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision },
    }));
    assert.equal(finalized.status, 200);
    assert.equal(finalized.body.result.potentialWinner.displayName, "TrailBara");
  });

  it("hard-deletes an unused draft with revision and idempotency protection", async () => {
    const created = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: compactDraft({ slug: "delete-me", title: "Delete Me" }),
    }));
    const key = crypto.randomUUID();
    const deletion = await read(await request(server.baseUrl, "DELETE", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": key },
      body: { revision: created.body.contest.revision },
    }));
    assert.equal(deletion.status, 200);
    assert.deepEqual(deletion.body, { deleted: {
      id: created.body.contest.id, slug: "delete-me", lifecycleStatus: "DRAFT",
    } });
    assert.equal(await prisma.giveawayContest.findUnique({ where: { id: created.body.contest.id } }), null);

    const replay = await read(await request(server.baseUrl, "DELETE", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": key },
      body: { revision: created.body.contest.revision },
    }));
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, deletion.body);

    const mismatched = await read(await request(server.baseUrl, "DELETE", `/admin/giveaways/${created.body.contest.id}`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": key },
      body: { revision: created.body.contest.revision + 1 },
    }));
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.code, "IDEMPOTENCY_CONFLICT");

    const staleDraft = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: compactDraft({ slug: "stale-delete", title: "Stale Delete" }),
    }));
    const stale = await read(await request(server.baseUrl, "DELETE", `/admin/giveaways/${staleDraft.body.contest.id}`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision: staleDraft.body.contest.revision + 1 },
    }));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "REVISION_CONFLICT");

    const protectedContest = await prisma.giveawayContest.findUnique({ where: { slug: "september-trail" } });
    const nonDraft = await read(await request(server.baseUrl, "DELETE", `/admin/giveaways/${protectedContest.id}`, {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: { revision: protectedContest.revision },
    }));
    assert.equal(nonDraft.status, 409);
    assert.equal(nonDraft.body.code, "CONTEST_DELETE_NOT_ALLOWED");
  });
});
