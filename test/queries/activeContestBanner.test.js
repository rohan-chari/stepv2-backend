const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveActiveContestBanner } = require("../../src/modules/giveaways");

const NOW = new Date("2026-08-25T15:00:00.000Z");

function activeContest(overrides = {}) {
  return {
    slug: "bara-referral-active",
    title: "Bara Referral Contest",
    lifecycleStatus: "PUBLISHED",
    startsAt: new Date("2026-08-25T14:00:00.000Z"),
    endsAt: new Date("2026-08-26T15:00:00.000Z"),
    coinPrize: 5000,
    ...overrides,
  };
}

function prismaReturning(rows, calls = []) {
  return {
    giveawayContest: {
      async findMany(args) {
        calls.push(args);
        return rows;
      },
    },
  };
}

test("resolveActiveContestBanner returns the locked additive contract for one active published contest", async () => {
  const calls = [];
  const banner = await resolveActiveContestBanner({
    prisma: prismaReturning([activeContest()], calls),
    now: NOW,
  });

  assert.deepEqual(banner, {
    type: "referral_contest",
    contestSlug: "bara-referral-active",
    title: "Bara Referral Contest",
    status: "ACTIVE",
    endsAt: "2026-08-26T15:00:00.000Z",
    coinPrize: 5000,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, {
    lifecycleStatus: "PUBLISHED",
    startsAt: { lte: NOW },
    endsAt: { gt: NOW },
  });
});

test("resolveActiveContestBanner omits absent, duplicate, scheduled, ended, and malformed contests", async () => {
  const cases = [
    [],
    [activeContest(), activeContest({ slug: "bara-referral-duplicate" })],
    [activeContest({ startsAt: new Date("2026-08-25T16:00:00.000Z") })],
    [activeContest({ endsAt: new Date("2026-08-25T14:59:59.000Z") })],
    [activeContest({ lifecycleStatus: "DRAFT" })],
    [activeContest({ slug: "bad slug" })],
    [activeContest({ title: "" })],
    [activeContest({ title: "x".repeat(121) })],
    [activeContest({ coinPrize: 0 })],
    [activeContest({ coinPrize: 1.5 })],
    [activeContest({ endsAt: "not a date" })],
  ];

  for (const rows of cases) {
    assert.equal(
      await resolveActiveContestBanner({ prisma: prismaReturning(rows), now: NOW }),
      null
    );
  }
});

test("resolveActiveContestBanner omits on query failure", async () => {
  const failed = {
    giveawayContest: {
      async findMany() {
        throw new Error("db unavailable");
      },
    },
  };

  assert.equal(await resolveActiveContestBanner({ prisma: failed, now: NOW }), null);
});
