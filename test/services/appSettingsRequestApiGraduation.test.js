const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildAppSettings,
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
} = require("../../src/shared/config/appSettings");

const REQUEST_API_FLAGS = [
  "raceProgressLeanProjectionV1Enabled",
  "legacyUploaderStepSamplePrefetchV1Enabled",
  "raceMessageLeanAccessV1Enabled",
  "raceListSqlSummaryV1Enabled",
  "apiRaceListCompactV1Enabled",
  "apiRaceBootstrapCompactV1Enabled",
  "homeRaceCardLeanLiveV1Enabled",
  "homeRaceCardParallelOptionalV1Enabled",
  "homeRaceCardSnapshotReuseV1Enabled",
  "publicRaceCountSqlV1Enabled",
  "apiRaceMessageConditionalV1Enabled",
  "apiRacePowerupTargetContextV1Enabled",
  "racePowerupLeanUseContextV1Enabled",
  "apiLeaderboardCompactV1Enabled",
  "apiRaceBootstrapV1Enabled",
  "apiRaceProgressCompactV1Enabled",
  "apiRaceMessageStreamsV1Enabled",
  "apiFriendsSummaryV1Enabled",
  "apiAuthShellV1Enabled",
  "apiHomeShellV1Enabled",
  "apiGetCoinsV1Enabled",
  "apiPublicRaceBrowserV1Enabled",
  "apiRankedV2CompactV1Enabled",
  "apiProfileStatsV1Enabled",
  "apiImpactNoticesEnabled",
  "apiImpactSummariesEnabled",
  "apiReviewPromptEnabled",
  "apiInboxV1Enabled",
  "apiShopBootstrapV1Enabled",
  "apiStaticEtagsV1Enabled",
  "apiTournamentDetailV1Enabled",
  "apiRaceChatWatermarkCacheV1Enabled",
];

test("production ignores stale rows and rejects writes for graduated request/API controls", async () => {
  const writes = [];
  const settings = buildAppSettings({
    prisma: {
      appSetting: {
        async findMany() {
          return REQUEST_API_FLAGS.map((key) => ({ key, value: false }));
        },
        async upsert(args) { writes.push(args); },
      },
    },
    cacheTtlMs: 0,
    allowPermanentOverrides: false,
  });

  assert.equal(REQUEST_API_FLAGS.length, 32);
  for (const key of REQUEST_API_FLAGS) {
    assert.equal(KNOWN_FLAGS[key], undefined, `${key} must not remain mutable`);
    assert.equal(PERMANENT_FLAGS[key], true, `${key} permanent value`);
    assert.equal(await settings.getFlag(key), true, `${key} ignores stale false row`);
    await assert.rejects(settings.setFlag(key, false), /Unknown setting/);
  }
  assert.equal(writes.length, 0);
  const admin = await settings.getAllFlags();
  for (const key of REQUEST_API_FLAGS) {
    assert.equal(Object.hasOwn(admin, key), false, `${key} hidden from admin`);
  }
});

test("NODE_TEST_CONTEXT cannot reopen graduated controls in production", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = "production";
  process.env.NODE_TEST_CONTEXT = "1";

  try {
    const writes = [];
    const settings = buildAppSettings({
      prisma: {
        appSetting: {
          async findMany() {
            return [{ key: "apiAuthShellV1Enabled", value: false }];
          },
          async upsert(args) { writes.push(args); },
        },
      },
      cacheTtlMs: 0,
    });

    assert.equal(await settings.getFlag("apiAuthShellV1Enabled"), true);
    await assert.rejects(
      settings.setFlag("apiAuthShellV1Enabled", false),
      /Unknown setting/,
    );
    assert.equal(writes.length, 0);
    assert.equal(
      Object.hasOwn(await settings.getAllFlags(), "apiAuthShellV1Enabled"),
      false,
    );
  } finally {
    if (originalNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalTestContext == null) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = originalTestContext;
  }
});
