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

function contestData(overrides = {}) {
  const startsAt = new Date("2026-08-25T14:00:00.000Z");
  const endsAt = new Date("2026-08-26T15:00:00.000Z");
  return {
    slug: "bara-referral-active",
    title: "Bara Referral Contest",
    lifecycleStatus: "PUBLISHED",
    governingTimeZone: "America/New_York",
    startsAt,
    endsAt,
    cashCurrency: "USD",
    cashMinor: 0,
    coinPrize: 5000,
    minimumAge: 18,
    eligibleCountries: ["US"],
    eligibleRegions: ["US-NY"],
    sponsor: { legalName: "Bara", mailingAddress: "PO Box 1" },
    rulesVersion: "bara-referral-standard-v1",
    rulesSections: [{ heading: "How to enter", body: "No purchase necessary." }],
    rulesHash: crypto.createHash("sha256").update("test-rules").digest("hex"),
    socialLinks: [],
    bannerMessage: "Bara Referral Contest: win 5,000 coins.",
    ...overrides,
  };
}

async function createContest(overrides = {}) {
  return prisma.giveawayContest.create({ data: contestData(overrides) });
}

async function getRaceCard(server, user, headers = { "X-Client-Features": "referral_contest_v1" }) {
  const response = await request(server.baseUrl, "GET", "/home/race-card", {
    token: user.token,
    headers,
  });
  assert.equal(response.status, 200);
  return response.json();
}

function settings({ parallel = false, manual = false } = {}) {
  return {
    async getFlag(key) {
      if (key === "homeRaceCardParallelOptionalV1Enabled") return parallel;
      if (manual && key === "homeServiceBannerEnabled") return true;
      if (manual && key === "homeServiceBannerMessage") return "Maintenance tonight";
      if (manual && key === "homeServiceBannerContestSlug") return "";
      return false;
    },
  };
}

describe("automatic active referral contest home banner", () => {
  let user;

  before(async () => {
    await cleanDatabase();
    user = await createTestUser({ displayName: "Banner Viewer" });
  });

  beforeEach(async () => {
    await prisma.giveawayContest.deleteMany();
  });

  after(async () => {
    await prisma.giveawayContest.deleteMany();
  });

  it("omits the automatic field for absent, scheduled, ended, malformed, and failed lookups", async () => {
    const server = await startServer({
      appSettings: settings(),
      now: () => new Date("2026-08-25T15:00:00.000Z"),
    });
    try {
      assert.equal((await getRaceCard(server, user)).homeGiveawayBanner, undefined);

      await createContest({ slug: "scheduled", startsAt: new Date("2026-08-25T16:00:00.000Z") });
      assert.equal((await getRaceCard(server, user)).homeGiveawayBanner, undefined);
      await prisma.giveawayContest.deleteMany();

      await createContest({ slug: "ended", endsAt: new Date("2026-08-25T14:59:59.000Z") });
      assert.equal((await getRaceCard(server, user)).homeGiveawayBanner, undefined);
      await prisma.giveawayContest.deleteMany();

      await createContest({ title: "" });
      assert.equal((await getRaceCard(server, user)).homeGiveawayBanner, undefined);
    } finally {
      await server.close();
    }

    const failingServer = await startServer({
      appSettings: settings(),
      now: () => new Date("2026-08-25T15:00:00.000Z"),
      prisma: {
        giveawayContest: {
          async findMany() {
            throw new Error("db unavailable");
          },
        },
      },
    });
    try {
      assert.equal((await getRaceCard(failingServer, user)).homeGiveawayBanner, undefined);
    } finally {
      await failingServer.close();
    }
  });

  it("automatically wins over the manual banner on both legacy and parallel home paths", async () => {
    await createContest();
    for (const parallel of [false, true]) {
      const server = await startServer({
        appSettings: settings({ parallel, manual: true }),
        now: () => new Date("2026-08-25T15:00:00.000Z"),
      });
      const body = await getRaceCard(server, user);
      assert.deepEqual(body.homeGiveawayBanner, {
        type: "referral_contest",
        contestSlug: "bara-referral-active",
        title: "Bara Referral Contest",
        status: "ACTIVE",
        endsAt: "2026-08-26T15:00:00.000Z",
        coinPrize: 5000,
      });
      assert.deepEqual(body.homeServiceBanner, {
        enabled: true,
        message: "Maintenance tonight",
      });
      await server.close();
    }
  });

  it("keeps the automatic field absent for clients without the capability", async () => {
    await createContest();
    const server = await startServer({
      appSettings: settings({ parallel: true, manual: true }),
      now: () => new Date("2026-08-25T15:00:00.000Z"),
    });
    const body = await getRaceCard(server, user, {});
    assert.equal(body.homeGiveawayBanner, undefined);
    assert.deepEqual(body.homeServiceBanner, {
      enabled: true,
      message: "Maintenance tonight",
    });
    await server.close();
  });
});
