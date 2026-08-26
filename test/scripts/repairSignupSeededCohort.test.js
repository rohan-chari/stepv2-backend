const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  auditCohort,
  historicalWindowFor,
  chooseHistoricalRace,
} = require("../../scripts/repair-signup-seeded-cohort");

function historicalAuditDb({ dailyRace, dailyBucket = true }) {
  const user = {
    id: "signup-user",
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    isReviewAccount: false,
  };
  const dailyWindow = historicalWindowFor(
    { cadence: "DAILY" },
    user.createdAt,
  );
  const weeklyWindow = historicalWindowFor(
    { cadence: "WEEKLY" },
    user.createdAt,
  );
  const weeklyRace = {
    id: "weekly-race",
    seedId: "weekly-seed",
    seededBucketId: "weekly-bucket",
    status: "ACTIVE",
    completedAt: null,
    timezone: "America/New_York",
  };
  return {
    user: { async findMany() { return [user]; } },
    raceSeed: {
      async findMany() {
        return [
          { id: "daily-seed", kind: "DAILY_10K", cadence: "DAILY", active: true },
          { id: "weekly-seed", kind: "WEEKLY_50K", cadence: "WEEKLY", active: true },
        ];
      },
    },
    seededRaceBucket: {
      async findMany({ where }) {
        if (where.seedId === "weekly-seed") {
          return [{
            id: "weekly-bucket",
            ...weeklyWindow,
            createdAt: weeklyWindow.windowStart,
            race: weeklyRace,
          }];
        }
        return dailyBucket
          ? [{
              id: "daily-bucket",
              ...dailyWindow,
              createdAt: dailyWindow.windowStart,
              race: dailyRace,
            }]
          : [];
      },
    },
    seededRaceWindowMembership: { async findUnique() { return null; } },
    race: {
      async findMany({ where }) {
        if (where.seedId !== "daily-seed" || dailyBucket) return [];
        assert.equal(
          where.status,
          undefined,
          "historical identity lookup must not discard a terminal legacy race",
        );
        return [dailyRace];
      },
    },
    raceParticipant: {
      async findUnique({ where }) {
        return where.raceId_userId.raceId === weeklyRace.id
          ? { id: "weekly-membership" }
          : null;
      },
    },
  };
}

describe("historical seeded cohort reconstruction", () => {
  it("uses canonical New York daily and weekly windows across the UTC boundary", () => {
    const dailySeed = { cadence: "DAILY" };
    const weeklySeed = { cadence: "WEEKLY" };
    assert.deepEqual(
      historicalWindowFor(dailySeed, new Date("2026-08-25T03:59:59.999Z")),
      {
        windowStart: new Date("2026-08-24T04:00:00.000Z"),
        windowEnd: new Date("2026-08-25T04:00:00.000Z"),
      },
    );
    assert.deepEqual(
      historicalWindowFor(dailySeed, new Date("2026-08-25T04:00:00.000Z")),
      {
        windowStart: new Date("2026-08-25T04:00:00.000Z"),
        windowEnd: new Date("2026-08-26T04:00:00.000Z"),
      },
    );
    assert.deepEqual(
      historicalWindowFor(weeklySeed, new Date("2026-08-30T23:59:59.999Z")),
      {
        windowStart: new Date("2026-08-24T04:00:00.000Z"),
        windowEnd: new Date("2026-08-31T04:00:00.000Z"),
      },
    );
  });

  it("keeps the New York DST transition instead of assuming a 24-hour UTC day", () => {
    assert.deepEqual(
      historicalWindowFor(
        { cadence: "DAILY" },
        new Date("2026-11-01T12:00:00.000Z"),
      ),
      {
        windowStart: new Date("2026-11-01T04:00:00.000Z"),
        windowEnd: new Date("2026-11-02T05:00:00.000Z"),
      },
    );
  });

  it("selects only the exact historical bucket and reports ambiguous buckets", () => {
    const exactWindow = {
      windowStart: new Date("2026-08-25T04:00:00.000Z"),
      windowEnd: new Date("2026-08-26T04:00:00.000Z"),
    };
    const wrongOverlap = {
      id: "wrong-overlap",
      windowStart: new Date("2026-08-25T00:00:00.000Z"),
      windowEnd: new Date("2026-08-26T00:00:00.000Z"),
      race: { id: "wrong-race", status: "ACTIVE", timezone: "America/New_York" },
    };
    const exact = {
      id: "exact",
      ...exactWindow,
      race: { id: "exact-race", status: "ACTIVE", timezone: "America/New_York" },
    };
    assert.deepEqual(
      chooseHistoricalRace([wrongOverlap, exact], exactWindow),
      { race: exact.race, bucketId: "exact" },
    );
    assert.deepEqual(
      chooseHistoricalRace([
        exact,
        { ...exact, id: "exact-2", race: { ...exact.race, id: "exact-race-2" } },
      ], exactWindow),
      { error: "AMBIGUOUS_BUCKET", candidateRaceIds: ["exact-race", "exact-race-2"] },
    );
  });

  it("reports an exact completed historical bucket instead of losing its identity", async () => {
    const report = await auditCohort({
      db: historicalAuditDb({
        dailyRace: {
          id: "completed-daily-bucket-race",
          seedId: "daily-seed",
          seededBucketId: "daily-bucket",
          status: "COMPLETED",
          completedAt: new Date("2026-08-26T04:00:00.000Z"),
          timezone: "America/New_York",
        },
      }),
      date: "2026-08-25",
    });
    assert.deepEqual(report.completedOrSettled, [{
      userId: "signup-user",
      cadence: "DAILY",
      raceId: "completed-daily-bucket-race",
    }]);
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.commands, [], "terminal historical races are report-only");
  });

  it("reports an exact completed legacy window without enqueueing it", async () => {
    const report = await auditCohort({
      db: historicalAuditDb({
        dailyBucket: false,
        dailyRace: {
          id: "completed-daily-legacy-race",
          seedId: "daily-seed",
          seededBucketId: null,
          status: "COMPLETED",
          completedAt: new Date("2026-08-27T04:00:00.000Z"),
          timezone: "America/New_York",
        },
      }),
      date: "2026-08-25",
    });
    assert.deepEqual(report.completedOrSettled, [{
      userId: "signup-user",
      cadence: "DAILY",
      raceId: "completed-daily-legacy-race",
    }]);
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.commands, []);
  });
});
