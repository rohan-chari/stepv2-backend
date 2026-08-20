const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildAppSettings,
  KNOWN_FLAGS,
  PERMANENT_FLAGS,
} = require("../../src/shared/config/appSettings");

test("onboarding v2 is permanently retired for current code", async () => {
  const writes = [];
  const settings = buildAppSettings({
    prisma: {
      appSetting: {
        async findMany() { return []; },
        async upsert(args) { writes.push(args); },
      },
    },
    cacheTtlMs: 0,
    allowPermanentOverrides: false,
  });
  assert.equal(KNOWN_FLAGS.onboardingV2Enabled, undefined);
  assert.equal(PERMANENT_FLAGS.onboardingV2Enabled, false);
  assert.equal(await settings.getFlag("onboardingV2Enabled"), false);
  await assert.rejects(settings.setFlag("onboardingV2Enabled", true), /Unknown setting/);
  assert.equal(writes.length, 0);
});

test("production ignores NODE_TEST_CONTEXT for retired immutable settings", async () => {
  const oldNodeEnv = process.env.NODE_ENV;
  const oldTestContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_ENV = "production";
  process.env.NODE_TEST_CONTEXT = "1";
  const writes = [];
  try {
    const settings = buildAppSettings({
      prisma: {
        appSetting: {
          async findMany() {
            return [{ key: "onboardingV2Enabled", value: true }];
          },
          async upsert(args) { writes.push(args); },
        },
      },
      cacheTtlMs: 0,
    });
    assert.equal(await settings.getFlag("onboardingV2Enabled"), false);
    await assert.rejects(
      settings.setFlag("onboardingV2Enabled", true),
      /Unknown setting/,
    );
    assert.equal(writes.length, 0);
    assert.equal(
      Object.hasOwn(await settings.getAllFlags(), "onboardingV2Enabled"),
      false,
    );
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = oldTestContext;
  }
});
